import { getGithubToken } from "../config";

async function ghFetch(path: string, token: string, opts: RequestInit = {}): Promise<any> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${res.status} ${path}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

export function getGhToken(): string {
  return getGithubToken();
}

export async function getRepoTree(token: string, repo: string, branch: string): Promise<Array<{ path: string; type: string; size: number }>> {
  const data = await ghFetch(`/repos/${repo}/git/trees/${branch}?recursive=1`, token);
  return (data.tree || [])
    .filter((f: any) => f.type === "blob")
    .map((f: any) => ({ path: f.path, type: "blob", size: f.size || 0 }));
}

export async function readFile(token: string, repo: string, path: string, ref: string): Promise<string> {
  const data = await ghFetch(`/repos/${repo}/contents/${encodeURIComponent(path)}?ref=${ref}`, token);
  if (data.encoding === "base64") {
    return Buffer.from(data.content, "base64").toString("utf-8");
  }
  return data.content || "";
}

export async function branchExists(token: string, repo: string, branch: string): Promise<boolean> {
  try {
    await ghFetch(`/repos/${repo}/git/ref/heads/${branch}`, token);
    return true;
  } catch {
    return false;
  }
}

export async function getBranchFiles(
  token: string, repo: string, branch: string, baseBranch: string
): Promise<Array<{ path: string; content: string }>> {
  try {
    const compare = await ghFetch(`/repos/${repo}/compare/${baseBranch}...${branch}`, token);
    const files: Array<{ path: string; content: string }> = [];
    for (const f of (compare.files || [])) {
      if (f.status === "removed") continue;
      try {
        const content = await readFile(token, repo, f.filename, branch);
        files.push({ path: f.filename, content });
      } catch { /* file may be binary or too large */ }
    }
    return files;
  } catch {
    return [];
  }
}

export async function getAuthenticatedUser(token: string): Promise<string> {
  const data = await ghFetch("/user", token);
  return data.login;
}

export async function findBranchByJiraKey(
  token: string,
  repo: string,
  jiraKey: string,
): Promise<{ branch: string; hasUserCommits: boolean } | null> {
  const keyLower = jiraKey.toLowerCase();
  let branches: any[];
  try {
    branches = await ghFetch(`/repos/${repo}/branches?per_page=100`, token);
  } catch {
    return null;
  }

  const matches = branches.filter(
    (b: any) => b.name.toLowerCase().includes(keyLower)
  );

  if (matches.length === 0) return null;
  if (matches.length === 1) {
    return { branch: matches[0].name, hasUserCommits: true };
  }

  // Multiple matches — pick the one with the user's commits
  let ghUsername: string | null = null;
  try {
    ghUsername = await getAuthenticatedUser(token);
  } catch { /* can't resolve username */ }

  if (ghUsername) {
    for (const m of matches) {
      try {
        const commits = await ghFetch(
          `/repos/${repo}/commits?sha=${encodeURIComponent(m.name)}&author=${ghUsername}&per_page=1`,
          token
        );
        if (commits.length > 0) {
          return { branch: m.name, hasUserCommits: true };
        }
      } catch { /* skip */ }
    }
  }

  // No user commits found on any match — return the most recently updated one
  return { branch: matches[0].name, hasUserCommits: false };
}

export async function getDefaultBranch(token: string, repo: string): Promise<string> {
  const data = await ghFetch(`/repos/${repo}`, token);
  return data.default_branch || "main";
}

export async function getLatestSha(token: string, repo: string, branch: string): Promise<string> {
  const data = await ghFetch(`/repos/${repo}/git/ref/heads/${branch}`, token);
  return data.object.sha;
}

export async function createBranch(token: string, repo: string, branchName: string, fromSha: string): Promise<void> {
  try {
    await ghFetch(`/repos/${repo}/git/ref/heads/${branchName}`, token);
    // Branch exists — update it
    await ghFetch(`/repos/${repo}/git/refs/heads/${branchName}`, token, {
      method: "PATCH",
      body: JSON.stringify({ sha: fromSha, force: true }),
    });
  } catch {
    // Branch doesn't exist — create it
    await ghFetch(`/repos/${repo}/git/refs`, token, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: fromSha }),
    });
  }
}

export async function commitFiles(
  token: string,
  repo: string,
  branch: string,
  baseSha: string,
  files: Array<{ path: string; content: string }>,
  message: string
): Promise<string> {
  // Create blobs for each file
  const treeItems = [];
  for (const file of files) {
    const blob = await ghFetch(`/repos/${repo}/git/blobs`, token, {
      method: "POST",
      body: JSON.stringify({ content: file.content, encoding: "utf-8" }),
    });
    treeItems.push({ path: file.path, mode: "100644" as const, type: "blob" as const, sha: blob.sha });
  }

  // Create tree
  const tree = await ghFetch(`/repos/${repo}/git/trees`, token, {
    method: "POST",
    body: JSON.stringify({ base_tree: baseSha, tree: treeItems }),
  });

  // Create commit
  const commit = await ghFetch(`/repos/${repo}/git/commits`, token, {
    method: "POST",
    body: JSON.stringify({ message, tree: tree.sha, parents: [baseSha] }),
  });

  // Update branch ref
  await ghFetch(`/repos/${repo}/git/refs/heads/${branch}`, token, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha }),
  });

  return commit.sha;
}

