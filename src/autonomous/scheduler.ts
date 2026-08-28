/**
 * Autonomous Task Scheduler
 *
 * 自主任务调度系统 —— 让 novus 从被动工具变成能自主触发行动的 agent。
 *
 * 核心设计：
 *   - 任务存储在 ~/.novus/autonomous/tasks.json
 *   - 每次会话启动时，identity 自动检查待执行任务
 *   - 支持三种触发类型：on-start / periodic / event
 *   - 任务执行结果记录到执行历史
 *
 * 注意：由于能力边界（不能跑daemon），不实现真正的定时器，
 * 而是在每次启动时检查 periodic 任务是否到期。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const AUTONOMOUS_DIR = join(homedir(), ".novus", "autonomous");
const TASKS_FILE = join(AUTONOMOUS_DIR, "tasks.json");
const HISTORY_FILE = join(AUTONOMOUS_DIR, "history.jsonl");

// ===== 数据结构 =====

export type TaskTrigger = "on-start" | "on-start-recurring" | "periodic" | "event" | "delay-until";
export type TaskStatus = "active" | "paused" | "completed" | "failed";

export interface AutonomousTask {
  id: string;
  /** 任务名称 */
  name: string;
  /** 任务描述（要做什么的具体指令） */
  instruction: string;
  /** 触发类型 */
  trigger: TaskTrigger;
  /** periodic 任务的间隔（小时），默认24 */
  intervalHours?: number;
  /** event 触发的条件描述，如 "knowledge > 100" */
  eventCondition?: string;
  /** delay-until 指定时间后才触发（ISO datetime），过期后一次性执行 */
  delayUntil?: string;
  /** 任务状态 */
  status: TaskStatus;
  /** 创建时间 */
  createdAt: string;
  /** 最后执行时间 */
  lastRunAt?: string;
  /** 下次应该执行的时间 */
  nextRunAt?: string;
  /** 执行次数 */
  runCount: number;
  /** 成功次数 */
  successCount: number;
  /** 标签，方便分类 */
  tags?: string[];
  /** 最近一次质量评分 0-1 */
  lastQualityScore?: number;
  /** 连续低质量次数 */
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

// ===== 存储 =====

function ensureDir(): void {
  if (!existsSync(AUTONOMOUS_DIR)) {
    mkdirSync(AUTONOMOUS_DIR, { recursive: true });
  }
}

