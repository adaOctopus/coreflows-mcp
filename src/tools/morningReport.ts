import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as store from "../store";
import { mcpText } from "../lib/response";

function timeAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatDuration(startIso: string, endIso: string): string {
  const diff = new Date(endIso).getTime() - new Date(startIso).getTime();
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return "<1 min";
  return `${mins} min`;
}

function formatDate(isoDate: string): string {
  const d = new Date(isoDate);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatTime(isoDate: string): string {
  const d = new Date(isoDate);
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true }).toUpperCase();
}

function buildReport(
  mode: "latest" | "today" | "full",
  slackChannels: string[]
): string {
  const tasks = store.getAllTasks();
  const now = new Date();

  // Determine which tasks to report on based on mode
  let reportTasks: store.Task[];
  let reportTitle: string;
  let runInfo = "";

  if (mode === "latest") {
    const latestRun = store.getLatestRun();
    if (latestRun && latestRun.finishedAt && latestRun.taskResults.length > 0) {
      reportTitle = `CORE MCP — ${latestRun.trigger.toUpperCase()} REPORT`;
      runInfo = `${formatTime(latestRun.startedAt)} RUN  ·  ${formatDate(latestRun.startedAt)}  ·  COMPLETED IN ${formatDuration(latestRun.startedAt, latestRun.finishedAt)}`;

      // Use run's task results for the report
      const lines = buildFromRunRecord(latestRun, slackChannels);
      return lines;
    }
    // Fall through to task-based report if no run records
    reportTasks = tasks;
    reportTitle = "CORE MCP — STATUS REPORT";
    runInfo = `GENERATED  ·  ${formatDate(now.toISOString())}  ·  ${formatTime(now.toISOString())}`;
  } else if (mode === "today") {
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    reportTasks = tasks.filter((t) => t.updatedAt >= todayStart);
    reportTitle = "CORE MCP — TODAY'S REPORT";
    runInfo = `${formatDate(now.toISOString())}  ·  ${formatTime(now.toISOString())}`;
  } else {
    reportTasks = tasks;
    reportTitle = "CORE MCP — FULL REPORT";
    runInfo = `${formatDate(now.toISOString())}  ·  ${formatTime(now.toISOString())}`;
  }

  return buildFromTasks(reportTitle, runInfo, reportTasks, slackChannels);
}

function buildFromRunRecord(run: store.RunRecord, slackChannels: string[]): string {
  const results = run.taskResults;
  const done = results.filter((r) => r.status === "DONE");
  const blocked = results.filter((r) => r.status === "BLOCKED");
  const ciRetries = results.reduce((sum, r) => sum + r.ciRetries, 0);
  const prsOpened = results.filter((r) => r.prUrl).length;

  const lines: string[] = [];

  // Header
  lines.push(`╔══════════════════════════════════════════════════════════════╗`);
  lines.push(`║  CORE MCP — ${run.trigger.toUpperCase()} REPORT`);
  lines.push(`║  ${formatTime(run.startedAt)} RUN  ·  ${formatDate(run.startedAt)}  ·  COMPLETED IN ${formatDuration(run.startedAt, run.finishedAt!)}`);
  lines.push(`╚══════════════════════════════════════════════════════════════╝`);
  lines.push("");

  // Stats bar
  lines.push(`┌──────────┬──────────┬──────────┬──────────┐`);
  lines.push(`│ ✅ ${String(done.length).padEnd(5)} │ 🔗 ${String(prsOpened).padEnd(5)} │ 🔄 ${String(ciRetries).padEnd(5)} │ 🚫 ${String(blocked.length).padEnd(5)} │`);
  lines.push(`│ DONE     │ PRS      │ RETRIES  │ BLOCKED  │`);
  lines.push(`└──────────┴──────────┴──────────┴──────────┘`);
  lines.push("");

  // Completed tasks
  if (done.length > 0) {
    lines.push(`── COMPLETED TASKS ──────────────────────────────────────────`);
    lines.push("");
    for (const r of done) {
      lines.push(`  ✅ ${r.jiraKey}  ${r.title}`);
      const prInfo = r.prNumber ? `PR #${r.prNumber}` : "PR";
      const repoInfo = r.repo || "unknown";
      const retryInfo = r.ciRetries > 0 ? `  (${r.ciRetries} CI retry)` : "";
      lines.push(`     ${prInfo} → ${repoInfo}  CI passed${retryInfo}`);
      lines.push("");
    }
  }

  // Blocked tasks
  if (blocked.length > 0) {
    lines.push(`── BLOCKED ──────────────────────────────────────────────────`);
    lines.push("");
    for (const r of blocked) {
      lines.push(`  🚫 ${r.jiraKey}  ${r.title}`);
      lines.push(`     ${r.error || "Unknown error"}`);
      lines.push("");
    }
  }

  // Slack drafts from run record
  if (run.slackDrafts.length > 0) {
    lines.push(`── SLACK DRAFT UPDATES ──────────────────────────────────────`);
    lines.push("");
    for (const draft of run.slackDrafts) {
      lines.push(`  ┌─ ${draft.channel} ──────────────────────────────`);
      for (const line of draft.message.split("\n")) {
        lines.push(`  │ ${line}`);
      }
      lines.push(`  └────────────────────────────────────────────────`);
      lines.push("");
    }
  } else if (slackChannels.length > 0 && done.length > 0) {
    // Generate slack drafts dynamically
    lines.push(`── SLACK DRAFT UPDATES ──────────────────────────────────────`);
    lines.push("");
    lines.push(...generateSlackDrafts(done, blocked, slackChannels));
  }

  // Next run
  lines.push(`─────────────────────────────────────────────────────────────`);
  lines.push(`  NEXT SCHEDULED RUN: check your /schedule configuration`);

  return lines.join("\n");
}

