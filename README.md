# Core MCP

MCP tools that turn Jira tickets into PRs through Claude Code. Fetches context from Jira, GitHub, Notion, and Slack, builds structured prompts, handles git push/PR/CI — all autonomously.

## Setup (5 minutes)

### 1. Install

```bash
git clone https://github.com/adaOctopus/coolplugz-core.git
cd coolplugz-core
npm install
```

### 2. Create your `.env`

```bash
cp .env.example .env
```

Open `.env` and fill in:

**Required:**

| Variable | Where to get it |
|----------|----------------|
| `GITHUB_TOKEN` | [github.com/settings/tokens](https://github.com/settings/tokens) → Generate classic token → check `repo` + `workflow` |
| `SHELL_ENV` | Your dev environment: `wsl2`, `macos`, `linux`, `git-bash`, or `powershell` |
| `REPOS_ROOT` | Absolute path where your repos live, e.g. `/home/you/projects` |

**Optional (but recommended):**

| Variable | Where to get it |
|----------|----------------|
| `JIRA_API_TOKEN` | [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens) |
| `JIRA_EMAIL` | Your Atlassian account email |
| `JIRA_BASE_URL` | Your workspace URL, e.g. `https://yourteam.atlassian.net` |
| `NOTION_TOKEN` | [notion.so/my-integrations](https://www.notion.so/my-integrations) → Create integration → copy token |
| `SLACK_TOKEN` | [api.slack.com/apps](https://api.slack.com/apps) → Create app → Bot Token with `channels:history`, `search:read` |
| `ANTHROPIC_API_KEY` | Enables AI-powered repo detection from ticket text and smart Slack reply drafts |
| `WSL_DISTRO` | Only if `SHELL_ENV=wsl2` — your distro name (e.g. `Ubuntu`) |

### 3. Start the server

```bash
npm run dev
```

You should see:
```
CoolPlugz Core MCP server listening on :3100
```

### 4. Connect to Claude Code (one time)

```bash
claude mcp add coolplugz --transport http http://localhost:3100/mcp
```

### 5. Use it

Open Claude Code and say:

```
Show my dashboard
```
```
Start PROJ-142
```

That's it. CoolPlugz handles the rest.

---

## What Happens When You Use It

```
You: "Start PROJ-142"

CoolPlugz:
  ├── Fetches Jira ticket (description, acceptance criteria, comments)
  ├── Checks GitHub for existing branches/PRs
  ├── Pulls linked Notion specs
  ├── Finds relevant Slack mentions
  ├── Figures out which repo (from ticket links or fuzzy matching)
  ├── Builds a CRISPE implementation prompt
  └── Returns loop metadata → Claude Code knows exactly what to do next

Claude Code: writes the code, runs tests

You: (or Claude Code automatically calls push_branch)

CoolPlugz:
  ├── Pushes via token-authenticated HTTPS (no SSH needed)
  ├── Handles fork detection/creation automatically
  └── Returns next action → verify_and_submit

CoolPlugz (verify_and_submit):
  ├── Verifies push landed on GitHub (via API, not trusting output)
  ├── Opens PR with correct title/body
  ├── Polls CI for up to 5 minutes
  ├── If CI passes + no review comments → auto-marks DONE
  ├── If CI fails → fetches failure logs, tells Claude Code to fix
  └── If review comments → fetches them, tells Claude Code to address
```

## Available Tools

| Tool | What it does |
|------|-------------|
| `get_dashboard` | Shows all your tasks with status, PRs, and blockers |
| `start_task` | Fetches all context for a Jira ticket and returns the implementation prompt |
| `push_branch` | Pushes your branch to GitHub — handles auth, forks, everything |
| `verify_and_submit` | Verifies push, creates PR, polls CI, auto-completes if green |
| `check_comments` | Fetches unresolved PR review comments to address |
| `complete_task` | Marks a task done after verification |
| `get_task_state` | Shows ground truth state from the store + GitHub API |
| `check_conflicts` | Detects merge conflicts and gives resolution steps |
| `add_insight` | Adds a custom instruction included in all future prompts |

## Custom Instructions

Tell Claude Code to add instructions that CoolPlugz will include in every future prompt:

```
"Add an insight: always use pnpm, never npm or yarn"
"Add an insight: this repo uses Tailwind, no inline styles"
"Add an insight for PROJ-142: the auth module uses Passport.js"
```

Global insights apply to all tasks. Task-scoped insights apply to one ticket. Stored in `~/.coolplugz/data.json` and persist across sessions.

## How the Prompt Builder Works

Every `start_task` builds a structured prompt using the CRISPE framework:

| Section | What's in it |
|---------|-------------|
| **[C] Capacity** | Role, repo, branch, workspace setup (WSL2/macOS/Linux), local paths |
| **[R] Insight** | Full ticket description, AC, Jira comments, Notion specs, Slack context, PR review comments |
| **[I] Statement** | The specific implementation instruction |
| **[S] Personality** | Code style, commit conventions (`feat(PROJ-142): ...`), communication rules |
| **[P] Experiment** | Autonomous execution permissions, loop engineering instructions, safety constraints |
| **[F] Fence** | Never delete, never push to main, never commit secrets |
| **[Q] Quality** | Type safety, surgical changes, security defaults |
| **[D] Developer insights** | Your custom instructions (from `add_insight`) |
| **[E] Error context** | Previous failure details on retries |

## Loop Engineering

Every tool response carries structured metadata instead of free-text checklists:

```
State: EXECUTING → Goal: DONE
Next: push_branch({ jiraKey: "PROJ-142", branch: "proj-142-impl", repo: "org/repo" })
```

Claude Code reads this and calls the next tool automatically. The state machine:

```
IDLE → start_task → EXECUTING → push_branch → PUSHED → verify_and_submit
  → CI passed, no comments → DONE ✅
  → CI failed → fix code → push_branch → verify_and_submit (loop)
  → Review comments → fix → push_branch → verify_and_submit (loop)
```

## Data Storage

All data lives in `~/.coolplugz/data.json` — tasks, context snapshots, repo mappings, insights, prompt history. No database required. Delete the file to start fresh.

## Architecture

```
src/
├── index.ts              # MCP server (Express + StreamableHTTP)
├── config.ts             # Reads tokens from .env
├── store.ts              # JSON file store (~/.coolplugz/data.json)
├── lib/
│   ├── loopState.ts      # State machine
│   └── response.ts       # mcpText() and mcpLoop() builders
├── context/
│   ├── jira.ts           # Jira fetcher (Basic auth)
│   ├── github.ts         # GitHub state (branches, PRs, CI)
│   ├── notion.ts         # Notion doc fetcher
│   ├── slack.ts          # Slack mentions + AI draft replies
│   ├── repoResolver.ts   # Auto-detect repo from ticket content
│   └── assemble.ts       # CRISPE prompt builder
├── orchestrator/
│   └── githubApi.ts      # GitHub API helpers
└── tools/
    ├── orchestrator.ts   # start_task, verify_and_submit, etc.
    ├── pushBranch.ts     # Token-authenticated push + fork handling
    ├── getDashboard.ts   # Text dashboard
    └── addInsight.ts     # Custom instruction management
```

## License

MIT
