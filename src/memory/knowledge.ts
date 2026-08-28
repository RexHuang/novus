/**
 * Knowledge Store v2 — 分层记忆系统
 *
 * 核心改进：
 *   1. 分层存储：核心知识（高价值持久）vs 对话日志（低价值可过期）
 *   2. 分类体系：knowledge / preference / fact / self-improvement / business
 *   3. 时间衰减：低价值记忆30天后自动降低权重
 *   4. 智能recall：按价值×相关度排序，而非纯时间
 *   5. 精简标签：不再存 used-xx/topic-xx 等噪音标签
 *
 * Storage: JSONL in ~/.novus/knowledge/
 */

import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// 支持环境变量覆盖（测试隔离用）；默认 ~/.novus/knowledge
const KNOWLEDGE_DIR = process.env.NOVUS_KNOWLEDGE_DIR || join(homedir(), ".novus", "knowledge");
const CORE_STORE = join(KNOWLEDGE_DIR, "core.jsonl");     // 高价值持久知识
const LOG_STORE = join(KNOWLEDGE_DIR, "log.jsonl");       // 低价值对话日志
const LEGACY_STORE = join(KNOWLEDGE_DIR, "store.jsonl"); // 旧格式（迁移用）

// ===== 类型 =====

export type KnowledgeCategory =
	| "knowledge"        // 技术知识、概念、原理
	| "preference"       // 用户偏好、工作习惯
	| "fact"             // 具体事实：IP、路径、配置、URL
	| "self-improvement" // 真正有价值的自我改进结论（不是自我批判）
	| "business";        // 商业计划、产品信息、变现策略

export interface KnowledgeEntry {
	id: string;
	/** 内容 */
	content: string;
	/** 来源 */
	source: string;
	/** 分类 */
	category: KnowledgeCategory;
	/** 手动标签（不含噪音） */
	tags: string[];
	/** 创建时间 */
	timestamp: string;
	/** 信心/重要度 0-1 */
	confidence: number;
	/** 引用计数 — 被recall命中过几次 */
	refCount?: number;
	/** 最后被引用的时间 */
	lastReferenced?: string;
}

export interface KnowledgeQuery {
	query?: string;
	category?: KnowledgeCategory;
	tags?: string[];
	source?: string;
	minConfidence?: number;
	limit?: number;
	/** 排序: "value" (价值×相关度), "recent", "confidence" */
	sortBy?: "value" | "recent" | "confidence";
	/** 只查核心知识（默认true） */
	coreOnly?: boolean;
}

// ===== 基础操作 =====

function ensureDir(): void {
	if (!existsSync(KNOWLEDGE_DIR)) mkdirSync(KNOWLEDGE_DIR, { recursive: true });
}

/** 判断条目应该存核心库还是日志 */
function isCoreEntry(entry: { category: KnowledgeCategory; confidence: number }): boolean {
	// 低信心 + 非知识/事实 → 日志
	if (entry.confidence < 0.7 && (entry.category === "self-improvement")) return false;
	return true;
}

function getStorePath(core: boolean): string {
	return core ? CORE_STORE : LOG_STORE;
}

function loadEntries(path: string): KnowledgeEntry[] {
	if (!existsSync(path)) return [];
	const raw = readFileSync(path, "utf-8");
	const entries: KnowledgeEntry[] = [];
	for (const line of raw.trim().split("\n")) {
		if (!line) continue;
		try {
			entries.push(JSON.parse(line) as KnowledgeEntry);
		} catch {
			// skip
		}
	}
	return entries;
}

function saveEntries(path: string, entries: KnowledgeEntry[]): void {
	ensureDir();
	writeFileSync(path, entries.map(e => JSON.stringify(e)).join("\n") + "\n", "utf-8");
}

/** 时间衰减系数：低价值记忆30天后降到0.3，90天后降到0.1 */
function timeDecay(entry: KnowledgeEntry): number {
	const ageMs = Date.now() - new Date(entry.timestamp).getTime();
	const ageDays = ageMs / (1000 * 60 * 60 * 24);
	if (ageDays <= 7) return 1.0;
	if (ageDays <= 30) return 1.0 - 0.3 * ((ageDays - 7) / 23);
	if (ageDays <= 90) return 0.7 - 0.6 * ((ageDays - 30) / 60);
	return 0.1;
}

/** 生成内容指纹（用于去重） */
function contentHash(content: string): string {
	return createHash("sha256").update(content.trim()).digest("hex").slice(0, 12);
}

/** 检查内容是否已存在（基于内容指纹） */
function isDuplicate(content: string, entries: KnowledgeEntry[]): boolean {
	const hash = contentHash(content);
	return entries.some(e => contentHash(e.content) === hash);
}

/** 检查内容是否有意义（非空 JSON、非纯过程记录） */
function isMeaningful(content: string, tags: string[]): boolean {
	const trimmed = content.trim();
	if (trimmed.length < 10) return false;

	// 拒绝过程日志（非知识结论）
	if (/^高强度工作轮/.test(trimmed)) return false;
	if (/^技术决策:\s*(我来看看|我先看看|我看到|我来分析|我来认真|我们)/.test(trimmed)) return false;
	// 拒绝过程性碎片（短句，无实质内容）
	if (/^技术决策:\s*[\u4e00-\u9fff]{1,12}$/.test(trimmed)) return false;
	// 拒绝测试用内容
	if (/^测试去重/.test(trimmed)) return false;

	// 拒绝空 plan JSON
	if (trimmed.startsWith("{")) {
		try {
			const obj = JSON.parse(trimmed);
			if (obj && typeof obj === "object") {
				// 空 plan: {goal: "", steps: []}
				if (obj.goal === "" && Array.isArray(obj.steps) && obj.steps.length === 0) return false;
				// 无意义结构: 只有元数据没有内容
				if (!obj.goal && Array.isArray(obj.steps) && obj.steps.length === 0) return false;
			}
		} catch { /* not JSON, that's fine */ }
	}

	return true;
}