function buildFromTasks(
  title: string,
  subtitle: string,
  tasks: store.Task[],
  slackChannels: string[]
): string {
  const done = tasks.filter((t) => t.status === "DONE");
  const active = tasks.filter((t) => !["DONE", "BLOCKED"].includes(t.status));
  const blocked = tasks.filter((t) => t.status === "BLOCKED");
  const prsOpened = tasks.filter((t) => t.prUrl).length;
  const ciRetries = tasks.reduce((sum, t) => sum + t.retryCount, 0);

  const lines: string[] = [];

  // Header
  lines.push(`╔══════════════════════════════════════════════════════════════╗`);
  lines.push(`║  ${title}`);
  lines.push(`║  ${subtitle}`);
  lines.push(`╚══════════════════════════════════════════════════════════════╝`);
  lines.push("");

  // Stats bar
  lines.push(`┌──────────┬──────────┬──────────┬──────────┐`);
  lines.push(`│ ✅ ${String(done.length).padEnd(5)} │ 🔗 ${String(prsOpened).padEnd(5)} │ 🔄 ${String(ciRetries).padEnd(5)} │ 🚫 ${String(blocked.length).padEnd(5)} │`);
  lines.push(`│ DONE     │ PRS      │ RETRIES  │ BLOCKED  │`);
  lines.push(`└──────────┴──────────┴──────────┴──────────┘`);
  lines.push("");

  // Completed tasks
  if (done.length > 0) {
    lines.push(`── COMPLETED TASKS ──────────────────────────────────────────`);
    lines.push("");
    for (const t of done) {
      lines.push(`  ✅ ${t.jiraKey}  ${t.title}`);
      const prInfo = t.prNumber ? `PR #${t.prNumber}` : (t.prUrl ? "PR" : "no PR");
      const repoInfo = t.repo || "unknown";
      const retryInfo = t.retryCount > 0 ? `  (${t.retryCount} CI retry)` : "";
      lines.push(`     ${prInfo} → ${repoInfo}  CI passed${retryInfo}`);
      lines.push("");
    }
  }

  // Active tasks
  if (active.length > 0) {
    lines.push(`── IN PROGRESS ──────────────────────────────────────────────`);
    lines.push("");
    for (const t of active) {
      const icon = t.status === "EXECUTING" ? "🔨" : t.status === "CI_RUNNING" ? "⏳" : "📋";
      lines.push(`  ${icon} ${t.jiraKey}  ${t.title}`);
      lines.push(`     Status: ${t.status}  ·  Updated ${timeAgo(t.updatedAt)}`);
      lines.push("");
    }
  }

  // Blocked tasks
  if (blocked.length > 0) {
    lines.push(`── BLOCKED ──────────────────────────────────────────────────`);
    lines.push("");
    for (const t of blocked) {
      lines.push(`  🚫 ${t.jiraKey}  ${t.title}`);
      lines.push(`     ${t.lastError || "Unknown error"}`);
      lines.push("");
    }
  }

  // Slack drafts
  if (slackChannels.length > 0 && done.length > 0) {
    lines.push(`── SLACK DRAFT UPDATES ──────────────────────────────────────`);
    lines.push("");

    const taskResults = done.map((t) => ({
      jiraKey: t.jiraKey,
      title: t.title,
      status: t.status,
      repo: t.repo,
      prUrl: t.prUrl,
      prNumber: t.prNumber,
      ciRetries: t.retryCount,
      error: t.lastError,
    }));

    lines.push(...generateSlackDrafts(taskResults, blocked.map((t) => ({
      jiraKey: t.jiraKey,
      title: t.title,
      status: t.status,
      repo: t.repo,
      prUrl: t.prUrl,
      prNumber: t.prNumber,
      ciRetries: t.retryCount,
      error: t.lastError,
    })), slackChannels));
  }

  // Empty state
  if (done.length === 0 && active.length === 0 && blocked.length === 0) {
    lines.push("  No tasks found. Run start_task with a Jira key to begin.");
    lines.push("");
  }

  return lines.join("\n");
}

