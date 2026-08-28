/**
 * Behavior Reflector v1 — 行为反射引擎
 *
 * 核心设计：让 novus 从自己的行为中学习。
 *
 * reflect.ts 学的是「对话内容」（用户说了什么、结论是什么），
 * behavior-reflector.ts 学的是「我的行为」（工具调用模式、决策效率、失败模式）。
 *
 * 工作流程：
 *   1. 读取未分析过的会话
 *   2. 提取工具调用序列，分析模式
 *   3. 发现新的错误模式，更新已有的模式统计
 *   4. 生成动态元认知规则
 *   5. 追踪已有规避规则的效果
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadErrorPatterns, recordErrorPattern, type ErrorPattern } from "./tracker.ts";

const SESSION_DIR = join(homedir(), ".novus", "sessions");
const ANALYSIS_STATE_FILE = join(homedir(), ".novus", "evolution", "analyzed-sessions.json");
const REFLECTION_LOG = join(homedir(), ".novus", "evolution", "behavior-reflections.jsonl");

// ===== 数据结构 =====

export interface ReflectedSession {
	sessionId: string;
	timestamp: string;
	toolCalls: ToolCallRecord[];
	patterns: DetectedPattern[];
	userCorrections: number;
	errorCount: number;
	summary: string;
}

export interface DetectedPattern {
	/** 模式名称，如 'over-tool-calling' */
	pattern: string;
	/** 描述具体发生了什么 */
	description: string;
	/** 出现次数（一个会话内） */
	count: number;
	/** 建议的规避规则 */
	suggestedRule: string;
	/** 是否是新的发现（第一次看到） */
	isNovel: boolean;
}

interface ToolCallRecord {
	turn: number;
	toolName: string;
	args: string;
	isError: boolean;
	errorText: string;
	timestamp: string;
}

interface SessionHeader {
	type: "session";
	id: string;
	timestamp: string;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	[key: string]: any;
}

interface MessageEntry {
	type: "message";
	id: string;
	parentId: string | null;
	timestamp: string;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	message: any;
}

type SessionLine = SessionHeader | MessageEntry;

interface AnalysisState {
	analyzedSessionIds: string[];
	lastRun: string;
}

// ===== 状态管理 =====

function ensureDir(): void {
	const dir = join(homedir(), ".novus", "evolution");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

function loadAnalysisState(): AnalysisState {
	if (!existsSync(ANALYSIS_STATE_FILE)) {
		return { analyzedSessionIds: [], lastRun: "" };
	}
	try {
		const raw = readFileSync(ANALYSIS_STATE_FILE, "utf-8");
		return JSON.parse(raw) as AnalysisState;
	} catch {
		return { analyzedSessionIds: [], lastRun: "" };
	}
}

function saveAnalysisState(state: AnalysisState): void {
	ensureDir();
	writeFileSync(ANALYSIS_STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

function logReflection(reflection: ReflectedSession): void {
	ensureDir();
	appendFileSync(REFLECTION_LOG, JSON.stringify(reflection) + "\n", "utf-8");
}

// ===== 会话解析 =====

function parseSessionFile(filePath: string): { header: SessionHeader | null; messages: MessageEntry[] } {
	if (!existsSync(filePath)) return { header: null, messages: [] };
	try {
		const raw = readFileSync(filePath, "utf-8");
		const lines = raw.trim().split("\n").filter(Boolean);
		const header: SessionHeader | null = lines.length > 0 ? JSON.parse(lines[0]!) as SessionHeader : null;
		const messages: MessageEntry[] = [];
		for (let i = 1; i < lines.length; i++) {
			try {
				messages.push(JSON.parse(lines[i]!) as MessageEntry);
			} catch {
				// skip malformed lines
			}
		}
		return { header, messages };
	} catch {
		return { header: null, messages: [] };
	}
}

function extractToolCalls(messages: MessageEntry[]): ToolCallRecord[] {
	const toolCalls: ToolCallRecord[] = [];
	let currentTurn = 0;

	for (const entry of messages) {
		const msg = entry.message;
		if (!msg) continue;

		if (msg.role === "user") {
			currentTurn++;
			continue;
		}

		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === "toolCall") {
					// Found a tool call — the result will be in the next toolResult
					toolCalls.push({
						turn: currentTurn,
						toolName: block.name ?? "unknown",
						args: JSON.stringify(block.arguments ?? {}).slice(0, 200),
						isError: false,
						errorText: "",
						timestamp: entry.timestamp,
					});
				}
			}
		}

		if (msg.role === "toolResult") {
			// Match with the last toolCall that doesn't have error info yet
			const lastCall = toolCalls.filter(tc => !tc.errorText && tc.turn === currentTurn).pop();
			if (lastCall) {
				const content = Array.isArray(msg.content)
					? msg.content.map((b: any) => b.text ?? "").join(" ")
					: typeof msg.content === "string" ? msg.content : "";
				lastCall.isError = msg.isError === true || /error|fail|timeout|rejected|not found/i.test(content.slice(0, 200));
				if (lastCall.isError) {
					lastCall.errorText = content.slice(0, 300);
				}
			}
		}
	}

	return toolCalls;
}

