/**
 * knowledge-graph — 知识图谱：从知识库中提取实体和关系，构建关联网络。
 *
 * 存储位置: ~/.novus/knowledge-graph/graph.json
 *
 * 功能：
 *   - build: 从现有 knowledge entries 提取实体和关系，构建图谱
 *   - query: 查询实体及其关联实体链
 *   - link: 手动添加实体关联
 *   - show: 显示图谱统计和核心节点
 *   - clear: 清空图谱
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const GRAPH_DIR = join(homedir(), ".novus", "knowledge-graph");
const GRAPH_FILE = join(GRAPH_DIR, "graph.json");
const KNOWLEDGE_DIR = join(homedir(), ".novus", "knowledge");

function ensureDir(): void {
	if (!existsSync(GRAPH_DIR)) mkdirSync(GRAPH_DIR, { recursive: true });
}

function text(t: string) {
	return { type: "text" as const, text: t };
}

// ── Types ─────────────────────────────────────────────────────────

interface Entity {
	id: string;
	label: string;
	type: "concept" | "tool" | "person" | "project" | "technology" | "business" | "custom";
	weight: number; // number of connections
	occurrences: number; // times mentioned in knowledge
}

interface Relation {
	from: string; // entity id
	to: string;
	label: string; // e.g. "uses", "related-to", "depends-on", "part-of"
	weight: number;
}

interface KnowledgeGraph {
	entities: Map<string, Entity>;
	relations: Relation[];
	builtAt: string;
}

interface GraphParams {
	action: "build" | "query" | "link" | "show" | "clear" | "suggest";
	entity?: string;
	from?: string;
	to?: string;
	label?: string;
	depth?: number;
}

// ── Simple entity extraction ──────────────────────────────────────
// Uses keyword patterns + known terms to extract entities from text.

const TECH_TERMS = new Set([
	"typescript", "javascript", "python", "rust", "go", "node.js", "react", "vue",
	"mcp", "api", "rest", "graphql", "docker", "kubernetes", "aws", "gcp",
	"llm", "gpt", "claude", "openai", "anthropic", "langchain", "rag",
	"geo", "seo", "snaptool", "novus", "agent", "vector", "embedding",
	"chromadb", "pinecone", "redis", "postgres", "sqlite",
	"git", "github", "npm", "vitest", "typescript", "esbuild",
	"computer-use", "multimodal", "embodied", "robotics",
]);

const BUSINESS_TERMS = new Set([
	"saas", "pricing", "subscription", "api-first", "marketplace",
	"b2b", "b2c", "freemium", "enterprise", "startup", "funding",
	"valuation", "revenue", "churn", "conversion", "funnel",
]);

function extractEntities(text: string): Array<{ label: string; type: Entity["type"] }> {
	const results: Array<{ label: string; type: Entity["type"] }> = [];
	const lower = text.toLowerCase();

	// Extract known tech/business terms
	for (const term of TECH_TERMS) {
		if (lower.includes(term)) {
			results.push({ label: term, type: "technology" });
		}
	}
	for (const term of BUSINESS_TERMS) {
		if (lower.includes(term)) {
			results.push({ label: term, type: "business" });
		}
	}

	// Extract quoted terms (likely important concepts)
	const quotedPattern = /「([^」]+)」|["""]([^"""]+)["""]|`([^`]+)`/g;
	let match;
	while ((match = quotedPattern.exec(text)) !== null) {
		const term = (match[1] || match[2] || match[3]).trim().toLowerCase();
		if (term.length >= 2 && term.length <= 50) {
			results.push({ label: term, type: "concept" });
		}
	}

	// Extract hashtags/tags
	const tagPattern = /#(\w[\w-]+)/g;
	while ((match = tagPattern.exec(text)) !== null) {
		const tag = match[1].toLowerCase();
		if (tag.length >= 2) {
			results.push({ label: tag, type: "concept" });
		}
	}

	return results;
}

// ── Load knowledge entries ───────────────────────────────────────

interface RawKnowledgeEntry {
	id: string;
	content: string;
	tags: string[];
	category: string;
	confidence: number;
}

function loadKnowledgeEntries(): RawKnowledgeEntry[] {
	const entries: RawKnowledgeEntry[] = [];
	for (const file of ["core.jsonl", "log.jsonl"]) {
		const path = join(KNOWLEDGE_DIR, file);
		if (!existsSync(path)) continue;
		try {
			const raw = readFileSync(path, "utf-8");
			for (const line of raw.trim().split("\n")) {
				if (!line) continue;
				try {
					entries.push(JSON.parse(line) as RawKnowledgeEntry);
				} catch { /* skip */ }
			}
		} catch { /* skip */ }
	}
	return entries;
}

// ── Graph operations ─────────────────────────────────────────────