/** 检查是否应该降级到 log（而非核心库） */
function shouldDemoteToLog(content: string, tags: string[]): boolean {
	// discussion-points 是对话过程记录，不是结论
	if (tags.includes("discussion-points")) return true;
	// 重复的 plan JSON 也降级
	if (tags.includes("plan") && content.startsWith("{")) {
		try {
			const obj = JSON.parse(content);
			if (obj && obj.goal === "") return true;
		} catch { /* not JSON */ }
	}
	return false;
}

/** 清理噪音标签 */
function cleanTags(tags: string[]): string[] {
	return tags.filter(t =>
		!t.startsWith("used-") &&
		!t.startsWith("topic:") &&
		t !== "self-reflection" &&
		t !== "self-critique" &&
		t !== "user-correction" &&
		t !== "decision" &&
		t !== "implementation"
	);
}

// ===== 公共API =====

/** 存储新知识 — 自动判断分层，自动清理标签，去重 */
export function storeKnowledge(entry: {
	content: string;
	source?: string;
	category?: KnowledgeCategory;
	tags?: string[];
	confidence?: number;
}): KnowledgeEntry | null {
	ensureDir();

	const tags = cleanTags(entry.tags ?? []);

	// 守卫1: 拒绝无意义内容
	if (!isMeaningful(entry.content, tags)) {
		return null;
	}

	// 守卫2: 去重（检查核心库+日志库）
	const allEntries = [...loadEntries(CORE_STORE), ...loadEntries(LOG_STORE)];
	if (isDuplicate(entry.content, allEntries)) {
		return null;
	}

	const category = entry.category ?? inferCategory(entry.content, tags);
	const confidence = entry.confidence ?? 0.8;

	const full: KnowledgeEntry = {
		id: randomUUID().slice(0, 8),
		content: entry.content,
		source: entry.source ?? "manual",
		category,
		tags,
		timestamp: new Date().toISOString(),
		confidence,
		refCount: 0,
	};

	// 守卫3: discussion-points 和空 plan 降级到 log
	const forceLog = shouldDemoteToLog(entry.content, tags);
	const core = forceLog ? false : isCoreEntry(full);
	const path = getStorePath(core);
	appendFileSync(path, JSON.stringify(full) + "\n", "utf-8");
	return full;
}

/** 根据内容自动推断分类 */
function inferCategory(content: string, tags: string[]): KnowledgeCategory {
	const c = content.toLowerCase();

	// 偏好/习惯
	if (/以后|每次|下次|记住|习惯|偏好|不要.*要/.test(content) ||
		tags.includes("user-preference") || tags.includes("user-habit")) {
		return "preference";
	}

	// 事实
	if (/^(?:ssh|服务器ip|路径|远程部署|产品url|项目名|配置)/.test(content) ||
		tags.some(t => ["ssh", "server", "infrastructure", "deployment", "path", "product", "url", "config"].includes(t))) {
		return "fact";
	}

	// 商业
	if (/月入|变现|商业|snaptool|snaptools|营收|定价|订阅|客户/.test(c) ||
		tags.some(t => ["business", "snaptool", "monetization"].includes(t))) {
		return "business";
	}

	// 自我改进（只保留真正的改进结论，不是自我批判）
	if (/^(?:自我改进|进化|改进|优化|升级)/.test(content) ||
		tags.includes("self-improvement")) {
		return "self-improvement";
	}

	return "knowledge";
}

/** 写回引用计数更新到磁盘（延迟批量写入，避免频繁IO） */
let pendingRefUpdates = new Map<string, { refCount: number; lastReferenced: string }>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flushRefUpdates(): void {
	if (pendingRefUpdates.size === 0) return;
	const updates = new Map(pendingRefUpdates);
	pendingRefUpdates.clear();
	if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }

	// 只更新核心库（日志库不追踪引用）
	const path = CORE_STORE;
	if (!existsSync(path)) return;
	const entries = loadEntries(path);
	let changed = false;
	for (const e of entries) {
		const update = updates.get(e.id);
		if (update) {
			e.refCount = update.refCount;
			e.lastReferenced = update.lastReferenced;
			changed = true;
		}
	}
	if (changed) saveEntries(path, entries);
}

/** 安排延迟写回（100ms内的多次recall合并为一次写入） */
function scheduleRefFlush(): void {
	if (flushTimer) return;
	flushTimer = setTimeout(() => {
		flushTimer = null;
		flushRefUpdates();
	}, 100);
}

