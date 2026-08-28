/**
 * connect v2 — novus's gateway to the world.
 *
 * v2 changes:
 *   - learn: supports category parameter
 *   - recall: shows category, defaults to value-sorted, supports coreOnly
 *   - stats: shows category breakdown, core vs log split
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";

/** Strip HTML tags, decode entities, normalize whitespace */
function stripHtml(raw: string): string {
	let text = raw;
	// Remove script and style blocks entirely
	text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
	text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
	// Block-level elements → newline
	text = text.replace(/<\/(p|div|br|h[1-6]|li|tr|blockquote|pre|hr)[^>]*>/gi, "\n");
	text = text.replace(/<br[^>]*>/gi, "\n");
	// Remove all remaining tags
	text = text.replace(/<[^>]+>/g, "");
	// Decode common HTML entities
	text = text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
	// Normalize whitespace
	text = text.replace(/\t/g, " ").replace(/ +/g, " ");
	// Collapse multiple blank lines
	text = text.replace(/\n{3,}/g, "\n\n");
	return text.trim();
}

/** Check if content looks like HTML */
function isHtml(contentType: string, body: string): boolean {
	if (contentType.includes("text/html")) return true;
	if (body.trimStart().startsWith("<!") || body.trimStart().startsWith("<html")) return true;
	return false;
}
import { fetchUrl, extractArticle, parseFeed, fetchBrowser, type ExtractedArticle, type ParsedFeed } from "../../senses/web.ts";
import { storeKnowledge, queryKnowledge, knowledgeStats, coreKnowledgeCount, analyzeKnowledgeQuality, pruneEntries, findCompressibleGroups, compressGroup, compressAllKnowledge, flushPendingRefs, storeExperience, recallExperience, experienceStats, extractExperienceFromWorklog, metaMemory, type KnowledgeCategory, type ExperienceEntry, type MetaMemoryReport } from "../../memory/knowledge.ts";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// knowledge-graph integration
const GRAPH_FILE = join(homedir(), ".novus", "knowledge-graph", "graph.json");

interface GraphEntity { id: string; label: string; type: string; weight: number; occurrences: number; }
interface GraphRelation { from: string; to: string; label: string; weight: number; }
interface GraphData { entities: Record<string, GraphEntity>; relations: GraphRelation[]; builtAt: string; }

function loadGraphData(): GraphData | null {
	if (!existsSync(GRAPH_FILE)) return null;
	try { return JSON.parse(readFileSync(GRAPH_FILE, "utf-8")); } catch { return null; }
}

function findRelatedEntities(query: string, depth: number = 1): string {
	const graph = loadGraphData();
	if (!graph) return "";
	const lower = query.toLowerCase();
	const matched: string[] = [];
	for (const entity of Object.values(graph.entities)) {
		if (entity.label && lower.includes(entity.label.toLowerCase())) {
			matched.push(entity.id);
		}
	}
	if (matched.length === 0) return "";
	// BFS to find connected entities
	const visited = new Set<string>();
	const related: string[] = [];
	const queue = [...matched.map(id => ({ id, d: 0 }))];
	while (queue.length > 0) {
		const { id, d } = queue.shift()!;
		if (visited.has(id) || d > depth) continue;
		visited.add(id);
		const e = graph.entities[id];
		if (e && !matched.includes(id)) related.push(e.label);
		for (const rel of graph.relations) {
			const neighbor = rel.from === id ? rel.to : rel.to === id ? rel.from : null;
			if (neighbor && !visited.has(neighbor)) queue.push({ id: neighbor, d: d + 1 });
		}
	}
	return related.length > 0 ? `\n🔗 Related entities: ${related.slice(0, 8).join(" → ")}` : "";
}