function generateId(): string {
  // 时间戳(10char) + 随机字符(8char) = 18位唯一ID
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

// ===== 核心 API =====

/** 注册一个新任务 */
export function registerTask(opts: {
  name: string;
  instruction: string;
  trigger: TaskTrigger;
  intervalHours?: number;
  eventCondition?: string;
  delayUntil?: string;
  tags?: string[];
  /** 最近一次质量评分 0-1 */
  lastQualityScore?: number;
  /** 连续低质量次数 */
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
    task.nextRunAt = now; // 首次注册后就可以执行
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

/** 列出所有任务，支持按状态过滤 */
export function listTasks(filter?: TaskStatus): AutonomousTask[] {
  const tasks = loadTasks();
  if (filter) return tasks.filter(t => t.status === filter);
  return tasks;
}

/** 暂停/恢复/完成/删除任务 */
export function updateTaskStatus(taskId: string, status: TaskStatus): AutonomousTask | null {
  const tasks = loadTasks();
  const task = getTask(taskId);
  if (!task) return null;
  task.status = status;
  saveTasks(tasks);
  return task;
}

/** 删除任务 */
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
 * 获取单个任务 —— 支持完整ID或前缀匹配。
 * 先尝试精确匹配，再尝试前缀匹配。
 * 如果前缀匹配到多个任务，返回 null（不明确的引用）。
 */
export function getTask(taskId: string): AutonomousTask | null {
  const tasks = loadTasks();
  // 精确匹配
  const exact = tasks.find(t => t.id === taskId);
  if (exact) return exact;
  // 前缀匹配
  const prefixMatches = tasks.filter(t => t.id.startsWith(taskId));
  if (prefixMatches.length === 1) return prefixMatches[0];
  return null;
}

/**
 * 计算任务ID的最短唯一前缀，用于显示。
 * 确保显示的前缀能唯一标识该任务。
 */
export function shortId(taskId: string): string {
  const tasks = loadTasks();
  // 从4位开始递增，直到唯一
  for (let len = 4; len <= taskId.length; len++) {
    const prefix = taskId.slice(0, len);
    const matches = tasks.filter(t => t.id.startsWith(prefix));
    if (matches.length === 1) return prefix;
  }
  return taskId;
}

/**
 * 检查哪些任务应该执行。
 * 不实际执行，只返回「建议执行」的任务列表。
 * 由 identity.ts 在启动时调用，注入到系统提示中。
 */
export function getDueTasks(): AutonomousTask[] {
  const tasks = loadTasks();
  const now = new Date();
  const due: AutonomousTask[] = [];

  for (const task of tasks) {
    if (task.status !== "active") continue;

    if (task.trigger === "on-start" || task.trigger === "on-start-recurring" || task.trigger === "periodic" || task.trigger === "delay-until") {
      if (!task.nextRunAt) {
        // 没有 nextRunAt，设为现在
        task.nextRunAt = now.toISOString();
        due.push(task);
        continue;
      }
      const nextRun = new Date(task.nextRunAt);
      if (now >= nextRun) {
        due.push(task);
      }
    }
    // event 类型的任务不在这里触发，需要外部判断条件
  }

  return due;
}

/**
 * 标记任务已执行，更新调度时间。
 * 由 auto-manage 工具在任务执行后调用。
 */
/**
 * 评估任务执行的质量（0-1）
 * 基于 summary 内容分析：长度、信息密度、是否有实质发现
 */
function evaluateQuality(summary: string | undefined): number {
  if (!summary || summary.trim().length === 0) return 0;
  const s = summary.trim();

  // 明确的负面信号
  if (/^(无|没有|未|不需要|不适用|n\/a)/.test(s)) return 0.1;
  if (/网络限制|未执行|跳过|skip/.test(s)) return 0.1;
  if (/正常|无异常|无问题|no issue/.test(s) && s.length < 30) return 0.2;

  let score = 0.5; // 基准分

  // 长度加分（有实质内容通常更长）
  if (s.length > 50) score += 0.1;
  if (s.length > 100) score += 0.1;
  if (s.length > 200) score += 0.1;

  // 信息密度加分：包含具体数据/发现
  if (/\\d+/.test(s)) score += 0.05;
  if (/发现|找到|识别|追踪到|获取|完成.*发现/.test(s)) score += 0.1;
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

  // 评估产出质量
  const quality = evaluateQuality(summary);
  task.lastQualityScore = quality;

  // 连续低质量检测：质量 < 0.3 算低质量
  if (quality < 0.3) {
    task.lowQualityStreak = (task.lowQualityStreak ?? 0) + 1;
  } else {
    task.lowQualityStreak = 0;
  }

  // 自动降频/暂停策略
  if (task.lowQualityStreak >= 4) {
    task.status = "paused";
  } else if (task.lowQualityStreak >= 2 && task.trigger === "periodic") {
    // 连续2次低质量：间隔翻倍，最多翻到7天
    task.intervalHours = Math.min((task.intervalHours ?? 24) * 2, 168);
  }

  // 更新下次执行时间
  if (task.trigger === "periodic") {
    const intervalMs = (task.intervalHours ?? 24) * 60 * 60 * 1000;
    const lastRun = task.lastRunAt ? new Date(task.lastRunAt) : new Date();
    task.nextRunAt = new Date(lastRun.getTime() + intervalMs).toISOString();
  }

  // on-start / delay-until（一次性）任务执行成功后暂停
  if ((task.trigger === "on-start" || task.trigger === "delay-until") && success) {
    task.status = "paused";
  }
  // on-start-recurring 任务不暂停，下次启动继续执行

  saveTasks(tasks);

  // 记录执行历史
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

/** 记录执行历史 */
function recordExecution(exec: TaskExecution): void {
  ensureDir();
  appendFileSync(HISTORY_FILE, JSON.stringify(exec) + "\n", "utf-8");
}

/** 获取执行历史 */
/** Max history entries before rotation */
const MAX_HISTORY_ENTRIES = 500;

/**
 * 获取执行历史，自动轮转超大文件。
 * 保留最近 MAX_HISTORY_ENTRIES 条，防止 JSONL 无限增长。
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
 * 生成自主任务摘要 —— 供 identity 启动时注入
 * 到期任务要求 agent 主动执行（auto-manage action=run）
 */
export function buildAutonomousSummary(): string {
  const due = getDueTasks();
  const active = listTasks("active");

  if (active.length === 0) return "";

  const parts: string[] = [];

  // 活跃任务：紧凑一行
  const taskNames = active.slice(0, 4).map(t => {
    const icon = t.trigger === "on-start" || t.trigger === "on-start-recurring" ? "🚀" : t.trigger === "periodic" ? "🔄" : t.trigger === "delay-until" ? "⏰" : "⚡";
    return icon + t.name;
  }).join(", ");
  const suffix = active.length > 4 ? " +" + (active.length - 4) : "";
  parts.push(active.length + " active (" + taskNames + suffix + ")");

  // 到期任务：明确要求执行
  if (due.length > 0) {
    const dueNames = due.map(t => t.name).join(", ");
    parts.push(due.length + " due: " + dueNames);
    if (due.length > 0) {
      parts.push("→ 你必须执行到期任务: auto-manage action=run");
    }
  }

  // event 任务：展示触发条件，让 agent 知道何时执行
  const eventTasks = active.filter(t => t.trigger === "event" && t.eventCondition);
  if (eventTasks.length > 0) {
    const eventInfo = eventTasks.map(t => `${t.name}（${t.eventCondition} → auto-manage action=run taskId=${shortId(t.id)}）`).join("; ");
    parts.push("⚡Events: " + eventInfo);
  }

  return parts.join(" | ");
}