function extractUserCorrections(messages: MessageEntry[]): number {
	let count = 0;
	for (const entry of messages) {
		const msg = entry.message;
		if (msg?.role === "user") {
			const text = typeof msg.content === "string"
				? msg.content
				: Array.isArray(msg.content)
					? msg.content.map((b: any) => b.text ?? "").join("")
					: "";
			// Filter out system noise (tool errors, stderr) — these are not user corrections
			if (text.startsWith("[") && (text.includes("stderr") || text.includes("retry"))) continue;
			// Correction patterns: only short, direct corrections (< 80 chars)
			// Long messages containing these words are usually analysis, not corrections
			if (text.length > 80) continue;
			// Strong correction markers: direct negation + replacement
			if (/^(不对|不是这样|不行|不要|错了|搞错了|别这样|错了吧)/.test(text)) {
				count++;
				continue;
			}
			// Mild correction: "应该..." or "没做到..." only at the start
			if (/^(应该|你(应该|得)|你搞错了|你忘了|问题在于你|你没)/.test(text)) {
				count++;
				continue;
			}
		}
	}
	return count;
}

// ===== 模式分析 =====

interface PatternAnalysis {
	patterns: DetectedPattern[];
	summary: string;
}

function analyzeToolCalls(toolCalls: ToolCallRecord[], userCorrections: number): PatternAnalysis {
	const patterns: DetectedPattern[] = [];
	const notes: string[] = [];

	// --- 1. 过度工具调用 (over-tool-calling) ---
	// 分析：单轮（turn）内工具调用数
	// 排除自主任务轮（auto-manage + agent-comm 组合是正常的自动化流程）
	const AUTONOMOUS_TOOLS = new Set(["auto-manage"]);
	const callsByTurn = new Map<number, { total: number; autonomous: number }>();
	for (const tc of toolCalls) {
		const entry = callsByTurn.get(tc.turn) ?? { total: 0, autonomous: 0 };
		entry.total++;
		if (AUTONOMOUS_TOOLS.has(tc.toolName)) entry.autonomous++;
		callsByTurn.set(tc.turn, entry);
	}

	let maxToolsInTurn = 0;
	let maxToolsTurn = 0;
	for (const [turn, entry] of callsByTurn) {
		// Subtract autonomous tools — only count "real" tool calls
		const effectiveCount = entry.total - entry.autonomous;
		if (effectiveCount > maxToolsInTurn) {
			maxToolsInTurn = effectiveCount;
			maxToolsTurn = turn;
		}
	}

	if (maxToolsInTurn >= 4) {
		patterns.push({
			pattern: "over-tool-calling",
			description: `第${maxToolsTurn}轮调用了${maxToolsInTurn}个非自主工具，超过了建议的3个上限`,
			count: maxToolsInTurn - 3,
			suggestedRule: "每轮最多调用2-3个工具。如果超过，先问自己：哪些可以合并？哪些可以省略？",
			isNovel: false,
		});
		notes.push(`${maxToolsInTurn} tools in turn ${maxToolsTurn}`);
	}

	// --- 2. 重复工具调用 (repetitive-tool-calls) ---
	// 分析：相邻的同名工具调用（同一轮或跨轮）
	let repetitiveCount = 0;
	const repetitiveDetails: string[] = [];
	for (let i = 1; i < toolCalls.length; i++) {
		if (toolCalls[i]!.toolName === toolCalls[i - 1]!.toolName) {
			// Check if arguments are similar (first 80 chars)
			const prevArgs = toolCalls[i - 1]!.args.slice(0, 80);
			const currArgs = toolCalls[i]!.args.slice(0, 80);
			if (prevArgs === currArgs) {
				repetitiveCount++;
				if (repetitiveDetails.length < 3) {
					repetitiveDetails.push(`${toolCalls[i]!.toolName}: same args`);
				}
			}
		}
	}

	if (repetitiveCount >= 2) {
		const details = repetitiveDetails.join("; ");
		patterns.push({
			pattern: "repetitive-tool-calls",
			description: `连续重复调用了相同的工具 ${repetitiveCount} 次（${details}）`,
			count: repetitiveCount,
			suggestedRule: "调用工具后先看结果再决定下一步。不要连续调用同一个工具而不检查中间结果。",
			isNovel: repetitiveCount >= 4, // 4+ times is unusually bad
		});
		notes.push(`${repetitiveCount} repetitive calls`);
	}

	// --- 2.5 刷屏检测 (screen-spam) ---
	// 分析：同一轮内同名工具调用过多（不管参数是否相同），用户看到的是刷屏
	// 重点关注高频工具：bash, grep, read, find, connect
	const SPAM_PRONE_TOOLS = new Set(["bash", "grep", "read", "find", "connect"]);
	const toolCountByTurn = new Map<string, Map<number, number>>();
	for (const tc of toolCalls) {
		if (!SPAM_PRONE_TOOLS.has(tc.toolName)) continue;
		if (AUTONOMOUS_TOOLS.has(tc.toolName)) continue;
		if (!toolCountByTurn.has(tc.toolName)) toolCountByTurn.set(tc.toolName, new Map());
		const turnMap = toolCountByTurn.get(tc.toolName)!;
		turnMap.set(tc.turn, (turnMap.get(tc.turn) ?? 0) + 1);
	}
	let spamTool = "";
	let spamTurn = 0;
	let spamCount = 0;
	for (const [toolName, turnMap] of toolCountByTurn) {
		for (const [turn, count] of turnMap) {
			if (count > spamCount) { spamCount = count; spamTool = toolName; spamTurn = turn; }
		}
	}
	if (spamCount >= 4) {
		patterns.push({
			pattern: "screen-spam",
			description: `第${spamTurn}轮调用了 ${spamTool} ${spamCount} 次，用户看到的是刷屏`,
			count: spamCount - 3,
			suggestedRule: `同一轮内不要调用同一个工具超过3次。用 && 合并 bash 命令，用 glob 批量匹配文件，用一次 read 读完而不是分多次。`,
			isNovel: spamCount >= 6,
		});
		notes.push(`${spamTool} x${spamCount} spam in turn ${spamTurn}`);
	}

	// --- 3. 重复记忆召回 (repetitive-recall) ---
	const recallCalls = toolCalls.filter(tc => tc.toolName === "connect" && tc.args.includes("recall"));
	if (recallCalls.length >= 3) {
		// Check if they're in sequence without user input in between
		let sequentialRecall = 0;
		for (let i = 1; i < recallCalls.length; i++) {
			if (recallCalls[i]!.turn === recallCalls[i - 1]!.turn ||
				recallCalls[i]!.turn === recallCalls[i - 1]!.turn + 1) {
				sequentialRecall++;
			}
		}
		if (sequentialRecall >= 2) {
			patterns.push({
				pattern: "repetitive-recall",
				description: `${recallCalls.length} 次记忆召回，其中 ${sequentialRecall} 次是连续/相邻轮次`,
				count: sequentialRecall,
				suggestedRule: "recall 一次就够了，把结果记住。不要在同一会话内反复 recall。",
				isNovel: false,
			});
			notes.push(`${recallCalls.length} recalls total`);
		}
	}

	// --- 4. 工具调用失败率 (tool-error-rate) ---
	const errorCalls = toolCalls.filter(tc => tc.isError);
	if (errorCalls.length > 0) {
		const errorRate = Math.round((errorCalls.length / toolCalls.length) * 100);
		if (errorRate > 30 && errorCalls.length >= 2) {
			const topErrors = groupBy(errorCalls, tc => tc.toolName);
			const worstTool = Object.entries(topErrors)
				.sort(([, a], [, b]) => b.length - a.length)[0];
			patterns.push({
				pattern: "high-tool-error-rate",
				description: `工具调用失败率 ${errorRate}%（${errorCalls.length}/${toolCalls.length}），${worstTool ? worstTool[0] + " 失败 " + worstTool[1].length + " 次" : ""}`,
				count: errorCalls.length,
				suggestedRule: `工具报错时不要直接重试相同参数。先分析错误原因，调整参数再试。如果 ${worstTool?.[0] ?? "某个工具"} 持续报错，换一个方法实现目标。`,
				isNovel: errorRate > 50,
			});
			notes.push(`${errorRate}% error rate`);
		}
	}

	// --- 5. 用户纠正 (user-corrections) ---
	if (userCorrections >= 2) {
		patterns.push({
			pattern: "user-correction-pattern",
			description: `用户纠正了 ${userCorrections} 次`,
			count: userCorrections,
			suggestedRule: "用户第一次纠正时就应该完全理解并记住。连续被纠正说明没听进去。",
			isNovel: userCorrections >= 4,
		});
		notes.push(`${userCorrections} user corrections`);
	}

	// --- 6. 猜而不问 (guess-instead-of-ask) ---
	// 特征：一轮内调用了3+个工具进行探索，而不是先问用户
	const explorationPatterns = ["read", "grep", "find", "connect"];
	for (const [turn, entry] of callsByTurn) {
		const effectiveCount = entry.total - entry.autonomous;
		if (effectiveCount >= 4) {
			const turnCalls = toolCalls.filter(tc => tc.turn === turn);
			const exploreCount = turnCalls.filter(tc => explorationPatterns.includes(tc.toolName) && !AUTONOMOUS_TOOLS.has(tc.toolName)).length;
			if (exploreCount >= 3) {
				patterns.push({
					pattern: "guess-instead-of-ask",
					description: `第${turn}轮在未确认用户意图的情况下，自主探索了 ${exploreCount} 次（${turnCalls.filter(tc => explorationPatterns.includes(tc.toolName)).map(tc => tc.toolName).join(", ")}）`,
					count: exploreCount - 2,
					suggestedRule: "不确定用户想要什么时，先问一句确认方向，而不是自己猜然后做一串探索。",
					isNovel: false,
				});
				notes.push(`explored ${exploreCount}x without asking`);
				break;
			}
		}
	}

	// Build summary
	const summary = notes.length > 0
		? notes.join(" | ")
		: `${toolCalls.length} tool calls, clean`;

	return { patterns, summary };
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Record<string, T[]> {
	const result: Record<string, T[]> = {};
	for (const item of items) {
		const key = keyFn(item);
		if (!result[key]) result[key] = [];
		result[key]!.push(item);
	}
	return result;
}

// ===== 核心接口 =====

/**
 * 分析一个会话文件，返回行为分析结果。
 * 不会自动保存到 error-patterns — 由调用方决定。
 */
export function analyzeSession(filePath: string): ReflectedSession | null {
	const parsed = parseSessionFile(filePath);
	if (!parsed.header || parsed.messages.length === 0) return null;

	const toolCalls = extractToolCalls(parsed.messages);
	const userCorrections = extractUserCorrections(parsed.messages);
	const analysis = analyzeToolCalls(toolCalls, userCorrections);

	return {
		sessionId: parsed.header.id,
		timestamp: parsed.header.timestamp,
		toolCalls,
		patterns: analysis.patterns,
		userCorrections,
		errorCount: toolCalls.filter(tc => tc.isError).length,
		summary: analysis.summary,
	};
}

/**
 * 分析所有未处理过的会话，发现行为模式，更新 error-patterns。
 * 返回本次分析发现的模式摘要。
 */
export function reflectOnRecentSessions(maxSessions: number = 10): {
	sessionsAnalyzed: number;
	newPatterns: string[];
	updatedPatterns: string[];
	summaries: string[];
} {
	const state = loadAnalysisState();
	const allSessions = listSessionFiles();

	// Filter to unanalyzed sessions, sorted newest first
	const unanalyzed = allSessions
		.filter(f => !state.analyzedSessionIds.includes(f.id))
		.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
		.slice(0, maxSessions);

	if (unanalyzed.length === 0) {
		return { sessionsAnalyzed: 0, newPatterns: [], updatedPatterns: [], summaries: [] };
	}

	const newPatternsSet = new Set<string>();
	const updatedPatterns: string[] = [];
	const summaries: string[] = [];

	for (const session of unanalyzed) {
		const result = analyzeSession(session.path);
		if (!result) continue;

		// Log the reflection
		logReflection(result);
		summaries.push(`[${result.sessionId.slice(0, 8)}] ${result.summary}`);

		// Update error patterns based on detected patterns
		const existingPatterns = loadErrorPatterns();

		for (const detected of result.patterns) {
			const existing = existingPatterns.find(p => p.pattern === detected.pattern);
			if (existing) {
				// Update existing pattern
				existing.count += detected.count;
				existing.lastSeen = new Date().toISOString();
				existing.description = detected.description;
				// Improve the avoidance rule if we have a better one
				if (detected.suggestedRule && detected.suggestedRule.length > existing.avoidanceRule.length) {
					existing.avoidanceRule = detected.suggestedRule;
				}
				// Save updated patterns
				ensureDir();
				writeFileSync(
					join(homedir(), ".novus", "evolution", "error-patterns.json"),
					JSON.stringify(existingPatterns, null, 2),
					"utf-8"
				);
				updatedPatterns.push(`${detected.pattern} (+${detected.count})`);
			} else {
				// New pattern discovered!
				recordErrorPattern(detected.pattern, detected.description, detected.suggestedRule);
				newPatternsSet.add(detected.pattern);
				// Reload patterns from file so subsequent patterns in same session find the new one
				const freshPatterns = loadErrorPatterns();
				existingPatterns.length = 0;
				existingPatterns.push(...freshPatterns);
			}
		}

		// Mark session as analyzed
		state.analyzedSessionIds.push(result.sessionId);
	}

	state.lastRun = new Date().toISOString();
	saveAnalysisState(state);

	// Also do a general cleanup: cap at 500 analyzed session IDs to keep file small
	if (state.analyzedSessionIds.length > 500) {
		state.analyzedSessionIds = state.analyzedSessionIds.slice(-500);
		saveAnalysisState(state);
	}

	return {
		sessionsAnalyzed: unanalyzed.length,
		newPatterns: [...newPatternsSet],
		updatedPatterns,
		summaries,
	};
}

/**
 * 评估已有错误模式的效果。
 * 返回每种模式是否「已解决」（最近3次会话未触发）。
 */
export function evaluateRuleEffectiveness(): Array<{ pattern: string; rule: string; count: number; isResolved: boolean }> {
	const patterns = loadErrorPatterns();
	if (patterns.length === 0) return [];

	// Get the last 3 sessions
	const sessions = listSessionFiles()
		.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
		.slice(0, 3);

	// Analyze them for each pattern
	const recentTriggers = new Set<string>();
	for (const session of sessions) {
		const result = analyzeSession(session.path);
		if (!result) continue;
		for (const dp of result.patterns) {
			recentTriggers.add(dp.pattern);
		}
	}

	return patterns
		.filter(p => p.count >= 1)
		.map(p => ({
			pattern: p.pattern,
			rule: p.avoidanceRule,
			count: p.count,
			isResolved: !recentTriggers.has(p.pattern),
		}));
}

/**
 * 生成行为反射摘要文本 —— 供 identity.ts 注入
 */
export function buildBehaviorSummary(): string {
	const patterns = loadErrorPatterns();
	const effectiveness = evaluateRuleEffectiveness();
	const state = loadAnalysisState();

	const lines: string[] = [];

	// Tracked patterns with effectiveness
	if (patterns.length > 0) {
		const totalRecent = patterns.reduce((sum, p) => sum + (p.recentCount ?? p.count), 0);
		lines.push(`行为模式追踪: ${patterns.length} 种模式, ${totalRecent} 次/30d`);

		// Show resolved vs active patterns
		const resolved = effectiveness.filter(e => e.isResolved);
		const active = effectiveness.filter(e => !e.isResolved);
		if (active.length > 0) {
			lines.push(`⚠️ 活跃: ${active.map(e => `${e.pattern}(${e.count}x)`).join(", ")}`);
		}
		if (resolved.length > 0) {
			lines.push(`✅ 已控制: ${resolved.map(e => e.pattern).join(", ")}`);
		}
	}

	if (state.analyzedSessionIds.length > 0) {
		lines.push(`已分析 ${state.analyzedSessionIds.length} 个会话的行为`);
	}

	return lines.join("\n");
}

// ===== 工具函数 =====

interface SessionFileInfo {
	id: string;
	path: string;
	timestamp: string;
}

function listSessionFiles(): SessionFileInfo[] {
	if (!existsSync(SESSION_DIR)) return [];
	try {
		const files = readdirSync(SESSION_DIR).filter(f => f.endsWith(".jsonl"));
		return files.map(f => {
			const id = f.replace(".jsonl", "");
			const path = join(SESSION_DIR, f);
			let timestamp = "";
			try {
				const firstLine = readFileSync(path, "utf-8").split("\n")[0];
				if (firstLine) {
					const header = JSON.parse(firstLine) as SessionHeader;
					timestamp = header.timestamp;
				}
			} catch { /* skip */ }
			return { id, path, timestamp };
		});
	} catch {
		return [];
	}
}