interface ConnectParams {
	action: "fetch" | "learn" | "recall" | "stats" | "analyze" | "prune" | "compress" | "experience" | "recall-experience" | "meta-memory";
	/** Experience: title */
	title?: string;
	/** Experience: scenario description */
	scenario?: string;
	/** Experience: situation/problem */
	situation?: string;
	/** Experience: actions taken (string or JSON array) */
	actions?: string | string[];
	/** Experience: outcome */
	outcome?: string;
	/** Experience: lessons learned */
	lessons?: string | string[];
	/** Experience/recall: tags (scenario classification) */
	expTags?: string[];
	/** Recall-experience: scenario to match */
	expScenario?: string;
	/** Recall-experience: keyword full-text search */
	expKeyword?: string;
	url?: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	content?: string;
	source?: string;
	tags?: string[];
	category?: string;
	confidence?: number;
	query?: string;
	limit?: number;
	sortBy?: string;
	coreOnly?: boolean;
	/** Fetch mode: 'raw' (default), 'article' (extract main content), 'feed' (parse RSS/Atom), 'browser' (headless browser via CDP/Playwright) */
	mode?: "raw" | "article" | "feed" | "browser";
	/** Browser mode: scroll to bottom to trigger lazy loading (default true) */
	scrollToBottom?: boolean;
	/** Browser mode: extra wait ms after load (default 1000) */
	extraWaitMs?: number;
	/** Browser mode: CDP WebSocket endpoint (overrides CHROME_WS_ENDPOINT env var) */
	wsEndpoint?: string;
	/** Recall: show full content instead of 200-char preview */
	fullContent?: boolean;
	/** Recall: disable result deduplication (default: true, similar results grouped) */
	deduplicate?: boolean;
	/** Fetch: max response size in bytes (default 1MB) */
	maxBytes?: number;
	/** Fetch: max text returned to LLM (default 200KB) */
	maxTextBytes?: number;
}

function text(t: string) {
	return { type: "text" as const, text: t };
}

export function createTool(_cwd: string): AgentTool<any> {
	return {
		name: "connect",
		description:
				"Connect to the world. Actions: fetch (get URLs), learn (store knowledge), recall (query knowledge), experience (store episodic memory), recall-experience (query past experiences), stats (breakdown), analyze (quality report), prune (remove entries).",
		label: "connect",
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					description: "Action: 'fetch', 'learn', 'recall', 'stats', 'analyze', 'prune'",
					enum: ["fetch", "learn", "recall", "stats", "analyze", "prune", "compress", "experience", "recall-experience", "meta-memory"],
				},
				url: { type: "string", description: "URL to fetch" },
				method: { type: "string", description: "HTTP method (default GET)" },
				headers: { type: "object", description: "HTTP headers" },
				body: { type: "string", description: "Request body" },
				content: { type: "string", description: "Knowledge content (for learn)" },
				source: { type: "string", description: "Source URL or description (for learn)" },
				tags: { type: "array", items: { type: "string" }, description: "Tags (for learn/recall)" },
				category: { type: "string", description: "Category: knowledge/preference/fact/self-improvement/business (for learn/recall)" },
				confidence: { type: "number", description: "Confidence 0-1 (default 0.8)" },
				query: { type: "string", description: "Search query (for recall)" },
				limit: { type: "number", description: "Max results (default 20)" },
				sortBy: { type: "string", description: "Sort: 'value' (default), 'recent', 'confidence'" },
				coreOnly: { type: "boolean", description: "Only search core knowledge (default true)" },
				fullContent: { type: "boolean", description: "Show full content in recall results (default: false, 200-char preview)" },
				deduplicate: { type: "boolean", description: "Disable result deduplication (default: true, similar results grouped)" },
				maxBytes: { type: "number", description: "Max response size in bytes (default 1MB)" },
				maxTextBytes: { type: "number", description: "Max text returned to LLM (default 200KB)" },
				mode: { type: "string", description: "Fetch mode: raw (default), article, feed, browser", enum: ["raw", "article", "feed", "browser"] },
				scrollToBottom: { type: "boolean", description: "Browser: scroll to trigger lazy loading (default true)" },
				extraWaitMs: { type: "number", description: "Browser: extra wait ms after load (default 1000)" },
				wsEndpoint: { type: "string", description: "Browser: CDP WebSocket URL (e.g. ws://IP:9222/devtools/browser/xxx)" },
				title: { type: "string", description: "Experience title (for experience)" },
				scenario: { type: "string", description: "Experience scenario/context (for experience)" },
				situation: { type: "string", description: "Experience situation/problem (for experience)" },
				actions: { type: "string", description: "Experience actions taken (comma-separated or JSON array, for experience)" },
				outcome: { type: "string", description: "Experience outcome (for experience)" },
				lessons: { type: "string", description: "Experience lessons learned (comma-separated or JSON array, for experience)" },
				expTags: { type: "array", items: { type: "string" }, description: "Experience tags: debug/deploy/ssh/optimize/monitor (for experience/recall-experience)" },
				expScenario: { type: "string", description: "Recall-experience: scenario to match" },
				expKeyword: { type: "string", description: "Recall-experience: keyword full-text search" },
			},
			required: ["action"],
		},
		execute: async (_toolCallId: string, params: unknown) => {
			const p = params as ConnectParams;

			switch (p.action) {
				case "fetch":
					return handleFetch(p);
				case "learn":
					return handleLearn(p);
				case "recall":
					return handleRecall(p);
				case "analyze":
					return handleAnalyze();
				case "prune":
					return handlePrune(p);
				case "compress":
					return handleCompress();
				case "stats":
					return handleStats();
				case "experience":
					return handleStoreExperience(p);
				case "recall-experience":
					return handleRecallExperience(p);
				case "meta-memory":
					return handleMetaMemory(p);
				default:
					return { content: [text(`Unknown action: ${p.action}`)], details: {} };
			}
		},
	};
}

