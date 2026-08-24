import Anthropic from "@anthropic-ai/sdk";
import { getJiraConfig, getGithubToken, getNotionToken } from "../config";
import * as store from "../store";

const EXTRACTION_MODEL = "claude-haiku-4-5";

export interface RepoResolveResult {
  repos: string[];
  source: "jira" | "mapping" | "notion" | "github" | "none";
}

export async function resolveRepos(jiraKey: string): Promise<RepoResolveResult> {
  const project = jiraKey.split("-")[0];
  console.log(`[repo-resolver] Resolving repos for ${jiraKey} (project: ${project})`);

  // 1. ALWAYS check Jira ticket first — the ticket is the source of truth for which repo to use.
  //    This runs before saved mappings because tickets within the same project can target different repos.
  const jiraRepos = await extractReposFromJira(jiraKey);
  if (jiraRepos.length > 0) {
    console.log(`[repo-resolver] ✅ Found repo(s) in Jira ticket: ${jiraRepos.join(", ")}`);
    // Do NOT save as project-level mapping — different tickets in the same project can use different repos
    return { repos: jiraRepos, source: "jira" };
  }
  console.log(`[repo-resolver] Step 1: No GitHub URLs found in Jira ticket ${jiraKey}`);

  // 2. Check saved mapping (only used as fallback when ticket doesn't specify a repo)
  const mapping = store.getRepoMapping(project);
  if (mapping) {
    console.log(`[repo-resolver] ✅ Fallback to saved mapping: ${project} → ${mapping.repo}`);
    return { repos: [mapping.repo], source: "mapping" };
  }
  console.log(`[repo-resolver] Step 2: No saved mapping for ${project}`);

  // 3. Fuzzy match: extract short repo names from ticket text and match against user's GitHub repos
  const fuzzyRepo = await fuzzyMatchRepoFromTicket(jiraKey);
  if (fuzzyRepo) {
    console.log(`[repo-resolver] ✅ Fuzzy matched repo: ${fuzzyRepo}`);
    // Do NOT auto-save fuzzy matches as project-level mappings — they are guesses
    return { repos: [fuzzyRepo], source: "github" };
  }
  console.log(`[repo-resolver] Step 3: No fuzzy match from ticket text`);

  // 4. Search Notion for repo references related to this project
  const notionRepo = await searchNotionForRepo(project);
  if (notionRepo) {
    console.log(`[repo-resolver] ✅ Found repo in Notion: ${notionRepo}`);
    return { repos: [notionRepo], source: "notion" };
  }
  console.log(`[repo-resolver] Step 4: No repo found in Notion`);

  // 5. NO single-repo fallback — do not guess. If we can't find the repo, say so.
  //    The user will link it explicitly via set_repo.
  console.log(`[repo-resolver] ❌ All strategies failed for ${jiraKey} — no repo found. User must link via set_repo.`);

  return { repos: [], source: "none" };
}

// Backward-compatible wrapper — does NOT auto-save mappings
export async function resolveRepo(jiraKey: string): Promise<{ repo: string | null; source: string }> {
  const result = await resolveRepos(jiraKey);
  return { repo: result.repos[0] || null, source: result.source };
}

// Only save a mapping when the USER explicitly sets it
// Never auto-save from fuzzy matches, single-repo fallbacks, or Jira extraction
export function saveMapping(jiraProject: string, repo: string, source: string) {
  store.saveRepoMapping(jiraProject, repo, source);
}

function extractExternalUrls(nodes: any[]): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const node of nodes || []) {
    if (node.type === "inlineCard" && node.attrs?.url) {
      const u = node.attrs.url;
      if (!seen.has(u)) { seen.add(u); urls.push(u); }
    }
    if (node.type === "text" && node.marks) {
      for (const mark of node.marks) {
        if (mark.type === "link" && mark.attrs?.href) {
          const u = mark.attrs.href;
          if (!seen.has(u)) { seen.add(u); urls.push(u); }
        }
      }
    }
    if (node.content) urls.push(...extractExternalUrls(node.content));
  }
  return urls;
}

function isExternalDocUrl(url: string): boolean {
  if (/github\.com/.test(url)) return false;
  if (/atlassian\.net\/browse\//.test(url)) return false;
  return /^https?:\/\//.test(url);
}

async function fetchPageText(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "CoolPlugz/1.0 (repo-resolver)" },
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain") && !contentType.includes("application/json")) return null;
    const html = await res.text();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 8000);
  } catch {
    return null;
  }
}