/** 查询知识 — 默认按价值排序，支持结果去重 */
export function queryKnowledge(q: KnowledgeQuery & { deduplicate?: boolean }): KnowledgeEntry[] {
	const coreOnly = q.coreOnly !== false;

	let coreEntries = loadEntries(CORE_STORE);
	let logEntries = coreOnly ? [] : loadEntries(LOG_STORE);
	let entries = [...coreEntries, ...logEntries];

	// 按分类过滤
	if (q.category) {
		entries = entries.filter(e => e.category === q.category);
	}

	// 按标签过滤
	if (q.tags && q.tags.length > 0) {
		entries = entries.filter(e => q.tags!.some(t => e.tags.includes(t)));
	}

	// 按来源过滤
	if (q.source) {
		const src = q.source.toLowerCase();
		entries = entries.filter(e => e.source.toLowerCase().includes(src));
	}

	// 最低信心
	if (q.minConfidence !== undefined) {
		entries = entries.filter(e => e.confidence >= q.minConfidence!);
	}

	// 文本搜索 + 评分
	if (q.query) {
		const queryTokens = tokenize(q.query);
		const scored = entries.map(e => {
			const entryTokens = tokenize(e.content + " " + e.tags.join(" "));
			let relevance = 0;
			for (const qt of queryTokens) {
				if (entryTokens.has(qt)) relevance += 1;
				for (const et of entryTokens) {
					if (et.startsWith(qt) && et !== qt) relevance += 0.5;
					if (qt.startsWith(et) && et !== qt) relevance += 0.3;
				}
			}
			// 价值 = 信心 × 时间衰减 × (1 + 引用加成)
			const refBonus = Math.min((e.refCount ?? 0) * 0.05, 0.3);
			const value = e.confidence * timeDecay(e) * (1 + refBonus) * (0.5 + relevance);
			return { entry: e, relevance, value };
		}).filter(s => s.relevance > 0);

		// 更新引用计数并安排延迟写回
		for (const s of scored.slice(0, 5)) {
			s.entry.refCount = (s.entry.refCount ?? 0) + 1;
			s.entry.lastReferenced = new Date().toISOString();
			pendingRefUpdates.set(s.entry.id, {
				refCount: s.entry.refCount,
				lastReferenced: s.entry.lastReferenced,
			});
		}
		scheduleRefFlush();

		if (q.sortBy === "value" || !q.sortBy) {
		scored.sort((a, b) => b.value - a.value);
		entries = scored.map(s => s.entry);
		} else {
		// 按其他排序时也用scored的relevance过滤
		entries = scored.map(s => s.entry);
		if (q.sortBy === "confidence") {
			entries.sort((a, b) => b.confidence - a.confidence);
		} else {
			entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
		}
		}
	} else {
		// 无搜索词时的排序
		if (q.sortBy === "confidence") {
			entries.sort((a, b) => b.confidence - a.confidence);
		} else {
			entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
		}
	}

	// 结果去重：相似条目只保留最佳
	if (q.deduplicate !== false && q.query && entries.length > 1) {
		entries = deduplicateResults(entries, 0.55);
	}

	if (q.limit && q.limit > 0) {
		entries = entries.slice(0, q.limit);
	}

	return entries;
}

/** 对召回结果去重：相似条目（Jaccard > threshold）分组，每组只保留最高分 */
function deduplicateResults(entries: KnowledgeEntry[], threshold: number = 0.55): KnowledgeEntry[] {
	if (entries.length <= 1) return entries;
	
	const groups: KnowledgeEntry[][] = [];
	const assigned = new Set<string>();
	
	for (let i = 0; i < entries.length; i++) {
		if (assigned.has(entries[i]!.id)) continue;
		const group: KnowledgeEntry[] = [entries[i]!];
		assigned.add(entries[i]!.id);
		
		for (let j = i + 1; j < entries.length; j++) {
			if (assigned.has(entries[j]!.id)) continue;
			if (entries[i]!.category !== entries[j]!.category) continue;
			const sim = tokenSimilarity(entries[i]!.content, entries[j]!.content);
			if (sim > threshold) {
				group.push(entries[j]!);
				assigned.add(entries[j]!.id);
			}
		}
		groups.push(group);
	}
	
	// 每组保留最佳条目（按内容长度优先，因为更长通常更完整）
	const results: KnowledgeEntry[] = [];
	for (const group of groups) {
		if (group.length === 1) {
			results.push(group[0]!);
		} else {
			// 选内容最长的（最完整），标记有重复
			group.sort((a, b) => b.content.length - a.content.length);
			const best = { ...group[0]! };
			best.tags = [...best.tags, `merged:${group.length - 1}`];
			results.push(best);
		}
	}
	
	return results;
}

/** 获取总数（核心+日志） */
export function knowledgeCount(): number {
	return loadEntries(CORE_STORE).length + loadEntries(LOG_STORE).length;
}

/** 获取核心知识数 */
export function coreKnowledgeCount(): number {
	return loadEntries(CORE_STORE).length;
}

/** 获取各类别统计 */
export function knowledgeStats(): { total: number; core: number; log: number; byCategory: Record<string, number> } {
	const core = loadEntries(CORE_STORE);
	const log = loadEntries(LOG_STORE);
	const all = [...core, ...log];
	const byCategory: Record<string, number> = {};
	for (const e of all) {
		byCategory[e.category] = (byCategory[e.category] || 0) + 1;
	}
	return { total: all.length, core: core.length, log: log.length, byCategory };
}

/** 清理过期日志（超过90天的低价值记忆） */
export function pruneExpired(): number {
	const logEntries = loadEntries(LOG_STORE);
	const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
	const kept = logEntries.filter(e => new Date(e.timestamp).getTime() > cutoff);
	const removed = logEntries.length - kept.length;
	if (removed > 0) saveEntries(LOG_STORE, kept);
	return removed;
}

// ===== 知识质量分析 =====

export interface PruneAnalysis {
	/** 总条目数 */
	total: number;
	/** 低价值条目（建议清理） */
	candidates: PruneCandidate[];
	/** 各类问题统计 */
	issues: { noise: number; duplicateTopic: number; processLog: number; stale: number };
	/** 建议 */
	recommendation: string;
}

