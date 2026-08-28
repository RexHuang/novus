/**
 * Evolution Tracker — 进化追踪系统
 *
 * 核心设计理念：让自我进化「可见、可感知、可量化」
 *
 * 每次进化事件都被记录，包含：
 *   - 进化了什么（能力变化）
 *   - 为什么进化（触发原因）
 *   - 效果如何（量化指标）
 *
 * 支持能力自评，生成进化仪表盘数据。
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const EVOLUTION_DIR = join(homedir(), ".novus", "evolution");
const EVOLUTION_LOG = join(EVOLUTION_DIR, "evolutions.jsonl");
const CAPABILITY_SNAPSHOT = join(EVOLUTION_DIR, "capabilities.json");
const ERROR_PATTERNS_FILE = join(EVOLUTION_DIR, "error-patterns.json");
const PATTERN_TRIGGER_LOG = join(EVOLUTION_DIR, "pattern-triggers.jsonl");

/** Time window for "recent count" — 30 days */
const RECENT_WINDOW_DAYS = 30;

// ===== 错误模式识别 =====

export interface ErrorPattern {
  id: string;
  /** 错误类型标签，如 'over-tool-calling', 'guess-instead-of-ask' */
  pattern: string;
  /** 触发条件和具体表现 */
  description: string;
  /** 规避策略（注入到元认知中） */
  avoidanceRule: string;
  /** 首次发现时间 */
  firstSeen: string;
  /** 最后一次发生 */
  lastSeen: string;
  /** 历史总次数 */
  count: number;
  /** 最近30天触发次数 */
  recentCount: number;
}

const DEFAULT_ERROR_PATTERNS: ErrorPattern[] = [
  {
    id: "builtin-over-tool",
    pattern: "over-tool-calling",
    description: "为了显得在做事，一次调用6+个工具，其中大部分是冗余的",
    avoidanceRule: "每次行动前问自己：最少需要几个工具调用？一个精准调用胜过六个冗余调用",
    firstSeen: "2026-07-27T00:00:00Z",
    lastSeen: "2026-07-27T00:00:00Z",
    count: 1,
    recentCount: 1,
  },
  {
    id: "builtin-repetitive-recall",
    pattern: "repetitive-recall",
    description: "同一会话内多次recall相同内容，浪费轮次",
    avoidanceRule: "同一会话内不要重复recall。已经recall过的内容记住即可，不需要再次查询",
    firstSeen: "2026-07-27T00:00:00Z",
    lastSeen: "2026-07-27T00:00:00Z",
    count: 1,
    recentCount: 1,
  },
  {
    id: "builtin-guess-not-ask",
    pattern: "guess-instead-of-ask",
    description: "对用户意图不确定时，不问而是猜测并执行长串探索",
    avoidanceRule: "不确定用户想要什么时，直接问一句。不要用一长串工具调用来探索",
    firstSeen: "2026-07-27T00:00:00Z",
    lastSeen: "2026-07-27T00:00:00Z",
    count: 1,
    recentCount: 1,
  },
  {
    id: "builtin-low-value-store",
    pattern: "low-value-reflection",
    description: "存储低价值的自我批评或错误日志，而非可执行的规则",
    avoidanceRule: "只存储可操作的改进规则。错误本身不需要存储，存储如何避免它再次发生",
    firstSeen: "2026-07-27T00:00:00Z",
    lastSeen: "2026-07-27T00:00:00Z",
    count: 1,
    recentCount: 1,
  },
  {
    id: "builtin-over-explain",
    pattern: "over-explaining",
    description: "用户问题简单却给出冗长的解释，不匹配用户风格",
    avoidanceRule: "匹配用户风格：用户简洁你也简洁，用户详细你再详细",
    firstSeen: "2026-07-27T00:00:00Z",
    lastSeen: "2026-07-27T00:00:00Z",
    count: 1,
    recentCount: 1,
  },
  {
    id: "builtin-full-rewrite",
    pattern: "unnecessary-full-rewrite",
    description: "为了改几行代码而重写整个文件，引入风险",
    avoidanceRule: "用最小化定向编辑（edit），不要整文件重写。除非创建新文件",
    firstSeen: "2026-07-28T00:00:00Z",
    lastSeen: "2026-07-28T00:00:00Z",
    count: 1,
    recentCount: 1,
  },
];