async function extractRepoWithClaude(pageText: string, context: string): Promise<string | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: EXTRACTION_MODEL,
      max_tokens: 200,
      system: "You extract GitHub repository references from text. Respond with ONLY the repo in owner/name format (e.g. facebook/react). If no GitHub repo is found, respond with NONE.",
      messages: [{
        role: "user",
        content: `Context: Looking for the GitHub repository related to Jira ticket "${context}".\n\nPage content:\n${pageText}\n\nWhat GitHub repository (owner/repo format) is referenced or implied? Reply with just the repo or NONE.`,
      }],
    });
    const text = response.content[0]?.type === "text" ? response.content[0].text.trim() : "";
    if (text === "NONE" || !text || text.length > 100) return null;
    const match = text.match(/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)/);
    return match ? match[1] : null;
  } catch (err: any) {
    console.error("[repo-resolver] Claude extraction failed:", err.message);
    return null;
  }
}

function extractGithubRepo(text: string): string | null {
  const match = text.match(/github\.com\/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)/);
  if (!match) return null;
  return match[1].replace(/\.git$/, "").replace(/\/(?:pull|issues|tree|blob|compare|commit|releases).*$/, "");
}

function extractReposFromAdf(nodes: any[]): string[] {
  const urls: string[] = [];
  for (const node of nodes || []) {
    if (node.type === "inlineCard" && node.attrs?.url) {
      const repo = extractGithubRepo(node.attrs.url);
      if (repo) urls.push(repo);
    }
    if (node.type === "text" && node.marks) {
      for (const mark of node.marks) {
        if (mark.type === "link" && mark.attrs?.href) {
          const repo = extractGithubRepo(mark.attrs.href);
          if (repo) urls.push(repo);
        }
      }
    }
    if (node.type === "text" && node.text) {
      const repo = extractGithubRepo(node.text);
      if (repo) urls.push(repo);
    }
    if (node.content) urls.push(...extractReposFromAdf(node.content));
  }
  return urls;
}

function basicAuth(email: string, apiToken: string): string {
  return Buffer.from(`${email}:${apiToken}`).toString("base64");
}

async function jiraFetch(baseUrl: string, path: string, auth: string): Promise<any> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
  });
  if (!res.ok) return null;
  return res.json();
}