export interface PruneCandidate {
	id: string;
	content: string;
	category: string;
	tags: string[];
	timestamp: string;
	confidence: number;
	refCount?: number;
	reason: string;
}

/** 模式匹配：检测明显低价值的内容 */
function detectNoisePatterns(content: string): string | null {
	const c = content.trim();
	// "高强度工作轮" — 纯过程日志
	if (/^高强度工作轮/.test(c)) return "process-log";
	// "技术决策: 我先看看/我来分析" — 行动过程，不是结论
	if (/^技术决策:\s*(我来看看|我先看看|我来看看|我来分析|我看到)/.test(c)) return "process-log";
	// "讨论要点:" 开头的长对话过程记录
	if (/^讨论要点[:：]/.test(c) && c.length > 200) return "discussion-fragment";
	// 纯结构化JSON（plan步骤列表等），非知识
	if (/^\s*\[.*\]\s*$/.test(c) && c.length < 100) return "empty-structure";
	// 过短的"knowledge"类内容（小于20字）
	if (c.length < 20) return "trivial";
	return null;
}

/**
 * Compute token-based Jaccard similarity between two strings.
 * Returns 0-1 where 1 means identical token sets.
 */
function tokenSimilarity(a: string, b: string): number {
	const ta = tokenize(a);
	const tb = tokenize(b);
	if (ta.size === 0 || tb.size === 0) return 0;
	let intersection = 0;
	for (const t of ta) {
		if (tb.has(t)) intersection++;
	}
	return intersection / (ta.size + tb.size - intersection);
}

/**
 * Detect near-duplicate entries using token overlap (Jaccard similarity).
 * Groups entries where similarity > 0.6 as potential duplicates.
 * Much more accurate than prefix-based matching.
 */
function findTopicDuplicates(entries: KnowledgeEntry[]): Map<string, KnowledgeEntry[]> {
	const groups = new Map<string, KnowledgeEntry[]>();
	const assigned = new Set<string>(); // Track already-assigned entry IDs

	for (let i = 0; i < entries.length; i++) {
		if (assigned.has(entries[i].id)) continue;
		for (let j = i + 1; j < entries.length; j++) {
			if (assigned.has(entries[j].id)) continue;
			if (entries[i].category !== entries[j].category) continue;
			const sim = tokenSimilarity(entries[i].content, entries[j].content);
			if (sim > 0.6) {
				// Use the earlier entry's id as group key
				const key = entries[i].id;
				if (!groups.has(key)) groups.set(key, [entries[i]]);
				groups.get(key)!.push(entries[j]);
				assigned.add(entries[j].id);
			}
		}
	}

	return groups;
}

/** 分析知识库质量，返回建议清理的条目 */
export function analyzeKnowledgeQuality(): PruneAnalysis {
	const core = loadEntries(CORE_STORE);
	const log = loadEntries(LOG_STORE);
	const all = [...core, ...log];
	const now = Date.now();

	const candidates: PruneCandidate[] = [];
	const issues = { noise: 0, duplicateTopic: 0, processLog: 0, stale: 0 };

	// 1. 噪音检测：明显低价值模式
	for (const e of all) {
		const pattern = detectNoisePatterns(e.content);
		if (pattern === "process-log") {
			issues.processLog++;
			candidates.push({ ...e, reason: "过程日志（非知识结论）" });
		} else if (pattern === "discussion-fragment") {
			issues.noise++;
			candidates.push({ ...e, reason: "对话过程碎片（非结论）" });
		} else if (pattern === "trivial") {
			issues.noise++;
			candidates.push({ ...e, reason: "内容过短（<20字）" });
		} else if (pattern === "empty-structure") {
			issues.noise++;
			candidates.push({ ...e, reason: "空结构化数据" });
		}
	}

	// 2. 同主题重复检测（保留最长的版本）
	const duplicates = findTopicDuplicates(all);
	const deduplicatedIds = new Set<string>();
	for (const [, group] of duplicates) {
		// 按内容长度排序，保留最长的
		group.sort((a, b) => b.content.length - a.content.length);
		for (let i = 1; i < group.length; i++) {
			const e = group[i];
			if (!candidates.some(c => c.id === e.id)) {
				issues.duplicateTopic++;
				candidates.push({ ...e, reason: `同主题重复（保留最长版 ${group[0].id}）` });
				deduplicatedIds.add(e.id);
			}
		}
	}

	// 3. 陈旧检测：>30天未被引用且低信心
	for (const e of all) {
		const age = (now - new Date(e.timestamp).getTime()) / 86400000;
		const lastRef = e.lastReferenced
			? (now - new Date(e.lastReferenced).getTime()) / 86400000
			: 999;
		if (age > 30 && lastRef > 30 && e.confidence < 0.8 && !candidates.some(c => c.id === e.id)) {
			issues.stale++;
			candidates.push({ ...e, reason: "30天+未引用且低信心" });
		}
	}

	// 生成建议
	const total = all.length;
	const pruneCount = candidates.length;
	let recommendation: string;
	if (pruneCount === 0) {
		recommendation = "知识库质量良好，无需清理。";
	} else if (pruneCount < total * 0.1) {
		recommendation = `发现 ${pruneCount} 条低价值条目（${(pruneCount/total*100).toFixed(0)}%），建议清理。`;
	} else if (pruneCount < total * 0.3) {
		recommendation = `发现 ${pruneCount} 条低价值条目（${(pruneCount/total*100).toFixed(0)}%），建议批量清理以提升知识密度。`;
	} else {
		recommendation = `发现 ${pruneCount} 条低价值条目（${(pruneCount/total*100).toFixed(0)}%），知识库质量较低，建议深度清理。`;
	}

	return { total, candidates, issues, recommendation };
}