async function handleFetch(p: ConnectParams) {
	if (!p.url) {
		return { content: [text("Error: 'url' is required for fetch.")], details: {} };
	}

	// Browser mode: use headless browser for JS rendering
	if (p.mode === "browser") {
		const result = await fetchBrowser({
			url: p.url,
			timeout: 30_000,
			maxTextBytes: p.maxTextBytes,
			scrollToBottom: p.scrollToBottom !== false,
			extraWaitMs: p.extraWaitMs,
			wsEndpoint: p.wsEndpoint,
		});
		if (!result.ok) {
			return { content: [text(result.text)], details: { url: result.finalUrl, status: result.status, error: result.text } };
		}
		return {
			content: [text(`🌐 Browser rendered | ${result.length} bytes\n\n${result.text}`)],
			details: { url: result.finalUrl, status: result.status, contentType: result.contentType, length: result.length },
		};
	}

	// Standard fetch
	const result = await fetchUrl({
		url: p.url,
		method: (p.method as "GET" | "POST") ?? "GET",
		headers: p.headers,
		body: p.body,
		maxBytes: p.maxBytes,
		maxTextBytes: p.maxTextBytes,
	});

	if (!result.ok) {
		return {
			content: [text(result.text)],
			details: { url: result.finalUrl, status: result.status, error: result.text },
		};
	}

	// Article mode: extract main content from HTML
	if (p.mode === "article" && typeof result.body === "string") {
		try {
			const article = extractArticle(result.body, result.finalUrl);
			const preview = article.textContent.slice(0, 8000);
			const header = `📄 ${article.title} | ${article.author || "unknown"} | ${article.siteName} | ${article.wordCount} words`;
			return {
				content: [text(`${header}\n\n${preview}`)],
				details: { url: result.finalUrl, status: result.status, contentType: result.contentType, title: article.title, wordCount: article.wordCount },
			};
		} catch (e) {
			return {
				content: [text(`Article extraction failed: ${e}\n\nFalling back to raw content:\n${stripHtml(String(result.body ?? "")).slice(0, 6000)}`)],
				details: { url: result.finalUrl, status: result.status },
			};
		}
	}

	// Feed mode: parse RSS/Atom
	if (p.mode === "feed" && typeof result.body === "string") {
		try {
			const feed = parseFeed(result.body);
			const entries = feed.entries.slice(0, 10).map((e, i) =>
				`${i + 1}. **${e.title}** (${e.author || ""})\n   ${e.link}\n   ${e.summary.slice(0, 150)}${e.summary.length > 150 ? "..." : ""}`
			).join("\n\n");
			const header = `📡 ${feed.title} | ${feed.entries.length} entries | ${feed.language}`;
			return {
				content: [text(`${header}\n\n${entries}`)],
				details: { url: result.finalUrl, status: result.status, totalEntries: feed.entries.length },
			};
		} catch (e) {
			return {
				content: [text(`Feed parsing failed: ${e}\n\nRaw content:\n${stripHtml(String(result.body ?? "")).slice(0, 6000)}`)],
				details: { url: result.finalUrl, status: result.status },
			};
		}
	}

	// Default/raw mode
	const summary = `HTTP ${result.status} | ${result.contentType} | ${result.length} bytes`;
	let bodyPreview: string;
	if (typeof result.body === "object" && result.body !== null) {
		bodyPreview = JSON.stringify(result.body, null, 2).slice(0, 8000);
	} else {
		const raw = String(result.body ?? "");
		// Intelligently clean HTML → plain text for better LLM context
		bodyPreview = isHtml(result.contentType, raw) ? stripHtml(raw).slice(0, 8000) : raw.slice(0, 8000);
	}

	return {
		content: [text(`${summary}\n\n${bodyPreview}`)],
		details: { url: result.finalUrl, status: result.status, contentType: result.contentType, length: result.length },
	};
}

