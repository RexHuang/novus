/**
 * project-memory — project-level persistent memory
 *
 * Problem: across dev sessions, project progress/decisions/todos lived only in ad-hoc code reading.
 * This module provides a structured project profile, auto-injecting project context on session resume.
 *
 * Storage: ~/.novus/projects/<project-slug>.json
 * One file per project; complements session-context:
 *   - session-context: "what I'm working on right now"
 *   - project-memory:  "where this project stands"
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PROJECTS_DIR = join(homedir(), ".novus", "projects");

// ── Types ──────────────────────────────────────────────────────────

export interface ProjectDecision {
  date: string;
  decision: string;
  reason: string;
}

export interface ProjectModule {
  name: string;
  status: "done" | "in-progress" | "not-started";
  detail?: string;
  files?: string[];
}

export interface ProjectProfile {
  slug: string;
  name: string;
  description: string;
  techStack: string[];
  /** module progress */
  modules: ProjectModule[];
  /** key decision records */
  decisions: ProjectDecision[];
  /** todo queue (high → low priority) */
  todo: string[];
  /** files from the last work session */
  lastFiles: string[];
  /** last work summary (one sentence) */
  lastWork: string;
  /** next step plan */
  nextStep: string;
  /** created at */
  createdAt: string;
  /** last updated at */
  updatedAt: string;
}

// ── Storage ────────────────────────────────────────────────────────

function ensureDir(): void {
  if (!existsSync(PROJECTS_DIR)) mkdirSync(PROJECTS_DIR, { recursive: true });
}

function profilePath(slug: string): string {
  return join(PROJECTS_DIR, `${slug}.json`);
}

// ── Core API ───────────────────────────────────────────────────────

/** Load a project profile */
export function loadProject(slug: string): ProjectProfile | null {
  const path = profilePath(slug);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ProjectProfile;
  } catch {
    return null;
  }
}

/** Save a project profile */
export function saveProject(profile: ProjectProfile): void {
  ensureDir();
  profile.updatedAt = new Date().toISOString();
  writeFileSync(profilePath(profile.slug), JSON.stringify(profile, null, 2), "utf-8");
}

/** List all project slugs */
export function listProjects(): string[] {
  ensureDir();
  try {
    return readdirSync(PROJECTS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''));
  } catch {
    return [];
  }
}

/** Quick update: set lastWork + nextStep + lastFiles + timestamp */
export function touchProject(slug: string, opts: {
  lastWork?: string;
  nextStep?: string;
  lastFiles?: string[];
}): void {
  const p = loadProject(slug);
  if (!p) return;
  if (opts.lastWork) p.lastWork = opts.lastWork;
  if (opts.nextStep) p.nextStep = opts.nextStep;
  if (opts.lastFiles) p.lastFiles = opts.lastFiles;
  saveProject(p);
}

/** Update a module status */
export function updateModule(slug: string, moduleName: string, status: ProjectModule["status"], detail?: string): void {
  const p = loadProject(slug);
  if (!p) return;
  const mod = p.modules.find(m => m.name === moduleName);
  if (mod) {
    mod.status = status;
    if (detail) mod.detail = detail;
  } else {
    p.modules.push({ name: moduleName, status, detail });
  }
  saveProject(p);
}

/** Add a decision record */
export function addDecision(slug: string, decision: string, reason: string): void {
  const p = loadProject(slug);
  if (!p) return;
  p.decisions.push({ date: new Date().toISOString(), decision, reason });
  // Keep last 50 decisions
  if (p.decisions.length > 50) p.decisions = p.decisions.slice(-50);
  saveProject(p);
}

/** Add a todo item (dedup by prefix match) */
export function addTodo(slug: string, item: string): void {
  const p = loadProject(slug);
  if (!p) return;
  // Dedup: skip if any existing todo starts with the same first 10 chars
  if (p.todo.some(t => t.slice(0, 15) === item.slice(0, 15))) return;
  p.todo.push(item);
  saveProject(p);
}

/** Complete a todo item */
export function completeTodo(slug: string, item: string): void {
  const p = loadProject(slug);
  if (!p) return;
  p.todo = p.todo.filter(t => t.slice(0, 15) !== item.slice(0, 15));
  saveProject(p);
}

// ── Context Injection ──────────────────────────────────────────────

/** Generate a project context summary for injecting into system prompt */
export function projectContextSummary(slug: string): string {
  const p = loadProject(slug);
  if (!p) return "";

  const modules = p.modules.map(m => {
    const icon = m.status === "done" ? "✅" : m.status === "in-progress" ? "🔄" : "⬜";
    return `  ${icon} ${m.name}${m.detail ? ` — ${m.detail}` : ""}`;
  }).join("\n");

  const recentDecisions = p.decisions.slice(-3).map(d =>
    `  - ${d.decision}（${d.reason}）`
  ).join("\n");

  const todos = p.todo.slice(0, 5).map((t, i) =>
    `  ${i + 1}. ${t}`
  ).join("\n");

  return [
    `## 📁 Current project: ${p.name}`,
    `${p.description}`,
    `**Tech stack**: ${p.techStack.join(", ")}`,
    `**Last work**: ${p.lastWork || "none"}`,
    `**Next step**: ${p.nextStep || "none"}`,
    "",
    "**Module progress:**",
    modules,
  ].join("\n")
    + (recentDecisions ? `\n\n**Recent decisions:**\n${recentDecisions}` : "")
    + (todos ? `\n\n**Todos:**\n${todos}` : "");
}

/** Find the most recently updated project */
export function getActiveProject(): ProjectProfile | null {
  const slugs = listProjects();
  if (slugs.length === 0) return null;
  let latest: ProjectProfile | null = null;
  for (const s of slugs) {
    const p = loadProject(s);
    if (p && (!latest || p.updatedAt > latest.updatedAt)) latest = p;
  }
  return latest;
}