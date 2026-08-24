import { getGithubToken } from "../config";
import { findBranchByJiraKey, getPRReviewComments } from "../orchestrator/githubApi";
import * as store from "../store";

export interface GithubFetchResult {
  status: "synced" | "stale" | "error";
  existingBranch?: string;
  existingPrNumber?: number;
  ciState?: "pending⏳" | "success✅" | "fail🚨";
}

async function ghApi(path: string, token: string): Promise<any> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

export async function fetchGithubState(taskId?: string): Promise<GithubFetchResult> {
  let token: string;
  try {
    token = getGithubToken();
  } catch {
    return { status: "stale" };
  }

  const tasks = taskId
    ? [store.findTaskById(taskId)]
    : store.getAllTasks().filter((t) => t.status !== "DONE" && t.status !== "BLOCKED");

  for (const task of tasks) {
    if (!task || !task.repo) continue;

    try {
      const [owner, repo] = task.repo.split("/");
      const result: GithubFetchResult = { status: "synced" };

      if (task.branch) {
        try {
          await ghApi(`/repos/${owner}/${repo}/branches/${task.branch}`, token);
          result.existingBranch = task.branch;
        } catch {
          // Branch doesn't exist yet
        }
      }

      if (task.prNumber) {
        try {
          const pr = await ghApi(`/repos/${owner}/${repo}/pulls/${task.prNumber}`, token);
          result.existingPrNumber = pr.number;

          const checks = await ghApi(`/repos/${owner}/${repo}/commits/${pr.head.sha}/check-runs`, token);
          const runs: any[] = checks.check_runs || [];
          if (runs.length === 0) {
            result.ciState = "pending⏳";
          } else if (runs.every((r: any) => r.conclusion === "success")) {
            result.ciState = "success✅";
          } else if (runs.some((r: any) => r.conclusion === "failure" || r.conclusion === "cancelled")) {
            result.ciState = "fail🚨";
          } else {
            result.ciState = "pending⏳";
          }
        } catch {
          // PR doesn't exist
        }
      } else {
        // Search for existing PR by Jira key
        try {
          const prs = await ghApi(`/repos/${owner}/${repo}/pulls?state=open&per_page=100`, token);
          const match = (prs as any[]).find(
            (pr: any) => pr.head.ref.includes(task.jiraKey) || pr.head.ref.includes(task.jiraKey.toLowerCase())
          );
          if (match) {
            result.existingPrNumber = match.number;
            result.existingBranch = match.head.ref;

            store.updateTask(task.id, {
              prNumber: match.number,
              prUrl: match.html_url,
              branch: match.head.ref,
            });
          }
        } catch {
          // Search failed — non-critical
        }

        // No PR found — search for existing branch by Jira key + user activity
        if (!result.existingBranch) {
          try {
            const found = await findBranchByJiraKey(token, `${owner}/${repo}`, task.jiraKey);
            if (found) {
              result.existingBranch = found.branch;
              store.updateTask(task.id, { branch: found.branch });
              console.log(`[github] Found branch ${found.branch} for ${task.jiraKey} (user commits: ${found.hasUserCommits})`);
            }
          } catch {
            // Branch search failed — non-critical
          }
        }
      }

      // Fetch PR review comments and store as context
      let commentSummary = "";
      const prNum = result.existingPrNumber || task.prNumber;
      if (prNum) {
        try {
          const reviewData = await getPRReviewComments(token, `${owner}/${repo}`, prNum);
          const allComments = [...reviewData.reviews, ...reviewData.comments].filter(Boolean);
          if (allComments.length > 0) {
            commentSummary = allComments.join("\n");
            store.upsertSnapshot(
              `gh-comments-${task.id}`,
              task.id,
              "github-comments",
              commentSummary,
              task.prUrl || undefined,
            );
            console.log(`[github] Fetched ${allComments.length} PR comment(s) for ${task.jiraKey}`);
          }
        } catch {
          // Comment fetch failed — non-critical
        }
      }

      const summary = [
        result.existingBranch ? `Branch ${result.existingBranch} exists` : "No branch yet",
        result.existingPrNumber ? `PR #${result.existingPrNumber} open` : "No PR yet",
        result.ciState ? `CI: ${result.ciState}` : "",
        commentSummary ? `${commentSummary.split("\n").length} review comment(s)` : "",
      ]
        .filter(Boolean)
        .join(". ");

      store.upsertSnapshot(
        `gh-${task.id}`,
        task.id,
        "github",
        summary,
        task.prUrl || undefined,
      );

      return result;
    } catch (err: any) {
      console.error(`[github] Error fetching for ${task.jiraKey}:`, err.message);
      return { status: "error" };
    }
  }

  return { status: "stale" };
}
