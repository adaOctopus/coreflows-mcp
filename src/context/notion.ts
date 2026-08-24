import { getNotionToken } from "../config";
import * as store from "../store";

export interface NotionFetchResult {
  status: "synced" | "stale" | "error";
  summary?: string;
}

async function notionApi(path: string, token: string, method = "GET", body?: string): Promise<any> {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": "2022-06-28",
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body } : {}),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

export async function fetchNotionContext(taskId: string, notionPageIds?: string[]): Promise<NotionFetchResult> {
  const token = getNotionToken();
  if (!token) return { status: "stale" };

  const task = store.findTaskById(taskId);
  if (!task) return { status: "error" };

  const jiraSnapshot = store.getSnapshotBySource(taskId, "jira");

  let pageIds = notionPageIds || [];
  if (pageIds.length === 0) {
    if (jiraSnapshot?.summary) {
      const notionUrlMatches = jiraSnapshot.summary.match(/notion\.so\/[^\s)]+/g);
      if (notionUrlMatches) {
        pageIds = notionUrlMatches.map((url: string) => {
          const parts = url.split(/[-/]/);
          return parts[parts.length - 1].replace(/[^a-f0-9]/gi, "");
        }).filter((id: string) => id.length >= 32);
      }
    }

    if (pageIds.length === 0 && task.jiraKey) {
      const searchQueries = [task.jiraKey];
      const titleWords = (task.title || "").split(/\s+/).filter((w: string) => w.length > 4);
      if (titleWords.length >= 2) {
        searchQueries.push(titleWords.slice(0, 3).join(" "));
      }

      for (const query of searchQueries) {
        try {
          const data = await notionApi("/search", token, "POST", JSON.stringify({ query, page_size: 5 }));
          const results = (data.results || [])
            .filter((r: any) => r.object === "page")
            .slice(0, 3)
            .map((r: any) => r.id);
          for (const id of results) {
            if (!pageIds.includes(id)) pageIds.push(id);
          }
        } catch {
          // Search failed — non-critical
        }
        if (pageIds.length >= 3) break;
      }
    }
  }

  if (pageIds.length === 0) {
    store.upsertSnapshot(
      `notion-${taskId}`,
      taskId,
      "notion",
      "No linked Notion docs found",
    );
    return { status: "synced", summary: "No linked Notion docs found" };
  }

  try {
    const docSummaries: string[] = [];

    for (const pageId of pageIds.slice(0, 3)) {
      try {
        const page = await notionApi(`/pages/${pageId}`, token);
        const title = extractPageTitle(page);
        const url = page.url || "";

        const blocks = await notionApi(`/blocks/${pageId}/children?page_size=100`, token);
        const content = extractBlockText(blocks.results || []);

        const lines = [`Doc: ${title} (${url})`];

        const purposeLine = content.split("\n").find((l: string) => l.trim().length > 0);
        lines.push(`Purpose: ${purposeLine?.slice(0, 100) || "Not stated"}`);

        const decisions = content
          .split("\n")
          .filter((l: string) => /decision|decided|agreed|must|shall|constraint/i.test(l))
          .slice(0, 5);
        if (decisions.length > 0) {
          lines.push("Decisions/constraints:");
          decisions.forEach((d) => lines.push(`  - ${d.trim().slice(0, 120)}`));
        }

        const undecided = content
          .split("\n")
          .filter((l: string) => /TBD|undecided|open question|TODO|to be decided/i.test(l))
          .slice(0, 3);
        if (undecided.length > 0) {
          lines.push("Open/undecided:");
          undecided.forEach((u) => lines.push(`  - ${u.trim().slice(0, 120)}`));
        } else {
          lines.push("Open/undecided: none noted");
        }

        docSummaries.push(lines.join("\n"));
      } catch (err: any) {
        console.error(`[notion] Error fetching page ${pageId}:`, err.message);
      }
    }

    const summary = docSummaries.join("\n\n");

    let conflictNote = "";
    if (jiraSnapshot?.summary) {
      const jiraAC = jiraSnapshot.summary
        .split("\n")
        .filter((l: string) => l.startsWith("  - "))
        .map((l: string) => l.trim().replace(/^- /, ""));

      if (jiraAC.length > 0 && summary.includes("Decisions")) {
        conflictNote = "\n\n⚠ Review Notion decisions against Jira AC for potential conflicts — both sources included verbatim.";
      }
    }

    const fullSummary = summary + conflictNote;

    store.upsertSnapshot(
      `notion-${taskId}`,
      taskId,
      "notion",
      fullSummary,
    );

    return { status: "synced", summary: fullSummary };
  } catch (err: any) {
    console.error(`[notion] Error:`, err.message);
    return { status: "error" };
  }
}

function extractPageTitle(page: any): string {
  const props = page.properties || {};
  for (const key of Object.keys(props)) {
    const prop = props[key];
    if (prop.type === "title" && prop.title?.length > 0) {
      return prop.title.map((t: any) => t.plain_text || "").join("");
    }
  }
  return "Untitled";
}

function extractBlockText(blocks: any[]): string {
  return blocks
    .map((block) => {
      const type = block.type;
      const content = block[type];
      if (!content) return "";
      if (content.rich_text) {
        return content.rich_text.map((t: any) => t.plain_text || "").join("");
      }
      if (content.text) {
        return content.text.map((t: any) => t.plain_text || "").join("");
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}
