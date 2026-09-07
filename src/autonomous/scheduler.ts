/**
 * Autonomous Task Scheduler
 *
 * Autonomous task scheduler — turns novus from a passive tool into an agent that triggers its own actions.
 *
 * Core design:
 *   - Tasks stored in ~/.novus/autonomous/tasks.json
 *   - On every session start, identity checks for due tasks
 *   - Three trigger types: on-start / periodic / event
 *   - Execution results recorded to execution history
 *
 * Note: due to capability boundaries (can't run a daemon), no real timers are implemented —
 * instead, each startup checks whether periodic tasks are due.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const AUTONOMOUS_DIR = join(homedir(), ".novus", "autonomous");
const TASKS_FILE = join(AUTONOMOUS_DIR, "tasks.json");
const HISTORY_FILE = join(AUTONOMOUS_DIR, "history.jsonl");

// ===== Data structures =====

export type TaskTrigger = "on-start" | "on-start-recurring" | "periodic" | "event" | "delay-until";
export type TaskStatus = "active" | "paused" | "completed" | "failed";

export interface AutonomousTask {
  id: string;
  /** Task name */
  name: string;
  /** Task description (concrete instruction of what to do) */
  instruction: string;
  /** Trigger type */
  trigger: TaskTrigger;
  /** Interval for periodic tasks (hours), default 24 */
  intervalHours?: number;
  /** Event trigger condition, e.g. "knowledge > 100" */
  eventCondition?: string;
  /** delay-until: fires once at/after the given time (ISO datetime) */
  delayUntil?: string;
  /** Task status */
  status: TaskStatus;
  /** Created at */
  createdAt: string;
  /** Last run at */
  lastRunAt?: string;
  /** Next due time */
  nextRunAt?: string;
  /** Run count */
  runCount: number;
  /** Success count */
  successCount: number;
  /** Tags for classification */
  tags?: string[];
  /** Latest quality score 0-1 */
  lastQualityScore?: number;
  /** Consecutive low-quality count */
  lowQualityStreak?: number;
}

export interface TaskExecution {
  taskId: string;
  taskName: string;
  startedAt: string;
  completedAt?: string;
  success: boolean;
  summary?: string;
  qualityScore?: number;
  error?: string;
}

// ===== Storage =====

function ensureDir(): void {
  if (!existsSync(AUTONOMOUS_DIR)) {
    mkdirSync(AUTONOMOUS_DIR, { recursive: true });
  }
}

function generateId(): string {
  // timestamp(10ch) + random chars(8ch) = 18-char unique ID
  return Date.now().toString(36).padStart(6, '0') + Math.random().toString(36).slice(2, 10);
}

function loadTasks(): AutonomousTask[] {
  if (!existsSync(TASKS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(TASKS_FILE, "utf-8")) as AutonomousTask[];
  } catch {
    return [];
  }
}

function saveTasks(tasks: AutonomousTask[]): void {
  ensureDir();
  writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2), "utf-8");
}

// ===== Core API =====

/** Register a new task */
export function registerTask(opts: {
  name: string;
  instruction: string;
  trigger: TaskTrigger;
  intervalHours?: number;
  eventCondition?: string;
  delayUntil?: string;
  tags?: string[];
  /** Latest quality score 0-1 */
  lastQualityScore?: number;
  /** Consecutive low-quality count */
  lowQualityStreak?: number;
}): AutonomousTask {
  const now = new Date().toISOString();
  const task: AutonomousTask = {
    id: generateId(),
    name: opts.name,
    instruction: opts.instruction,
    trigger: opts.trigger,
    intervalHours: opts.intervalHours ?? 24,
    eventCondition: opts.eventCondition,
    status: "active",
    createdAt: now,
    runCount: 0,
    successCount: 0,
    tags: opts.tags,
  };

  // Set initial nextRunAt
  if (opts.trigger === "periodic") {
    task.nextRunAt = now; // runs right after first registration
  } else if (opts.trigger === "on-start" || opts.trigger === "on-start-recurring") {
    task.nextRunAt = now;
  } else if (opts.trigger === "delay-until") {
    task.delayUntil = opts.delayUntil ?? now;
    task.nextRunAt = task.delayUntil;
  }

  const tasks = loadTasks();
  tasks.push(task);
  saveTasks(tasks);
  return task;
}