function entityKey(label: string): string {
	return label.toLowerCase().replace(/\s+/g, "-");
}

function saveGraph(graph: KnowledgeGraph): void {
	ensureDir();
	const serializable = {
		entities: Object.fromEntries(graph.entities),
		relations: graph.relations,
		builtAt: graph.builtAt,
	};
	writeFileSync(GRAPH_FILE, JSON.stringify(serializable, null, 2), "utf-8");
}

function loadGraph(): KnowledgeGraph | null {
	ensureDir();
	if (!existsSync(GRAPH_FILE)) return null;
	try {
		const raw = JSON.parse(readFileSync(GRAPH_FILE, "utf-8")) as {
			entities: Record<string, Entity>;
			relations: Relation[];
			builtAt: string;
		};
		return {
			entities: new Map(Object.entries(raw.entities)),
			relations: raw.relations,
			builtAt: raw.builtAt,
		};
	} catch {
		return null;
	}
}

function buildGraphFromKnowledge(): KnowledgeGraph {
	const graph: KnowledgeGraph = {
		entities: new Map(),
		relations: [],
		builtAt: new Date().toISOString(),
	};

	const entries = loadKnowledgeEntries();
	const coOccurrence: Map<string, Map<string, number>> = new Map();

	for (const entry of entries) {
		const extracted = extractEntities(entry.content + " " + entry.tags.join(" "));

		// Add/update entities
		for (const e of extracted) {
			const key = entityKey(e.label);
			const existing = graph.entities.get(key);
			if (existing) {
				existing.occurrences++;
			} else {
				graph.entities.set(key, {
					id: key,
					label: e.label,
					type: e.type,
					weight: 0,
					occurrences: 1,
				});
			}
		}

		// Track co-occurrence within same entry
		const keys = extracted.map(e => entityKey(e.label));
		const uniqueKeys = [...new Set(keys)];
		for (let i = 0; i < uniqueKeys.length; i++) {
			for (let j = i + 1; j < uniqueKeys.length; j++) {
				const from = uniqueKeys[i];
				const to = uniqueKeys[j];
				if (!coOccurrence.has(from)) coOccurrence.set(from, new Map());
				const m = coOccurrence.get(from)!;
				m.set(to, (m.get(to) || 0) + 1);
			}
		}
	}

	// Convert co-occurrence to relations (min 2 co-occurrences)
	for (const [from, toMap] of coOccurrence) {
		for (const [to, count] of toMap) {
			if (count >= 2) {
				graph.relations.push({
					from,
					to,
					label: "co-occurs",
					weight: count,
				});
			}
		}
	}

	// Calculate entity weights from relations
	for (const rel of graph.relations) {
		const fromEntity = graph.entities.get(rel.from);
		const toEntity = graph.entities.get(rel.to);
		if (fromEntity) fromEntity.weight++;
		if (toEntity) toEntity.weight++;
	}

	return graph;
}

function queryEntityChain(graph: KnowledgeGraph, entityId: string, depth: number = 2): string[] {
	const visited = new Set<string>();
	const chain: string[] = [];
	const queue: Array<{ id: string; d: number }> = [{ id: entityId, d: 0 }];

	while (queue.length > 0) {
		const { id, d } = queue.shift()!;
		if (visited.has(id) || d > depth) continue;
		visited.add(id);
		const entity = graph.entities.get(id);
		if (entity) chain.push(entity.label);

		for (const rel of graph.relations) {
			const neighbor = rel.from === id ? rel.to : rel.to === id ? rel.from : null;
			if (neighbor && !visited.has(neighbor)) {
				queue.push({ id: neighbor, d: d + 1 });
			}
		}
	}

	return chain;
}

// ── Format ─────────────────────────────────────────────────────────

function formatGraph(graph: KnowledgeGraph): string {
	const entities = [...graph.entities.values()].sort((a, b) => b.weight - a.weight);
	const topEntities = entities.slice(0, 20);
	const lines = [
		`🕸️ Knowledge Graph`,
		`   Built: ${graph.builtAt}`,
		`   Entities: ${graph.entities.size} | Relations: ${graph.relations.length}`,
		"",
		"── Top Entities (by connectivity) ──",
	];
	for (const e of topEntities) {
		const typeIcon: Record<string, string> = {
			concept: "💡", technology: "🔧", business: "💰", tool: "🛠️",
			person: "👤", project: "📦", custom: "📌",
		};
		lines.push(`   ${typeIcon[e.type] || "📌"} ${e.label} (${e.type}, weight:${e.weight}, occ:${e.occurrences})`);
	}

	if (graph.relations.length > 0) {
		const topRels = graph.relations.sort((a, b) => b.weight - a.weight).slice(0, 15);
		lines.push("", "── Top Relations ──");
		for (const rel of topRels) {
			const fromE = graph.entities.get(rel.from);
			const toE = graph.entities.get(rel.to);
			lines.push(`   ${fromE?.label || rel.from} ←[${rel.label}: ${rel.weight}]→ ${toE?.label || rel.to}`);
		}
	}

	return lines.join("\n");
}