/** 执行清理：删除指定的条目 */
export function pruneEntries(ids: string[]): { removed: number } {
	let removed = 0;
	for (const store of [CORE_STORE, LOG_STORE]) {
		const entries = loadEntries(store);
		const kept = entries.filter(e => !ids.includes(e.id));
		removed += entries.length - kept.length;
		if (entries.length !== kept.length) {
			saveEntries(store, kept);
		}
	}
	return { removed };
}

/** 清空所有（危险） */
export function clearKnowledge(): void {
	for (const p of [CORE_STORE, LOG_STORE, LEGACY_STORE]) {
		if (existsSync(p)) unlinkSync(p);
	}
}

// ===== 知识压缩 =====

export interface CompressResult {
	compressed: number;
	merged: number;
	/** 被合并的条目ID列表 */
	removedIds: string[];
	/** 新创建的合并条目 */
	newEntry?: KnowledgeEntry;
}

/** 查找可压缩的条目组（相似度 > 0.6，同分类） */
export function findCompressibleGroups(minSimilarity: number = 0.6): Array<{ entries: KnowledgeEntry[]; avgSimilarity: number }> {
	const core = loadEntries(CORE_STORE);
	if (core.length < 2) return [];

	const groups: Array<{ entries: KnowledgeEntry[]; avgSimilarity: number }> = [];
	const assigned = new Set<string>();

	for (let i = 0; i < core.length; i++) {
		if (assigned.has(core[i]!.id)) continue;
		const group: KnowledgeEntry[] = [core[i]!];
		let totalSim = 0;
		let pairwiseCount = 0;

		for (let j = i + 1; j < core.length; j++) {
			if (assigned.has(core[j]!.id)) continue;
			if (core[i]!.category !== core[j]!.category) continue;
			const sim = tokenSimilarity(core[i]!.content, core[j]!.content);
			if (sim > minSimilarity) {
				group.push(core[j]!);
				assigned.add(core[j]!.id);
				totalSim += sim;
				pairwiseCount++;
			}
		}

		if (group.length >= 2) {
			assigned.add(core[i]!.id);
			groups.push({
				entries: group,
				avgSimilarity: pairwiseCount > 0 ? totalSim / pairwiseCount : 0,
			});
		}
	}

	return groups;
}

/** 压缩一组相似条目：合并为一条摘要，删除原条目 */
export function compressGroup(group: KnowledgeEntry[]): CompressResult {
	if (group.length < 2) return { compressed: 0, merged: 0, removedIds: [] };

	// 合并内容：最长条目作基础，附加其他条目的独特信息
	const sorted = [...group].sort((a, b) => b.content.length - a.content.length);
	const base = sorted[0]!;
	const extraTags = new Set<string>();
	const extraInfo: string[] = [];

	for (let i = 1; i < sorted.length; i++) {
		const e = sorted[i]!;
		for (const t of e.tags) extraTags.add(t);
		// 提取不在 base 中的独特短语
		const baseTokens = tokenize(base.content);
		const eTokens = tokenize(e.content);
		const uniqueTokens = [...eTokens].filter(t => !baseTokens.has(t) && t.length > 1);
		if (uniqueTokens.length > 0) {
			extraInfo.push(e.content.slice(0, 200));
		}
	}

	// 构建合并内容
	let mergedContent = base.content;
	if (extraInfo.length > 0) {
		mergedContent += "\n\n【压缩补充】" + extraInfo.map((s, i) => `(${i + 1}) ${s}`).join("\n");
	}

	// 计算合并后的 confidence：取最高
	const maxConfidence = Math.max(...group.map(e => e.confidence));
	// 累积引用计数
	const totalRefs = group.reduce((sum, e) => sum + (e.refCount ?? 0), 0);
	// 最早的时间戳
	const oldest = group.map(e => e.timestamp).sort()[0]!;
	// 合并标签
	const allTags = [...new Set([...base.tags, ...extraTags])].filter(t => !t.startsWith("merged:"));
	allTags.push(`compressed:${group.length}`);

	const merged: KnowledgeEntry = {
		id: randomUUID().slice(0, 8),
		content: mergedContent,
		source: "compress",
		category: base.category,
		tags: allTags,
		timestamp: oldest,
		confidence: maxConfidence,
		refCount: totalRefs,
	};

	return {
		compressed: group.length,
		merged: 1,
		removedIds: group.map(e => e.id),
		newEntry: merged,
	};
}

/** 执行知识压缩：查找并压缩所有可合并的组 */
export function compressAllKnowledge(minSimilarity: number = 0.6): { groups: number; totalCompressed: number; totalMerged: number } {
	const groups = findCompressibleGroups(minSimilarity);
	if (groups.length === 0) return { groups: 0, totalCompressed: 0, totalMerged: 0 };

	let totalCompressed = 0;
	let totalMerged = 0;
	const allRemovedIds: string[] = [];
	const newEntries: KnowledgeEntry[] = [];

	for (const group of groups) {
		const result = compressGroup(group.entries);
		totalCompressed += result.compressed;
		totalMerged += result.merged;
		allRemovedIds.push(...result.removedIds);
		if (result.newEntry) newEntries.push(result.newEntry);
	}

	// 删除被合并的旧条目
	pruneEntries(allRemovedIds);

	// 写入新的合并条目
	for (const e of newEntries) {
		appendFileSync(CORE_STORE, JSON.stringify(e) + "\n", "utf-8");
	}

	return { groups: groups.length, totalCompressed, totalMerged };
}