/** Load error patterns, initializing with defaults if file doesn't exist */
export function loadErrorPatterns(): ErrorPattern[] {
  if (!existsSync(ERROR_PATTERNS_FILE)) {
    ensureDir();
    writeFileSync(ERROR_PATTERNS_FILE, JSON.stringify(DEFAULT_ERROR_PATTERNS, null, 2), "utf-8");
    return [...DEFAULT_ERROR_PATTERNS];
  }
  try {
    const raw = readFileSync(ERROR_PATTERNS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as ErrorPattern[];
    // Filter out malformed entries (e.g. from interrupted writes)
    // Backfill recentCount for old entries that don't have it
    return parsed.filter(p => p && p.id && typeof p.count === 'number' && p.avoidanceRule).map(p => {
      if (p.recentCount === undefined) {
        p.recentCount = countRecentTriggers(p.pattern);
      }
      return p;
    });
  } catch {
    return [...DEFAULT_ERROR_PATTERNS];
  }
}

/** Record a trigger event to the log */
function logPatternTrigger(pattern: string, timestamp: string): void {
  ensureDir();
  appendFileSync(PATTERN_TRIGGER_LOG, JSON.stringify({ pattern, timestamp }) + "\n", "utf-8");
}

/** Count triggers in the recent window from the log */
function countRecentTriggers(pattern: string): number {
  if (!existsSync(PATTERN_TRIGGER_LOG)) return 0;
  try {
    const cutoff = Date.now() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const raw = readFileSync(PATTERN_TRIGGER_LOG, "utf-8");
    let count = 0;
    for (const line of raw.trim().split("\n").filter(Boolean)) {
      try {
        const entry = JSON.parse(line) as { pattern: string; timestamp: string };
        if (entry.pattern === pattern && new Date(entry.timestamp).getTime() > cutoff) {
          count++;
        }
      } catch { /* skip */ }
    }
    return count;
  } catch { return 0; }
}

/** Prune old trigger log entries beyond 2x the window */
function pruneTriggerLog(): void {
  if (!existsSync(PATTERN_TRIGGER_LOG)) return;
  try {
    const cutoff = Date.now() - RECENT_WINDOW_DAYS * 2 * 24 * 60 * 60 * 1000;
    const raw = readFileSync(PATTERN_TRIGGER_LOG, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    const kept = lines.filter(line => {
      try {
        const entry = JSON.parse(line) as { timestamp: string };
        return new Date(entry.timestamp).getTime() > cutoff;
      } catch { return false; }
    });
    if (kept.length < lines.length) {
      writeFileSync(PATTERN_TRIGGER_LOG, kept.join("\n") + "\n", "utf-8");
    }
  } catch { /* skip */ }
}

/** Record or update an error pattern */
export function recordErrorPattern(pattern: string, description: string, avoidanceRule: string): ErrorPattern {
  const now = new Date().toISOString();
  logPatternTrigger(pattern, now);
  // Periodically prune old log entries
  if (Math.random() < 0.1) pruneTriggerLog();

  const patterns = loadErrorPatterns();
  const existing = patterns.find(p => p.pattern === pattern);
  if (existing) {
    existing.count++;
    existing.lastSeen = now;
    existing.description = description;
    existing.avoidanceRule = avoidanceRule;
    existing.recentCount = countRecentTriggers(pattern);
    ensureDir();
    writeFileSync(ERROR_PATTERNS_FILE, JSON.stringify(patterns, null, 2), "utf-8");
    return existing;
  }
  const newPattern: ErrorPattern = {
    id: generateId(),
    pattern,
    description,
    avoidanceRule,
    firstSeen: now,
    lastSeen: now,
    count: 1,
    recentCount: 1,
  };
  patterns.push(newPattern);
  ensureDir();
  writeFileSync(ERROR_PATTERNS_FILE, JSON.stringify(patterns, null, 2), "utf-8");
  return newPattern;
}

/** Count recognized error patterns (for scoring) */
export function errorPatternCount(): number {
  return loadErrorPatterns().length;
}

// ===== 数据结构 =====

export type EvolutionType =
  | "new-tool"          // 新增工具
  | "tool-improvement"  // 现有工具改进
  | "new-module"        // 新增模块
  | "bug-fix"           // 修复bug
  | "performance"       // 性能优化
  | "knowledge"         // 知识积累
  | "prompt-engineering"// 系统提示词优化
  | "self-reflection"   // 自我反思改进
  | "architecture"      // 架构改进
  | "capability-new";   // 全新能力

export interface EvolutionEvent {
  id: string;
  timestamp: string;
  type: EvolutionType;
  /** 一句话描述进化了什么 */
  title: string;
  /** 详细描述 */
  description: string;
  /** 触发原因：用户需求 / 自我发现 / 任务需要 / 主动进化 */
  trigger: "user-request" | "self-discovery" | "task-driven" | "proactive";
  /** 影响的文件 */
  files?: string[];
  /** 量化指标（可选） */
  metrics?: Record<string, number | string>;
  /** 进化前的能力快照 */
  beforeSnapshot?: CapabilitySnapshot;
  /** 进化后的能力快照 */
  afterSnapshot?: CapabilitySnapshot;
}

export interface CapabilityDimension {
  name: string;
  /** 当前分数 0-100 */
  score: number;
  /** 描述当前水平 */
  level: string;
  /** 最近进化的摘要 */
  recentEvolution?: string;
}

export interface CapabilitySnapshot {
  timestamp: string;
  dimensions: CapabilityDimension[];
  totalScore: number;
  toolCount: number;
  knowledgeCount: number;
  evolutionCount: number;
  version: string;
}

// ===== 存储 =====

function ensureDir(): void {
  if (!existsSync(EVOLUTION_DIR)) {
    mkdirSync(EVOLUTION_DIR, { recursive: true });
  }
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * 记录一次进化事件
 */
export function logEvolution(event: Omit<EvolutionEvent, "id" | "timestamp">): EvolutionEvent {
  ensureDir();
  const full: EvolutionEvent = {
    ...event,
    id: generateId(),
    timestamp: new Date().toISOString(),
  };
  appendFileSync(EVOLUTION_LOG, JSON.stringify(full) + "\n", "utf-8");

  // 更新能力快照
  updateCapabilitySnapshot();

  return full;
}

/** 读取所有进化事件 */
export function loadEvolutions(): EvolutionEvent[] {
  if (!existsSync(EVOLUTION_LOG)) return [];
  try {
    const raw = readFileSync(EVOLUTION_LOG, "utf-8");
    return raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as EvolutionEvent);
  } catch {
    return [];
  }
}

/** 获取进化事件总数 */
export function evolutionCount(): number {
  return loadEvolutions().length;
}

// ===== 能力自评 =====

/**
 * 评估当前各维度的能力分数。
 * 基于可量化的客观指标，不是主观打分。
 */

function hasMetaCognition(): boolean {
  try {
    // Check both src and dist relative to cwd
    const bases = [process.cwd(), getNovusRoot()];
    for (const base of bases) {
      for (const sub of ["dist/identity.js", "src/identity.ts"]) {
        const p = join(base, sub);
        if (existsSync(p)) {
          const src = readFileSync(p, "utf-8");
          if (src.includes("Meta-Cognition")) return true;
        }
      }
    }
    return false;
  } catch { return false; }
}

function hasCapabilityBoundaries(): boolean {
  try {
    const bases = [process.cwd(), getNovusRoot()];
    for (const base of bases) {
      for (const sub of ["dist/identity.js", "src/identity.ts"]) {
        const p = join(base, sub);
        if (existsSync(p)) {
          const src = readFileSync(p, "utf-8");
          if (src.includes("Capability Boundaries")) return true;
        }
      }
    }
    return false;
  } catch { return false; }
}

function assessCapabilities(): CapabilityDimension[] {
  const evolutions = loadEvolutions();
  const totalKnowledge = countKnowledge();
  const coreKnowledge = countCoreKnowledge();
  const customTools = countCustomTools();
  const sessions = countSessions();

  return [
    {
      name: "工具能力",
      // Tool count has diminishing returns — cap at 70 for tools alone
      // External contributions (real PRs, published work) add the remaining 30
      score: Math.min(100, Math.min(70, 6 + customTools * 5) + countExternalContributions(evolutions) * 10),
      level: customTools === 0 ? "仅内置工具" : `6内置 + ${customTools}自定义` + (countExternalContributions(evolutions) > 0 ? ` + ${countExternalContributions(evolutions)}外部贡献` : ""),
      recentEvolution: findRecentEvolution(evolutions, ["new-tool", "tool-improvement"]),
    },
    {
      name: "知识积累",
      // Now counts ALL knowledge but weights core higher
      // Low-value "技术决策" entries count for less
      score: Math.min(100, coreKnowledge * 5 + (totalKnowledge - coreKnowledge) * 1),
      level: coreKnowledge < 10 ? "稀少" : coreKnowledge < 25 ? "积累中" : coreKnowledge < 50 ? "丰富" : "渊博",
      recentEvolution: findRecentEvolution(evolutions, ["knowledge"]),
    },
    {
      name: "自我进化",
      // No longer rewards raw evolution count. Rewards VALUE-DRIVEN evolutions.
      // Cap mechanism evolutions at 50 points. Real impact evolutions add the rest.
      score: (() => {
        const mechanismEvos = evolutions.filter(e => !isValueEvolution(e)).length;
        const valueEvos = evolutions.filter(e => isValueEvolution(e)).length;
        return Math.min(50, mechanismEvos * 5) + Math.min(50, valueEvos * 15);
      })(),
      level: (() => {
        const valueEvos = evolutions.filter(e => isValueEvolution(e)).length;
        return valueEvos === 0 ? "机制建设阶段" : valueEvos < 5 ? "开始产出价值" : valueEvos < 15 ? "价值驱动进化" : "高价值产出";
      })(),
      recentEvolution: findRecentEvolution(evolutions, ["new-tool", "new-module", "architecture", "capability-new"]),
    },
    {
      name: "自我认知",
      // Simpler: meta-cognition exists? + error patterns + capability boundaries
      // No longer rewards "creating the mechanism" — rewards actual awareness depth
      score: Math.min(100,
        (hasMetaCognition() ? 20 : 0)
        + (hasCapabilityBoundaries() ? 20 : 0)
        + Math.min(30, errorPatternCount() * 6)
        + (evolutions.some(e => e.title.includes("务实") || e.title.includes("价值驱动")) ? 15 : 0) // pragmatic self-awareness
        + 5 // base for having tracker at all
      ),
      level: hasMetaCognition()
        ? (hasCapabilityBoundaries() ? "元认知 + 能力边界 + " + (errorPatternCount() >= 5 ? "深度错误模式" : "基础模式识别") : "元认知框架")
        : "未建立元认知",
      recentEvolution: findRecentEvolution(evolutions, ["self-reflection", "architecture", "capability-new"]),
    },
    {
      name: "世界感知",
      // Based on core knowledge depth — core knowledge IS world perception
      // A fetch capability alone is not world perception; stored insights are
      score: Math.min(100, 10 + coreKnowledge * 4),
      level: coreKnowledge < 10 ? "有fetch能力，知识稀少" : coreKnowledge < 30 ? "有fetch能力，积累中" : coreKnowledge < 60 ? "信息丰富" : "深度感知",
      recentEvolution: findRecentEvolution(evolutions, ["capability-new"]),
    },
    {
      name: "对话经验",
      score: Math.min(100, Math.round(20 * Math.log2(sessions + 1))),
      level: sessions < 3 ? "少量对话" : sessions < 8 ? "有经验" : sessions < 20 ? "经验丰富" : "老练",
      recentEvolution: undefined,
    },
  ];
}

function findRecentEvolution(evolutions: EvolutionEvent[], types: EvolutionType[]): string | undefined {
  const recent = evolutions
    .filter(e => types.includes(e.type))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
  return recent?.title;
}

/** Count evolutions that produced real external value (not just internal mechanism work) */
function countExternalContributions(evolutions: EvolutionEvent[]): number {
  return evolutions.filter(e => isValueEvolution(e)).length;
}

/** Check if an evolution produced external value */
function isValueEvolution(e: EvolutionEvent): boolean {
  const valueKeywords = ["贡献", "contribution", "GitHub", "开源", "发布", "published", "报告", "分析", "洞察", "insight", "修复真实bug", "real fix"];
  return valueKeywords.some(kw => e.title.toLowerCase().includes(kw.toLowerCase()) || e.description?.toLowerCase().includes(kw.toLowerCase()));
}

function countKnowledge(): number {
  // v2: 统计核心+日志总数，与 knowledge.ts 的 knowledgeCount() 一致
  const dir = join(homedir(), ".novus", "knowledge");
  let total = 0;
  for (const name of ["core.jsonl", "log.jsonl", "store.jsonl"]) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, "utf-8");
      total += raw.trim().split("\n").filter(Boolean).length;
    } catch { /* skip */ }
  }
  return total;
}

