/**
 * loopState.ts — State machine for CoolPlugz loop engineering.
 *
 * Instead of returning checklists and hoping Claude follows them,
 * every tool response carries structured loop metadata:
 *   - currentState: where the task is RIGHT NOW
 *   - goalState: the terminal state we're driving toward
 *   - availableActions: what tools to call next (with args)
 *   - recovery: if something failed, how to fix it and retry
 *
 * Claude Code reads _meta from structuredContent — this gives it
 * a state machine to follow instead of free-form text to interpret.
 */

// ── Task states (matches prisma schema) ────────────────────────────────

export type TaskState =
  | "IDLE"              // task exists but not started
  | "CONTEXT_SYNCING"   // fetching Jira/GitHub/Slack/Notion context
  | "EXECUTING"         // Claude Code is writing code
  | "PUSH_READY"        // code written, tests pass, ready to push
  | "PUSHED"            // branch pushed to GitHub (upstream or fork)
  | "PR_OPEN"           // PR created, waiting for CI
  | "CI_RUNNING"        // CI checks in progress
  | "CI_FAILED"         // CI checks failed — needs fix
  | "CI_PASSED"         // CI green, ready to complete
  | "REVIEW_PENDING"    // PR has unresolved review comments
  | "READY_FOR_PR"      // legacy compat
  | "BLOCKED"           // can't proceed — missing repo, token, etc.
  | "DONE";             // task complete, PR open and CI green

// ── Actions Claude can take ────────────────────────────────────────────

export interface LoopAction {
  tool: string;               // MCP tool name to call
  args: Record<string, any>;  // arguments to pass
  description: string;        // human-readable description
  condition?: string;         // when this action applies (optional)
  priority: number;           // lower = do first
}

// ── Recovery — what to do when something fails ─────────────────────────

export interface LoopRecovery {
  error: string;              // what went wrong
  fix: LoopAction;            // tool call to fix it
  retryAfterFix: LoopAction;  // tool call to retry the original action
}

// ── Full loop metadata attached to every response ──────────────────────

export interface LoopMeta {
  currentState: TaskState;
  goalState: TaskState;
  availableActions: LoopAction[];
  recovery?: LoopRecovery;
  autoCompleted?: boolean;     // true when verify_and_submit auto-completed
  stateHistory?: string[];     // breadcrumb of states this session
}

// ── State transition map ───────────────────────────────────────────────
// Defines which actions are available from each state.

export function getAvailableActions(
  state: TaskState,
  taskContext: {
    jiraKey: string;
    branch?: string;
    repo?: string;
    prUrl?: string;
    prNumber?: number;
  },
): LoopAction[] {
  const { jiraKey, branch, repo } = taskContext;

  switch (state) {
    case "IDLE":
      return [{
        tool: "start_task",
        args: { jiraKey },
        description: "Fetch context and get implementation instructions",
        priority: 1,
      }];

    case "EXECUTING":
    case "PUSH_READY":
      return [{
        tool: "push_branch",
        args: { jiraKey, branch: branch || "", repo: repo || "" },
        description: "Push the branch to GitHub using server-side auth",
        condition: "Code is written and tests pass locally",
        priority: 1,
      }];

    case "PUSHED":
      return [{
        tool: "verify_and_submit",
        args: { jiraKey },
        description: "Verify push landed, create PR, check CI",
        priority: 1,
      }];

    case "CI_RUNNING":
      return [{
        tool: "verify_and_submit",
        args: { jiraKey },
        description: "Re-check CI status",
        priority: 1,
      }];

    case "CI_FAILED":
      return [
        {
          tool: "verify_and_submit",
          args: { jiraKey },
          description: "Re-verify after fixing CI failures and pushing",
          condition: "After fixing the failing tests/checks and pushing the fix",
          priority: 1,
        },
        {
          tool: "check_comments",
          args: { jiraKey },
          description: "Check if there are also review comments to address",
          priority: 2,
        },
      ];

    case "CI_PASSED":
      return [{
        tool: "complete_task",
        args: { jiraKey },
        description: "Mark task as done — CI is green, PR is open",
        priority: 1,
      }];

    case "REVIEW_PENDING":
      return [
        {
          tool: "check_comments",
          args: { jiraKey },
          description: "Get the review comments to address",
          priority: 1,
        },
        {
          tool: "verify_and_submit",
          args: { jiraKey },
          description: "Re-verify after addressing comments and pushing",
          condition: "After fixing review comments and pushing",
          priority: 2,
        },
      ];

    case "PR_OPEN":
      return [{
        tool: "verify_and_submit",
        args: { jiraKey },
        description: "Check CI status and review comments",
        priority: 1,
      }];

    case "BLOCKED":
      return [
        {
          tool: "get_task_state",
          args: { jiraKey },
          description: "Check current state and diagnose the issue",
          priority: 1,
        },
      ];

    case "DONE":
      return []; // terminal state — no more actions

    default:
      return [{
        tool: "get_task_state",
        args: { jiraKey },
        description: "Check current task state",
        priority: 1,
      }];
  }
}

// ── Recovery builders ──────────────────────────────────────────────────

export function pushFailedRecovery(
  jiraKey: string,
  branch: string,
  repo: string,
  errorType: "scope" | "auth" | "not_found" | "generic",
): LoopRecovery {
  const retryAction: LoopAction = {
    tool: "push_branch",
    args: { jiraKey, branch, repo },
    description: "Retry the push after fixing the issue",
    priority: 1,
  };

  switch (errorType) {
    case "scope":
      return {
        error: "GitHub token lacks 'workflow' scope — can't push CI files",
        fix: {
          tool: "get_task_state",
          args: { jiraKey },
          description: "Check current state — update GITHUB_TOKEN in .env with a token that has the 'workflow' scope",
          priority: 1,
        },
        retryAfterFix: retryAction,
      };

    case "auth":
      return {
        error: "GitHub token expired or invalid",
        fix: {
          tool: "get_task_state",
          args: { jiraKey },
          description: "Check current state — update GITHUB_TOKEN in .env",
          priority: 1,
        },
        retryAfterFix: retryAction,
      };

    case "not_found":
      return {
        error: "Repository not found or not accessible",
        fix: {
          tool: "get_task_state",
          args: { jiraKey },
          description: "Verify the repo name is correct",
          priority: 1,
        },
        retryAfterFix: retryAction,
      };

    default:
      return {
        error: "Push failed — unknown reason",
        fix: {
          tool: "get_task_state",
          args: { jiraKey },
          description: "Check current state and diagnose",
          priority: 1,
        },
        retryAfterFix: retryAction,
      };
  }
}

// ── Goal state ─────────────────────────────────────────────────────────

export const GOAL_STATE: TaskState = "DONE";

// ── Build loop _meta for a tool response ───────────────────────────────

export function buildLoopMeta(
  currentState: TaskState,
  taskContext: {
    jiraKey: string;
    branch?: string;
    repo?: string;
    prUrl?: string;
    prNumber?: number;
  },
  opts?: {
    recovery?: LoopRecovery;
    autoCompleted?: boolean;
  },
): LoopMeta {
  return {
    currentState,
    goalState: GOAL_STATE,
    availableActions: getAvailableActions(currentState, taskContext),
    recovery: opts?.recovery,
    autoCompleted: opts?.autoCompleted,
  };
}