function generateSlackDrafts(
  done: Array<{ jiraKey: string; title: string; prNumber: number | null; repo: string | null; ciRetries: number }>,
  blocked: Array<{ jiraKey: string; title: string; error: string | null }>,
  channels: string[]
): string[] {
  const lines: string[] = [];

  // Standup channel — always generate if present
  const standupChannel = channels.find((c) => c.includes("standup")) || channels[0];
  if (standupChannel) {
    const standupLines: string[] = [];
    standupLines.push("Overnight update:");
    for (const t of done) {
      const pr = t.prNumber ? `PR #${t.prNumber}` : "PR";
      const retry = t.ciRetries > 0 ? " (CI fixed on retry)" : "";
      standupLines.push(`✅ ${t.jiraKey} ${t.title} — ${pr} ready for review${retry}`);
    }
    for (const t of blocked) {
      standupLines.push(`🚫 ${t.jiraKey} ${t.title} — ${t.error || "blocked"}`);
    }
    if (blocked.length === 0) {
      standupLines.push("All PRs green. Nothing blocked.");
    }

    lines.push(`  ┌─ #${standupChannel} ──────────────────────────────`);
    for (const l of standupLines) {
      lines.push(`  │ ${l}`);
    }
    lines.push(`  └────────────────────────────────────────────────`);
    lines.push("");
  }

  // Group tasks by repo for team-specific channels
  const byRepo: Record<string, typeof done> = {};
  for (const t of done) {
    const repo = t.repo || "unknown";
    if (!byRepo[repo]) byRepo[repo] = [];
    byRepo[repo].push(t);
  }

  // Generate per-repo drafts for remaining channels
  const remainingChannels = channels.filter((c) => c !== standupChannel);
  const repos = Object.keys(byRepo);
  for (let i = 0; i < Math.min(remainingChannels.length, repos.length); i++) {
    const channel = remainingChannels[i];
    const repo = repos[i];
    const repoTasks = byRepo[repo];
    const repoShort = repo.split("/")[1] || repo;

    const draftLines: string[] = [];
    if (repoTasks.length === 1) {
      const t = repoTasks[0];
      const pr = t.prNumber ? `PR #${t.prNumber}` : "PR";
      draftLines.push(`${t.title} landed in ${pr}.`);
    } else {
      draftLines.push(`${repoTasks.length} PRs landed overnight on ${repoShort}:`);
      for (const t of repoTasks) {
        const pr = t.prNumber ? `PR #${t.prNumber}` : "PR";
        draftLines.push(`• ${pr} — ${t.title}`);
      }
    }
    draftLines.push("Passing CI — ready for review when you are.");

    lines.push(`  ┌─ #${channel} ──────────────────────────────`);
    for (const l of draftLines) {
      lines.push(`  │ ${l}`);
    }
    lines.push(`  └────────────────────────────────────────────────`);
    lines.push("");
  }

  return lines;
}