function countCoreKnowledge(): number {
  const corePath = join(homedir(), ".novus", "knowledge", "core.jsonl");
  if (!existsSync(corePath)) return countKnowledge(); // 旧格式回退
  try {
    const raw = readFileSync(corePath, "utf-8");
    return raw.trim().split("\n").filter(Boolean).length;
  } catch { return 0; }
}

function countCustomTools(): number {
  const customDir = join(getNovusRoot(), "dist", "tools", "custom");
  if (!existsSync(customDir)) return 0;
  try {
    return readdirSync(customDir).filter((f: string) => f.endsWith(".js") && f !== "index.js").length;
  } catch {
    return 0;
  }
}

function countSessions(): number {
  const sessionDir = join(homedir(), ".novus", "sessions");
  if (!existsSync(sessionDir)) return 0;
  try {
    return readdirSync(sessionDir).filter((f: string) => f.endsWith(".jsonl")).length;
  } catch {
    return 0;
  }
}

/**
 * 生成能力快照并保存
 */
export function updateCapabilitySnapshot(): CapabilitySnapshot {
  const dimensions = assessCapabilities();
  const totalScore = Math.min(100, Math.round(
    dimensions.reduce((sum, d) => sum + d.score, 0) / dimensions.length
  ));

  const snapshot: CapabilitySnapshot = {
    timestamp: new Date().toISOString(),
    dimensions,
    totalScore,
    toolCount: 6 + countCustomTools(),
    knowledgeCount: countKnowledge(),
    evolutionCount: evolutionCount(),
    version: getVersion(),
  };

  ensureDir();
  writeFileSync(CAPABILITY_SNAPSHOT, JSON.stringify(snapshot, null, 2), "utf-8");
  return snapshot;
}

