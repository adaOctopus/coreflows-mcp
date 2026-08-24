import Anthropic from "@anthropic-ai/sdk";
import { getSlackToken } from "../config";
import * as store from "../store";

export interface SlackFetchResult {
  status: "synced" | "stale" | "error";
  mentionCount?: number;
}

async function slackApi(method: string, token: string, params?: Record<string, string>): Promise<any> {
  const url = new URL(`https://slack.com/api/${method}`);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Slack API ${res.status}`);
  const data: any = await res.json();
  if (!data.ok) throw new Error(`Slack error: ${data.error}`);
  return data;
}

export async function fetchSlackMentions(): Promise<SlackFetchResult> {
  const token = getSlackToken();
  if (!token) return { status: "stale" };

  try {
    const auth = await slackApi("auth.test", token);
    const slackUserId = auth.user_id;

    const query = `<@${slackUserId}>`;
    const searchResult = await slackApi("search.messages", token, {
      query,
      sort: "timestamp",
      sort_dir: "desc",
      count: "20",
    });

    const messages = searchResult.messages?.matches || [];

    const tasks = store.getAllTasks().filter((t) => t.status !== "DONE");

    const taskContext = tasks.map((t) => {
      let ctx = `${t.jiraKey}: "${t.title}" - status: ${t.status}`;
      if (t.prUrl) ctx += `, PR: ${t.prUrl}`;
      if (t.prNumber) ctx += ` (#${t.prNumber})`;
      if (t.branch) ctx += `, branch: ${t.branch}`;
      if (t.lastError) ctx += `, error: ${t.lastError.slice(0, 60)}`;
      return ctx;
    }).join("\n");

    let newMentions = 0;

    // Process recent mentions and correlate with active tasks
    const recentMentions: Array<{ channel: string; author: string; snippet: string }> = [];

    for (const msg of messages) {
      const msgTime = parseFloat(msg.ts) * 1000;
      if (Date.now() - msgTime > 24 * 60 * 60 * 1000) continue;

      const channel = msg.channel?.name || "unknown";
      const author = msg.username || msg.user || "unknown";
      const snippet = (msg.text || "").replace(/<@[A-Z0-9]+>/g, "@user").slice(0, 200);

      recentMentions.push({ channel, author, snippet });
      newMentions++;
    }

    // Correlate mentions with tasks and store as context snapshots
    for (const task of tasks) {
      const titleWords = task.title.toLowerCase().split(/\s+/).filter((w: string) => w.length > 3);
      const keyLower = task.jiraKey.toLowerCase();

      const relevant = recentMentions.filter((m) => {
        const text = `${m.snippet} ${m.channel}`.toLowerCase();
        if (text.includes(keyLower)) return true;
        const matchCount = titleWords.filter((w: string) => text.includes(w)).length;
        return matchCount >= 2 || (matchCount >= 1 && titleWords.length <= 3);
      });

      const summary = relevant.length > 0
        ? relevant.map((m) => `#${m.channel} - ${m.author}: ${m.snippet.slice(0, 80)}`).join("\n")
        : "";

      if (summary) {
        store.upsertSnapshot(
          `slack-${task.id}`,
          task.id,
          "slack",
          summary,
        );
      }
    }

    return { status: "synced", mentionCount: newMentions };
  } catch (err: any) {
    console.error(`[slack] Error fetching mentions:`, err.message);
    return { status: "error" };
  }
}

function needsResponse(message: string): boolean {
  const lower = message.toLowerCase();
  if (lower.includes("?")) return true;
  if (/can you|could you|please|let me know|thoughts|update|status|when|what do you|any update|how's|where are we/i.test(lower)) return true;
  if (/^(cc|fyi|for visibility|just sharing)/i.test(lower)) return false;
  return false;
}

export async function generateSmartDraft(
  author: string,
  channel: string,
  snippet: string,
  taskContext: string
): Promise<{ reply: string; confidence: "high" | "low" }> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { reply: fallbackDraft(snippet), confidence: "low" };
  }

  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const res = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 100,
      system: [
        "You write short Slack replies on behalf of a developer.",
        "RULES:",
        "- 15 to 40 words max. No exceptions.",
        "- Sound like a real human texting a coworker. Casual, direct.",
        "- No em dashes. No bullet points. No exclamation marks unless genuinely excited.",
        "- No AI patterns: no 'Great question!', no 'I'd be happy to', no 'Absolutely!'",
        "- Never start with 'Hey' or 'Hi' followed by their name.",
        "- If you know the actual status of a task/PR from the context, state the facts. Don't say 'will share an update' when you already have the update.",
        "- If you don't have relevant context, keep it honest and brief: 'Let me check on that' or 'Will get back to you on this'.",
        "- Match the energy of the message. Quick question gets a quick answer. Serious concern gets a straight response.",
        "- Output ONLY the reply text. Nothing else.",
      ].join("\n"),
      messages: [{
        role: "user",
        content: [
          `Slack message from ${author} in #${channel}:`,
          `"${snippet}"`,
          "",
          "Current task/PR context:",
          taskContext || "(no active tasks)",
          "",
          "Write a draft reply.",
        ].join("\n"),
      }],
    });

    const text = res.content[0]?.type === "text" ? res.content[0].text.trim() : "";
    if (text && text.length > 0 && text.length < 200) {
      return { reply: text, confidence: "high" };
    }
    return { reply: fallbackDraft(snippet), confidence: "low" };
  } catch (err: any) {
    console.error("[slack] Smart draft failed:", err.message);
    return { reply: fallbackDraft(snippet), confidence: "low" };
  }
}

function fallbackDraft(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("status") || lower.includes("update")) return "Working on it, will update you shortly.";
  if (lower.includes("review") || lower.includes("pr")) return "Taking a look now.";
  if (lower.includes("?")) return "Let me check on that and get back to you.";
  return "Noted, will follow up.";
}
