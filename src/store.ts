import fs from "fs";
import path from "path";
import os from "os";

const DATA_DIR = path.join(os.homedir(), ".coolplugz");
const DATA_FILE = path.join(DATA_DIR, "data.json");

export interface Task {
  id: string;
  jiraKey: string;
  title: string;
  status: string;
  repo: string | null;
  repos: string[];
  branch: string | null;
  prUrl: string | null;
  prNumber: number | null;
  prUrls: string[];
  prNumbers: number[];
  epicKey: string | null;
  retryCount: number;
  lastError: string | null;
  workspaceId: string | null;
  updatedAt: string;
  createdAt: string;
}

export interface ContextSnapshot {
  id: string;
  taskId: string;
  source: string;
  summary: string;
  refUrl?: string;
  fetchedAt: string;
}

export interface RepoMapping {
  jiraProject: string;
  repo: string;
  source: string;
}

export interface DeveloperInsight {
  id: string;
  taskId: string | null;
  scope: "global" | "task";
  text: string;
  active: boolean;
  createdAt: string;
}

export interface PromptRecord {
  id: string;
  taskId: string;
  crispeJson: Record<string, any>;
  fullPrompt: string;
  tokenCount: number;
  costEstimate: number;
  createdAt: string;
}

interface StoreData {
  tasks: Task[];
  snapshots: ContextSnapshot[];
  mappings: RepoMapping[];
  insights: DeveloperInsight[];
  prompts: PromptRecord[];
}

function ensureDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function load(): StoreData {
  ensureDir();
  if (!fs.existsSync(DATA_FILE)) {
    return { tasks: [], snapshots: [], mappings: [], insights: [], prompts: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  } catch {
    return { tasks: [], snapshots: [], mappings: [], insights: [], prompts: [] };
  }
}

function save(data: StoreData): void {
  ensureDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function genId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ── Task operations ─────────────────────────────────────────────────────

export function findTaskByJiraKey(jiraKey: string): Task | null {
  const data = load();
  return data.tasks.find((t) => t.jiraKey === jiraKey.toUpperCase()) || null;
}

export function findTaskById(id: string): Task | null {
  const data = load();
  return data.tasks.find((t) => t.id === id) || null;
}

export function getAllTasks(): Task[] {
  return load().tasks;
}

export function upsertTask(jiraKey: string, updates: Partial<Task>): Task {
  const data = load();
  const existing = data.tasks.find((t) => t.jiraKey === jiraKey.toUpperCase());
  if (existing) {
    Object.assign(existing, updates, { updatedAt: new Date().toISOString() });
    save(data);
    return existing;
  }
  const task: Task = {
    id: genId(),
    jiraKey: jiraKey.toUpperCase(),
    title: updates.title || jiraKey,
    status: updates.status || "QUEUED",
    repo: updates.repo || null,
    repos: updates.repos || [],
    branch: updates.branch || null,
    prUrl: updates.prUrl || null,
    prNumber: updates.prNumber || null,
    prUrls: updates.prUrls || [],
    prNumbers: updates.prNumbers || [],
    epicKey: updates.epicKey || null,
    retryCount: updates.retryCount || 0,
    lastError: updates.lastError || null,
    workspaceId: null,
    updatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    ...updates,
  };
  data.tasks.push(task);
  save(data);
  return task;
}

export function updateTask(id: string, updates: Partial<Task>): Task | null {
  const data = load();
  const task = data.tasks.find((t) => t.id === id);
  if (!task) return null;
  Object.assign(task, updates, { updatedAt: new Date().toISOString() });
  save(data);
  return task;
}

// ── Context snapshots ───────────────────────────────────────────────────

export function getSnapshots(taskId: string): ContextSnapshot[] {
  return load().snapshots.filter((s) => s.taskId === taskId);
}

export function getSnapshotBySource(taskId: string, source: string): ContextSnapshot | null {
  return load().snapshots.find((s) => s.taskId === taskId && s.source === source) || null;
}

export function upsertSnapshot(id: string, taskId: string, source: string, summary: string, refUrl?: string): void {
  const data = load();
  const existing = data.snapshots.find((s) => s.id === id);
  if (existing) {
    existing.summary = summary;
    existing.fetchedAt = new Date().toISOString();
    if (refUrl) existing.refUrl = refUrl;
  } else {
    data.snapshots.push({ id, taskId, source, summary, refUrl, fetchedAt: new Date().toISOString() });
  }
  save(data);
}

// ── Repo mappings ───────────────────────────────────────────────────────

export function getRepoMapping(jiraProject: string): RepoMapping | null {
  return load().mappings.find((m) => m.jiraProject === jiraProject) || null;
}

export function saveRepoMapping(jiraProject: string, repo: string, source: string): void {
  const data = load();
  const existing = data.mappings.find((m) => m.jiraProject === jiraProject);
  if (existing) {
    existing.repo = repo;
    existing.source = source;
  } else {
    data.mappings.push({ jiraProject, repo, source });
  }
  save(data);
}

// ── Developer insights ──────────────────────────────────────────────────

export function getInsights(taskId?: string): DeveloperInsight[] {
  const data = load();
  return data.insights.filter((i) => {
    if (!i.active) return false;
    if (taskId) return i.scope === "global" || i.taskId === taskId;
    return i.scope === "global";
  });
}

export function addInsight(scope: "global" | "task", text: string, taskId?: string): DeveloperInsight {
  const data = load();
  const insight: DeveloperInsight = {
    id: genId(),
    taskId: scope === "task" ? (taskId || null) : null,
    scope,
    text,
    active: true,
    createdAt: new Date().toISOString(),
  };
  data.insights.push(insight);
  save(data);
  return insight;
}

// ── Prompt records ──────────────────────────────────────────────────────

export function savePromptRecord(taskId: string, crispeJson: Record<string, any>, fullPrompt: string, tokenCount: number, costEstimate: number): void {
  const data = load();
  data.prompts.push({
    id: genId(),
    taskId,
    crispeJson,
    fullPrompt,
    tokenCount,
    costEstimate,
    createdAt: new Date().toISOString(),
  });
  save(data);
}

export function getLatestPrompt(taskId: string): PromptRecord | null {
  const data = load();
  const matching = data.prompts.filter((p) => p.taskId === taskId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return matching[0] || null;
}