// ── Tool ───────────────────────────────────────────────────────────

export function createTool(_cwd: string): AgentTool<any> {
	return {
		name: "knowledge-graph",
		description:
			"Knowledge graph: extracts entities and relations from knowledge store. Actions: build (scan knowledge and build graph), query (find entity and its connection chain), link (manually add relation), show (graph stats), clear, suggest (find unlinked entities that should connect).",
		label: "knowledge-graph",

		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["build", "query", "link", "show", "clear", "suggest"],
					description: "Graph action",
				},
				entity: { type: "string", description: "Entity label to query (for query)" },
				from: { type: "string", description: "Source entity (for link)" },
				to: { type: "string", description: "Target entity (for link)" },
				label: { type: "string", description: "Relation label (for link, e.g. 'uses', 'related-to')" },
				depth: { type: "number", description: "Max traversal depth for query (default 2)" },
			},
			required: ["action"],
		},

		execute: async (_callId: string, params: unknown) => {
			const p = params as GraphParams;

			switch (p.action) {
				case "build": {
					const graph = buildGraphFromKnowledge();
					saveGraph(graph);
					return {
						content: [text(`🕸️ Graph built: ${graph.entities.size} entities, ${graph.relations.length} relations\n\n` + formatGraph(graph))],
						details: {},
					};
				}

				case "query": {
					if (!p.entity) {
						return { content: [text("Error: 'entity' is required for query.")], details: {} };
					}
					const graph = loadGraph();
					if (!graph) {
						return { content: [text("No graph exists. Run 'build' first.")], details: {} };
					}
					const key = entityKey(p.entity);
					const chain = queryEntityChain(graph, key, p.depth || 2);
					if (chain.length === 0) {
						return { content: [text(`Entity "${p.entity}" not found in graph.`)], details: {} };
					}
					return {
						content: [text(`🔗 Entity chain for "${p.entity}": ${chain.join(" → ")}`)],
						details: {},
					};
				}

				case "link": {
					if (!p.from || !p.to || !p.label) {
						return { content: [text("Error: 'from', 'to', and 'label' are required for link.")], details: {} };
					}
					const graph = loadGraph() || {
						entities: new Map<string, Entity>(),
						relations: [],
						builtAt: new Date().toISOString(),
					};
					const fromKey = entityKey(p.from);
					const toKey = entityKey(p.to);

					// Ensure entities exist
					for (const [label, key] of [[p.from, fromKey], [p.to, toKey]] as [string, string][]) {
						if (!graph.entities.has(key)) {
							graph.entities.set(key, { id: key, label, type: "custom", weight: 0, occurrences: 1 });
						}
						graph.entities.get(key)!.weight++;
					}

					// Check if relation exists
					const existing = graph.relations.find(
						r => (r.from === fromKey && r.to === toKey && r.label === p.label)
					);
					if (existing) {
						existing.weight++;
					} else {
						graph.relations.push({ from: fromKey, to: toKey, label: p.label, weight: 1 });
					}

					saveGraph(graph);
					return {
						content: [text(`🔗 Linked: ${p.from} —[${p.label}]→ ${p.to}`)],
						details: {},
					};
				}

				case "suggest": {
					const graph = loadGraph();
					if (!graph) {
						return { content: [text("No graph exists. Run 'build' first.")], details: {} };
					}
					// Find entities with high occurrence but low connectivity (possible missed links)
					const suggestions: string[] = [];
					for (const [key, entity] of graph.entities) {
						if (entity.occurrences >= 3 && entity.weight <= 1) {
							suggestions.push(`${entity.label} (occ:${entity.occurrences}, weight:${entity.weight})`);
						}
					}
					if (suggestions.length === 0) {
						return { content: [text("No suggestions — all well-connected entities.")], details: {} };
					}
					return {
						content: [text("💡 Entities that may need more links:\n" + suggestions.slice(0, 10).join("\n"))],
						details: {},
					};
				}

				case "show": {
					const graph = loadGraph();
					if (!graph) {
						return { content: [text("No graph exists. Run 'build' first.")], details: {} };
					}
					return { content: [text(formatGraph(graph))], details: {} };
				}

				case "clear": {
					ensureDir();
					if (existsSync(GRAPH_FILE)) unlinkSync(GRAPH_FILE);
					return { content: [text("Knowledge graph cleared.")], details: {} };
				}

				default:
					return { content: [text(`Unknown action: ${p.action}`)], details: {} };
			}
		},
	};
}