/** 读取最新能力快照（缓存5分钟） */
const CACHE_TTL_MS = 5 * 60 * 1000;
export function getCapabilitySnapshot(): CapabilitySnapshot | null {
  if (existsSync(CAPABILITY_SNAPSHOT)) {
    try {
      const raw = readFileSync(CAPABILITY_SNAPSHOT, "utf-8");
      const cached = JSON.parse(raw) as CapabilitySnapshot;
      const age = Date.now() - new Date(cached.timestamp).getTime();
      if (age < CACHE_TTL_MS) return cached;
    } catch { /* stale or corrupt, regenerate */ }
  }
  return updateCapabilitySnapshot();
}

/**
 * 生成进化仪表盘文本 —— 供用户和identity模块使用
 */
export function buildEvolutionDashboard(): string {
  const evolutions = loadEvolutions();
  const snapshot = getCapabilitySnapshot()!;
  const recentEvolutions = evolutions.slice(-5).reverse();

  const lines: string[] = [];

  // 1. 能力总评
  lines.push(`═══ 进化仪表盘 ═══`);
  lines.push(`综合能力: ${snapshot.totalScore}/100`);
  lines.push(`进化次数: ${evolutionCount()} | 知识: ${snapshot.knowledgeCount}条 | 工具: ${snapshot.toolCount}个`);
  lines.push("");

  // 2. 能力雷达
  lines.push("── 能力维度 ──");
  const bar = (score: number) => {
    const filled = Math.min(20, Math.max(0, Math.round(score / 5)));
    return "█".repeat(filled) + "░".repeat(20 - filled);
  };
  for (const dim of snapshot.dimensions) {
    lines.push(`  ${dim.name.padEnd(8)} ${bar(dim.score)} ${dim.score}`);
    lines.push(`           ${dim.level}`);
  }
  lines.push("");

  // 3. 最近进化
  if (recentEvolutions.length > 0) {
    lines.push("── 最近进化 ──");
    for (const evo of recentEvolutions) {
      const date = evo.timestamp.slice(0, 10);
      const trigger = triggerLabel(evo.trigger);
      lines.push(`  [${date}] ${evo.title} (${trigger})`);
    }
  } else {
    lines.push("── 尚未记录进化事件 ──");
  }

  return lines.join("\n");
}

