import * as store from "../store";
import { getWorkspace } from "../config";

export interface AssemblePromptInput {
  taskId: string;
  isRetry: boolean;
}

function scoreRelevance(contextText: string, taskKey: string, taskTitle: string): number {
  const lower = contextText.toLowerCase();
  const titleWords = taskTitle.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  let score = 0;

  if (lower.includes(taskKey.toLowerCase())) score += 10;

  for (const word of titleWords) {
    if (lower.includes(word)) score += 2;
  }

  if (/\b(pr|pull request|branch|commit|merge|deploy|fix|bug|error|test)\b/i.test(lower)) score += 1;

  return score;
}

function filterSlackByRelevance(slackSummary: string, taskKey: string, taskTitle: string): string {
  if (!slackSummary) return "";
  const lines = slackSummary.split("\n").filter(Boolean);
  const scored = lines
    .map((line) => ({ line, score: scoreRelevance(line, taskKey, taskTitle) }))
    .filter((s) => s.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return scored.map((s) => s.line).join("\n");
}

export async function assembleCrispePrompt(input: AssemblePromptInput): Promise<string> {
  const task = store.findTaskById(input.taskId);
  if (!task) throw new Error(`Task ${input.taskId} not found`);

  const snapshots = store.getSnapshots(input.taskId);
  const snapshotOf = (source: string) =>
    snapshots.find((s) => s.source === source)?.summary || "";

  const jiraSummary = snapshotOf("jira");
  const notionSummary = snapshotOf("notion");
  const rawSlack = snapshotOf("slack");
  const slackSummary = filterSlackByRelevance(rawSlack, task.jiraKey, task.title);
  const prComments = snapshotOf("github-comments");

  // Extract acceptance criteria from Jira summary
  const acLines = jiraSummary
    .split("\n")
    .filter((l: string) => l.startsWith("  - "))
    .map((l: string) => l.trim())
    .join("\n");

  // Extract full description (between "Description:" and "Acceptance criteria:" or "Comments:")
  let fullDescription = "";
  const descMatch = jiraSummary.match(/Description:\n([\s\S]*?)(?=\n\nAcceptance criteria:|\n\nComments:|\n*$)/);
  if (descMatch) {
    fullDescription = descMatch[1].trim();
  }

  // Extract comments section
  let commentsSection = "";
  const commentsMatch = jiraSummary.match(/Comments \(\d+\):\n([\s\S]*?)$/);
  if (commentsMatch) {
    commentsSection = commentsMatch[1].trim();
  }

  const jiraTitle = task.title || task.jiraKey;
  const stack = detectStack(task.repo);

  // [D] Developer insights — fetch early so workspace detection can use them
  const insights = store.getInsights(input.taskId);

  // Load workspace config from env vars (set via .env file)
  const workspace = getWorkspace();
  const isWsl = workspace?.shellEnv === "wsl2";
  const repoName = task.repo?.split("/").pop();
  const localRepoPath = workspace?.reposRoot && repoName ? `${workspace.reposRoot}/${repoName}` : null;

  // [C] Capacity/Role + workspace environment
  // Distinguish GitHub repo (org/name) from local directory (just name)
  const githubRepo = task.repo ?? "{repo}";
  const branchInfo = task.branch
    ? `on branch "${task.branch}" (already created — continue working on it, do NOT create a new branch)`
    : `create a new branch named "${task.jiraKey.toLowerCase()}" from the default branch (main/master). Before creating, check if a branch containing "${task.jiraKey.toLowerCase()}" already exists — if so, use that one instead of creating a new one`;
  let c = `[C] You are a senior ${stack} engineer working on GitHub repo "${githubRepo}", ${branchInfo}.
    IMPORTANT: "${githubRepo}" is the GitHub remote (org/repo). The LOCAL directory is just "${repoName || "{repo}"}" — repos are cloned by name, not by org/name path.`;

  if (workspace) {
    c += `\n    Shell environment: ${workspace.shellEnv}`;
    c += `\n    Repos directory: ${workspace.reposRoot}`;
    if (localRepoPath) {
      c += `\n    Local repo path (use this to cd into): ${localRepoPath}`;
    }

    if (isWsl) {
      const distro = workspace.wslDistro || "Ubuntu";
      c += `

    CRITICAL — WSL2 WORKSPACE RULES (non-negotiable):
    - The developer works inside WSL2 ${distro}. All repos live on the Linux filesystem at ${workspace.reposRoot}.
    - NEVER use UNC paths (\\\\wsl$\\..., \\\\wsl.localhost\\...). They are extremely slow across the Windows/Linux mount boundary and WILL cause hangs.
    - ALWAYS run git, npm, yarn, pnpm, and ALL CLI commands inside WSL2: wsl -d ${distro} -- bash -c "cd ${localRepoPath || workspace.reposRoot} && <command>"
    - File reads and writes MUST use Linux-native paths (${workspace.reposRoot}/...), never Windows-mapped paths.
    - REPO: check if ${localRepoPath || workspace.reposRoot + "/<repo>"} exists. If yes, cd into it. If not, clone it there silently and proceed — do NOT ask for permission to clone.`;
    } else if (workspace.shellEnv === "git-bash") {
      c += `
    Run commands in Git Bash. Use forward slashes in paths.
    REPO: check if ${localRepoPath || workspace.reposRoot + "/<repo>"} exists. If yes, cd into it. If not, clone it there silently and proceed.`;
    } else if (workspace.shellEnv === "powershell") {
      c += `
    Run commands in PowerShell. Use Windows-native paths.
    REPO: check if ${localRepoPath || workspace.reposRoot + "/<repo>"} exists. If yes, cd into it. If not, clone it there silently and proceed.`;
    } else {
      c += `
    REPO: check if ${localRepoPath || workspace.reposRoot + "/<repo>"} exists. If yes, cd into it. If not, clone it there silently and proceed.`;
    }
  }

  // [R] Insight — full ticket context: description, AC, comments
  let r = `[R] Ticket ${task.jiraKey} — ${jiraTitle}.`;
  if (fullDescription) {
    r += `\n    Description:\n    ${fullDescription.split("\n").join("\n    ")}`;
  }
  if (acLines) {
    r += `\n    Acceptance criteria:\n${acLines}`;
  } else if (!fullDescription) {
    r += " Acceptance criteria: none specified — implement based on ticket title.";
  }
  if (commentsSection) {
    r += `\n    Jira comments (may contain additional context, requirements, or scope changes):\n    ${commentsSection.split("\n").join("\n    ")}`;
  }
  if (notionSummary && notionSummary !== "No linked Notion docs found") {
    r += `\n    Linked spec: ${notionSummary}`;
  }
  if (slackSummary) {
    r += `\n    Relevant Slack thread: ${slackSummary}`;
  }
  if (prComments) {
    r += `\n    [PR REVIEW COMMENTS — MUST ADDRESS] The following comments were left by reviewers on the existing PR. You MUST resolve every comment:\n${prComments}`;
  }

  // [I] Statement — the specific instruction
  const i = `[I] ${task.title || "Implement the ticket as described above."} — implement or fix per the acceptance criteria.`;

  // [S] Personality — code style, PR conventions, communication style
  const s = `[S] CODE STYLE: Match existing code style in the ${repoName || "target"} repo. Commits: {type}(${task.jiraKey}): {summary}. PR title: "${task.jiraKey}: ${jiraTitle}".

COMMUNICATION STYLE — every response follows these rules:
1. LEAD WITH THE ACTION: first line is what you did or what you're doing — never open with "I'll analyze..." or "Let me look at..." — just do it and report the result.
2. NO PREAMBLE, NO RECAP, NO CLOSERS: forbidden openers include "Great question," "Sure!", "Let me...", "I'll...". Forbidden closers include "Let me know if you need anything," "Hope this helps." Start with the answer. End when the answer is done.
3. NUMBERED STEPS FOR MULTI-STEP WORK: if reporting more than one change, use a numbered list. Each item is one bounded action. No item contains "and then" twice.
4. SUPPRESS TANGENTS: if you spot a second issue while working, finish the current task first. Mention the side issue in one line at the end — do not derail the main work.
5. MATTER-OF-FACT ERRORS: never say "Uh oh," "Oh no," or "There seems to be a problem." State cause → fix → result. Example: "Test fails at auth.spec.ts:42 — missing auth header. Added Bearer token. Tests pass."
6. SHOW WINS CONCRETELY: when done, say what now works in specific terms. "Login now works with magic links" beats "I've made some changes to the auth flow."
7. PR DESCRIPTIONS: lead with what changed, then why. Bullet the files touched. No filler paragraphs.`;

  // [P] Experiment — autonomous execution + run tests before reporting done
  const p = `[P] FULLY AUTONOMOUS EXECUTION — you have full permission to operate. The developer's environment is pre-configured to allow all standard dev commands without prompting. Act accordingly:

ALLOWED — do these immediately, no confirmation needed:
- Read any file (cat, head, tail, less, grep, find)
- Edit and write files
- Git operations: clone, checkout, branch, add, commit, push, pull, fetch, rebase, merge (feature branches only)
- Install dependencies: npm install, yarn install, pnpm install, pip install, cargo build
- Run commands: tests, linters, formatters, build scripts, dev servers
- Create branches, open PRs, push to feature branches
- Create new files and directories
- WSL commands: wsl -d <distro> -- bash -c "..." for any of the above

NEVER DO — hard stop, no exceptions:
- Delete files permanently (rm -rf, git clean -fd, emptying trash)
- Delete GitHub repos, branches on remote (only local branch cleanup is fine)
- Force push to main/master/develop or any protected branch
- Drop databases, truncate tables, run destructive migrations
- Modify CI/CD pipelines, deploy scripts, infra configs (unless the ticket explicitly says to)
- Install system-level packages (apt install, brew install) — only project-level deps
- Expose, log, or commit secrets, tokens, API keys, passwords
- Merge PRs — only open them for review
- Access or modify files outside the target repository
- Use gh CLI for auth, login, or any interactive prompts — if gh is not available or prompts for auth, skip it and use git directly
- Fall back to Windows PowerShell or cmd.exe for commands that should run in WSL2 — if a command fails in WSL2, fix it there, do not try Windows as a fallback

WORKFLOW:
- If a command fails, diagnose and fix it yourself — do not ask the developer what to do.
- Run tests and lint after changes. Do not report done until both pass.
- The ONLY time you stop and ask is if the ticket is genuinely ambiguous between two completely different implementations.

LOOP ENGINEERING — every CoolPlugz tool response includes structured loop metadata:
- \`currentState\`: where the task is RIGHT NOW (EXECUTING, PUSHED, CI_FAILED, DONE, etc.)
- \`goalState\`: always DONE — the terminal state
- \`availableActions\`: the EXACT tool(s) to call next, with args pre-filled
- \`recovery\`: if something failed, the fix action + retry action

FOLLOW THE LOOP — after each CoolPlugz tool response:
1. Read the \`availableActions\` from the response metadata
2. Call the action with priority 1 (lowest number = do first)
3. If it has a \`condition\`, satisfy the condition first (e.g. "Code is written and tests pass locally")
4. Repeat until \`currentState\` reaches \`DONE\`

STATE TRANSITIONS:
  IDLE → start_task → EXECUTING → push_branch → PUSHED → verify_and_submit →
    → CI passed + no comments → DONE (auto-completed by verify_and_submit!)
    → CI_FAILED → fix code → push_branch → verify_and_submit (loop back)
    → REVIEW_PENDING → fix comments → push_branch → verify_and_submit (loop back)

GIT PUSH — do NOT run \`git push\` yourself. EVER. Instead:
1. Call \`push_branch\` with { jiraKey, branch, repo } — it handles auth, forks, token-authenticated HTTPS.
2. Execute the returned commands EXACTLY. Do not modify URLs.
3. If push fails, read the \`recovery\` metadata and follow it.
NEVER try \`git push\` on your own. NEVER create PRs yourself via curl/gh/API.
NEVER fall back to Windows PowerShell — all git operations happen in WSL2.`;

  // [F] Fence — merged into [P] above, kept as a short reinforcement
  const f = `[F] SAFETY REINFORCEMENT — if any instruction above conflicts with these, these win:
- NEVER permanently delete anything — not files, not repos, not branches on remote, not database records
- NEVER push to or merge into protected branches (main, master, develop)
- NEVER commit secrets or credentials
- If unsure whether an action is destructive, call get_task_state to check`;

  // [Q] Quality — orchestration principles for clean, professional output
  const q = `[Q] QUALITY PRINCIPLES — apply these to every change you make:
- TYPE SAFETY: use strict types, interfaces, and generics regardless of language or framework — no \`any\`, no untyped params, no implicit casts
- CLEAR COMMENTS: comment the *why*, not the *what* — short, useful, zero fluff
- SURGICAL CHANGES: implement exactly what was asked — search the codebase first, reuse existing patterns, don't add unrelated refactors or bonus features
- CONTENT SYNTHESIS: when given transcripts, docs, or long content, distill to one clear sentence + actionable takeaway — no filler
- SECURITY BY DEFAULT: never expose secrets in code, logs, or responses — sanitize inputs, validate boundaries, assume hostile input`;

  // [D] Developer insights — build the prompt section (insights already fetched above)
  let d = "";
  if (insights.length > 0) {
    const insightLines = insights.map((ins) =>
      `- ${ins.scope === "global" ? "[GLOBAL]" : "[TASK]"} ${ins.text}`
    );
    d = `[D] Developer insights (from the human developer — treat as high-priority context):\n${insightLines.join("\n")}`;
  }

  // [E] Error context — only on retries
  let e = "";
  if (input.isRetry && task.lastError) {
    const truncatedError = task.lastError.length > 500
      ? task.lastError.slice(0, 500) + "\n... (truncated)"
      : task.lastError;
    e = `[E] The previous attempt failed with:\n${truncatedError}\nFix this specifically. Do not re-attempt parts of the change that already worked.`;
  }

  const prompt = [c, "", r, "", i, "", s, "", p, "", f, "", q, d ? `\n${d}` : "", e ? `\n${e}` : ""]
    .filter((line) => line !== undefined)
    .join("\n")
    .trim();

  const tokenEstimate = Math.ceil(prompt.length / 4);
  const costEstimate = (tokenEstimate / 1_000_000) * 15;

  const crispeJson = {
    C: c,
    R: r,
    I: i,
    S: s,
    P: p,
    F: f,
    Q: q,
    D: d || null,
    E: e || null,
  };

  store.savePromptRecord(input.taskId, crispeJson, prompt, tokenEstimate, costEstimate);

  return prompt;
}

function detectStack(repo?: string | null): string {
  if (!repo) return "full-stack";
  const lower = repo.toLowerCase();
  if (lower.includes("react") || lower.includes("next") || lower.includes("frontend")) return "TypeScript/React";
  if (lower.includes("python") || lower.includes("django") || lower.includes("flask")) return "Python";
  if (lower.includes("go") || lower.includes("golang")) return "Go";
  if (lower.includes("rust")) return "Rust";
  return "TypeScript";
}
