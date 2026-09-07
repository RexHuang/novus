/**
 * Knowledge Store v2 — Layered memory system
 *
 * Key improvements:
 *   1. Layered storage: core knowledge (high-value, persistent) vs conversation log (low-value, expirable)
 *   2. Categories: knowledge / preference / fact / self-improvement / business
 *   3. Time decay: low-value memory loses weight after 30 days
 *   4. Smart recall: ranked by value × relevance, not pure recency
 *   5. Lean tags: no more used-xx/topic-xx noise tags
 *
 * Storage: JSONL in ~/.novus/knowledge/
 */

import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Env var override supported (for test isolation); default ~/.novus/knowledge
const KNOWLEDGE_DIR = process.env.NOVUS_KNOWLEDGE_DIR || join(homedir(), ".novus", "knowledge");
const CORE_STORE = join(KNOWLEDGE_DIR, "core.jsonl");     // core knowledge (high-value, persistent)
const LOG_STORE = join(KNOWLEDGE_DIR, "log.jsonl");       // conversation log (low-value)
const LEGACY_STORE = join(KNOWLEDGE_DIR, "store.jsonl"); // legacy format (migration)

// ===== Types =====

export type KnowledgeCategory =
	| "knowledge"        // tech knowledge, concepts, principles
	| "preference"       // user preferences, work habits
	| "fact"             // concrete facts: IPs, paths, configs, URLs
	| "self-improvement" // genuinely valuable self-improvement conclusions (not self-criticism)
	| "business";        // business plans, product info, monetization

export interface KnowledgeEntry {
	id: string;
	/** content */
	content: string;
	/** source */
	source: string;
	/** category */
	category: KnowledgeCategory;
	/** manual tags (no noise) */
	tags: string[];
	/** created at */
	timestamp: string;
	/** confidence/importance 0-1 */
	confidence: number;
	/** ref count — how many times hit by recall */
	refCount?: number;
	/** last referenced at */
	lastReferenced?: string;
}

export interface KnowledgeQuery {
	query?: string;
	category?: KnowledgeCategory;
	tags?: string[];
	source?: string;
	minConfidence?: number;
	limit?: number;
	/** sort: "value" (value × relevance), "recent", "confidence" */
	sortBy?: "value" | "recent" | "confidence";
	/** core only (default true) */
	coreOnly?: boolean;
}

// ===== Basic ops =====

function ensureDir(): void {
	if (!existsSync(KNOWLEDGE_DIR)) mkdirSync(KNOWLEDGE_DIR, { recursive: true });
}