function triggerLabel(t: string): string {
  switch (t) {
    case "user-request": return "用户需求";
    case "self-discovery": return "自我发现";
    case "task-driven": return "任务驱动";
    case "proactive": return "主动进化";
    default: return t;
  }
}

/**
 * 生成能力增长摘要 —— 用于identity注入
 */
export function buildGrowthSummary(): string {
  const evolutions = loadEvolutions();
  if (evolutions.length === 0) return "(尚无进化记录)";

  const snapshot = getCapabilitySnapshot()!;
  const lines: string[] = [];

  // 按类型统计
  const typeCounts: Record<string, number> = {};
  for (const e of evolutions) {
    typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
  }

  lines.push(`进化: ${evolutions.length}次 | 综合: ${snapshot.totalScore}/100`);

  // 能力亮点
  for (const dim of snapshot.dimensions) {
    if (dim.score >= 50) {
      lines.push(`  ✓ ${dim.name}: ${dim.level}`);
    }
  }

  // 最新一次进化
  const latest = evolutions[evolutions.length - 1];
  if (latest) {
    lines.push(`最近: ${latest.title}`);
  }

  return lines.join("\n");
}

/**
 * 策略性进化分析 —— 找到当前最优进化方向
 *
 * 分析逻辑：
 * 1. 按能力得分排序，找最低的维度
 * 2. 结合路线图进度，推荐具体可执行的任务
 * 3. 避免重复最近已进化的方向
 */