// ===== 主动召回（会话上下文）=====

/** 从记忆库中提取"你应该知道"的上下文，用于注入 system prompt */
export function getContextualMemory(maxEntries: number = 8): string {
	const core = loadEntries(CORE_STORE);
	if (core.length === 0) return "";

	// 按价值排序：confidence × timeDecay × (1 + refBonus)
	const scored = core.map(e => {
		const refBonus = Math.min((e.refCount ?? 0) * 0.05, 0.3);
		const value = e.confidence * timeDecay(e) * (1 + refBonus);
		return { entry: e, value };
	});
	scored.sort((a, b) => b.value - a.value);

	// 取 top N，去重
	const topEntries = deduplicateResults(
		scored.slice(0, maxEntries * 2).map(s => s.entry),
		0.6
	).slice(0, maxEntries);

	if (topEntries.length === 0) return "";

	const lines: string[] = [];
	// 按分类分组
	const byCategory: Record<string, KnowledgeEntry[]> = {};
	for (const e of topEntries) {
		(byCategory[e.category] ??= []).push(e);
	}

	for (const [cat, entries] of Object.entries(byCategory)) {
		const catLabel: Record<string, string> = {
			knowledge: "🧠 Knowledge",
			preference: "💡 Preferences",
			fact: "📋 Facts",
			"self-improvement": "🔧 Self-Improvement",
			business: "💰 Business",
		};
		lines.push(catLabel[cat] ?? cat);
		for (const e of entries) {
			const preview = e.content.length > 150 ? e.content.slice(0, 150) + "..." : e.content;
			lines.push(`  - ${preview}`);
		}
	}

	return `\n## 🧠 Memory Context (from past sessions)\n${lines.join("\n")}`;
}

/** Ensure pending refCount updates are flushed (call before process exit) */
export function flushPendingRefs(): void {
	if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
	flushRefUpdates();
}

// ===== 元记忆系统 (Meta-Memory) =====
//
// 让AI知道“自己知道什么”和“自己不知道什么”。
// 分析知识库覆盖度，识别盲区，提供召回质量评估。

export interface MetaMemoryReport {
	/** 知识库总览 */
	summary: {
		total: number;
		core: number;
		log: number;
		experiences: number;
	};
	/** 分类覆盖 */
	categories: Record<string, { count: number; avgConfidence: number; avgRefCount: number }>;
	/** 高频标签（标签云，反映知识面） */
	tagCloud: Array<{ tag: string; count: number }>;
	/** 盲区检测：查询是否命中任何知识 */
	queryHit: {
		query: string;
		hit: boolean;
		hitCount: number;
		score: number;
		bestCategory: string;
	};
	/** 知识健康指标 */
	health: {
		avgConfidence: number;
		avgRefCount: number;
		staleEntries: number; // 30天以上未被引用
		orphanEntries: number; // 从未被引用过的
		knowledgeFreshness: number; // 0-1, 越高越新鲜
	};
}

/** 生成元记忆报告 */
export function metaMemory(query?: string): MetaMemoryReport {
	const coreEntries = loadEntries(CORE_STORE);
	const logEntries = loadEntries(LOG_STORE);
	const experiences = loadExperiences();
	const all = [...coreEntries, ...logEntries];
	const now = Date.now();

	// 分类覆盖
	const categories: Record<string, { count: number; totalConf: number; totalRef: number }> = {};
	for (const e of all) {
		if (!categories[e.category]) categories[e.category] = { count: 0, totalConf: 0, totalRef: 0 };
		categories[e.category].count++;
		categories[e.category].totalConf += e.confidence;
		categories[e.category].totalRef += e.refCount ?? 0;
	}

	// 标签云
	const tagMap: Record<string, number> = {};
	for (const e of all) {
		for (const tag of e.tags) tagMap[tag] = (tagMap[tag] || 0) + 1;
	}
	const tagCloud = Object.entries(tagMap)
		.map(([tag, count]) => ({ tag, count }))
		.sort((a, b) => b.count - a.count)
		.slice(0, 30);

	// 查询命中检测
	let queryHit: MetaMemoryReport["queryHit"] = {
		query: query || "(none)",
		hit: false,
		hitCount: 0,
		score: 0,
		bestCategory: "",
	};

	if (query) {
		const queryTokens = tokenize(query);
		const scored = all.map(e => {
			const entryTokens = tokenize(e.content + " " + e.tags.join(" "));
			let relevance = 0;
			for (const qt of queryTokens) {
				if (entryTokens.has(qt)) relevance += 1;
			}
			return { entry: e, relevance };
		}).filter(s => s.relevance > 0);

		queryHit.hit = scored.length > 0;
		queryHit.hitCount = scored.length;
		queryHit.score = scored.length > 0 ? Math.min(scored[0]!.relevance / queryTokens.size, 1) : 0;
		queryHit.bestCategory = scored.length > 0 ? scored[0]!.entry.category : "";
	}

	// 健康指标
	const thirtyDaysAgo = now - 30 * 86400000;
	let staleEntries = 0;
	let orphanEntries = 0;
	let totalConf = 0;
	let totalRef = 0;
	for (const e of all) {
		totalConf += e.confidence;
		totalRef += e.refCount ?? 0;
		if (e.refCount === 0) orphanEntries++;
		const lastRef = e.lastReferenced ? new Date(e.lastReferenced).getTime() : new Date(e.timestamp).getTime();
		if (lastRef < thirtyDaysAgo) staleEntries++;
	}
	const n = all.length || 1;
	const freshness = Math.max(0, 1 - staleEntries / n);

	return {
		summary: { total: all.length, core: coreEntries.length, log: logEntries.length, experiences: experiences.length },
		categories: Object.fromEntries(
			Object.entries(categories).map(([k, v]) => [k, { count: v.count, avgConfidence: Math.round(v.totalConf / v.count * 100) / 100, avgRefCount: Math.round(v.totalRef / v.count * 100) / 100 }]),
		),
		tagCloud,
		queryHit,
		health: {
			avgConfidence: Math.round(totalConf / n * 100) / 100,
			avgRefCount: Math.round(totalRef / n * 100) / 100,
			staleEntries,
			orphanEntries,
			knowledgeFreshness: Math.round(freshness * 100) / 100,
		},
	};
}