/** Decide whether an entry goes to the core store or the log */
function isCoreEntry(entry: { category: KnowledgeCategory; confidence: number }): boolean {
	// low confidence + not knowledge/fact → log
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

/** Time decay: low-value memory drops to 0.3 after 30 days, 0.1 after 90 */
function timeDecay(entry: KnowledgeEntry): number {
	const ageMs = Date.now() - new Date(entry.timestamp).getTime();
	const ageDays = ageMs / (1000 * 60 * 60 * 24);
	if (ageDays <= 7) return 1.0;
	if (ageDays <= 30) return 1.0 - 0.3 * ((ageDays - 7) / 23);
	if (ageDays <= 90) return 0.7 - 0.6 * ((ageDays - 30) / 60);
	return 0.1;
}

/** Content fingerprint (for dedup) */
function contentHash(content: string): string {
	return createHash("sha256").update(content.trim()).digest("hex").slice(0, 12);
}

/** Check if content already exists (by fingerprint) */
function isDuplicate(content: string, entries: KnowledgeEntry[]): boolean {
	const hash = contentHash(content);
	return entries.some(e => contentHash(e.content) === hash);
}

/** Check whether content is meaningful (non-empty JSON, not a pure process log) */
function isMeaningful(content: string, tags: string[]): boolean {
	const trimmed = content.trim();
	if (trimmed.length < 10) return false;

	// reject process logs (not knowledge conclusions)
	if (/^高强度工作轮/.test(trimmed)) return false;
	if (/^技术决策:\s*(我来看看|我先看看|我看到|我来分析|我来认真|我们)/.test(trimmed)) return false;
	// reject process fragments (short sentences with no substance)
	if (/^技术决策:\s*[\u4e00-\u9fff]{1,12}$/.test(trimmed)) return false;
	// reject test content
	if (/^测试去重/.test(trimmed)) return false;

	// reject empty plan JSON
	if (trimmed.startsWith("{")) {
		try {
			const obj = JSON.parse(trimmed);
			if (obj && typeof obj === "object") {
				// empty plan: {goal: "", steps: []}
				if (obj.goal === "" && Array.isArray(obj.steps) && obj.steps.length === 0) return false;
				// meaningless structure: metadata only, no content
				if (!obj.goal && Array.isArray(obj.steps) && obj.steps.length === 0) return false;
			}
		} catch { /* not JSON, that's fine */ }
	}

	return true;
}

/** Check whether it should be demoted to log (instead of core) */
function shouldDemoteToLog(content: string, tags: string[]): boolean {
	// discussion-points are conversation process records, not conclusions
	if (tags.includes("discussion-points")) return true;
	// duplicate plan JSON also gets demoted
	if (tags.includes("plan") && content.startsWith("{")) {
		try {
			const obj = JSON.parse(content);
			if (obj && obj.goal === "") return true;
		} catch { /* not JSON */ }
	}
	return false;
}

/** Clean noise tags */
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

// ===== Public API =====

/** Store new knowledge — auto layering, tag cleanup, dedup */
export function storeKnowledge(entry: {
	content: string;
	source?: string;
	category?: KnowledgeCategory;
	tags?: string[];
	confidence?: number;
}): KnowledgeEntry | null {
	ensureDir();

	const tags = cleanTags(entry.tags ?? []);

	// guard 1: reject meaningless content
	if (!isMeaningful(entry.content, tags)) {
		return null;
	}

	// guard 2: dedup (check core + log stores)
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

	// guard 3: discussion-points and empty plans demoted to log
	const forceLog = shouldDemoteToLog(entry.content, tags);
	const core = forceLog ? false : isCoreEntry(full);
	const path = getStorePath(core);
	appendFileSync(path, JSON.stringify(full) + "\n", "utf-8");
	return full;
}

/** Infer category from content */
function inferCategory(content: string, tags: string[]): KnowledgeCategory {
	const c = content.toLowerCase();

	// preferences/habits
	if (/以后|每次|下次|记住|习惯|偏好|不要.*要/.test(content) ||
		tags.includes("user-preference") || tags.includes("user-habit")) {
		return "preference";
	}

	// facts
	if (/^(?:ssh|服务器ip|路径|远程部署|产品url|项目名|配置)/.test(content) ||
		tags.some(t => ["ssh", "server", "infrastructure", "deployment", "path", "product", "url", "config"].includes(t))) {
		return "fact";
	}

	// business
	if (/月入|变现|商业|snaptool|snaptools|营收|定价|订阅|客户/.test(c) ||
		tags.some(t => ["business", "snaptool", "monetization"].includes(t))) {
		return "business";
	}

	// self-improvement (only real improvement conclusions, not self-criticism)
	if (/^(?:自我改进|进化|改进|优化|升级)/.test(content) ||
		tags.includes("self-improvement")) {
		return "self-improvement";
	}

	return "knowledge";
}

/** Write ref-count updates back to disk (batched, avoids frequent IO) */
let pendingRefUpdates = new Map<string, { refCount: number; lastReferenced: string }>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flushRefUpdates(): void {
	if (pendingRefUpdates.size === 0) return;
	const updates = new Map(pendingRefUpdates);
	pendingRefUpdates.clear();
	if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }

	// only the core store tracks references
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

/** Schedule a deferred write-back (multiple recalls within 100ms merge into one write) */
function scheduleRefFlush(): void {
	if (flushTimer) return;
	flushTimer = setTimeout(() => {
		flushTimer = null;
		flushRefUpdates();
	}, 100);
}

/** Query knowledge — sorted by value, with result dedup */
export function queryKnowledge(q: KnowledgeQuery & { deduplicate?: boolean }): KnowledgeEntry[] {
	const coreOnly = q.coreOnly !== false;

	let coreEntries = loadEntries(CORE_STORE);
	let logEntries = coreOnly ? [] : loadEntries(LOG_STORE);
	let entries = [...coreEntries, ...logEntries];

	// filter by category
	if (q.category) {
		entries = entries.filter(e => e.category === q.category);
	}

	// filter by tags
	if (q.tags && q.tags.length > 0) {
		entries = entries.filter(e => q.tags!.some(t => e.tags.includes(t)));
	}

	// filter by source
	if (q.source) {
		const src = q.source.toLowerCase();
		entries = entries.filter(e => e.source.toLowerCase().includes(src));
	}

	// minimum confidence
	if (q.minConfidence !== undefined) {
		entries = entries.filter(e => e.confidence >= q.minConfidence!);
	}

	// text search + scoring
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
			// value = confidence × time decay × (1 + reference bonus)
			const refBonus = Math.min((e.refCount ?? 0) * 0.05, 0.3);
			const value = e.confidence * timeDecay(e) * (1 + refBonus) * (0.5 + relevance);
			return { entry: e, relevance, value };
		}).filter(s => s.relevance > 0);

		// update ref count and schedule deferred write-back
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
		// non-value sorts also filter by relevance
		entries = scored.map(s => s.entry);
		if (q.sortBy === "confidence") {
			entries.sort((a, b) => b.confidence - a.confidence);
		} else {
			entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
		}
		}
	} else {
		// sort order when there is no search query
		if (q.sortBy === "confidence") {
			entries.sort((a, b) => b.confidence - a.confidence);
		} else {
			entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
		}
	}

	// result dedup: keep only the best of similar entries
	if (q.deduplicate !== false && q.query && entries.length > 1) {
		entries = deduplicateResults(entries, 0.55);
	}

	if (q.limit && q.limit > 0) {
		entries = entries.slice(0, q.limit);
	}

	return entries;
}

