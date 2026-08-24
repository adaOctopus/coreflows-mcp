import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as store from "../store";
import { mcpText, mcpLoop } from "../lib/response";
import { buildLoopMeta, pushFailedRecovery } from "../lib/loopState";
import { getGhToken, getAuthenticatedUser, branchExists, findUserFork } from "../orchestrator/githubApi";

async function ghFetchRaw(path: string, token: string, opts: RequestInit = {}): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.headers || {}),
    },
  });
}

/**
 * Build a git push command that uses token-authenticated HTTPS.
 * Format: https://x-access-token:TOKEN@github.com/org/repo.git
 * Works in non-interactive shells — no SSH keys, no credential prompt.
 */
function tokenPushCmd(token: string, targetRepo: string, branch: string, remoteName?: string): string[] {
  const authUrl = `https://x-access-token:${token}@github.com/${targetRepo}.git`;
  const lines: string[] = [];

  if (remoteName) {
    lines.push(`git remote remove ${remoteName} 2>/dev/null || true`);
    lines.push(`git remote add ${remoteName} ${authUrl}`);
    lines.push(`git push ${remoteName} ${branch}`);
  } else {
    lines.push(`git remote set-url origin ${authUrl}`);
    lines.push(`git push origin ${branch}`);
  }

  return lines;
}

export function registerPushBranchTool(server: McpServer) {
  (server as any).tool(
    "push_branch",
    "Push a feature branch to GitHub. Handles auth automatically using the server-side GitHub token — no SSH keys or credential prompts needed. Checks write access, tries direct push, falls back to existing fork, creates new fork as last resort. Call this instead of running git push yourself. Execute the returned commands EXACTLY — do not modify the URLs. If push fails with 'workflow scope' or 'permission denied', update your GITHUB_TOKEN in .env.",
    {
      jiraKey: z.string().describe("The Jira ticket key, e.g. PROJ-142"),
      branch: z.string().describe("The branch name to push"),
      repo: z.string().describe("The target GitHub repo in org/name format, e.g. cowprotocol/cowswap"),
    },
    async ({ jiraKey, branch, repo }: { jiraKey: string; branch: string; repo: string }) => {
      const taskCtx = { jiraKey, branch, repo };

      let token: string;
      try {
        token = getGhToken();
      } catch {
        return mcpLoop(
          `No GitHub token found. Set GITHUB_TOKEN in your .env file.`,
          buildLoopMeta("BLOCKED", taskCtx, { recovery: pushFailedRecovery(jiraKey, branch, repo, "auth") }),
        );
      }

      let username: string;
      try {
        username = await getAuthenticatedUser(token);
      } catch {
        return mcpLoop(
          `GitHub token is invalid or expired. Update GITHUB_TOKEN in your .env file.`,
          buildLoopMeta("BLOCKED", taskCtx, { recovery: pushFailedRecovery(jiraKey, branch, repo, "auth") }),
        );
      }

      const [org, repoName] = repo.split("/");
      if (!org || !repoName) {
        return mcpText(`Invalid repo format: "${repo}". Expected org/name (e.g. cowprotocol/cowswap).`);
      }

      const steps: string[] = [];

      // ── Step 1: Try direct push (check if user has write access) ─────
      steps.push(`Checking write access to ${repo}...`);
      try {
        const permRes = await ghFetchRaw(`/repos/${repo}/collaborators/${username}/permission`, token);
        if (permRes.ok) {
          const permData: any = await permRes.json();
          const perm = permData.permission;
          if (perm === "admin" || perm === "write" || perm === "maintain") {
            steps.push(`You have ${perm} access to ${repo}. Pushing directly.`);

            const cmds = tokenPushCmd(token, repo, branch);

            steps.push(
              ``,
              `**Run these commands:**`,
              `\`\`\``,
              ...cmds,
              `\`\`\``,
              ``,
              `Then open a PR from \`${branch}\` → default branch on ${repo}.`,
            );

            // Update the task's branch
            const task = store.findTaskByJiraKey(jiraKey);
            if (task) {
              store.updateTask(task.id, { branch });
            }

            return mcpLoop(steps.join("\n"), buildLoopMeta("PUSHED", taskCtx));
          }
        }
      } catch {
        // Permission check failed — move to next strategy
      }
      steps.push(`No direct write access to ${repo}.`);

      // ── Step 2: Find existing fork (handles renamed forks like cowswap-mmc) ──
      steps.push(`Searching for your fork of ${repo}...`);
      const existingFork = await findUserFork(token, repo, username);

      if (existingFork) {
        steps.push(`Found your fork: ${existingFork.fullName}`);

        const cmds = tokenPushCmd(token, existingFork.fullName, branch, "fork");

        steps.push(
          ``,
          `**Push to your fork:**`,
          `\`\`\``,
          ...cmds,
          `\`\`\``,
          ``,
          `Then open a PR from \`${username}:${branch}\` → \`${org}:main\` on ${repo}.`,
        );

        const task = store.findTaskByJiraKey(jiraKey);
        if (task) {
          store.updateTask(task.id, { branch });
        }

        return mcpLoop(steps.join("\n"), buildLoopMeta("PUSHED", taskCtx));
      }
      steps.push(`No existing fork found.`);

      // ── Step 3: Create a fork (last resort) ──────────────────────────
      steps.push(`Creating a fork of ${repo}...`);
      try {
        const forkRes = await ghFetchRaw(`/repos/${repo}/forks`, token, {
          method: "POST",
          body: JSON.stringify({ default_branch_only: false }),
        });

        if (forkRes.ok || forkRes.status === 202) {
          const forkData: any = await forkRes.json();
          const forkFullName = forkData.full_name as string;
          steps.push(`Fork created: ${forkFullName}`);

          // Wait for fork to be ready (GitHub 202 = async creation)
          steps.push(`Waiting for fork to be ready...`);
          let forkReady = false;
          for (let i = 0; i < 10; i++) {
            await new Promise((r) => setTimeout(r, 5000));
            const checkRes = await ghFetchRaw(`/repos/${forkFullName}`, token);
            if (checkRes.ok) {
              forkReady = true;
              break;
            }
          }

          if (!forkReady) {
            steps.push(`Fork still initializing. Wait 60 seconds then run the commands below.`);
          } else {
            steps.push(`Fork ready.`);
          }

          const cmds = tokenPushCmd(token, forkFullName, branch, "fork");

          steps.push(
            ``,
            `**Push to your fork:**`,
            `\`\`\``,
            ...cmds,
            `\`\`\``,
            ``,
            `Then open a PR from \`${username}:${branch}\` → \`${org}:main\` on ${repo}.`,
          );

          const task = store.findTaskByJiraKey(jiraKey);
          if (task) {
            store.updateTask(task.id, { branch });
          }

          return mcpLoop(steps.join("\n"), buildLoopMeta("PUSHED", taskCtx));
        } else {
          const body = await forkRes.text();
          steps.push(`Fork creation failed (${forkRes.status}): ${body.slice(0, 200)}`);
        }
      } catch (err: any) {
        steps.push(`Fork creation error: ${err.message}`);
      }

      steps.push(
        ``,
        `All push strategies failed. Check:`,
        `1. Your GITHUB_TOKEN in .env is valid`,
        `2. The repo ${repo} exists and is accessible`,
        `3. Your account can fork the repo (some orgs restrict forking)`,
      );

      return mcpLoop(
        steps.join("\n"),
        buildLoopMeta("BLOCKED", taskCtx, { recovery: pushFailedRecovery(jiraKey, branch, repo, "generic") }),
      );
    },
  );
}