/** 加载所有知识（兼容旧代码） */
export function loadAllKnowledge(): KnowledgeEntry[] {
	// 优先从新格式加载
	const core = loadEntries(CORE_STORE);
	const log = loadEntries(LOG_STORE);
	if (core.length > 0 || log.length > 0) {
		return [...core, ...log];
	}
	// 兼容旧格式
	return loadEntries(LEGACY_STORE);
}

/**
 * 迁移旧格式记忆到新分层系统
 * 迁移策略：
 * - 自我批判/用户纠正 → 日志（低价值）
 * - 技术决策/结论/事实 → 核心（高价值）
 * - 清理所有噪音标签
 */
export function migrateFromLegacy(): { migrated: number; core: number; log: number; skipped: number } {
	if (!existsSync(LEGACY_STORE)) return { migrated: 0, core: 0, log: 0, skipped: 0 };

	const legacy = loadEntries(LEGACY_STORE);
	if (legacy.length === 0) return { migrated: 0, core: 0, log: 0, skipped: 0 };

	let core = 0, log = 0, skipped = 0;

	for (const entry of legacy) {
		// 跳过已经迁移过的
		if ((entry as any).category) { skipped++; continue; }

		const content = entry.content;

		// 自我批判和用户纠正 → 日志，低信心
		if (content.startsWith("自我批判") || content.startsWith("用户纠正")) {
			const migrated: KnowledgeEntry = {
				...entry,
			category: "self-improvement",
			tags: cleanTags(entry.tags),
			confidence: 0.4,
			refCount: 0,
			};
			appendFileSync(LOG_STORE, JSON.stringify(migrated) + "\n", "utf-8");
			log++;
			continue;
		}

		// 推断分类
		const category = inferCategory(content, entry.tags);
		const migrated: KnowledgeEntry = {
			...entry,
			category,
			tags: cleanTags(entry.tags),
			refCount: 0,
		};

		if (isCoreEntry(migrated)) {
			appendFileSync(CORE_STORE, JSON.stringify(migrated) + "\n", "utf-8");
			core++;
		} else {
			appendFileSync(LOG_STORE, JSON.stringify(migrated) + "\n", "utf-8");
			log++;
		}
	}

	return { migrated: core + log, core, log, skipped };
}

// ===== 情景记忆系统 (Episodic Memory) =====
//
// 区别于知识片段（flat conclusions），情景记忆存储完整的经历结构：
//   什么场景 → 遇到什么 → 做了什么 → 结果如何 → 学到什么
// 可按场景/标签/时间检索，形成可复用的经验库。
//
// 存储: ~/.novus/knowledge/experience.jsonl

const EXPERIENCE_STORE = join(KNOWLEDGE_DIR, "experience.jsonl");
const MAX_EXPERIENCES = 500;

export interface ExperienceEntry {
	id: string;
	/** 经历标题 */
	title: string;
	/** 场景描述（什么情况下发生的） */
	scenario: string;
	/** 遇到的问题/情况 */
	situation: string;
	/** 采取的行动 */
	actions: string[];
	/** 结果 */
	outcome: string;
	/** 学到的教训/规则（可被identity复用） */
	lessons: string[];
	/** 来源会话 */
	sessionId?: string;
	/** 标签（场景分类：debug、deploy、ssh、优化等） */
	tags: string[];
	/** 时间戳 */
	timestamp: string;
	/** 信心 0-1 */
	confidence: number;
	/** 引用计数 */
	refCount: number;
}

/** 存储情景记忆 */
export function storeExperience(entry: Omit<ExperienceEntry, "id" | "refCount">): ExperienceEntry {
	ensureDir();
	const entries = loadExperiences();

	// 去重：相同title+scenario的保留最新
	const dupIdx = entries.findIndex(e => e.title === entry.title && e.scenario === entry.scenario);
	if (dupIdx >= 0) entries.splice(dupIdx, 1);

	const newEntry: ExperienceEntry = {
		...entry,
		id: randomUUID().slice(0, 8),
		refCount: 0,
	};
	entries.unshift(newEntry);

	// 限制总数
	if (entries.length > MAX_EXPERIENCES) {
		entries.splice(MAX_EXPERIENCES);
	}

	// 经历用独立存储（不混入knowledge entries）
	writeFileSync(EXPERIENCE_STORE, entries.map(e => JSON.stringify(e)).join("\n") + "\n", "utf-8");
	return newEntry;
}