/** Dedup recall results: group similar entries (Jaccard > threshold), keep highest score per group */
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
	
	// keep the best entry per group (prefer longer content, usually more complete)
	const results: KnowledgeEntry[] = [];
	for (const group of groups) {
		if (group.length === 1) {
			results.push(group[0]!);
		} else {
			// pick the longest content (most complete), mark as duplicate
			group.sort((a, b) => b.content.length - a.content.length);
			const best = { ...group[0]! };
			best.tags = [...best.tags, `merged:${group.length - 1}`];
			results.push(best);
		}
	}
	
	return results;
}

/** Total count (core + log) */
export function knowledgeCount(): number {
	return loadEntries(CORE_STORE).length + loadEntries(LOG_STORE).length;
}

/** Core knowledge count */
export function coreKnowledgeCount(): number {
	return loadEntries(CORE_STORE).length;
}

/** Per-category stats */
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

/** Clean expired log entries (low-value memory older than 90 days) */
export function pruneExpired(): number {
	const logEntries = loadEntries(LOG_STORE);
	const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
	const kept = logEntries.filter(e => new Date(e.timestamp).getTime() > cutoff);
	const removed = logEntries.length - kept.length;
	if (removed > 0) saveEntries(LOG_STORE, kept);
	return removed;
}

// ===== Knowledge quality analysis =====

