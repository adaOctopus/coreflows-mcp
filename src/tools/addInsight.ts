import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as store from "../store";
import { mcpText } from "../lib/response";

export function registerAddInsightTool(server: McpServer) {
  (server as any).tool(
    "add_insight",
    "Add a custom instruction that CoolPlugz will include in every future CRISPE prompt. Use 'global' scope for instructions that apply to all tasks (e.g. 'always use pnpm, never npm'), or 'task' scope for a specific ticket. These appear in the [D] Developer Insights section of the prompt.",
    {
      text: z.string().describe("The instruction text, e.g. 'This repo uses pnpm — never use npm or yarn'"),
      scope: z.enum(["global", "task"]).describe("'global' applies to all tasks, 'task' applies to one specific ticket"),
      jiraKey: z.string().optional().describe("Required when scope is 'task' — the Jira ticket key this insight applies to"),
    },
    async ({ text, scope, jiraKey }: { text: string; scope: "global" | "task"; jiraKey?: string }) => {
      if (scope === "task" && !jiraKey) {
        return mcpText("❌ When scope is 'task', you must provide a jiraKey.");
      }

      let taskId: string | undefined;
      if (scope === "task" && jiraKey) {
        const task = store.findTaskByJiraKey(jiraKey);
        if (task) taskId = task.id;
      }

      const insight = store.addInsight(scope, text, taskId);

      const allInsights = store.getInsights(taskId);
      const lines = [
        `✅ Insight added (${scope}): "${text}"`,
        "",
        `**Active insights (${allInsights.length}):**`,
        ...allInsights.map((i) => `- ${i.scope === "global" ? "[GLOBAL]" : "[TASK]"} ${i.text}`),
        "",
        "These will be included in the [D] section of every future CRISPE prompt.",
      ];

      return mcpText(lines.join("\n"));
    }
  );
}