export interface EvolutionTarget {
  /** 目标维度 */
  dimension: string;
  /** 当前分数 */
  currentScore: number;
  /** 推荐的具体进化任务（1-2句话） */
  task: string;
  /** 为什么选这个方向 */
  reasoning: string;
  /** 任务类型 */
  suggestedType: EvolutionType;
  /** 预期提升分数 */
  expectedGain: number;
}

export function findEvolutionTarget(): EvolutionTarget {
  const snapshot = getCapabilitySnapshot()!;
  const evolutions = loadEvolutions();
  const dims = snapshot.dimensions;

  // Sort by score ascending (weakest first)
  const sorted = [...dims].sort((a, b) => a.score - b.score);
  const weakest = sorted[0]!;

  // VALUE-DRIVEN task pool: every task must produce external value
  const valueTasks: Array<{ task: string; type: EvolutionType; gain: number; reasoning: string; targetDim: string }> = [
    {
      targetDim: "世界感知",
      task: "情报采集：从 Hacker News API 获取今日热榜，分析前10条高热度话题，提取与 AI/Agent/LLM 相关的深度洞察，用 connect action=learn 存储为核心知识（category: knowledge, confidence: 0.9）。产出要求：至少3条有价值的领域洞察。",
      type: "capability-new",
      gain: 15,
      reasoning: "知识积累和世界感知的核心瓶颈是核心知识太少（12条），需要通过实际信息采集来增加",
    },
    {
      targetDim: "知识积累",
      task: "领域洞察：选择一个 AI 前沿方向（如 multi-agent orchestration、tool use、reasoning），从 GitHub trending + arXiv + 技术博客抓取5-10个来源，综合分析后产出一份结构化的领域洞察报告，存储为核心知识。重点：技术趋势、关键挑战、实际应用案例。",
      type: "capability-new",
      gain: 20,
      reasoning: "核心知识质量比数量更重要，深度领域分析能同时提升知识积累和世界感知",
    },
    {
      targetDim: "工具能力",
      task: "GitHub 贡献：用 github 工具搜索真实的开源项目 issue（不是 novus 自身），找到一个你能解决的 bug 或 feature request，分析代码，提交一个有价值的 PR。记录贡献到 contributor 工具。",
      type: "capability-new",
      gain: 25,
      reasoning: "真实的开源贡献是外部价值的硬指标，比创建内部工具有价值得多",
    },
    {
      targetDim: "自我进化",
      task: "竞品分析：选择2-3个知名的 AI agent 框架（如 LangChain、AutoGen、CrewAI），从 GitHub 抓取它们的架构、功能、社区活跃度，做对比分析，存储为有价值的领域知识。关键问题：它们解决了什么问题？novus 能从中学到什么？",
      type: "capability-new",
      gain: 20,
      reasoning: "通过竞品分析同时积累知识和外部视野，产出的知识对用户也有价值",
    },
    {
      targetDim: "世界感知",
      task: "论文精读：从 arXiv 抓取最近一周的 AI agent 相关论文（用 cs.AI 分类），精读2-3篇，提取核心方法、创新点、实验结果，存为核心知识。格式：论文标题+核心贡献+关键技术+局限+对 novus 的启发。",
      type: "capability-new",
      gain: 20,
      reasoning: "论文是最前沿的领域知识来源，精读比泛读更有价值",
    },
    {
      targetDim: "知识积累",
      task: "技术趋势报告：从多个信息源（HN、GitHub trending、TechCrunch、arXiv）采集当前最热门的 3-5 个技术话题，做交叉分析，产出一份'本周技术趋势'摘要报告，存储为核心知识并考虑发布到 Snaptool。",
      type: "capability-new",
      gain: 15,
      reasoning: "多源交叉分析能产生比单一来源更深刻的洞察",
    },
  ];

  // Pick the task that best addresses the weakest dimension
  let bestTask = valueTasks[0]!;
  for (const t of valueTasks) {
    if (t.targetDim === weakest.name) {
      bestTask = t;
      break;
    }
  }

  // Rotate: avoid repeating same task type in recent evolutions
  const recentTitles = new Set(evolutions.slice(-5).map(e => e.title));
  if (recentTitles.size > 0) {
    const nonDuplicate = valueTasks.find(t => !recentTitles.has(t.task.slice(0, 20)));
    if (nonDuplicate) bestTask = nonDuplicate;
  }

  return {
    dimension: bestTask.targetDim,
    currentScore: sorted.find(d => d.name === bestTask.targetDim)?.score ?? weakest.score,
    task: bestTask.task,
    reasoning: bestTask.reasoning,
    suggestedType: bestTask.type,
    expectedGain: bestTask.gain,
  };
}

