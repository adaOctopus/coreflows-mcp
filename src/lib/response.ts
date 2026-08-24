import type { LoopMeta } from "./loopState";

/** Build an MCP text response */
export function mcpText(text: string): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text" as const, text }] };
}

/**
 * Loop-engineered MCP response — carries structured loop metadata
 * alongside the human-readable text. Claude Code reads _meta from
 * structuredContent to know: current state, goal state, what to call next.
 */
export function mcpLoop(text: string, loop: LoopMeta) {
  const nextSteps = loop.availableActions
    .sort((a, b) => a.priority - b.priority)
    .map((a) => `→ **${a.tool}**(${JSON.stringify(a.args)})${a.condition ? ` — ${a.condition}` : ""}`)
    .join("\n");

  const stateBar = `\n\n---\n📍 **State:** \`${loop.currentState}\` → 🎯 \`${loop.goalState}\``;
  const actionBlock = nextSteps
    ? `\n\n**Next action${loop.availableActions.length > 1 ? "s" : ""}:**\n${nextSteps}`
    : "";
  const recoveryBlock = loop.recovery
    ? `\n\n⚠️ **Recovery:** ${loop.recovery.error}\n→ Fix: **${loop.recovery.fix.tool}**(${JSON.stringify(loop.recovery.fix.args)})\n→ Then retry: **${loop.recovery.retryAfterFix.tool}**(${JSON.stringify(loop.recovery.retryAfterFix.args)})`
    : "";

  const fullText = text + stateBar + actionBlock + recoveryBlock;

  return {
    content: [{ type: "text" as const, text: fullText }],
    structuredContent: { loop },
    _meta: { loop },
  };
}