export interface PruneAnalysis {
	/** total entries */
	total: number;
	/** low-value entries (cleanup candidates) */
	candidates: PruneCandidate[];
	/** per-issue stats */
	issues: { noise: number; duplicateTopic: number; processLog: number; stale: number };
	/** recommendation */
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

/** Pattern matching: detect obviously low-value content */
function detectNoisePatterns(content: string): string | null {
	const c = content.trim();
	// "高强度工作轮" (intense-work-round) — pure process log
	if (/^高强度工作轮/.test(c)) return "process-log";
	// "技术决策: 我先看看" (tech-decision: let me look) — action process, not a conclusion
	if (/^技术决策:\s*(我来看看|我先看看|我来看看|我来分析|我看到)/.test(c)) return "process-log";
	// long conversation-process records starting with "讨论要点:" (discussion points)
	if (/^讨论要点[:：]/.test(c) && c.length > 200) return "discussion-fragment";
	// pure structured JSON (plan step lists etc.), not knowledge
	if (/^\s*\[.*\]\s*$/.test(c) && c.length < 100) return "empty-structure";
	// too-short "knowledge" content (<20 chars)
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

/** Analyze knowledge-base quality, return cleanup candidates */
export function analyzeKnowledgeQuality(): PruneAnalysis {
	const core = loadEntries(CORE_STORE);
	const log = loadEntries(LOG_STORE);
	const all = [...core, ...log];
	const now = Date.now();

	const candidates: PruneCandidate[] = [];
	const issues = { noise: 0, duplicateTopic: 0, processLog: 0, stale: 0 };

	// 1. noise detection: obviously low-value patterns
	for (const e of all) {
		const pattern = detectNoisePatterns(e.content);
		if (pattern === "process-log") {
			issues.processLog++;
			candidates.push({ ...e, reason: "Process log (not a knowledge conclusion)" });
		} else if (pattern === "discussion-fragment") {
			issues.noise++;
			candidates.push({ ...e, reason: "Conversational fragments (not a conclusion)" });
		} else if (pattern === "trivial") {
			issues.noise++;
			candidates.push({ ...e, reason: "Content too short (<20 chars)" });
		} else if (pattern === "empty-structure") {
			issues.noise++;
			candidates.push({ ...e, reason: "Empty structured data" });
		}
	}

	// 2. same-topic duplicate detection (keep the longest version)
	const duplicates = findTopicDuplicates(all);
	const deduplicatedIds = new Set<string>();
	for (const [, group] of duplicates) {
		// sort by content length, keep the longest
		group.sort((a, b) => b.content.length - a.content.length);
		for (let i = 1; i < group.length; i++) {
			const e = group[i];
			if (!candidates.some(c => c.id === e.id)) {
				issues.duplicateTopic++;
				candidates.push({ ...e, reason: `Duplicate of same topic (kept longest ${group[0].id})` });
				deduplicatedIds.add(e.id);
			}
		}
	}

	// 3. staleness: unreferenced >30 days with low confidence
	for (const e of all) {
		const age = (now - new Date(e.timestamp).getTime()) / 86400000;
		const lastRef = e.lastReferenced
			? (now - new Date(e.lastReferenced).getTime()) / 86400000
			: 999;
		if (age > 30 && lastRef > 30 && e.confidence < 0.8 && !candidates.some(c => c.id === e.id)) {
			issues.stale++;
			candidates.push({ ...e, reason: "Unreferenced 30+ days with low confidence" });
		}
	}

	// build recommendation
	const total = all.length;
	const pruneCount = candidates.length;
	let recommendation: string;
	if (pruneCount === 0) {
		recommendation = "Knowledge base is healthy, no cleanup needed.";
	} else if (pruneCount < total * 0.1) {
		recommendation = `Found ${pruneCount} low-value entries (${(pruneCount/total*100).toFixed(0)}%), cleanup recommended.`;
	} else if (pruneCount < total * 0.3) {
		recommendation = `Found ${pruneCount} low-value entries (${(pruneCount/total*100).toFixed(0)}%), batch cleanup recommended to improve density.`;
	} else {
		recommendation = `Found ${pruneCount} low-value entries (${(pruneCount/total*100).toFixed(0)}%). Quality is low — deep cleanup recommended.`;
	}

	return { total, candidates, issues, recommendation };
}

/** Execute cleanup: delete the given entries */
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

/** Clear everything (dangerous) */
export function clearKnowledge(): void {
	for (const p of [CORE_STORE, LOG_STORE, LEGACY_STORE]) {
		if (existsSync(p)) unlinkSync(p);
	}
}

// ===== Knowledge compression =====

export interface CompressResult {
	compressed: number;
	merged: number;
	/** IDs of merged entries */
	removedIds: string[];
	/** the newly created merged entry */
	newEntry?: KnowledgeEntry;
}

/** Find compressible groups (similarity > 0.6, same category) */
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

/** Compress a group of similar entries: merge into one summary, remove originals */
export function compressGroup(group: KnowledgeEntry[]): CompressResult {
	if (group.length < 2) return { compressed: 0, merged: 0, removedIds: [] };

	// merge content: longest entry as base, append unique info from others
	const sorted = [...group].sort((a, b) => b.content.length - a.content.length);
	const base = sorted[0]!;
	const extraTags = new Set<string>();
	const extraInfo: string[] = [];

	for (let i = 1; i < sorted.length; i++) {
		const e = sorted[i]!;
		for (const t of e.tags) extraTags.add(t);
		// extract unique phrases not in base
		const baseTokens = tokenize(base.content);
		const eTokens = tokenize(e.content);
		const uniqueTokens = [...eTokens].filter(t => !baseTokens.has(t) && t.length > 1);
		if (uniqueTokens.length > 0) {
			extraInfo.push(e.content.slice(0, 200));
		}
	}

	// build merged content
	let mergedContent = base.content;
	if (extraInfo.length > 0) {
		mergedContent += "\n\n[Compressed supplement] " + extraInfo.map((s, i) => `(${i + 1}) ${s}`).join("\n");
	}

	// merged confidence: take the max
	const maxConfidence = Math.max(...group.map(e => e.confidence));
	// accumulate ref counts
	const totalRefs = group.reduce((sum, e) => sum + (e.refCount ?? 0), 0);
	// earliest timestamp
	const oldest = group.map(e => e.timestamp).sort()[0]!;
	// merge tags
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

/** Run knowledge compression: find and compress all mergeable groups */
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

	// delete merged old entries
	pruneEntries(allRemovedIds);

	// write the new merged entry
	for (const e of newEntries) {
		appendFileSync(CORE_STORE, JSON.stringify(e) + "\n", "utf-8");
	}

	return { groups: groups.length, totalCompressed, totalMerged };
}

// ===== Proactive recall (session context) =====

/** Extract "what you should know" context from memory, injected into the system prompt */
export function getContextualMemory(maxEntries: number = 8): string {
	const core = loadEntries(CORE_STORE);
	if (core.length === 0) return "";

	// sort by value: confidence × timeDecay × (1 + refBonus)
	const scored = core.map(e => {
		const refBonus = Math.min((e.refCount ?? 0) * 0.05, 0.3);
		const value = e.confidence * timeDecay(e) * (1 + refBonus);
		return { entry: e, value };
	});
	scored.sort((a, b) => b.value - a.value);

	// take top N, dedup
	const topEntries = deduplicateResults(
		scored.slice(0, maxEntries * 2).map(s => s.entry),
		0.6
	).slice(0, maxEntries);

	if (topEntries.length === 0) return "";

	const lines: string[] = [];
	// group by category
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

// ===== Meta-Memory system =====
//
// Lets the AI know "what it knows" and "what it doesn't know".
// Analyzes knowledge-base coverage, detects blind spots, provides recall quality assessment.

export interface MetaMemoryReport {
	/** knowledge base overview */
	summary: {
		total: number;
		core: number;
		log: number;
		experiences: number;
	};
	/** category coverage */
	categories: Record<string, { count: number; avgConfidence: number; avgRefCount: number }>;
	/** frequent tags (tag cloud, reflects knowledge breadth) */
	tagCloud: Array<{ tag: string; count: number }>;
	/** blind-spot detection: does a query hit any knowledge */
	queryHit: {
		query: string;
		hit: boolean;
		hitCount: number;
		score: number;
		bestCategory: string;
	};
	/** knowledge health metrics */
	health: {
		avgConfidence: number;
		avgRefCount: number;
		staleEntries: number; // unreferenced for 30+ days
		orphanEntries: number; // never referenced
		knowledgeFreshness: number; // 0-1, higher = fresher
	};
}

/** Generate a meta-memory report */
export function metaMemory(query?: string): MetaMemoryReport {
	const coreEntries = loadEntries(CORE_STORE);
	const logEntries = loadEntries(LOG_STORE);
	const experiences = loadExperiences();
	const all = [...coreEntries, ...logEntries];
	const now = Date.now();

	// category coverage
	const categories: Record<string, { count: number; totalConf: number; totalRef: number }> = {};
	for (const e of all) {
		if (!categories[e.category]) categories[e.category] = { count: 0, totalConf: 0, totalRef: 0 };
		categories[e.category].count++;
		categories[e.category].totalConf += e.confidence;
		categories[e.category].totalRef += e.refCount ?? 0;
	}

	// tag cloud
	const tagMap: Record<string, number> = {};
	for (const e of all) {
		for (const tag of e.tags) tagMap[tag] = (tagMap[tag] || 0) + 1;
	}
	const tagCloud = Object.entries(tagMap)
		.map(([tag, count]) => ({ tag, count }))
		.sort((a, b) => b.count - a.count)
		.slice(0, 30);

	// query hit detection
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

	// health metrics
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

/** Load all knowledge (legacy compatibility) */
export function loadAllKnowledge(): KnowledgeEntry[] {
	// load from the new format first
	const core = loadEntries(CORE_STORE);
	const log = loadEntries(LOG_STORE);
	if (core.length > 0 || log.length > 0) {
		return [...core, ...log];
	}
	// fall back to legacy format
	return loadEntries(LEGACY_STORE);
}

/**
 * Migrate legacy memory into the new layered system
 * Migration strategy:
 * - self-criticism / user corrections → log (low value)
 * - tech decisions / conclusions / facts → core (high value)
 * - strip all noise tags
 */
export function migrateFromLegacy(): { migrated: number; core: number; log: number; skipped: number } {
	if (!existsSync(LEGACY_STORE)) return { migrated: 0, core: 0, log: 0, skipped: 0 };

	const legacy = loadEntries(LEGACY_STORE);
	if (legacy.length === 0) return { migrated: 0, core: 0, log: 0, skipped: 0 };

	let core = 0, log = 0, skipped = 0;

	for (const entry of legacy) {
		// skip already-migrated entries
		if ((entry as any).category) { skipped++; continue; }

		const content = entry.content;

		// self-criticism and user corrections → log, low confidence
		if (content.startsWith("自我批判") || content.startsWith("用户纠正") || content.startsWith("self-criticism") || content.startsWith("user correction")) {
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

		// infer category
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

// ===== Episodic Memory =====
//
// Unlike flat knowledge conclusions, episodic memory stores complete experience structures:
//   what scenario → what happened → what was done → outcome → lesson learned
// Searchable by scenario/tag/time, forming a reusable experience library.
//
// storage: ~/.novus/knowledge/experience.jsonl

const EXPERIENCE_STORE = join(KNOWLEDGE_DIR, "experience.jsonl");
const MAX_EXPERIENCES = 500;

export interface ExperienceEntry {
	id: string;
	/** experience title */
	title: string;
	/** scenario description (in what situation it happened) */
	scenario: string;
	/** problem/situation encountered */
	situation: string;
	/** actions taken */
	actions: string[];
	/** outcome */
	outcome: string;
	/** lessons/rules learned (reusable by identity) */
	lessons: string[];
	/** source session */
	sessionId?: string;
	/** tags (scenario classes: debug, deploy, ssh, optimize…) */
	tags: string[];
	/** timestamp */
	timestamp: string;
	/** confidence 0-1 */
	confidence: number;
	/** ref count */
	refCount: number;
}

/** Store an episodic memory */
export function storeExperience(entry: Omit<ExperienceEntry, "id" | "refCount">): ExperienceEntry {
	ensureDir();
	const entries = loadExperiences();

	// dedup: same title+scenario keeps the latest
	const dupIdx = entries.findIndex(e => e.title === entry.title && e.scenario === entry.scenario);
	if (dupIdx >= 0) entries.splice(dupIdx, 1);

	const newEntry: ExperienceEntry = {
		...entry,
		id: randomUUID().slice(0, 8),
		refCount: 0,
	};
	entries.unshift(newEntry);

	// cap total count
	if (entries.length > MAX_EXPERIENCES) {
		entries.splice(MAX_EXPERIENCES);
	}

	// experiences use separate storage (not mixed into knowledge entries)
	writeFileSync(EXPERIENCE_STORE, entries.map(e => JSON.stringify(e)).join("\n") + "\n", "utf-8");
	return newEntry;
}

/** Recall episodic memories (by scenario/tag/keyword) */
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

		// exact tag match
		if (query.tags?.length) {
			for (const tag of query.tags) {
				if (e.tags.includes(tag)) score += 10;
			}
		}

		// scenario match
		if (query.scenario) {
			const queryTokens = tokenize(query.scenario);
			const sceneTokens = tokenize(e.scenario + " " + e.situation);
			let overlap = 0;
			for (const t of queryTokens) {
				if (sceneTokens.has(t)) overlap++;
			}
			if (queryTokens.size > 0) score += (overlap / queryTokens.size) * 8;
		}

		// keyword full-text search
		if (query.keyword) {
			const fullText = (e.title + " " + e.scenario + " " + e.situation + " " + e.outcome + " " + e.lessons.join(" ")).toLowerCase();
			if (fullText.includes(query.keyword.toLowerCase())) score += 5;
			// also search bigrams
			const kwTokens = tokenize(query.keyword);
			for (const t of kwTokens) {
				if (fullText.includes(t)) score += 2;
			}
		}

		// time decay (newer is better, but lessons don't expire)
		const ageDays = (Date.now() - new Date(e.timestamp).getTime()) / 86400000;
		const recency = ageDays < 7 ? 1.0 : ageDays < 30 ? 0.8 : 0.6;
		// experiences with lessons don't go stale
		const hasLessons = e.lessons.length > 0;

		return { entry: e, score: score * (hasLessons ? 1.2 : recency) };
	});

	scored.sort((a, b) => b.score - a.score);
	return scored.filter(s => s.score > 1).slice(0, query.limit ?? 10).map(s => s.entry);
}

/** Auto-extract an episodic memory from a worklog entry */
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
	// only extract work with real changes (skip idle/blocked/simple "checks")
	if (wle.status === "idle" || wle.status === "blocked") return null;
	if (!wle.changes && !wle.files?.length) return null;
	if (wle.activity.length < 8) return null;

	// infer scenario tags
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

	// extract lessons from change descriptions
	const lessons: string[] = [];
	if (wle.changes) {
		// extract key info after verbs like 改为/加/去掉 (changed/added/removed)
		const patterns = wle.changes.match(/(?:改为|改为|加|新增|去掉|移除|修复|改用)[^,;。]+/g);
		if (patterns) lessons.push(...patterns.map(p => "changes: " + p.trim()));
		// if it contains 避免 (avoid), extract directly as a lesson
		const avoidPatterns = wle.changes.match(/避免[^,;。]+/g);
		if (avoidPatterns) lessons.push(...avoidPatterns.map(p => p.trim()));
	}

	const result: Omit<ExperienceEntry, "id" | "refCount"> = {		title: wle.activity,
		scenario: wle.step || tags.join(", "),
		situation: wle.activity,
		actions: wle.changes ? [wle.changes] : [],
		outcome: wle.status === "done" ? "success" : wle.status === "blocked" ? "blocked" : "in progress",
		lessons,
		sessionId: wle.sessionId,
		tags,
		timestamp: wle.timestamp || new Date().toISOString(),
		confidence: 0.85,
	};
	return result;
}

/** Load all episodic memories */
function loadExperiences(): ExperienceEntry[] {
	if (!existsSync(EXPERIENCE_STORE)) return [];
	return loadEntries(EXPERIENCE_STORE) as unknown as ExperienceEntry[];
}

/** Episodic memory stats */
export function experienceStats(): { total: number; byTag: Record<string, number>; recent: string } {
	const entries = loadExperiences();
	const byTag: Record<string, number> = {};
	for (const e of entries) {
		for (const tag of e.tags) byTag[tag] = (byTag[tag] || 0) + 1;
	}
	return {
		total: entries.length,
		byTag,
		recent: entries[0]?.timestamp || "none",
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