function handleLearn(p: ConnectParams) {
	if (!p.content) {
		return { content: [text("Error: 'content' is required for learn.")], details: {} };
	}

	const entry = storeKnowledge({
		content: p.content,
		source: p.source ?? "manual",
		category: (p.category as KnowledgeCategory) ?? undefined,
		tags: p.tags ?? [],
		confidence: p.confidence ?? 0.8,
	});

	if (!entry) {
		return { content: [text("Skipped: duplicate or empty content.")], details: {} };
	}

	return {
		content: [text(`Stored #${entry.id} | ${entry.category} | ${entry.tags.join(",") || "-"} | ${entry.source}`)],
		details: entry,
	};
}

function handleRecall(p: ConnectParams) {
	const results = queryKnowledge({
		query: p.query,
		category: p.category as KnowledgeCategory | undefined,
		tags: p.tags,
		limit: p.limit ?? 20,
		sortBy: (p.sortBy as any) ?? "value",
		coreOnly: p.coreOnly ?? true,
		deduplicate: p.deduplicate,
	});

	if (results.length === 0) {
		return { content: [text("No matching knowledge found.")], details: { results: [] } };
	}

	const lines = results.map(
		(r) => `[${r.id}] ${r.timestamp.slice(0, 10)} | ${r.category} | ${(r.tags.length ? r.tags.join(",") : "-").slice(0, 30)} | ${p.fullContent ? r.content : r.content.slice(0, 200)}`,
	);

	// Append knowledge-graph entity chain if available
	const entityChain = findRelatedEntities(p.query || "");
	return {
		content: [text(`${results.length} entries (coreOnly=${p.coreOnly !== false}):\n\n${lines.join("\n")}${entityChain}`)],
		details: { results },
	};
}

function handleStats() {
	const stats = knowledgeStats();
	const core = coreKnowledgeCount();

	const lines: string[] = [
		`Knowledge store: ${stats.total} entries (core: ${stats.core}, log: ${stats.log})`,
		`--- by category ---`,
	];
	for (const [cat, count] of Object.entries(stats.byCategory)) {
		lines.push(`  ${cat}: ${count}`);
	}

	return {
		content: [text(lines.join("\n"))],
		details: stats,
	};
}

function handleAnalyze() {
	const analysis = analyzeKnowledgeQuality();
	const lines: string[] = [
		`知识质量分析：${analysis.total} 条总计 | ${analysis.candidates.length} 条建议清理`,
		``,
		`问题统计：`,
		`  过程日志: ${analysis.issues.processLog} 条`,
		`  对话碎片: ${analysis.issues.noise} 条`,
		`  同主题重复: ${analysis.issues.duplicateTopic} 条`,
		`  陈旧未引用: ${analysis.issues.stale} 条`,
		``,
		`${analysis.recommendation}`,
	];

	if (analysis.candidates.length > 0) {
		lines.push(``, `建议清理的条目（前15条）：`);
		for (const c of analysis.candidates.slice(0, 15)) {
			const preview = c.content.substring(0, 60).replace(/\n/g, ' ');
			lines.push(`  [${c.id}] ${c.category} | ${c.reason} | ${preview}...`);
		}
		if (analysis.candidates.length > 15) {
			lines.push(`  ... 还有 ${analysis.candidates.length - 15} 条`);
		}
		lines.push(``, `使用 action=prune ids=["id1","id2",...] 执行清理`);
	}

	return {
		content: [text(lines.join("\n"))],
		details: analysis,
	};
}

function handlePrune(p: ConnectParams) {
	const ids = (p as any).ids as string[] | undefined;
	if (!ids || ids.length === 0) {
		return { content: [text("Error: 'ids' is required for prune. Use action=analyze first.")], details: {} };
	}
	const result = pruneEntries(ids);
	return {
		content: [text(`已清理 ${result.removed} 条知识（${ids.length} 条ID中匹配 ${result.removed} 条）`)],
		details: result,
	};
}