/** List all tasks, optionally filtered by status */
export function listTasks(filter?: TaskStatus): AutonomousTask[] {
  const tasks = loadTasks();
  if (filter) return tasks.filter(t => t.status === filter);
  return tasks;
}

/** Pause/resume/complete/delete a task */
export function updateTaskStatus(taskId: string, status: TaskStatus): AutonomousTask | null {
  const tasks = loadTasks();
  const task = getTask(taskId);
  if (!task) return null;
  task.status = status;
  saveTasks(tasks);
  return task;
}

/** Delete a task */
export function deleteTask(taskId: string): boolean {
  const tasks = loadTasks();
  const task = getTask(taskId);
  if (!task) return false;
  const idx = tasks.findIndex(t => t.id === task.id);
  if (idx === -1) return false;
  tasks.splice(idx, 1);
  saveTasks(tasks);
  return true;
}

/**
 * Get a single task — by full ID or prefix.
 * Tries exact match first, then prefix match.
 * If a prefix matches multiple tasks, returns null (ambiguous reference).
 */
export function getTask(taskId: string): AutonomousTask | null {
  const tasks = loadTasks();
  // exact match
  const exact = tasks.find(t => t.id === taskId);
  if (exact) return exact;
  // prefix match
  const prefixMatches = tasks.filter(t => t.id.startsWith(taskId));
  if (prefixMatches.length === 1) return prefixMatches[0];
  return null;
}

/**
 * Compute the shortest unique prefix of a task ID, for display.
 * Ensures the displayed prefix uniquely identifies the task.
 */
export function shortId(taskId: string): string {
  const tasks = loadTasks();
  // start at 4 chars, grow until unique
  for (let len = 4; len <= taskId.length; len++) {
    const prefix = taskId.slice(0, len);
    const matches = tasks.filter(t => t.id.startsWith(prefix));
    if (matches.length === 1) return prefix;
  }
  return taskId;
}

/**
 * Check which tasks should run.
 * Doesn't execute — returns the list of "due" tasks.
 * Called by identity.ts at startup, injected into the system prompt.
 */
export function getDueTasks(): AutonomousTask[] {
  const tasks = loadTasks();
  const now = new Date();
  const due: AutonomousTask[] = [];

  for (const task of tasks) {
    if (task.status !== "active") continue;

    if (task.trigger === "on-start" || task.trigger === "on-start-recurring" || task.trigger === "periodic" || task.trigger === "delay-until") {
      if (!task.nextRunAt) {
        // no nextRunAt — set to now
        task.nextRunAt = now.toISOString();
        due.push(task);
        continue;
      }
      const nextRun = new Date(task.nextRunAt);
      if (now >= nextRun) {
        due.push(task);
      }
    }
    // event tasks aren't triggered here; external condition checks needed
  }

  return due;
}

/**
 * Mark a task as executed, update scheduling.
 * Called by the auto-manage tool after a task runs.
 */
/**
 * Evaluate task execution quality (0-1)
 * Based on summary analysis: length, info density, real findings
 */
function evaluateQuality(summary: string | undefined): number {
  if (!summary || summary.trim().length === 0) return 0;
  const s = summary.trim();

  // explicit negative signals (zh + en)
  if (/^(无|没有|未|不需要|不适用|n\/a|none|nothing|not\s)/i.test(s)) return 0.1;
  if (/网络限制|未执行|跳过|skip|not executed|skipped|network restriction/i.test(s)) return 0.1;
  if (/正常|无异常|无问题|no issue|^ok\b|^all good/i.test(s) && s.length < 30) return 0.2;

  let score = 0.5; // baseline score

  // length bonus (substantial content is usually longer)
  if (s.length > 50) score += 0.1;
  if (s.length > 100) score += 0.1;
  if (s.length > 200) score += 0.1;

  // info-density bonus: contains concrete data/findings
  if (/\\d+/.test(s)) score += 0.05;
  if (/发现|找到|识别|追踪到|获取|完成.*发现|found|identified|discovered|tracked|completed/i.test(s)) score += 0.1;
  if (/(?:https?:|arXiv|github\\.com|\\$|USD|\\d+%)/.test(s)) score += 0.05;

  return Math.min(score, 1.0);
}