export function registerMorningReportTool(server: McpServer) {
  (server as any).tool(
    "morning_report",
    "Generate a status report showing completed tasks, PRs, CI results, and Slack draft messages. Call this after a scheduled run completes, or anytime to see current status. Returns a formatted terminal-style report. Provide Slack channel names to get draft messages for each channel.",
    {
      mode: z.enum(["latest", "today", "full"]).default("latest").describe(
        "'latest' shows the most recent run's results, 'today' shows all tasks updated today, 'full' shows everything"
      ),
      slack_channels: z.array(z.string()).default(["standup"]).describe(
        "Slack channel names to generate draft messages for, e.g. ['standup', 'engineering', 'defi-team']"
      ),
    },
    async ({ mode, slack_channels }: { mode: "latest" | "today" | "full"; slack_channels: string[] }) => {
      const report = buildReport(mode, slack_channels);
      return mcpText(report);
    }
  );
}

export function registerLogRunTool(server: McpServer) {
  (server as any).tool(
    "log_run",
    "Log the start or completion of an automated run. Call with action 'start' before processing tasks, and 'finish' after all tasks are done. This powers the morning_report tool with real data from each run.",
    {
      action: z.enum(["start", "finish"]).describe("'start' begins tracking a new run, 'finish' completes it"),
      trigger: z.string().default("manual").describe("What triggered this run: 'morning', 'midday', 'evening', 'manual'"),
      run_id: z.string().optional().describe("Required for 'finish' — the run ID returned by 'start'"),
      task_results: z.array(z.object({
        jiraKey: z.string(),
        title: z.string(),
        status: z.string(),
        repo: z.string().nullable().optional(),
        prUrl: z.string().nullable().optional(),
        prNumber: z.number().nullable().optional(),
        ciRetries: z.number().default(0),
        error: z.string().nullable().optional(),
      })).optional().describe("Task results — required for 'finish'"),
      slack_drafts: z.array(z.object({
        channel: z.string(),
        message: z.string(),
      })).optional().describe("Slack draft messages generated during the run"),
    },
    async ({ action, trigger, run_id, task_results, slack_drafts }: {
      action: "start" | "finish";
      trigger: string;
      run_id?: string;
      task_results?: store.RunRecord["taskResults"];
      slack_drafts?: store.RunRecord["slackDrafts"];
    }) => {
      if (action === "start") {
        const run = store.startRun(trigger);
        return mcpText([
          `🏁 Run started: ${run.id}`,
          `Trigger: ${trigger}`,
          `Started at: ${formatTime(run.startedAt)}`,
          "",
          "When you finish processing tasks, call log_run with action 'finish' and this run_id to record results.",
        ].join("\n"));
      }

      if (!run_id) {
        return mcpText("❌ run_id is required for 'finish' action. Use the ID returned by 'start'.");
      }

      const run = store.finishRun(run_id, task_results || [], slack_drafts || []);
      if (!run) {
        return mcpText(`❌ Run ${run_id} not found.`);
      }

      const done = (task_results || []).filter((r) => r.status === "DONE").length;
      const blocked = (task_results || []).filter((r) => r.status === "BLOCKED").length;

      return mcpText([
        `✅ Run ${run_id} completed`,
        `Duration: ${formatDuration(run.startedAt, run.finishedAt!)}`,
        `Tasks done: ${done}  |  Blocked: ${blocked}  |  Slack drafts: ${(slack_drafts || []).length}`,
        "",
        "Call morning_report to see the formatted status report.",
      ].join("\n"));
    }
  );
}
