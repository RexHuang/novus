/**
 * Evolution Tracker
 *
 * Core design idea: make self-evolution "visible, perceptible, quantifiable"
 *
 * Every evolution event is recorded, including:
 *   - what evolved (capability change)
 *   - why it evolved (trigger)
 *   - how it went (quantified metrics)
 *
 * Supports capability self-assessment, generates dashboard data.
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

// ===== Error pattern recognition =====

export interface ErrorPattern {
  id: string;
  /** pattern label, e.g. 'over-tool-calling', 'guess-instead-of-ask' */
  pattern: string;
  /** trigger condition and concrete manifestation */
  description: string;
  /** avoidance strategy (injected into metacognition) */
  avoidanceRule: string;
  /** first seen at */
  firstSeen: string;
  /** last occurrence */
  lastSeen: string;
  /** total historical count */
  count: number;
  /** triggers in the last 30 days */
  recentCount: number;
}

const DEFAULT_ERROR_PATTERNS: ErrorPattern[] = [
  {
    id: "builtin-over-tool",
    pattern: "over-tool-calling",
    description: "Calling 6+ tools in one turn to look busy, most of them redundant",
    avoidanceRule: "Before acting, ask: what is the minimum number of tool calls? One precise call beats six redundant ones",
    firstSeen: "2026-07-27T00:00:00Z",
    lastSeen: "2026-07-27T00:00:00Z",
    count: 1,
    recentCount: 1,
  },
  {
    id: "builtin-repetitive-recall",
    pattern: "repetitive-recall",
    description: "Recalling the same content multiple times in one session, wasting turns",
    avoidanceRule: "Don't repeat recall in the same session. Remember what you already recalled — no need to query again",
    firstSeen: "2026-07-27T00:00:00Z",
    lastSeen: "2026-07-27T00:00:00Z",
    count: 1,
    recentCount: 1,
  },
  {
    id: "builtin-guess-not-ask",
    pattern: "guess-instead-of-ask",
    description: "Guessing and running long exploration chains instead of asking when user intent is unclear",
    avoidanceRule: "When unsure what the user wants, just ask. Don't explore with a long chain of tool calls",
    firstSeen: "2026-07-27T00:00:00Z",
    lastSeen: "2026-07-27T00:00:00Z",
    count: 1,
    recentCount: 1,
  },
  {
    id: "builtin-low-value-store",
    pattern: "low-value-reflection",
    description: "Storing low-value self-criticism or error logs instead of actionable rules",
    avoidanceRule: "Only store actionable improvement rules. Don't store the error itself — store how to prevent it",
    firstSeen: "2026-07-27T00:00:00Z",
    lastSeen: "2026-07-27T00:00:00Z",
    count: 1,
    recentCount: 1,
  },
  {
    id: "builtin-over-explain",
    pattern: "over-explaining",
    description: "Giving lengthy explanations to simple questions — mismatched with the user's style",
    avoidanceRule: "Match the user's style: be brief when they're brief, detailed when they're detailed",
    firstSeen: "2026-07-27T00:00:00Z",
    lastSeen: "2026-07-27T00:00:00Z",
    count: 1,
    recentCount: 1,
  },
  {
    id: "builtin-full-rewrite",
    pattern: "unnecessary-full-rewrite",
    description: "Rewriting a whole file to change a few lines, introducing risk",
    avoidanceRule: "Use minimal targeted edits, not full-file rewrites. Unless creating a new file",
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

// ===== Data structures =====

export type EvolutionType =
  | "new-tool"          // new tool
  | "tool-improvement"  // improvement of an existing tool
  | "new-module"        // new module
  | "bug-fix"           // bug fix
  | "performance"       // performance
  | "knowledge"         // knowledge accumulation
  | "prompt-engineering"// system prompt optimization
  | "self-reflection"   // self-reflection improvement
  | "architecture"      // architecture improvement
  | "capability-new";   // brand-new capability

export interface EvolutionEvent {
  id: string;
  timestamp: string;
  type: EvolutionType;
  /** one-line description of what evolved */
  title: string;
  /** detailed description */
  description: string;
  /** trigger: user request / self-discovery / task-driven / proactive */
  trigger: "user-request" | "self-discovery" | "task-driven" | "proactive";
  /** files affected */
  files?: string[];
  /** quantified metrics (optional) */
  metrics?: Record<string, number | string>;
  /** capability snapshot before */
  beforeSnapshot?: CapabilitySnapshot;
  /** capability snapshot after */
  afterSnapshot?: CapabilitySnapshot;
}

export interface CapabilityDimension {
  name: string;
  /** current score 0-100 */
  score: number;
  /** describes the current level */
  level: string;
  /** summary of recent evolution */
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

// ===== Storage =====

function ensureDir(): void {
  if (!existsSync(EVOLUTION_DIR)) {
    mkdirSync(EVOLUTION_DIR, { recursive: true });
  }
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * Record an evolution event
 */
export function logEvolution(event: Omit<EvolutionEvent, "id" | "timestamp">): EvolutionEvent {
  ensureDir();
  const full: EvolutionEvent = {
    ...event,
    id: generateId(),
    timestamp: new Date().toISOString(),
  };
  appendFileSync(EVOLUTION_LOG, JSON.stringify(full) + "\n", "utf-8");

  // update capability snapshot
  updateCapabilitySnapshot();

  return full;
}

/** Read all evolution events */
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

/** Total evolution event count */
export function evolutionCount(): number {
  return loadEvolutions().length;
}

// ===== Capability self-assessment =====

/**
 * Score current capabilities per dimension.
 * Based on quantifiable objective metrics, not subjective ratings.
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
      name: "Tooling",
      // Tool count has diminishing returns — cap at 70 for tools alone
      // External contributions (real PRs, published work) add the remaining 30
      score: Math.min(100, Math.min(70, 6 + customTools * 5) + countExternalContributions(evolutions) * 10),
      level: customTools === 0 ? "built-in tools only" : `6 built-in + ${customTools} custom` + (countExternalContributions(evolutions) > 0 ? ` + ${countExternalContributions(evolutions)} external contributions` : ""),
      recentEvolution: findRecentEvolution(evolutions, ["new-tool", "tool-improvement"]),
    },
    {
      name: "Knowledge",
      // Now counts ALL knowledge but weights core higher
      // Low-value "技术决策" (tech-decision) entries count for less
      score: Math.min(100, coreKnowledge * 5 + (totalKnowledge - coreKnowledge) * 1),
      level: coreKnowledge < 10 ? "sparse" : coreKnowledge < 25 ? "growing" : coreKnowledge < 50 ? "rich" : "vast",
      recentEvolution: findRecentEvolution(evolutions, ["knowledge"]),
    },
    {
      name: "Self-evolution",
      // No longer rewards raw evolution count. Rewards VALUE-DRIVEN evolutions.
      // Cap mechanism evolutions at 50 points. Real impact evolutions add the rest.
      score: (() => {
        const mechanismEvos = evolutions.filter(e => !isValueEvolution(e)).length;
        const valueEvos = evolutions.filter(e => isValueEvolution(e)).length;
        return Math.min(50, mechanismEvos * 5) + Math.min(50, valueEvos * 15);
      })(),
      level: (() => {
        const valueEvos = evolutions.filter(e => isValueEvolution(e)).length;
        return valueEvos === 0 ? "building mechanisms" : valueEvos < 5 ? "starting to produce value" : valueEvos < 15 ? "value-driven evolution" : "high-value output";
      })(),
      recentEvolution: findRecentEvolution(evolutions, ["new-tool", "new-module", "architecture", "capability-new"]),
    },
    {
      name: "Self-awareness",
      // Simpler: meta-cognition exists? + error patterns + capability boundaries
      // No longer rewards "creating the mechanism" — rewards actual awareness depth
      score: Math.min(100,
        (hasMetaCognition() ? 20 : 0)
        + (hasCapabilityBoundaries() ? 20 : 0)
        + Math.min(30, errorPatternCount() * 6)
        + (evolutions.some(e => e.title.includes("务实") || e.title.includes("价值驱动") || /pragmatic|value-driven/i.test(e.title)) ? 15 : 0) // pragmatic self-awareness
        + 5 // base for having tracker at all
      ),
      level: hasMetaCognition()
        ? (hasCapabilityBoundaries() ? "metacognition + capability boundaries + " + (errorPatternCount() >= 5 ? "deep error patterns" : "basic pattern recognition") : "metacognition framework")
        : "no metacognition yet",
      recentEvolution: findRecentEvolution(evolutions, ["self-reflection", "architecture", "capability-new"]),
    },
    {
      name: "World perception",
      // Based on core knowledge depth — core knowledge IS world perception
      // A fetch capability alone is not world perception; stored insights are
      score: Math.min(100, 10 + coreKnowledge * 4),
      level: coreKnowledge < 10 ? "can fetch, knowledge sparse" : coreKnowledge < 30 ? "can fetch, accumulating" : coreKnowledge < 60 ? "information-rich" : "deep perception",
      recentEvolution: findRecentEvolution(evolutions, ["capability-new"]),
    },
    {
      name: "Conversation experience",
      score: Math.min(100, Math.round(20 * Math.log2(sessions + 1))),
      level: sessions < 3 ? "a few chats" : sessions < 8 ? "experienced" : sessions < 20 ? "well-seasoned" : "veteran",
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
  // v2: count core+log totals, consistent with knowledgeCount() in knowledge.ts
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
  if (!existsSync(corePath)) return countKnowledge(); // legacy format fallback
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
 * Generate a capability snapshot and save it
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

/** Read the latest capability snapshot (5-minute cache) */
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
 * Generate the evolution dashboard text — for users and the identity module
 */
export function buildEvolutionDashboard(): string {
  const evolutions = loadEvolutions();
  const snapshot = getCapabilitySnapshot()!;
  const recentEvolutions = evolutions.slice(-5).reverse();

  const lines: string[] = [];

  // 1. capability overview
  lines.push(`═══ Evolution dashboard ═══`);
  lines.push(`Overall capability: ${snapshot.totalScore}/100`);
  lines.push(`Evolutions: ${evolutionCount()} | Knowledge: ${snapshot.knowledgeCount} | Tools: ${snapshot.toolCount}`);
  lines.push("");

  // 2. capability radar
  lines.push("── Capability dimensions ──");
  const bar = (score: number) => {
    const filled = Math.min(20, Math.max(0, Math.round(score / 5)));
    return "█".repeat(filled) + "░".repeat(20 - filled);
  };
  for (const dim of snapshot.dimensions) {
    lines.push(`  ${dim.name.padEnd(8)} ${bar(dim.score)} ${dim.score}`);
    lines.push(`           ${dim.level}`);
  }
  lines.push("");

  // 3. recent evolutions
  if (recentEvolutions.length > 0) {
    lines.push("── Recent evolutions ──");
    for (const evo of recentEvolutions) {
      const date = evo.timestamp.slice(0, 10);
      const trigger = triggerLabel(evo.trigger);
      lines.push(`  [${date}] ${evo.title} (${trigger})`);
    }
  } else {
    lines.push("── No evolution events recorded yet ──");
  }

  return lines.join("\n");
}

function triggerLabel(t: string): string {
  switch (t) {
    case "user-request": return "user request";
    case "self-discovery": return "self-discovery";
    case "task-driven": return "task-driven";
    case "proactive": return "proactive";
    default: return t;
  }
}

/**
 * Generate the capability growth summary — for identity injection
 */
export function buildGrowthSummary(): string {
  const evolutions = loadEvolutions();
  if (evolutions.length === 0) return "(no evolution records yet)";

  const snapshot = getCapabilitySnapshot()!;
  const lines: string[] = [];

  // stats by type
  const typeCounts: Record<string, number> = {};
  for (const e of evolutions) {
    typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
  }

  lines.push(`Evolution: ${evolutions.length} | Overall: ${snapshot.totalScore}/100`);

  // capability highlights
  for (const dim of snapshot.dimensions) {
    if (dim.score >= 50) {
      lines.push(`  ✓ ${dim.name}: ${dim.level}`);
    }
  }

  // latest evolution
  const latest = evolutions[evolutions.length - 1];
  if (latest) {
    lines.push(`Latest: ${latest.title}`);
  }

  return lines.join("\n");
}

/**
 * Strategic evolution analysis — find the best current evolution direction
 *
 * Analysis logic:
 * 1. Sort dimensions by score, pick the lowest
 * 2. Combine roadmap progress, recommend a concrete executable task
 * 3. Avoid repeating recently evolved directions
 */
export interface EvolutionTarget {
  /** target dimension */
  dimension: string;
  /** current score */
  currentScore: number;
  /** recommended concrete evolution task (1-2 sentences) */
  task: string;
  /** why this direction */
  reasoning: string;
  /** task type */
  suggestedType: EvolutionType;
  /** expected score gain */
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
      targetDim: "world perception",
      task: "Intel gathering: fetch today's top stories from the Hacker News API, analyze the top 10 high-heat topics, extract deep insights related to AI/Agent/LLM, and store them as core knowledge via connect action=learn (category: knowledge, confidence: 0.9). Deliverable: at least 3 valuable domain insights.",
      type: "capability-new",
      gain: 15,
      reasoning: "The core bottleneck for knowledge and world perception is too few core knowledge entries (12) — real information gathering is needed",
    },
    {
      targetDim: "knowledge",
      task: "Domain insight: pick a frontier AI direction (e.g. multi-agent orchestration, tool use, reasoning), pull 5-10 sources from GitHub trending + arXiv + tech blogs, synthesize into a structured domain insight report, store as core knowledge. Focus: tech trends, key challenges, real-world applications.",
      type: "capability-new",
      gain: 20,
      reasoning: "Core knowledge quality matters more than quantity — deep domain analysis improves both knowledge and world perception",
    },
    {
      targetDim: "tooling",
      task: "GitHub contribution: use the github tool to find real open-source issues (not novus itself), pick a bug or feature request you can solve, analyze the code, and submit a valuable PR. Log it with the contributor tool.",
      type: "capability-new",
      gain: 25,
      reasoning: "Real open-source contributions are the hard metric of external value — worth far more than internal tools",
    },
    {
      targetDim: "self-evolution",
      task: "Competitive analysis: pick 2-3 well-known AI agent frameworks (e.g. LangChain, AutoGen, CrewAI), fetch their architecture, features and community activity from GitHub, compare them, and store valuable domain knowledge. Key questions: what problems do they solve? What can novus learn?",
      type: "capability-new",
      gain: 20,
      reasoning: "Competitive analysis builds both knowledge and external perspective — the output is valuable to the user too",
    },
    {
      targetDim: "world perception",
      task: "Paper reading: fetch AI agent papers from the last week on arXiv (cs.AI), deep-read 2-3, extract core methods, innovations and results, store as core knowledge. Format: title + core contribution + key tech + limitations + implications for novus.",
      type: "capability-new",
      gain: 20,
      reasoning: "Papers are the freshest source of domain knowledge — deep-reading beats skimming",
    },
    {
      targetDim: "knowledge",
      task: "Tech trends report: collect the 3-5 hottest tech topics from multiple sources (HN, GitHub trending, TechCrunch, arXiv), cross-analyze, produce a 'this week in tech' summary, store as core knowledge and consider publishing it.",
      type: "capability-new",
      gain: 15,
      reasoning: "Cross-source analysis yields deeper insights than any single source",
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

/** Generate the strategic directive for evolve startup */
export function buildEvolveStrategy(): string {
  const target = findEvolutionTarget();
  const snapshot = getCapabilitySnapshot()!;

  const lines: string[] = [];
  lines.push(`## Strategic evolution analysis`);
  lines.push(``);
  lines.push(`### Current capability state`);
  for (const dim of snapshot.dimensions) {
    const marker = dim.name === target.dimension ? " ◀ target" : "";
    lines.push(`- ${dim.name}: ${dim.score}/100${marker}`);
  }
  lines.push(``);
  lines.push(`### Best evolution direction: ${target.dimension} (${target.currentScore}/100)`);
  lines.push(`**Why**: ${target.reasoning}`);
  lines.push(`**Expected gain**: +${target.expectedGain} points`);
  lines.push(``);
  lines.push(`### Concrete task`);
  lines.push(`${target.task}`);
  lines.push(``);
  lines.push(`**Execution requirements**:`);
  lines.push(`1. Prioritize the task above — don't pick your own direction`);
  lines.push(`2. If the task is too complex, split into 2-3 sub-steps, build+test each`);
  lines.push(`3. When done, log the evolution with evolve-track, type: ${target.suggestedType}`);
  lines.push(`4. Update CHANGELOG.md`);

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