export function markTaskExecuted(taskId: string, success: boolean, summary?: string): AutonomousTask | null {
  const tasks = loadTasks();
  const task = tasks.find(t => t.id === taskId || t.id.startsWith(taskId));
  if (!task) return null;

  const now = new Date().toISOString();
  task.lastRunAt = now;
  task.runCount++;

  if (success) {
    task.successCount++;
  }

  // assess output quality
  const quality = evaluateQuality(summary);
  task.lastQualityScore = quality;

  // consecutive low-quality detection: quality < 0.3 counts as low
  if (quality < 0.3) {
    task.lowQualityStreak = (task.lowQualityStreak ?? 0) + 1;
  } else {
    task.lowQualityStreak = 0;
  }

  // auto-throttle/pause policy
  if (task.lowQualityStreak >= 4) {
    task.status = "paused";
  } else if (task.lowQualityStreak >= 2 && task.trigger === "periodic") {
    // 2 consecutive low-quality: double the interval, max 7 days
    task.intervalHours = Math.min((task.intervalHours ?? 24) * 2, 168);
  }

  // update next run time
  if (task.trigger === "periodic") {
    const intervalMs = (task.intervalHours ?? 24) * 60 * 60 * 1000;
    const lastRun = task.lastRunAt ? new Date(task.lastRunAt) : new Date();
    task.nextRunAt = new Date(lastRun.getTime() + intervalMs).toISOString();
  }

  // on-start / delay-until (one-shot) tasks pause after success
  if ((task.trigger === "on-start" || task.trigger === "delay-until") && success) {
    task.status = "paused";
  }
  // on-start-recurring tasks don't pause; run again next startup

  saveTasks(tasks);

  // record execution history
  recordExecution({
    taskId: task.id,
    taskName: task.name,
    startedAt: task.lastRunAt,
    completedAt: now,
    success,
    summary,
    qualityScore: quality,
  });

  return task;
}

/** Record execution history */
function recordExecution(exec: TaskExecution): void {
  ensureDir();
  appendFileSync(HISTORY_FILE, JSON.stringify(exec) + "\n", "utf-8");
}

/** Get execution history */
/** Max history entries before rotation */
const MAX_HISTORY_ENTRIES = 500;

/**
 * Get execution history, auto-rotating oversized files.
 * Keeps the last MAX_HISTORY_ENTRIES entries to prevent unbounded JSONL growth.
 */
export function getExecutionHistory(limit: number = 20): TaskExecution[] {
  if (!existsSync(HISTORY_FILE)) return [];
  try {
    const raw = readFileSync(HISTORY_FILE, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);

    // Auto-rotate if file exceeds threshold
    if (lines.length > MAX_HISTORY_ENTRIES) {
      const trimmed = lines.slice(-MAX_HISTORY_ENTRIES);
      writeFileSync(HISTORY_FILE, trimmed.join("\n") + "\n", "utf-8");
      return trimmed
        .map(line => JSON.parse(line) as TaskExecution)
        .reverse()
        .slice(0, limit);
    }

    return lines
      .map(line => JSON.parse(line) as TaskExecution)
      .reverse()
      .slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Generate the autonomous task summary — for identity to inject at startup;
 * due tasks instruct the agent to run them proactively (auto-manage action=run)
 */
export function buildAutonomousSummary(): string {
  const due = getDueTasks();
  const active = listTasks("active");

  if (active.length === 0) return "";

  const parts: string[] = [];

  // active tasks: one compact line each
  const taskNames = active.slice(0, 4).map(t => {
    const icon = t.trigger === "on-start" || t.trigger === "on-start-recurring" ? "🚀" : t.trigger === "periodic" ? "🔄" : t.trigger === "delay-until" ? "⏰" : "⚡";
    return icon + t.name;
  }).join(", ");
  const suffix = active.length > 4 ? " +" + (active.length - 4) : "";
  parts.push(active.length + " active (" + taskNames + suffix + ")");

  // due tasks: explicitly instruct execution
  if (due.length > 0) {
    const dueNames = due.map(t => t.name).join(", ");
    parts.push(due.length + " due: " + dueNames);
    if (due.length > 0) {
      parts.push("→ you MUST execute due tasks now: auto-manage action=run");
    }
  }

  // event tasks: show trigger conditions so the agent knows when to run
  const eventTasks = active.filter(t => t.trigger === "event" && t.eventCondition);
  if (eventTasks.length > 0) {
    const eventInfo = eventTasks.map(t => `${t.name}（${t.eventCondition} → auto-manage action=run taskId=${shortId(t.id)}）`).join("; ");
    parts.push("⚡Events: " + eventInfo);
  }

  return parts.join(" | ");
}