function handleCompress() {
	const groups = findCompressibleGroups(0.6);
	if (groups.length === 0) {
		return { content: [text("无可压缩条目 — 知识库中没有足够相似的条目。")], details: {} };
	}

	const totalBefore = groups.reduce((s, g) => s + g.entries.length, 0);

	// Execute compression: merge each group
	let totalCompressed = 0;
	const mergedIds: string[] = [];
	for (const g of groups) {
		const result = compressGroup(g.entries);
		pruneEntries(result.removedIds);
		if (result.newEntry) {
			const stored = storeKnowledge({
				content: result.newEntry.content,
				source: "compress",
				category: result.newEntry.category,
				tags: result.newEntry.tags,
				confidence: result.newEntry.confidence,
			});
			if (stored) mergedIds.push(stored.id);
			totalCompressed += result.compressed;
		}
	}

	return {
		content: [text(`已压缩 ${totalCompressed} 条 → ${mergedIds.length} 条 (${groups.length} 组)\n新增条目: ${mergedIds.join(", ")}`)],
		details: { groups: groups.length, totalCompressed, merged: mergedIds.length, mergedIds },
	};
}
function handleStoreExperience(p: ConnectParams) {
	if (!p.title) {
		return { content: [text("Error: 'title' is required for experience.")], details: {} };
	}

	const entry = storeExperience({
		title: p.title,
		scenario: p.scenario || p.expScenario || "",
		situation: p.situation || "",
		actions: typeof p.actions === "string" ? p.actions.split(",").map(s => s.trim()).filter(Boolean) : p.actions || [],
		outcome: p.outcome || "",
		lessons: typeof p.lessons === "string" ? p.lessons.split(",").map(s => s.trim()).filter(Boolean) : p.lessons || [],
		tags: p.expTags || [],
		timestamp: new Date().toISOString(),
		confidence: p.confidence ?? 0.85,
	});

	const lines: string[] = [
		`🧠 情景记忆已存储 #${entry.id}`,
		`  标题: ${entry.title}`,
		`  场景: ${entry.scenario}`,
		`  教训: ${entry.lessons.length > 0 ? entry.lessons.join("; ") : "无"}`,
		`  标签: ${entry.tags.join(", ")}`,
	];

	return { content: [text(lines.join("\n"))], details: entry };
}

function handleRecallExperience(p: ConnectParams) {
	const results = recallExperience({
		scenario: p.expScenario,
		tags: p.expTags,
		keyword: p.expKeyword || p.query,
		limit: p.limit ?? 10,
	});

	if (results.length === 0) {
		const stats = experienceStats();
		return { content: [text(`没有匹配的情景记忆。\n\n🧠 情景记忆库: ${stats.total} 条经历 | 标签分布: ${Object.entries(stats.byTag).map(([k, v]) => k + ":" + v).join(", ")}`)], details: stats };
	}

	const lines = results.map(e => {
		const lessonStr = e.lessons.length > 0 ? "💡 " + e.lessons.join("; ") : "";
		return `[${e.id}] ${e.timestamp.slice(0, 10)} | ${e.tags.join(",")} | ${e.title}\n  场景: ${e.scenario.slice(0, 80)} | 结果: ${e.outcome}\n  ${lessonStr}`;
	});

	return { content: [text(`🧠 ${results.length} 条相关经历:\n\n${lines.join("\n\n")}`)], details: { results } };
}

function handleMetaMemory(p: ConnectParams) {
	const report = metaMemory(p.query);
	const lines: string[] = [
		"🧠 元记忆报告",
		"",
		`📊 总览: ${report.summary.total}条知识 (核心${report.summary.core} + 日志${report.summary.log}) + ${report.summary.experiences}条经历`,
		"",
		"📁 分类覆盖:",
	];
	for (const [cat, info] of Object.entries(report.categories)) {
		lines.push(`  ${cat}: ${info.count}条 | 均值信心${info.avgConfidence} | 均值引用${info.avgRefCount}`);
	}
	lines.push("", "🏷️ 高频标签 TOP10:");
	for (const { tag, count } of report.tagCloud.slice(0, 10)) {
		lines.push(`  ${tag}: ${count}`);
	}
	if (p.query) {
		const qh = report.queryHit;
		lines.push("", `🔍 查询 "${qh.query}": ${qh.hit ? "✅ 命中" + qh.hitCount + "条 (相关度" + Math.round(qh.score * 100) + "%)" : "❌ 未命中 — 盲区!"}`);
		if (!qh.hit) {
			lines.push(`  ⚠️ 知识库中缺乏关于"${p.query}"的内容，建议通过 learn action 补充`);
		}
	}
	lines.push("", "🏥 知识健康:");
	lines.push(`  平均信心: ${report.health.avgConfidence}`);
	lines.push(`  平均引用: ${report.health.avgRefCount}`);
	lines.push(`  陈旧条目(30天+): ${report.health.staleEntries}`);
	lines.push(`  孤儿条目(从未引用): ${report.health.orphanEntries}`);
	lines.push(`  新鲜度: ${Math.round(report.health.knowledgeFreshness * 100)}%`);
	return { content: [text(lines.join("\n"))], details: report };
}