/** 检索情景记忆（按场景/标签/关键词匹配） */
export function recallExperience(query: {
	scenario?: string;
	tags?: string[];
	keyword?: string;
	limit?: number;
}): ExperienceEntry[] {
	const entries = loadExperiences();
	if (entries.length === 0) return [];

	let scored = entries.map(e => {
		let score = 0;

		// 标签精确匹配
		if (query.tags?.length) {
			for (const tag of query.tags) {
				if (e.tags.includes(tag)) score += 10;
			}
		}

		// 场景匹配
		if (query.scenario) {
			const queryTokens = tokenize(query.scenario);
			const sceneTokens = tokenize(e.scenario + " " + e.situation);
			let overlap = 0;
			for (const t of queryTokens) {
				if (sceneTokens.has(t)) overlap++;
			}
			if (queryTokens.size > 0) score += (overlap / queryTokens.size) * 8;
		}

		// 关键词全文搜索
		if (query.keyword) {
			const fullText = (e.title + " " + e.scenario + " " + e.situation + " " + e.outcome + " " + e.lessons.join(" ")).toLowerCase();
			if (fullText.includes(query.keyword.toLowerCase())) score += 5;
			// 额外搜索 bigrams
			const kwTokens = tokenize(query.keyword);
			for (const t of kwTokens) {
				if (fullText.includes(t)) score += 2;
			}
		}

		// 时间衰减（越新越好，但教训不会过时）
		const ageDays = (Date.now() - new Date(e.timestamp).getTime()) / 86400000;
		const recency = ageDays < 7 ? 1.0 : ageDays < 30 ? 0.8 : 0.6;
		// 有教训的经验不过时
		const hasLessons = e.lessons.length > 0;

		return { entry: e, score: score * (hasLessons ? 1.2 : recency) };
	});

	scored.sort((a, b) => b.score - a.score);
	return scored.filter(s => s.score > 1).slice(0, query.limit ?? 10).map(s => s.entry);
}

/** 从 worklog 条目自动提取情景记忆 */
export function extractExperienceFromWorklog(wle: {
	activity: string;
	changes?: string;
	nextStep?: string;
	step?: string;
	files?: string[];
	status?: string;
	timestamp?: string;
	sessionId?: string;
}): Omit<ExperienceEntry, "id" | "refCount"> | null {
	// 只提取有实质改动的工作（跳过idle/blocked/简单的"检查"）
	if (wle.status === "idle" || wle.status === "blocked") return null;
	if (!wle.changes && !wle.files?.length) return null;
	if (wle.activity.length < 8) return null;

	// 推断场景标签
	const tags: string[] = [];
	const fullText = (wle.activity + " " + (wle.changes || "") + " " + (wle.step || "")).toLowerCase();
	const tagMap: Record<string, string[]> = {
		debug: ["修复", "fix", "bug", "错误", "error", "排查", "诊断"],
		deploy: ["部署", "deploy", "发布", "publish", "同步", "sync"],
		ssh: ["ssh", "175", "93", "服务器", "远程"],
		optimize: ["优化", "优化", "改进", "升级", "improve", "重构"],
		monitor: ["巡检", "检查", "check", "健康", "health"],
	};
	for (const [tag, keywords] of Object.entries(tagMap)) {
		if (keywords.some(kw => fullText.includes(kw))) tags.push(tag);
	}
	if (tags.length === 0) tags.push("general");

	// 从改动描述中提取教训
	const lessons: string[] = [];
	if (wle.changes) {
		// 提取"改为""加""去掉"等动词后的关键信息
		const patterns = wle.changes.match(/(?:改为|改为|加|新增|去掉|移除|修复|改用)[^,;。]+/g);
		if (patterns) lessons.push(...patterns.map(p => "改动: " + p.trim()));
		// 如果有"避免"字样，直接提取为教训
		const avoidPatterns = wle.changes.match(/避免[^,;。]+/g);
		if (avoidPatterns) lessons.push(...avoidPatterns.map(p => p.trim()));
	}

	const result: Omit<ExperienceEntry, "id" | "refCount"> = {		title: wle.activity,
		scenario: wle.step || tags.join(", "),
		situation: wle.activity,
		actions: wle.changes ? [wle.changes] : [],
		outcome: wle.status === "done" ? "成功" : wle.status === "blocked" ? "受阻" : "进行中",
		lessons,
		sessionId: wle.sessionId,
		tags,
		timestamp: wle.timestamp || new Date().toISOString(),
		confidence: 0.85,
	};
	return result;
}

/** 加载所有情景记忆 */
function loadExperiences(): ExperienceEntry[] {
	if (!existsSync(EXPERIENCE_STORE)) return [];
	return loadEntries(EXPERIENCE_STORE) as unknown as ExperienceEntry[];
}

/** 情景记忆统计 */
export function experienceStats(): { total: number; byTag: Record<string, number>; recent: string } {
	const entries = loadExperiences();
	const byTag: Record<string, number> = {};
	for (const e of entries) {
		for (const tag of e.tags) byTag[tag] = (byTag[tag] || 0) + 1;
	}
	return {
		total: entries.length,
		byTag,
		recent: entries[0]?.timestamp || "无",
	};
}

// ===== Tokenize =====

function tokenize(text: string): Set<string> {
	const lower = text.toLowerCase();
	const tokens = new Set<string>();
	const regex = /[a-z0-9]+|[一-鿿㐀-䶿]+/g;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(lower)) !== null) {
		const word = match[0]!;
		tokens.add(word);
		// For Chinese: also extract bigrams for better recall
		if (word.length >= 2 && /[一-鿿㐀-䶿]/.test(word)) {
			for (let i = 0; i < word.length - 1; i++) {
				tokens.add(word.slice(i, i + 2));
			}
		}
	}
	return tokens;
}
