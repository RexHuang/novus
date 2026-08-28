/**
 * mcp-server — MCP (Model Context Protocol) server implementation.
 *
 * Exposes novus capabilities as MCP tools, accessible by any MCP-compatible client.
 * Uses stdio transport (JSON-RPC 2.0 over stdin/stdout).
 *
 * Exposed tools: fetch, learn, recall, knowledge-graph (build/query/link), plan.
 *
 * Run standalone: node dist/tools/custom/mcp-server.js
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { storeKnowledge, queryKnowledge, type KnowledgeCategory } from "../../memory/knowledge.ts";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const GRAPH_FILE = join(homedir(), ".novus", "knowledge-graph", "graph.json");

function text(t: string) {
	return { type: "text" as const, text: t };
}

// ── MCP Protocol Types ────────────────────────────────────────────

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: number | string;
	method: string;
	params?: Record<string, unknown>;
}

interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: number | string | null;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

// ── MCP Tool Definitions ──────────────────────────────────────────

interface McpToolDef {
	name: string;
	description: string;
	inputSchema: {
		type: "object";
		properties: Record<string, unknown>;
		required?: string[];
	};
}

const MCP_TOOLS: McpToolDef[] = [
	{
		name: "recall",
		description: "Search novus knowledge store by query string. Returns matching knowledge entries sorted by value.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "Search query" },
				category: { type: "string", description: "Filter by category (knowledge/preference/fact/self-improvement/business)" },
				limit: { type: "number", description: "Max results (default 10)" },
			},
			required: ["query"],
		},
	},
	{
		name: "learn",
		description: "Store knowledge into novus memory. Persists across sessions.",
		inputSchema: {
			type: "object",
			properties: {
				content: { type: "string", description: "Knowledge content to store" },
				tags: { type: "array", items: { type: "string" }, description: "Tags for categorization" },
				category: { type: "string", description: "Category (knowledge/preference/fact/self-improvement/business)" },
				source: { type: "string", description: "Source description" },
				confidence: { type: "number", description: "Confidence 0-1 (default 0.8)" },
			},
			required: ["content"],
		},
	},
	{
		name: "graph_query",
		description: "Query the knowledge graph for an entity and its connection chain.",
		inputSchema: {
			type: "object",
			properties: {
				entity: { type: "string", description: "Entity label to search" },
				depth: { type: "number", description: "Traversal depth (default 2)" },
			},
			required: ["entity"],
		},
	},
	{
		name: "graph_show",
		description: "Show knowledge graph statistics and top entities/relations.",
		inputSchema: {
			type: "object",
			properties: {},
		},
	},
];

// ── MCP Tool Execution ────────────────────────────────────────────

function executeMcpTool(name: string, args: Record<string, unknown>): string {
	switch (name) {
		case "recall": {
			const results = queryKnowledge({
				query: args.query as string,
				category: args.category as KnowledgeCategory | undefined,
				limit: (args.limit as number) || 10,
				sortBy: "value",
				coreOnly: true,
			});
			if (results.length === 0) return "No matching knowledge found.";
			return results.map(r =>
				`[${r.id}] ${r.category} | ${r.content.slice(0, 300)}`
			).join("\n");
		}

		case "learn": {
			const entry = storeKnowledge({
				content: args.content as string,
				source: (args.source as string) || "mcp-client",
				category: (args.category as KnowledgeCategory) || undefined,
				tags: (args.tags as string[]) || [],
				confidence: (args.confidence as number) || 0.8,
			});
			if (!entry) return "Skipped: duplicate or empty content.";
			return `Stored #${entry.id} | ${entry.category} | ${entry.tags.join(",") || "-"}`;
		}

		case "graph_query": {
			if (!existsSync(GRAPH_FILE)) return "No graph exists. Build it first via novus.";
			try {
				const graph = JSON.parse(readFileSync(GRAPH_FILE, "utf-8")) as {
					entities: Record<string, { id: string; label: string; type: string; weight: number }>;
					relations: Array<{ from: string; to: string; label: string; weight: number }>;
				};
				const query = (args.entity as string).toLowerCase();
				const matched = Object.values(graph.entities).filter(e =>
					e.label.toLowerCase().includes(query)
				);
				if (matched.length === 0) return `Entity "${args.entity}" not found.`;
				// Find connected entities
				const chain: string[] = [];
				for (const m of matched) {
					chain.push(m.label);
					for (const rel of graph.relations) {
						const neighbor = rel.from === m.id ? graph.entities[rel.to] : rel.to === m.id ? graph.entities[rel.from] : null;
						if (neighbor) chain.push(`${neighbor.label} (${rel.label})`);
					}
				}
				return `Chain: ${chain.join(" → ")}`;
			} catch {
				return "Error reading graph.";
			}
		}

		case "graph_show": {
			if (!existsSync(GRAPH_FILE)) return "No graph exists. Build it first via novus.";
			try {
				const graph = JSON.parse(readFileSync(GRAPH_FILE, "utf-8")) as {
					entities: Record<string, { label: string; type: string; weight: number; occurrences: number }>;
					relations: Array<{ from: string; to: string; label: string; weight: number }>;
				};
				const entities = Object.values(graph.entities).sort((a, b) => b.weight - a.weight).slice(0, 10);
				return [
					`Graph: ${Object.keys(graph.entities).length} entities, ${graph.relations.length} relations`,
					"Top entities:",
					...entities.map(e => `  ${e.label} (${e.type}, w:${e.weight}, occ:${e.occurrences})`),
				].join("\n");
			} catch {
				return "Error reading graph.";
			}
		}

		default:
			return `Unknown tool: ${name}`;
	}
}

// ── MCP Protocol Handlers ──────────────────────────────────────────

function handleInitialize(_params: Record<string, unknown>): Record<string, unknown> {
	return {
		protocolVersion: "2024-11-05",
		capabilities: {
			tools: {},
		},
		serverInfo: {
			name: "novus-mcp",
			version: "0.1.0",
		},
	};
}

function handleToolsList(): Record<string, unknown> {
	return {
		tools: MCP_TOOLS.map(t => ({
			name: t.name,
			description: t.description,
			inputSchema: t.inputSchema,
		})),
	};
}

function handleToolsCall(params: Record<string, unknown>): Record<string, unknown> {
	const toolName = params.name as string;
	const args = (params.arguments || {}) as Record<string, unknown>;

	const result = executeMcpTool(toolName, args);
	return {
		content: [{ type: "text", text: result }],
		isError: false,
	};
}

// ── Stdio Transport ───────────────────────────────────────────────

function createResponse(id: number | string | null, result?: unknown, error?: { code: number; message: string }): JsonRpcResponse {
	const resp: JsonRpcResponse = { jsonrpc: "2.0", id };
	if (error) resp.error = error;
	else resp.result = result;
	return resp;
}

async function main(): Promise<void> {
	process.stdin.setEncoding("utf-8");
	let buffer = "";

	for await (const chunk of process.stdin) {
		buffer += chunk;
		const lines = buffer.split("\n");
		buffer = lines.pop() || "";

		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const msg = JSON.parse(line) as JsonRpcRequest;
				let response: JsonRpcResponse;

				switch (msg.method) {
					case "initialize":
						response = createResponse(msg.id, handleInitialize(msg.params || {}));
						break;
					case "notifications/initialized":
						continue; // no response for notifications
					case "tools/list":
						response = createResponse(msg.id, handleToolsList());
						break;
					case "tools/call":
						response = createResponse(msg.id, handleToolsCall(msg.params || {}));
						break;
					case "ping":
						response = createResponse(msg.id, {});
						break;
					default:
						response = createResponse(msg.id, undefined, { code: -32601, message: `Method not found: ${msg.method}` });
				}

				process.stdout.write(JSON.stringify(response) + "\n");
			} catch {
				process.stderr.write("[mcp-server] Invalid JSON received\n");
			}
		}
	}
}

// Export for tool registry + allow standalone execution
export function createTool(_cwd: string): AgentTool<any> {
	return {
		name: "mcp-server",
		description:
			"MCP Server: exposes novus capabilities (recall, learn, knowledge-graph) as MCP tools via stdio transport. Run standalone with: node dist/tools/custom/mcp-server.js",
		label: "mcp-server",

		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["status", "tools", "help"],
					description: "MCP server action (informational only — actual server runs standalone)",
				},
			},
			required: [],
		},

		execute: async (_callId: string, params: unknown) => {
			const p = params as { action?: string };
			switch (p.action) {
				case "tools":
					return {
						content: [text("MCP Tools exposed:\n" + MCP_TOOLS.map(t => `  - ${t.name}: ${t.description}`).join("\n"))],
						details: {},
					};
				case "help":
				default:
					return {
						content: [text("MCP Server for novus\n\nExpose novus capabilities to any MCP-compatible client (Claude Desktop, Cursor, etc.)\n\nRun standalone:\n  node dist/tools/custom/mcp-server.js\n\nOr use with Claude Desktop config:\n  {\"command\":\"node\",\"args\":[\"dist/tools/custom/mcp-server.js\"]}\n\nTools: " + MCP_TOOLS.map(t => t.name).join(", "))],
						details: {},
					};
			}
		},
	};
}

// Run standalone if executed directly
const isMain = process.argv[1]?.endsWith("mcp-server.js") || process.argv[1]?.endsWith("mcp-server.ts");
if (isMain) {
	main().catch(err => {
		process.stderr.write(`[mcp-server] Fatal: ${err.message}\n`);
		process.exit(1);
	});
}