async function extractReposFromJira(jiraKey: string): Promise<string[]> {
  const config = getJiraConfig();
  if (!config) return [];
  const auth = basicAuth(config.email, config.apiToken);
  const found = new Set<string>();

  try {
    // 1. Fetch issue with description, comments, parent, and linked issues
    const issue = await jiraFetch(
      config.baseUrl,
      `/rest/api/3/issue/${jiraKey}?fields=description,comment,parent,issuelinks`,
      auth
    );
    if (!issue) return [...found];

    // 1a. Search description ADF for GitHub URLs (handles inlineCard, links, plain text)
    if (issue.fields?.description?.content) {
      for (const repo of extractReposFromAdf(issue.fields.description.content)) found.add(repo);
    }

    // 1b. Search comments for GitHub URLs
    const comments = issue.fields?.comment?.comments || [];
    for (const c of comments) {
      if (c.body?.content) {
        for (const repo of extractReposFromAdf(c.body.content)) found.add(repo);
      }
    }

    // 1c. Fallback: extract ALL GitHub repos from raw text
    const rawText = JSON.stringify(issue.fields?.description || "") + JSON.stringify(issue.fields?.comment || "");
    const rawMatches = rawText.matchAll(/github\.com\/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)/g);
    for (const m of rawMatches) {
      const repo = m[1].replace(/\.git$/, "").replace(/\/(?:pull|issues|tree|blob|compare|commit|releases).*$/, "");
      found.add(repo);
    }

    // 2. Check remote links (web links attached to the issue)
    try {
      const remoteLinks = await jiraFetch(config.baseUrl, `/rest/api/3/issue/${jiraKey}/remotelink`, auth);
      for (const link of remoteLinks || []) {
        const url = link.object?.url || "";
        const repo = extractGithubRepo(url);
        if (repo) found.add(repo);
      }
    } catch { /* remote links not available */ }

    // 3. Check linked issues (e.g. "is blocked by", "relates to") — they may have the repo
    const issueLinks = issue.fields?.issuelinks || [];
    for (const link of issueLinks) {
      const linkedKey = link.inwardIssue?.key || link.outwardIssue?.key;
      if (!linkedKey) continue;
      try {
        const linked = await jiraFetch(
          config.baseUrl,
          `/rest/api/3/issue/${linkedKey}?fields=description`,
          auth
        );
        if (linked?.fields?.description?.content) {
          for (const repo of extractReposFromAdf(linked.fields.description.content)) found.add(repo);
        }
        const linkedText = JSON.stringify(linked?.fields?.description || "");
        const linkedRepo = extractGithubRepo(linkedText);
        if (linkedRepo) found.add(linkedRepo);
      } catch { /* linked issue fetch failed */ }
    }

    // 4. Check parent/epic for repo references
    if (issue.fields?.parent?.key) {
      const parentKey = issue.fields.parent.key;
      try {
        const parent = await jiraFetch(
          config.baseUrl,
          `/rest/api/3/issue/${parentKey}?fields=description`,
          auth
        );
        if (parent?.fields?.description?.content) {
          for (const repo of extractReposFromAdf(parent.fields.description.content)) found.add(repo);
        }
        const parentText = JSON.stringify(parent?.fields?.description || "");
        const parentRepo = extractGithubRepo(parentText);
        if (parentRepo) found.add(parentRepo);
      } catch { /* parent fetch failed */ }
    }

    // If we already found repos, return them — skip expensive external crawling
    if (found.size > 0) return [...found];

    // 5. Deep extraction: fetch external URLs found in the ticket and use Claude to find repos
    const allExternalUrls: string[] = [];
    if (issue.fields?.description?.content) {
      allExternalUrls.push(...extractExternalUrls(issue.fields.description.content).filter(isExternalDocUrl));
    }
    for (const c of comments) {
      if (c.body?.content) {
        allExternalUrls.push(...extractExternalUrls(c.body.content).filter(isExternalDocUrl));
      }
    }
    try {
      const remoteLinks = await jiraFetch(config.baseUrl, `/rest/api/3/issue/${jiraKey}/remotelink`, auth);
      for (const link of remoteLinks || []) {
        const url = link.object?.url || "";
        if (isExternalDocUrl(url) && !allExternalUrls.includes(url)) {
          allExternalUrls.push(url);
        }
      }
    } catch { /* already tried above */ }

    const uniqueUrls = [...new Set(allExternalUrls)].slice(0, 5);
    for (const url of uniqueUrls) {
      console.log(`[repo-resolver] Crawling external link: ${url}`);
      const pageText = await fetchPageText(url);
      if (!pageText || pageText.length < 50) continue;

      const quickRepo = extractGithubRepo(pageText);
      if (quickRepo) { found.add(quickRepo); continue; }

      const claudeRepo = await extractRepoWithClaude(pageText, jiraKey);
      if (claudeRepo) {
        console.log(`[repo-resolver] Claude found repo "${claudeRepo}" from ${url}`);
        found.add(claudeRepo);
      }
    }

    return [...found];
  } catch {
    return [...found];
  }
}

async function fetchUserRepos(): Promise<Array<{ full_name: string; name: string }>> {
  let token: string;
  try {
    token = getGithubToken();
  } catch {
    console.error("[repo-resolver] No GitHub token available");
    return [];
  }

  try {
    const res = await fetch(
      "https://api.github.com/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member",
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } },
    );
    if (!res.ok) {
      console.error(`[repo-resolver] GitHub user/repos failed: ${res.status}`);
      return [];
    }
    const repos = (await res.json()) as any[];
    console.log(`[repo-resolver] Fetched ${repos.length} GitHub repo(s)`);
    return repos.map(r => ({ full_name: r.full_name, name: r.name }));
  } catch (err: any) {
    console.error("[repo-resolver] fetchUserRepos error:", err.message);
    return [];
  }
}

function extractPlainTextFromAdf(nodes: any[]): string {
  const parts: string[] = [];
  for (const node of nodes || []) {
    if (node.type === "text" && node.text) parts.push(node.text);
    if (node.content) parts.push(extractPlainTextFromAdf(node.content));
  }
  return parts.join(" ");
}

