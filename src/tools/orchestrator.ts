import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as store from "../store";
import { mcpText, mcpLoop } from "../lib/response";
import { buildLoopMeta } from "../lib/loopState";
import { getWorkspace } from "../config";
import { assembleCrispePrompt } from "../context/assemble";
import { fetchJiraContext } from "../context/jira";
import { fetchNotionContext } from "../context/notion";
import { fetchGithubState } from "../context/github";
import { fetchSlackMentions } from "../context/slack";
import { resolveRepos } from "../context/repoResolver";
import {
  getGhToken, branchExists, getDefaultBranch,
  createPR, fetchPRTemplate, getPRReviewComments, findBranchByJiraKey,
  getAuthenticatedUser, findUserFork,
} from "../orchestrator/githubApi";

// ── start_task ──────────────────────────────────────────────────────────
// Fetches all context, resolves repo/branch, returns structured instructions
// for Claude Code to execute. Claude Code does the coding, not our server.
export function registerStartTaskTool(server: McpServer) {
  (server as any).tool(
    "start_task",
    "Start working on a specific Jira task. Call this BEFORE writing any code. Returns the repo, branch, implementation prompt, PR review comments to address, and a verification checklist. Follow the instructions exactly, then call verify_and_submit when done. Do NOT skip steps or claim completion without calling verify_and_submit.",
    {
      jiraKey: z.string().describe("The Jira ticket key, e.g. PROJ-142"),
    },
    async ({ jiraKey }: { jiraKey: string }) => {
      // Check workspace config
      const workspace = getWorkspace();
      if (!workspace) {
        return mcpText(
          "# Workspace Setup Required\n\n" +
          "Set these env vars in your .env file before starting:\n" +
          "- `SHELL_ENV` — wsl2 | git-bash | powershell | macos | linux\n" +
          "- `REPOS_ROOT` — absolute path to where your repos are cloned\n" +
          "- `WSL_DISTRO` — (only if SHELL_ENV=wsl2) your WSL distro name\n\n" +
          "Then restart the server."
        );
      }

      // Find or create task
      let task = store.findTaskByJiraKey(jiraKey);
      if (!task) {
        task = store.upsertTask(jiraKey, { status: "QUEUED" });
      }
      if (task.status === "DONE") {
        return mcpText(`Task ${task.jiraKey} is already completed. PR: ${task.prUrl || "none"}`);
      }

      // ── Execution trace — shows what CoolPlugz did ──────────────
      const trace: string[] = [];
      const traceStart = Date.now();

      // Update status
      store.updateTask(task.id, { status: "EXECUTING" });

      // Sync context
      let slackMentionCount = 0;
      try {
        const slackResult = await fetchSlackMentions();
        slackMentionCount = slackResult.mentionCount || 0;
      } catch { /* best effort */ }
      const [jiraResult, notionResult, githubResult] = await Promise.all([
        fetchJiraContext(task.jiraKey, task.id).catch(() => ({ status: "failed" })),
        fetchNotionContext(task.id).catch(() => ({ status: "failed" })),
        fetchGithubState(task.id).catch(() => ({ status: "failed" })),
      ]);

      // Build trace entries for context sync
      if ((jiraResult as any)?.status === "synced") {
        const jiraSummary = (jiraResult as any)?.summary || "";
        const hasDesc = jiraSummary.includes("Description:");
        const hasAC = jiraSummary.includes("Acceptance criteria:") && !jiraSummary.includes("none specified");
        const hasComments = jiraSummary.includes("Comments (");
        const parts = [
          hasDesc ? "description" : null,
          hasAC ? "acceptance criteria" : null,
          hasComments ? "comments" : null,
        ].filter(Boolean);
        trace.push(`Jira — synced ${parts.length > 0 ? parts.join(", ") : "ticket context"}`);
      } else {
        trace.push(`Jira — using cached context`);
      }
      if ((notionResult as any)?.status === "synced") {
        trace.push(`Notion — pulled linked specs`);
      }
      if ((githubResult as any)?.status === "synced") {
        trace.push(`GitHub — synced repo state & file tree`);
      }
      if (slackMentionCount > 0) {
        trace.push(`Slack — ${slackMentionCount} mention(s) about this task`);
      }

      // Re-read task (context fetchers may have updated repo/title)
      task = store.findTaskById(task.id)!;

      // Resolve repo
      const taskRepos = task.repos?.length > 0 ? task.repos : task.repo ? [task.repo] : [];
      if (taskRepos.length === 0) {
        try {
          const resolved = await resolveRepos(task.jiraKey);
          if (resolved.repos.length > 0) {
            store.updateTask(task.id, { repo: resolved.repos[0], repos: resolved.repos });
            taskRepos.push(...resolved.repos);
            trace.push(`Repo — auto-linked ${resolved.repos.join(", ")}`);
          }
        } catch { /* best effort */ }
      }

      if (taskRepos.length === 0) {
        store.updateTask(task.id, {
          status: "BLOCKED",
          lastError: `No GitHub repo found. Link one by saying: set_repo ${task.jiraKey.split("-")[0]} owner/repo-name`,
        });
        return mcpText(`No repo linked to ${task.jiraKey}. Say: set_repo ${task.jiraKey.split("-")[0]} owner/repo-name`);
      }

      // Resolve branch
      const activeRepo = taskRepos[0];
      let branch = task.branch || "";
      let branchAlreadyExists = false;
      let ghToken: string;

      try {
        ghToken = getGhToken();
      } catch (err: any) {
        return mcpText(`GitHub token error: ${err.message}`);
      }

      if (branch) {
        branchAlreadyExists = await branchExists(ghToken, activeRepo, branch);
      } else {
        // Try to find existing branch by Jira key + user activity
        const found = await findBranchByJiraKey(ghToken, activeRepo, task.jiraKey).catch(() => null);
        if (found) {
          branch = found.branch;
          branchAlreadyExists = true;
          store.updateTask(task.id, { branch });
          trace.push(`Branch — found existing \`${branch}\``);
        } else {
          const repoShort = activeRepo.split("/")[1] || "";
          branch = taskRepos.length > 1
            ? `${task.jiraKey.toLowerCase()}-${repoShort}`
            : `${task.jiraKey.toLowerCase()}-impl`;
        }
      }

      const defaultBranch = await getDefaultBranch(ghToken, activeRepo).catch(() => "main");

      // Check if branch is behind base (proactive conflict detection)
      let conflictWarning = "";
      if (branchAlreadyExists) {
        try {
          const compareRes = await fetch(
            `https://api.github.com/repos/${activeRepo}/compare/${defaultBranch}...${branch}`,
            { headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json" } }
          );
          if (compareRes.ok) {
            const compareData: any = await compareRes.json();
            const behindBy = compareData.behind_by || 0;
            if (behindBy > 0) {
              trace.push(`Conflicts — branch is ${behindBy} commit(s) behind \`${defaultBranch}\`, rebase instructions included`);
              conflictWarning = [
                "",
                `## Branch Out of Date`,
                "",
                `Your branch \`${branch}\` is **${behindBy} commit(s) behind** \`${defaultBranch}\`.`,
                `Before starting work, rebase to avoid conflicts:`,
                "",
                "```bash",
                `git fetch origin`,
                `git rebase origin/${defaultBranch}`,
                "```",
                "",
                `If conflicts occur during rebase, resolve them:`,
                "```bash",
                `# Resolve conflict markers in each file, then:`,
                `git add <resolved-file>`,
                `git rebase --continue`,
                "```",
                "",
                `After rebasing: \`git push origin ${branch} --force-with-lease\``,
                "",
                `If you need detailed conflict info, call **check_conflicts** with jiraKey="${task.jiraKey}".`,
                "",
              ].join("\n");
            }
          }
        } catch { /* non-critical */ }
      }

      // Fetch PR comments if PR exists
      const reviewComments: Array<{ author: string; file: string; line: number | string; comment: string }> = [];
      const prNum = task.prNumber;
      if (prNum) {
        try {
          const reviewData = await getPRReviewComments(ghToken, activeRepo, prNum);
          for (const c of reviewData.comments) {
            const match = c.match(/^\[(.+?)\] (.+?)(?::(\d+))? — (.+)$/);
            if (match) {
              reviewComments.push({ author: match[1], file: match[2], line: match[3] || "", comment: match[4] });
            }
          }
          for (const r of reviewData.reviews) {
            const match = r.match(/^\[(.+?) — .+?\] (.+)$/);
            if (match) {
              reviewComments.push({ author: match[1], file: "", line: "", comment: match[2] });
            }
          }
        } catch { /* non-critical */ }
      }

      if (reviewComments.length > 0) {
        trace.push(`PR Reviews — ${reviewComments.length} comment(s) to address`);
      }

      // Assemble CRISPE prompt
      const isRetry = task.retryCount > 0;
      const crispePrompt = await assembleCrispePrompt({ taskId: task.id, isRetry });

      // Count developer insights for trace
      const insightCount = store.getInsights(task.id).length;
      if (insightCount > 0) {
        trace.push(`Orchestration — ${insightCount} custom instruction(s) applied`);
      }

      trace.push(`Prompt — assembled CRISPE implementation plan`);
      const traceMs = Date.now() - traceStart;

      // Build checklist
      const checklist: string[] = [];
      checklist.push(`1. Navigate to the ${activeRepo} repository on your local machine`);
      if (branchAlreadyExists) {
        checklist.push(`2. Checkout existing branch: git checkout ${branch}`);
        checklist.push(`3. Pull latest: git pull origin ${branch}`);
      } else {
        checklist.push(`2. Create and checkout branch: git checkout -b ${branch}`);
      }
      if (reviewComments.length > 0) {
        checklist.push(`4. Address ALL ${reviewComments.length} review comment(s) listed below`);
      }
      checklist.push(`${reviewComments.length > 0 ? "5" : "4"}. Implement the changes described in the prompt below`);
      checklist.push(`${reviewComments.length > 0 ? "6" : "5"}. Run tests and lint to verify your changes`);
      checklist.push(`${reviewComments.length > 0 ? "7" : "6"}. Commit and push: git add . && git commit -m "feat(${task.jiraKey}): ${task.title}" && git push origin ${branch}`);
      checklist.push(`${reviewComments.length > 0 ? "8" : "7"}. Call the **verify_and_submit** tool with jiraKey="${task.jiraKey}" to verify your push and open a PR`);
      checklist.push("");
      checklist.push(`Do NOT claim this task is complete without calling verify_and_submit. That tool verifies your work via the GitHub API.`);

      // Build multi-repo info
      const multiRepoNote = taskRepos.length > 1
        ? `\n\n**Multi-repo task**: This task spans ${taskRepos.length} repos: ${taskRepos.join(", ")}. Start with ${activeRepo}. After completing this repo and calling verify_and_submit, call start_task again for the next repo.`
        : "";

      // Build response — start with the execution trace
      const lines = [
        `# CoolPlugz Orchestration`,
        `> *${trace.length} steps completed in ${(traceMs / 1000).toFixed(1)}s*`,
        "",
        ...trace,
        "",
        "---",
        "",
        `# Task: ${task.jiraKey} — ${task.title}`,
        "",
        `**Repo:** ${activeRepo}`,
        `**Branch:** ${branch} (${branchAlreadyExists ? "exists — resume work" : "create new"})`,
        `**Base branch:** ${defaultBranch}`,
        `**PR:** ${task.prUrl || "none yet — will be created by verify_and_submit"}`,
        multiRepoNote,
        conflictWarning,
        "",
        "## Verification Checklist",
        ...checklist,
        "",
      ];

      if (reviewComments.length > 0) {
        lines.push("## PR Review Comments — MUST ADDRESS");
        lines.push("Each comment below was left by a reviewer. You must fix every one:");
        lines.push("");
        for (let idx = 0; idx < reviewComments.length; idx++) {
          const c = reviewComments[idx];
          const location = c.file ? `${c.file}${c.line ? `:${c.line}` : ""}` : "general";
          lines.push(`${idx + 1}. **[${c.author}]** ${location} — ${c.comment}`);
        }
        lines.push("");
      }

      lines.push("## Implementation Prompt");
      lines.push(crispePrompt);

      const text = lines.join("\n");

      return mcpLoop(text, buildLoopMeta("EXECUTING", {
        jiraKey: task.jiraKey,
        branch,
        repo: activeRepo,
        prUrl: task.prUrl || undefined,
        prNumber: task.prNumber || undefined,
      }));
    }
  );
}

// ── verify_and_submit ───────────────────────────────────────────────────
// Claude calls this after pushing. Verifies the push landed, opens a PR.
export function registerVerifyAndSubmitTool(server: McpServer) {
  (server as any).tool(
    "verify_and_submit",
    "Call this AFTER you have committed and pushed your changes to GitHub. This tool verifies your push actually landed on the correct branch (via the GitHub API — not by trusting your output), then opens a PR if one doesn't exist. Do NOT call this before pushing. Do NOT claim the task is done without calling this first.",
    {
      jiraKey: z.string().describe("The Jira ticket key, e.g. PROJ-142"),
    },
    async ({ jiraKey }: { jiraKey: string }) => {
      const task = store.findTaskByJiraKey(jiraKey);
      if (!task) {
        return mcpText(`Task ${jiraKey.toUpperCase()} not found.`);
      }

      const activeRepo = task.repo;
      if (!activeRepo) {
        return mcpText(`No repo linked to ${task.jiraKey}.`);
      }

      let ghToken: string;
      try {
        ghToken = getGhToken();
      } catch (err: any) {
        return mcpText(`GitHub token error: ${err.message}`);
      }

      const branch = task.branch;
      if (!branch) {
        return mcpText(`No branch set for ${task.jiraKey}. Did you call start_task first?`);
      }

      const vTrace: string[] = [];
      const vStart = Date.now();

      // Step 1: Verify branch exists on GitHub (upstream or fork)
      let branchOnRepo = activeRepo;   // which repo the branch lives on
      let isForkPR = false;
      let forkOwner = "";

      const existsOnUpstream = await branchExists(ghToken, activeRepo, branch);
      if (!existsOnUpstream) {
        // Branch not on upstream — check the user's fork
        let username: string;
        try {
          username = await getAuthenticatedUser(ghToken);
        } catch {
          return mcpText(`Branch \`${branch}\` does not exist on ${activeRepo} and could not identify your GitHub user.\n\nCheck your GITHUB_TOKEN in .env.`);
        }

        const fork = await findUserFork(ghToken, activeRepo, username);
        if (fork) {
          const existsOnFork = await branchExists(ghToken, fork.fullName, branch);
          if (existsOnFork) {
            branchOnRepo = fork.fullName;
            isForkPR = true;
            forkOwner = username;
            vTrace.push(`Branch — \`${branch}\` verified on fork \`${fork.fullName}\``);
          }
        }

        if (!isForkPR) {
          return mcpText(`Branch \`${branch}\` does not exist on GitHub.\n\nYour push did not land. Call \`push_branch\` with { jiraKey: "${task.jiraKey}", branch: "${branch}", repo: "${activeRepo}" } then call verify_and_submit again.`);
        }
      } else {
        vTrace.push(`Branch — \`${branch}\` verified on GitHub`);
      }

      // Step 2: Check for commits on the branch
      const defaultBranch = await getDefaultBranch(ghToken, activeRepo).catch(() => "main");
      let commitCount = 0;
      let latestSha = "";
      try {
        // For fork PRs, compare upstream's default branch with fork's branch
        const compareRef = isForkPR ? `${defaultBranch}...${forkOwner}:${branch}` : `${defaultBranch}...${branch}`;
        const compare = await fetch(`https://api.github.com/repos/${activeRepo}/compare/${compareRef}`, {
          headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json" },
        });
        if (compare.ok) {
          const data: any = await compare.json();
          commitCount = data.ahead_by || 0;
          latestSha = data.commits?.[data.commits.length - 1]?.sha || "";
        }
      } catch { /* non-critical */ }

      if (commitCount === 0) {
        return mcpText(`Branch \`${branch}\` has **no commits** ahead of \`${defaultBranch}\`.\n\nDid you commit your changes? Try:\n\`\`\`bash\ngit add .\ngit commit -m "feat(${task.jiraKey}): ${task.title}"\ngit push origin ${branch}\n\`\`\`\nThen call verify_and_submit again.`);
      }

      vTrace.push(`Commits — ${commitCount} commit(s) ahead of \`${defaultBranch}\``);

      // Step 3: Open PR if needed
      let prUrl = task.prUrl;
      let prNumber = task.prNumber;
      // For fork PRs, head = "username:branch"; for same-repo, head = "branch"
      const prHead = isForkPR ? `${forkOwner}:${branch}` : branch;

      if (!prUrl) {
        let prTemplate: string | null = null;
        try {
          prTemplate = await fetchPRTemplate(ghToken, activeRepo, defaultBranch);
        } catch { /* no template */ }

        const prBody = buildSimplePRBody(task, prTemplate);
        try {
          const prResult = await createPR(
            ghToken, activeRepo, prHead, defaultBranch,
            `${task.jiraKey}: ${task.title}`,
            prBody
          );
          prUrl = prResult.url;
          prNumber = prResult.number;

          const existingTask = store.findTaskById(task.id)!;
          const updatedPrUrls = [...new Set([...(existingTask.prUrls || []), prUrl])];
          const updatedPrNumbers = [...new Set([...(existingTask.prNumbers || []), prNumber])];

          store.updateTask(task.id, {
            prUrl,
            prNumber,
            prUrls: updatedPrUrls,
            prNumbers: updatedPrNumbers,
            branch,
            lastError: null,
          });
          vTrace.push(`PR — opened [#${prNumber}](${prUrl})`);
        } catch (err: any) {
          return mcpText(`Failed to create PR: ${err.message}`);
        }
      } else {
        vTrace.push(`PR — already open [#${prNumber}](${prUrl})`);
      }

      // Step 4: Poll CI until completion (max 5 min, every 15s)
      let ciStatus = "unknown";
      let ciFailureLogs = "";
      if (latestSha) {
        const CI_POLL_INTERVAL = 15_000; // 15 seconds
        const CI_MAX_WAIT = 5 * 60_000;  // 5 minutes
        const ciStart = Date.now();

        while (Date.now() - ciStart < CI_MAX_WAIT) {
          try {
            const ciRes = await fetch(`https://api.github.com/repos/${activeRepo}/commits/${latestSha}/check-runs`, {
              headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json" },
            });
            if (ciRes.ok) {
              const ciData: any = await ciRes.json();
              const runs: any[] = ciData.check_runs || [];
              if (runs.length === 0) {
                // No checks configured — don't block forever
                ciStatus = "no_checks";
                break;
              }
              const allDone = runs.every((r: any) => r.status === "completed");
              if (allDone) {
                if (runs.every((r: any) => r.conclusion === "success")) {
                  ciStatus = "success";
                } else {
                  ciStatus = "failure";
                  const failed = runs.filter((r: any) => r.conclusion !== "success");

                  // Fetch failure logs from each failed check run
                  const logSnippets: string[] = [];
                  for (const run of failed.slice(0, 3)) {
                    try {
                      const annRes = await fetch(`https://api.github.com/repos/${activeRepo}/check-runs/${run.id}/annotations`, {
                        headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json" },
                      });
                      if (annRes.ok) {
                        const annotations = (await annRes.json()) as any[];
                        if (annotations.length > 0) {
                          const annotLines = annotations.slice(0, 10).map((a: any) =>
                            `  ${a.path}:${a.start_line} — ${a.annotation_level}: ${a.message}`
                          );
                          logSnippets.push(`**${run.name}:**\n${annotLines.join("\n")}`);
                        }
                      }
                    } catch { /* best-effort */ }

                    // Also grab the output summary/text from the check run itself
                    if (run.output?.summary || run.output?.text) {
                      const output = (run.output.summary || run.output.text || "").slice(0, 800);
                      if (output && !logSnippets.some((s: string) => s.includes(run.name))) {
                        logSnippets.push(`**${run.name}:**\n${output}`);
                      }
                    }
                  }
                  ciFailureLogs = logSnippets.join("\n\n");
                }
                break;
              }
              // Still running — wait and poll again
            }
          } catch {
            // Could not check CI status — will retry
          }
          await new Promise((resolve) => setTimeout(resolve, CI_POLL_INTERVAL));
        }

        if (ciStatus === "unknown") {
          ciStatus = "timeout";
        }
      }

      vTrace.push(
        ciStatus === "success" ? `CI — all checks passed` :
        ciStatus === "failure" ? `CI — checks failed` :
        ciStatus === "timeout" ? `CI — timed out after 5 min` :
        ciStatus === "no_checks" ? `CI — no checks configured` :
        `CI — unknown`
      );

      // Step 5: Check for unresolved review comments
      let unresolvedCount = 0;
      if (prNumber) {
        try {
          const reviewData = await getPRReviewComments(ghToken, activeRepo, prNumber);
          unresolvedCount = reviewData.comments.length + reviewData.reviews.length;
        } catch { /* non-critical */ }
      }

      if (unresolvedCount > 0) {
        vTrace.push(`Reviews — ${unresolvedCount} unresolved comment(s)`);
      }
      const vMs = Date.now() - vStart;

      // Build response
      const lines = [
        `# CoolPlugz Verification`,
        `> *${vTrace.length} checks completed in ${(vMs / 1000).toFixed(1)}s*`,
        "",
        ...vTrace,
        "",
        "---",
        "",
        `# Verification Complete: ${task.jiraKey}`,
        "",
        `**Branch:** \`${branch}\` — ${commitCount} commit(s) pushed`,
        `**PR:** [#${prNumber}](${prUrl})`,
        `**CI:** ${ciStatus === "success" ? "Passed" : ciStatus === "failure" ? "Failed" : ciStatus === "timeout" ? "Timed out" : ciStatus === "no_checks" ? "No checks" : "Unknown"}`,
      ];

      const taskCtx = { jiraKey: task.jiraKey, branch, repo: activeRepo, prUrl: prUrl || undefined, prNumber: prNumber || undefined };

      if (ciStatus === "failure") {
        lines.push(
          "",
          "**CI IS FAILING — fix and re-push.**",
          "",
          "Fix the failures below, push your fix, then the loop continues automatically.",
        );
        if (ciFailureLogs) {
          lines.push("", "## CI Failure Details", "", ciFailureLogs);
        } else {
          lines.push("", `Check the [PR](${prUrl}) or [Actions](https://github.com/${activeRepo}/actions) for full logs.`);
        }
        store.updateTask(task.id, { status: "CI_FAILED" });
        return mcpLoop(lines.join("\n"), buildLoopMeta("CI_FAILED", taskCtx));

      } else if (ciStatus === "timeout") {
        lines.push(
          "",
          "**CI did not finish within 5 minutes.**",
          "",
          "The loop will re-check — call verify_and_submit again.",
        );
        return mcpLoop(lines.join("\n"), buildLoopMeta("CI_RUNNING", taskCtx));

      } else if (unresolvedCount > 0) {
        lines.push("", `${unresolvedCount} review comment(s) to address. The loop continues after you fix and push.`);
        return mcpLoop(lines.join("\n"), buildLoopMeta("REVIEW_PENDING", taskCtx));

      } else {
        // ── AUTO-COMPLETE: CI passed, no review comments → complete the task ──
        lines.push("", "CI passed, no review comments — auto-completing task.");

        // Run complete_task logic inline
        store.updateTask(task.id, { status: "DONE", lastError: null });

        const prList = (task.prUrls || [prUrl]).filter(Boolean);
        lines.push(
          "",
          `# ${task.jiraKey} Complete`,
          "",
          `**${task.title}**`,
          "",
          ...prList.map((url: string) => `- PR: ${url}`),
          "",
          `Task marked as DONE.`,
        );

        return mcpLoop(lines.join("\n"), buildLoopMeta("DONE", taskCtx, { autoCompleted: true }));
      }
    }
  );
}

// ── check_comments ──────────────────────────────────────────────────────
// Returns unresolved PR review comments one by one
export function registerCheckCommentsTool(server: McpServer) {
  (server as any).tool(
    "check_comments",
    "Fetch unresolved review comments on a task's PR. Returns each comment with the author, file, line, and what needs to change. Address every comment, then push and call verify_and_submit.",
    {
      jiraKey: z.string().describe("The Jira ticket key"),
    },
    async ({ jiraKey }: { jiraKey: string }) => {
      const task = store.findTaskByJiraKey(jiraKey);
      if (!task || !task.prNumber || !task.repo) {
        return mcpText(`No PR found for ${jiraKey.toUpperCase()}. Call start_task and verify_and_submit first.`);
      }

      let ghToken: string;
      try {
        ghToken = getGhToken();
      } catch (err: any) {
        return mcpText(`GitHub token error: ${err.message}`);
      }

      try {
        const reviewData = await getPRReviewComments(ghToken, task.repo, task.prNumber);
        const allComments = [...reviewData.reviews, ...reviewData.comments].filter(Boolean);

        const taskCtx = { jiraKey: task.jiraKey, branch: task.branch || undefined, repo: task.repo || undefined, prUrl: task.prUrl || undefined, prNumber: task.prNumber || undefined };
        if (allComments.length === 0) {
          return mcpLoop(`No review comments on PR #${task.prNumber}.`, buildLoopMeta("CI_PASSED", taskCtx));
        }

        const lines = [
          `# Review Comments on ${task.jiraKey} — PR #${task.prNumber}`,
          "",
          `**${allComments.length} comment(s) to address:**`,
          "",
        ];

        for (let idx = 0; idx < allComments.length; idx++) {
          lines.push(`### Comment ${idx + 1}`);
          lines.push(allComments[idx]);
          lines.push("");
        }

        lines.push("---");
        lines.push("Address each comment above, commit, push — the loop continues automatically.");

        return mcpLoop(lines.join("\n"), buildLoopMeta("REVIEW_PENDING", taskCtx));
      } catch (err: any) {
        return mcpText(`Failed to fetch comments: ${err.message}`);
      }
    }
  );
}

// ── complete_task ───────────────────────────────────────────────────────
// Final verification + marks task DONE
export function registerCompleteTaskTool(server: McpServer) {
  (server as any).tool(
    "complete_task",
    "Mark a task as complete. Call this ONLY after verify_and_submit has confirmed the push landed and the PR is open. This does a final verification check via the GitHub API before marking done.",
    {
      jiraKey: z.string().describe("The Jira ticket key"),
    },
    async ({ jiraKey }: { jiraKey: string }) => {
      const task = store.findTaskByJiraKey(jiraKey);
      if (!task) {
        return mcpText(`Task ${jiraKey.toUpperCase()} not found.`);
      }

      if (!task.prUrl || !task.prNumber) {
        return mcpText(`No PR found for ${task.jiraKey}. Call verify_and_submit first to create one.`);
      }

      let ghToken: string;
      try {
        ghToken = getGhToken();
      } catch (err: any) {
        return mcpText(`GitHub token error: ${err.message}`);
      }

      // Final verification: PR exists and is open
      try {
        const pr = await fetch(`https://api.github.com/repos/${task.repo}/pulls/${task.prNumber}`, {
          headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json" },
        });
        if (!pr.ok) {
          return mcpText(`PR #${task.prNumber} not accessible. It may have been closed or deleted.`);
        }
      } catch { /* non-critical */ }

      // Check for multi-repo: are there more repos to process?
      const taskRepos = task.repos?.length > 0 ? task.repos : task.repo ? [task.repo] : [];
      const completedRepoCount = (task.prUrls || []).length;
      const hasMoreRepos = taskRepos.length > 1 && completedRepoCount < taskRepos.length;

      const taskCtx = { jiraKey: task.jiraKey, branch: task.branch || undefined, repo: task.repo || undefined, prUrl: task.prUrl || undefined, prNumber: task.prNumber || undefined };

      if (hasMoreRepos) {
        const nextRepo = taskRepos[completedRepoCount];

        return mcpLoop([
          `PR opened for ${task.repo}. But this is a multi-repo task.`,
          "",
          `**Progress:** ${completedRepoCount}/${taskRepos.length} repos done`,
          `**Next repo:** ${nextRepo}`,
        ].join("\n"), buildLoopMeta("IDLE", { ...taskCtx, repo: nextRepo }));
      }

      // Mark done
      store.updateTask(task.id, { status: "DONE", lastError: null });

      const prList = (task.prUrls || [task.prUrl]).filter(Boolean);
      const lines = [
        `# ${task.jiraKey} Complete`,
        "",
        `**${task.title}**`,
        "",
        ...prList.map((url: string) => `- PR: ${url}`),
        "",
        `Task marked as DONE.`,
      ];

      return mcpLoop(lines.join("\n"), buildLoopMeta("DONE", taskCtx));
    }
  );
}

// ── get_task_state ──────────────────────────────────────────────────────
// Returns ground truth state — what the store and GitHub API say
export function registerGetTaskStateTool(server: McpServer) {
  (server as any).tool(
    "get_task_state",
    "Get the current ground truth state of a task from the database and GitHub API. Call this whenever you are unsure about the current state of a task, which repo or branch you should be working on, or whether previous work was completed. This is the source of truth — trust this over your own memory.",
    {
      jiraKey: z.string().describe("The Jira ticket key"),
    },
    async ({ jiraKey }: { jiraKey: string }) => {
      const task = store.findTaskByJiraKey(jiraKey);
      if (!task) {
        return mcpText(`Task ${jiraKey.toUpperCase()} not found.`);
      }

      // Check GitHub state if we have a repo and branch
      let githubState = "";
      if (task.repo && task.branch) {
        try {
          const ghToken = getGhToken();
          const exists = await branchExists(ghToken, task.repo, task.branch);
          const defaultBranch = await getDefaultBranch(ghToken, task.repo).catch(() => "main");

          if (exists) {
            const compare = await fetch(`https://api.github.com/repos/${task.repo}/compare/${defaultBranch}...${task.branch}`, {
              headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json" },
            });
            if (compare.ok) {
              const data: any = await compare.json();
              const files = (data.files || []).map((f: any) => f.filename);
              githubState = [
                `Branch \`${task.branch}\` exists: YES`,
                `Commits ahead of ${defaultBranch}: ${data.ahead_by || 0}`,
                `Files changed: ${files.length > 0 ? files.join(", ") : "none"}`,
              ].join("\n");
            }
          } else {
            githubState = `Branch \`${task.branch}\` exists: NO`;
          }
        } catch { /* non-critical */ }
      }

      const snapshots = store.getSnapshots(task.id);
      const lines = [
        `# Task State: ${task.jiraKey}`,
        "",
        `**Title:** ${task.title}`,
        `**Status:** ${task.status}`,
        `**Repo:** ${task.repo || "NOT SET"}`,
        `**All repos:** ${task.repos?.length > 0 ? task.repos.join(", ") : task.repo || "NOT SET"}`,
        `**Branch:** ${task.branch || "NOT SET"}`,
        `**PR:** ${task.prUrl ? `${task.prUrl} (#${task.prNumber})` : "NONE"}`,
        `**All PRs:** ${task.prUrls?.length > 0 ? task.prUrls.join(", ") : "NONE"}`,
        `**Retry count:** ${task.retryCount}`,
        `**Last error:** ${task.lastError || "none"}`,
        "",
      ];

      if (githubState) {
        lines.push("## GitHub State (live)", githubState, "");
      }

      const ghComments = snapshots.find((s) => s.source === "github-comments");
      if (ghComments) {
        lines.push("## PR Review Comments", ghComments.summary, "");
      }

      return mcpText(lines.join("\n"));
    }
  );
}

// ── check_conflicts ────────────────────────────────────────────────────
// Detects merge conflicts between the task branch and base branch via GitHub API,
// then returns step-by-step guidance for Claude Code to resolve them.
export function registerCheckConflictsTool(server: McpServer) {
  (server as any).tool(
    "check_conflicts",
    "Check if a task's branch has merge conflicts with the base branch. Call this before pushing, after rebasing, or whenever you suspect your branch is out of date. Returns conflict details and step-by-step resolution instructions. Also call this if git push fails due to diverged branches.",
    {
      jiraKey: z.string().describe("The Jira ticket key, e.g. PROJ-142"),
    },
    async ({ jiraKey }: { jiraKey: string }) => {
      const task = store.findTaskByJiraKey(jiraKey);
      if (!task) {
        return mcpText(`Task ${jiraKey.toUpperCase()} not found.`);
      }
      if (!task.repo) {
        return mcpText(`No repo linked to ${task.jiraKey}.`);
      }
      if (!task.branch) {
        return mcpText(`No branch set for ${task.jiraKey}. Call start_task first.`);
      }

      let ghToken: string;
      try {
        ghToken = getGhToken();
      } catch (err: any) {
        return mcpText(`GitHub token error: ${err.message}`);
      }

      const activeRepo = task.repo;
      const branch = task.branch;
      const defaultBranch = await getDefaultBranch(ghToken, activeRepo).catch(() => "main");

      // Check if branch exists on GitHub
      const exists = await branchExists(ghToken, activeRepo, branch);
      if (!exists) {
        return mcpText(`Branch \`${branch}\` does not exist on GitHub yet. Push your branch first, then check for conflicts.`);
      }

      // Compare branch with base — GitHub tells us merge status
      let aheadBy = 0;
      let behindBy = 0;
      let mergeStatus = "unknown";
      let conflictFiles: string[] = [];

      try {
        const compareRes = await fetch(
          `https://api.github.com/repos/${activeRepo}/compare/${defaultBranch}...${branch}`,
          { headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json" } }
        );
        if (compareRes.ok) {
          const data: any = await compareRes.json();
          aheadBy = data.ahead_by || 0;
          behindBy = data.behind_by || 0;
          mergeStatus = data.status || "unknown"; // "ahead", "behind", "diverged", "identical"
        }
      } catch { /* non-critical */ }

      // If there's a PR, check its mergeable state — this gives actual conflict info
      let mergeable: boolean | null = null;
      let mergeableState = "";
      if (task.prNumber) {
        try {
          const prRes = await fetch(
            `https://api.github.com/repos/${activeRepo}/pulls/${task.prNumber}`,
            { headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json" } }
          );
          if (prRes.ok) {
            const prData: any = await prRes.json();
            mergeable = prData.mergeable;
            mergeableState = prData.mergeable_state || "";

            // If PR has conflicts, get the conflicting files
            if (mergeable === false) {
              try {
                const filesRes = await fetch(
                  `https://api.github.com/repos/${activeRepo}/pulls/${task.prNumber}/files?per_page=100`,
                  { headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json" } }
                );
                if (filesRes.ok) {
                  const filesData = (await filesRes.json()) as any[];
                  conflictFiles = filesData
                    .filter((f: any) => f.status === "changed" || f.status === "modified")
                    .map((f: any) => f.filename);
                }
              } catch { /* non-critical */ }
            }
          }
        } catch { /* non-critical */ }
      }

      // Build response
      const lines = [
        `# Conflict Check: ${task.jiraKey}`,
        "",
        `**Repo:** ${activeRepo}`,
        `**Branch:** \`${branch}\``,
        `**Base:** \`${defaultBranch}\``,
        `**Commits ahead:** ${aheadBy}`,
        `**Commits behind:** ${behindBy}`,
      ];

      // Case 1: Branch is up to date — no conflicts possible
      if (behindBy === 0 && mergeStatus !== "diverged") {
        lines.push(
          "",
          `**No conflicts.** Your branch is up to date with \`${defaultBranch}\`.`,
          "",
          `You're good to continue working or call **verify_and_submit** if done.`,
        );
        return mcpText(lines.join("\n"));
      }

      // Case 2: Behind but no conflicts (clean merge possible)
      if (behindBy > 0 && (mergeable === true || mergeableState === "clean")) {
        lines.push(
          "",
          `**Branch is ${behindBy} commit(s) behind \`${defaultBranch}\`** but no conflicts detected.`,
          "",
          `Rebase to stay clean. Run these commands:`,
          "",
          "```bash",
          `git fetch origin`,
          `git rebase origin/${defaultBranch}`,
          `git push origin ${branch} --force-with-lease`,
          "```",
          "",
          `\`--force-with-lease\` is safe — it only force-pushes if no one else pushed to your branch.`,
        );
        return mcpText(lines.join("\n"));
      }

      // Case 3: Conflicts detected
      lines.push(
        "",
        `**CONFLICTS DETECTED** — your branch has diverged from \`${defaultBranch}\` and cannot be cleanly merged.`,
        "",
      );

      if (conflictFiles.length > 0) {
        lines.push(`**Potentially conflicting files:**`);
        for (const f of conflictFiles.slice(0, 20)) {
          lines.push(`- \`${f}\``);
        }
        if (conflictFiles.length > 20) {
          lines.push(`- ...and ${conflictFiles.length - 20} more`);
        }
        lines.push("");
      }

      lines.push(
        `## Resolution Steps`,
        "",
        `Run these commands to resolve the conflicts:`,
        "",
        "```bash",
        `# Step 1: Fetch the latest from remote`,
        `git fetch origin`,
        "",
        `# Step 2: Rebase your branch onto the latest base`,
        `git rebase origin/${defaultBranch}`,
        "```",
        "",
        `When conflicts appear during rebase:`,
        "",
        "```bash",
        `# Step 3: For each conflicting file, open it and resolve the conflict markers`,
        `# Look for <<<<<<< HEAD, =======, and >>>>>>> markers`,
        `# Keep the correct code, remove the markers`,
        "",
        `# Step 4: After resolving each file, stage it`,
        `git add <resolved-file>`,
        "",
        `# Step 5: Continue the rebase`,
        `git rebase --continue`,
        "",
        `# Repeat steps 3-5 for each conflict`,
        "```",
        "",
        `After all conflicts are resolved:`,
        "",
        "```bash",
        `# Step 6: Force push (safe — only overwrites your own branch)`,
        `git push origin ${branch} --force-with-lease`,
        "```",
        "",
        `**Rules:**`,
        `- Do NOT use \`git merge\` — always rebase to keep a linear history`,
        `- Do NOT use \`git push --force\` — always use \`--force-with-lease\``,
        `- Do NOT delete or skip commits — resolve every conflict`,
        `- After resolving, call **check_conflicts** again to verify`,
        `- When clean, call **verify_and_submit** to continue`,
      );

      return mcpText(lines.join("\n"));
    }
  );
}

// ── Helper ──────────────────────────────────────────────────────────────

function buildSimplePRBody(
  task: { jiraKey: string; title: string; repo?: string | null; epicKey?: string | null },
  template: string | null
): string {
  if (template) {
    let body = template;
    if (!body.includes(task.jiraKey)) {
      body += `\n\n**Ticket:** ${task.jiraKey}`;
    }
    body += `\n\n---\n*Automated by CoolPlugz*`;
    return body;
  }

  return [
    `## Summary`,
    task.title,
    "",
    `## Ticket`,
    task.jiraKey + (task.epicKey ? ` (Epic: ${task.epicKey})` : ""),
    "",
    `## Checklist`,
    "- [x] Code changes implemented",
    "- [x] Files committed to branch",
    "- [ ] CI passing",
    "- [ ] Code review approved",
    "",
    "---",
    "*Automated by CoolPlugz*",
  ].join("\n");
}
