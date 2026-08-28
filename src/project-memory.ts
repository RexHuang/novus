/**
 * project-memory — 项目级持久化记忆
 *
 * 解决问题：跨会话开发时，项目进度、决策、待办全靠临时看代码。
 * 本模块提供结构化的项目档案，让每次恢复会话时自动注入项目上下文。
 *
 * 存储位置：~/.novus/projects/<project-slug>.json
 * 一个项目一个文件，与 session-context 互补：
 *   - session-context: "我当前在做什么"
 *   - project-memory:  "这个项目做到哪了"
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
  /** 模块进度 */
  modules: ProjectModule[];
  /** 关键决策记录 */
  decisions: ProjectDecision[];
  /** 待办队列（优先级从高到低）*/
  todo: string[];
  /** 上次工作的文件 */
  lastFiles: string[];
  /** 上次工作内容（一句话）*/
  lastWork: string;
  /** 下一步计划 */
  nextStep: string;
  /** 创建时间 */
  createdAt: string;
  /** 最后更新时间 */
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
    `## 📁 当前项目: ${p.name}`,
    `${p.description}`,
    `**技术栈**: ${p.techStack.join(", ")}`,
    `**上次工作**: ${p.lastWork || "无"}`,
    `**下一步**: ${p.nextStep || "无"}`,
    "",
    "**模块进度:**",
    modules,
  ].join("\n")
    + (recentDecisions ? `\n\n**最近决策:**\n${recentDecisions}` : "")
    + (todos ? `\n\n**待办:**\n${todos}` : "");
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