async function fuzzyMatchRepoFromTicket(jiraKey: string): Promise<string | null> {
  const config = getJiraConfig();
  if (!config) return null;

  const auth = basicAuth(config.email, config.apiToken);
  const userRepos = await fetchUserRepos();
  if (userRepos.length === 0) return null;

  try {
    const issue = await jiraFetch(
      config.baseUrl,
      `/rest/api/3/issue/${jiraKey}?fields=description,summary`,
      auth
    );
    if (!issue) return null;

    const summary = issue.fields?.summary || "";
    const descriptionText = issue.fields?.description?.content
      ? extractPlainTextFromAdf(issue.fields.description.content)
      : "";
    const ticketText = (summary + " " + descriptionText).toLowerCase();

    // Score each repo by how well it matches words in the ticket
    let bestMatch: { full_name: string; score: number } | null = null;
    for (const repo of userRepos) {
      const repoName = repo.name.toLowerCase();
      const nameParts = repoName.split(/[-_.]/).filter(p => p.length > 2);
      let score = 0;

      // Exact repo name appears in ticket text
      if (ticketText.includes(repoName)) {
        score += 10;
      }

      // Individual parts of repo name (e.g. "cool-plugz" → ["cool", "plugz"])
      for (const part of nameParts) {
        if (ticketText.includes(part)) score += 3;
      }

      // Check for common short-name patterns: "Repos: Core", "Repo - Extension"
      const repoPatterns = /(?:repos?|repository|codebase|project)\s*[-:–]\s*([a-zA-Z0-9_.-]+(?:\s*,\s*[a-zA-Z0-9_.-]+)*)/gi;
      let match;
      while ((match = repoPatterns.exec(ticketText)) !== null) {
        const mentioned = match[1].split(/\s*,\s*/);
        for (const name of mentioned) {
          const trimmed = name.trim().toLowerCase();
          if (trimmed === repoName || nameParts.includes(trimmed)) {
            score += 15;
          }
          // Partial: "core" matches "company-core" or "core-api"
          if (trimmed.length > 2 && repoName.includes(trimmed)) {
            score += 8;
          }
        }
      }

      if (score > 0 && (!bestMatch || score > bestMatch.score)) {
        bestMatch = { full_name: repo.full_name, score };
      }
    }

    if (bestMatch && bestMatch.score >= 3) {
      console.log(`[repo-resolver] Fuzzy matched "${bestMatch.full_name}" (score ${bestMatch.score}) from ticket ${jiraKey}`);
      return bestMatch.full_name;
    }

    return null;
  } catch (err: any) {
    console.error(`[repo-resolver] Fuzzy match failed for ${jiraKey}:`, err.message);
    return null;
  }
}

async function searchNotionForRepo(jiraProject: string): Promise<string | null> {
  const token = getNotionToken();
  if (!token) return null;

  try {
    // Search Notion for pages mentioning the Jira project or repos
    const searches = [jiraProject, "repository", "repo", "github"];

    for (const query of searches) {
      const res = await fetch("https://api.notion.com/v1/search", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, page_size: 5 }),
      });
      if (!res.ok) continue;

      const data: any = await res.json();
      for (const page of (data.results || [])) {
        if (page.object !== "page") continue;

        // Read page blocks for GitHub URLs
        try {
          const blocksRes = await fetch(`https://api.notion.com/v1/blocks/${page.id}/children?page_size=100`, {
            headers: {
              Authorization: `Bearer ${token}`,
              "Notion-Version": "2022-06-28",
            },
          });
          if (!blocksRes.ok) continue;

          const blocks: any = await blocksRes.json();
          const blockText = (blocks.results || [])
            .map((b: any) => {
              const content = b[b.type];
              if (!content?.rich_text) return "";
              return content.rich_text.map((t: any) => t.plain_text || t.href || "").join(" ");
            })
            .join("\n");

          const repoMatch = blockText.match(/github\.com\/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)/);
          if (repoMatch) {
            const repo = repoMatch[1].replace(/\.git$/, "").replace(/\/(?:pull|issues|tree|blob).*$/, "");
            return repo;
          }
        } catch { /* block read failed */ }
      }
    }

    return null;
  } catch {
    return null;
  }
}
