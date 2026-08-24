import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as store from "../store";
import { mcpText } from "../lib/response";

function summarizeTaskGroup(tasks: store.Task[]): string {
  const byProject: Record<string, store.Task[]> = {};
  for (const t of tasks) {
    const proj = t.jiraKey.split("-")[0];
    if (!byProject[proj]) byProject[proj] = [];
    byProject[proj].push(t);
  }
  const parts: string[] = [];
  for (const [proj, items] of Object.entries(byProject)) {
    if (items.length === 1) {
      parts.push(items[0].title.toLowerCase());
    } else {
      const titles = items.slice(0, 2).map((t) => t.title.toLowerCase());
      const suffix = items.length > 2 ? ` + ${items.length - 2} more` : "";
      parts.push(`${titles.join(", ")}${suffix} (${proj})`);
    }
  }
  return parts.join("; ");
}

export function registerGetDashboardTool(server: McpServer) {
  (server as any).tool(
    "get_dashboard",
    "ALWAYS call this tool when the user says: dashboard, show dashboard, my dashboard, show my dashboard, status, progress, tasks, show tasks, what's happening, overview, or any request to see their tasks/progress. Show the response text EXACTLY as returned.",
    {
      _unused: z.string().optional().describe("No arguments needed"),
    },
    async () => {
      const tasks = store.getAllTasks();
      const lines: string[] = ["# CoolPlugz — Task Overview", ""];

      const activeTasks = tasks.filter((t) => t.status !== "DONE");
      const completedTasks = tasks.filter((t) => t.status === "DONE");

      if (activeTasks.length > 0) {
        lines.push("## Active Tasks", "| Ticket | Title | Status | PR |", "|--------|-------|--------|----|");
        for (const t of activeTasks) {
          let pr = "—";
          if (t.prUrls?.length > 1) {
            pr = t.prUrls.map((url: string, i: number) => t.prNumbers[i] ? `PR #${t.prNumbers[i]}` : `PR`).join(", ");
          } else if (t.prUrl) {
            pr = t.prNumber ? `[PR #${t.prNumber}](${t.prUrl})` : `[PR](${t.prUrl})`;
          }
          lines.push(`| ${t.jiraKey} | ${t.title} | ${t.status} | ${pr} |`);
        }

        const blocked = activeTasks.filter((t) => t.status === "BLOCKED");
        if (blocked.length) {
          lines.push("", "## Blocked Tasks — Action Needed");
          for (const t of blocked) {
            lines.push(`- **${t.jiraKey}** (${t.title})`);
            if (t.lastError) lines.push(`  - Error: ${t.lastError}`);
            lines.push(`  - Retried ${t.retryCount || 0} times`);
          }
        }
      } else if (completedTasks.length === 0) {
        lines.push("No tasks yet. Call **start_task** with a Jira key to begin.");
      } else {
        lines.push("All tasks completed. Call **start_task** when new Jira tickets come in.");
      }

      if (completedTasks.length > 0) {
        lines.push("", `## Recently Completed (${completedTasks.length})`, "| Ticket | Title | PR |", "|--------|-------|----|");
        for (const t of completedTasks) {
          let pr = "—";
          if (t.prUrls?.length > 1) {
            pr = t.prUrls.map((url: string, i: number) => t.prNumbers[i] ? `PR #${t.prNumbers[i]}` : `PR`).join(", ");
          } else if (t.prUrl) {
            pr = t.prNumber ? `[PR #${t.prNumber}](${t.prUrl})` : `[PR](${t.prUrl})`;
          }
          lines.push(`| ${t.jiraKey} | ${t.title} | ${pr} |`);
        }
      }

      if (tasks.length > 0) {
        const done = tasks.filter((t) => t.status === "DONE");
        const inProg = tasks.filter((t) => ["QUEUED", "EXECUTING", "CI_RUNNING", "CONTEXT_SYNCING"].includes(t.status));
        const blockedTasks = tasks.filter((t) => t.status === "BLOCKED" || t.status === "CI_FAILED");
        const prs = done.filter((t) => t.prUrl);

        const summaryLines: string[] = [];
        if (done.length) {
          const doneDesc = summarizeTaskGroup(done);
          summaryLines.push(`Wrapped up ${doneDesc}${prs.length ? ` — ${prs.length} PR${prs.length > 1 ? "s" : ""} opened` : ""}.`);
        }
        if (inProg.length) {
          summaryLines.push(`Currently working on ${summarizeTaskGroup(inProg)}.`);
        }
        if (blockedTasks.length) {
          summaryLines.push(`${blockedTasks.length} task(s) blocked or failing CI.`);
        }

        if (summaryLines.length) {
          lines.push("", "## Summary", ...summaryLines);
        }
      }

      return mcpText(lines.join("\n"));
    }
  );
}