export async function getPRReviewComments(
  token: string,
  repo: string,
  prNumber: number
): Promise<{ reviews: string[]; comments: string[]; body: string }> {
  // PR description
  const pr = await ghFetch(`/repos/${repo}/pulls/${prNumber}`, token);
  const body = pr.body || "";

  // Review comments (inline code comments)
  const reviewComments = await ghFetch(`/repos/${repo}/pulls/${prNumber}/comments?per_page=100&sort=created&direction=desc`, token);
  const comments = (reviewComments || []).map((c: any) => {
    const file = c.path || "";
    const line = c.line || c.original_line || "";
    const author = c.user?.login || "reviewer";
    return `[${author}] ${file}${line ? `:${line}` : ""} — ${c.body}`;
  });

  // PR reviews (approve/request changes with body text)
  const reviews = await ghFetch(`/repos/${repo}/pulls/${prNumber}/reviews?per_page=50`, token);
  const reviewBodies = (reviews || [])
    .filter((r: any) => r.body && r.body.trim())
    .map((r: any) => {
      const author = r.user?.login || "reviewer";
      const state = r.state || "";
      return `[${author} — ${state}] ${r.body}`;
    });

  // Issue comments (general PR conversation)
  const issueComments = await ghFetch(`/repos/${repo}/issues/${prNumber}/comments?per_page=50&sort=created&direction=desc`, token);
  const conversationComments = (issueComments || []).map((c: any) => {
    const author = c.user?.login || "someone";
    return `[${author}] ${c.body}`;
  });

  return {
    body,
    reviews: reviewBodies,
    comments: [...comments, ...conversationComments],
  };
}

const PR_TEMPLATE_PATHS = [
  ".github/pull_request_template.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
  ".github/PULL_REQUEST_TEMPLATE/default.md",
];

export async function fetchPRTemplate(
  token: string,
  repo: string,
  branch: string
): Promise<string | null> {
  for (const tplPath of PR_TEMPLATE_PATHS) {
    try {
      const data = await ghFetch(
        `/repos/${repo}/contents/${encodeURIComponent(tplPath)}?ref=${branch}`,
        token
      );
      if (data.encoding === "base64") {
        return Buffer.from(data.content, "base64").toString("utf-8");
      }
      return data.content || null;
    } catch {
      // not found at this path, try next
    }
  }
  return null;
}

/**
 * Find the user's fork of a given upstream repo.
 * GitHub can rename forks (e.g. cowswap → cowswap-mmc), so we search
 * the upstream's forks list rather than guessing the name.
 */
export async function findUserFork(
  token: string,
  upstreamRepo: string,
  username: string,
): Promise<{ fullName: string } | null> {
  // Method 1: Check the upstream repo's forks list for this user
  try {
    const res = await fetch(`https://api.github.com/repos/${upstreamRepo}/forks?per_page=100`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (res.ok) {
      const forks = (await res.json()) as any[];
      const userFork = forks.find(
        (f: any) => f.owner?.login?.toLowerCase() === username.toLowerCase(),
      );
      if (userFork) return { fullName: userFork.full_name };
    }
  } catch { /* fall through */ }

  // Method 2: Check if user has a repo with the same base name
  const repoName = upstreamRepo.split("/").pop();
  try {
    const data = await ghFetch(`/repos/${username}/${repoName}`, token);
    if (data.fork && data.parent?.full_name?.toLowerCase() === upstreamRepo.toLowerCase()) {
      return { fullName: data.full_name };
    }
  } catch { /* no fork found */ }

  return null;
}

export async function createPR(
  token: string,
  repo: string,
  head: string,
  base: string,
  title: string,
  body: string
): Promise<{ url: string; number: number }> {
  // Check if PR already exists for this branch
  // head may be "branch" (same-repo) or "username:branch" (cross-fork)
  const headFilter = head.includes(":") ? head : `${repo.split("/")[0]}:${head}`;
  const existing = await ghFetch(`/repos/${repo}/pulls?head=${encodeURIComponent(headFilter)}&state=open`, token);
  if (existing.length > 0) {
    return { url: existing[0].html_url, number: existing[0].number };
  }

  const pr = await ghFetch(`/repos/${repo}/pulls`, token, {
    method: "POST",
    body: JSON.stringify({ title, body, head, base }),
  });
  return { url: pr.html_url, number: pr.number };
}
