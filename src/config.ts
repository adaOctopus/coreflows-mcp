export function getGithubToken(): string {
  const token = process.env.GITHUB_TOKEN || process.env.GITHUB_FALLBACK_PAT;
  if (!token) throw new Error("GITHUB_TOKEN not set in .env");
  return token;
}

export interface JiraConfig {
  email: string;
  apiToken: string;
  baseUrl: string;
}

export function getJiraConfig(): JiraConfig | null {
  const apiToken = process.env.JIRA_API_TOKEN;
  const email = process.env.JIRA_EMAIL;
  const baseUrl = process.env.JIRA_BASE_URL;
  if (!apiToken || !email || !baseUrl) return null;
  return { email, apiToken, baseUrl: baseUrl.replace(/\/$/, "") };
}

export function getNotionToken(): string | null {
  return process.env.NOTION_TOKEN || null;
}

export function getSlackToken(): string | null {
  return process.env.SLACK_TOKEN || null;
}

export function getAnthropicKey(): string | null {
  return process.env.ANTHROPIC_API_KEY || null;
}

export interface WorkspaceConfig {
  shellEnv: string;
  reposRoot: string;
  wslDistro?: string;
}

export function getWorkspace(): WorkspaceConfig | null {
  const shellEnv = process.env.SHELL_ENV;
  const reposRoot = process.env.REPOS_ROOT;
  if (!shellEnv || !reposRoot) return null;
  return { shellEnv, reposRoot, wslDistro: process.env.WSL_DISTRO };
}
