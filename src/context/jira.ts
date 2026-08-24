import { getJiraConfig } from "../config";
import * as store from "../store";

export interface JiraFetchResult {
  status: "synced" | "stale" | "error";
  summary?: string;
}

function basicAuth(email: string, apiToken: string): string {
  return Buffer.from(`${email}:${apiToken}`).toString("base64");
}

async function jiraApi(baseUrl: string, path: string, auth: string): Promise<any> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jira API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

export async function fetchJiraContext(jiraKey: string, taskId: string): Promise<JiraFetchResult> {
  const config = getJiraConfig();
  if (!config) return { status: "stale" };

  const auth = basicAuth(config.email, config.apiToken);

  try {
    const issue = await jiraApi(config.baseUrl, `/rest/api/3/issue/${jiraKey}?expand=renderedFields`, auth);
    const fields = issue.fields;

    const title = fields.summary || jiraKey;
    const jiraStatus = fields.status?.name || "Unknown";

    // Extract FULL description text — not just list items
    let fullDescription = "";
    if (fields.description?.content) {
      fullDescription = extractTextFromAdf(fields.description.content).trim();
    }

    // Also try to extract structured acceptance criteria (bullet/numbered items)
    let ac: string[] = [];
    if (fullDescription) {
      ac = fullDescription
        .split("\n")
        .filter((line: string) => line.trim().startsWith("-") || line.trim().startsWith("*") || /^\d+\./.test(line.trim()))
        .map((line: string) => line.replace(/^[\s\-\*\d.]+/, "").trim())
        .filter(Boolean);
    }

    let epicKey = "";
    let epicGoal = "";
    if (fields.parent) {
      try {
        const parent = await jiraApi(config.baseUrl, `/rest/api/3/issue/${fields.parent.key}?fields=summary`, auth);
        epicKey = parent.key;
        epicGoal = parent.fields.summary || "";
      } catch {
        epicKey = fields.parent.key;
      }
    }

    // Fetch ALL comments (up to 20), not just last 24h
    let allComments: string[] = [];
    try {
      const comments = await jiraApi(config.baseUrl, `/rest/api/3/issue/${jiraKey}/comment?orderBy=-created&maxResults=20`, auth);
      allComments = (comments.comments || [])
        .map((c: any) => {
          const author = c.author?.displayName || "Unknown";
          const text = c.body?.content ? extractTextFromAdf(c.body.content) : "";
          const date = new Date(c.created).toISOString().split("T")[0];
          return `[${date}] ${author}: ${text.slice(0, 500)}`;
        })
        .filter((c: string) => c.length > 15); // skip empty/trivial comments
    } catch {
      // Comments fetch non-critical
    }

    const lines = [
      `Ticket: ${jiraKey} — ${title}`,
      `Status: ${jiraStatus}`,
    ];
    if (epicKey) lines.push(`Epic: ${epicKey} — ${epicGoal}`);

    // Always include full description
    if (fullDescription) {
      lines.push("", "Description:", fullDescription);
    }

    if (ac.length > 0) {
      lines.push("", "Acceptance criteria:");
      ac.forEach((c) => lines.push(`  - ${c}`));
    } else {
      lines.push("", "Acceptance criteria: none specified as bullet points — see description above for context");
    }

    if (allComments.length > 0) {
      lines.push("", `Comments (${allComments.length}):`);
      allComments.forEach((c) => lines.push(`  ${c}`));
    }

    const summary = lines.join("\n");

    // Extract GitHub repo references from description + comments — overrides default mapping
    const allText = fullDescription + "\n" + allComments.join("\n");
    const repoMatches = [...allText.matchAll(/github\.com\/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)/g)];
    const extractedRepos = [...new Set(
      repoMatches
        .map((m) => m[1].replace(/\.git$/, "").replace(/\/(?:pull|issues|tree|blob|compare|commit|releases).*$/, ""))
        .filter((r) => !r.includes(".."))
    )];

    // Also look for owner/repo patterns in plain text (e.g. "Consensys/skills")
    const plainRepoMatches = [...allText.matchAll(/\b([A-Za-z0-9_.-]+\/[A-Za-z][A-Za-z0-9_.-]{1,99})\b/g)];
    for (const m of plainRepoMatches) {
      const candidate = m[1];
      // Filter out obvious non-repos (paths like src/controllers, dates like 2026/08)
      if (/^\d/.test(candidate)) continue;
      if (/^(src|lib|dist|node_modules|\.github|test|spec|docs)\//.test(candidate)) continue;
      if (candidate.split("/").some((p) => p.length > 100)) continue;
      // Only add if it looks like an org/repo (both parts are plausible)
      const [org, repo] = candidate.split("/");
      if (org && repo && org.length >= 2 && repo.length >= 2 && /^[A-Za-z]/.test(org)) {
        extractedRepos.push(candidate);
      }
    }

    const updateData: Partial<store.Task> = { title, epicKey: epicKey || undefined };

    // If the ticket description explicitly mentions repos, override the task's repo
    if (extractedRepos.length > 0) {
      const uniqueRepos = [...new Set(extractedRepos)];
      updateData.repo = uniqueRepos[0];
      updateData.repos = uniqueRepos;
      console.log(`[jira] ${jiraKey}: description mentions repo(s): ${uniqueRepos.join(", ")} — overriding task repo`);
    }

    store.updateTask(taskId, updateData);

    store.upsertSnapshot(
      `jira-${taskId}`,
      taskId,
      "jira",
      summary,
      `${config.baseUrl}/browse/${jiraKey}`,
    );

    return { status: "synced", summary };
  } catch (err: any) {
    console.error(`[jira] Error fetching ${jiraKey}:`, err.message);
    return { status: "error" };
  }
}

function extractTextFromAdf(nodes: any[]): string {
  let text = "";
  for (const node of nodes) {
    if (node.type === "text") {
      text += node.text || "";
    } else if (node.type === "hardBreak") {
      text += "\n";
    } else if (node.type === "paragraph") {
      text += extractTextFromAdf(node.content || []) + "\n";
    } else if (node.type === "bulletList" || node.type === "orderedList") {
      for (const item of node.content || []) {
        text += "- " + extractTextFromAdf(item.content || []).trim() + "\n";
      }
    } else if (node.type === "heading") {
      text += extractTextFromAdf(node.content || []) + "\n";
    } else if (node.type === "codeBlock") {
      text += "```\n" + (node.content ? extractTextFromAdf(node.content) : "") + "```\n";
    } else if (node.type === "inlineCard" || node.type === "blockCard") {
      // Jira smart links — extract the URL
      const url = node.attrs?.url || "";
      if (url) text += url + " ";
    } else if (node.type === "mention") {
      text += "@" + (node.attrs?.text || "someone") + " ";
    } else if (node.type === "table") {
      // Extract table content row by row
      for (const row of node.content || []) {
        const cells = (row.content || []).map((cell: any) =>
          extractTextFromAdf(cell.content || []).trim()
        );
        text += cells.join(" | ") + "\n";
      }
    } else if (node.content) {
      text += extractTextFromAdf(node.content);
    }
  }
  return text;
}
