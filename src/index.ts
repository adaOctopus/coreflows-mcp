import "dotenv/config";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { registerStartTaskTool, registerVerifyAndSubmitTool, registerCheckCommentsTool, registerCompleteTaskTool, registerGetTaskStateTool, registerCheckConflictsTool } from "./tools/orchestrator";
import { registerPushBranchTool } from "./tools/pushBranch";
import { registerGetDashboardTool } from "./tools/getDashboard";
import { registerAddInsightTool } from "./tools/addInsight";
import { registerMorningReportTool, registerLogRunTool } from "./tools/morningReport";

const server = new McpServer({ name: "coolplugz", version: "1.0.0" });

// Register all MCP tools
registerStartTaskTool(server);
registerVerifyAndSubmitTool(server);
registerCheckCommentsTool(server);
registerCompleteTaskTool(server);
registerGetTaskStateTool(server);
registerCheckConflictsTool(server);
registerPushBranchTool(server);
registerGetDashboardTool(server);
registerAddInsightTool(server);
registerMorningReportTool(server);
registerLogRunTool(server);

const app = express();
app.use(express.json());

app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));

const PORT = Number(process.env.PORT ?? 3100);
app.listen(PORT, () => {
  console.log(`CoolPlugz Core MCP server listening on :${PORT}`);
  console.log(`   Add to Claude Code: claude mcp add coolplugz --transport http http://localhost:${PORT}/mcp`);
});