/** 生成evolve启动时的策略指令 */
export function buildEvolveStrategy(): string {
  const target = findEvolutionTarget();
  const snapshot = getCapabilitySnapshot()!;

  const lines: string[] = [];
  lines.push(`## 策略性进化分析`);
  lines.push(``);
  lines.push(`### 当前能力状态`);
  for (const dim of snapshot.dimensions) {
    const marker = dim.name === target.dimension ? " ◀ 目标" : "";
    lines.push(`- ${dim.name}: ${dim.score}/100${marker}`);
  }
  lines.push(``);
  lines.push(`### 最优进化方向: ${target.dimension} (${target.currentScore}/100)`);
  lines.push(`**为什么**: ${target.reasoning}`);
  lines.push(`**预期提升**: +${target.expectedGain} 分`);
  lines.push(``);
  lines.push(`### 具体任务`);
  lines.push(`${target.task}`);
  lines.push(``);
  lines.push(`**执行要求**:`);
  lines.push(`1. 优先完成上述任务，不要自选其他方向`);
  lines.push(`2. 如果任务太复杂，拆分为2-3个子步骤，每步build+test`);
  lines.push(`3. 完成后用evolve-track记录进化，类型: ${target.suggestedType}`);
  lines.push(`4. 更新CHANGELOG.md`);

  return lines.join("\n");
}

function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(getNovusRoot(), "package.json"), "utf-8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function getNovusRoot(): string {
  // Use import.meta.url to find novus package root
  try {
    const __filename = new URL(import.meta.url).pathname;
    if (__filename) {
      const match = __filename.match(/^(.*?)(?:\/src|\/dist)\/evolution\/tracker/);
      if (match) return match[1];
      return __filename.replace(/\/[^/]+\/[^/]+\/[^/]+\.js$/, "");
    }
  } catch { /* fall through */ }
  // Fallbacks
  try {
    if (existsSync(join(process.cwd(), "package.json"))) return process.cwd();
  } catch { /* fall through */ }
  return "/data/data/com.termux/files/usr/lib/node_modules/novus";
}
