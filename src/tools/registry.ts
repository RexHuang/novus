import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createBuiltinTools } from "./builtin.ts";
import { backupFiles } from "./custom/session-worklog.js";
import { isExternalPath, toMirrorPath, hasMirror, writeWithMirror, readWithMirror } from "../utils/android-storage.js";

// ── Path resolution ────────────────────────────────────────────────
// At runtime (after build), this file lives in dist/tools/registry.js.
// Custom tools compiled from src/tools/custom/ land in dist/tools/custom/.

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Directory where compiled custom tools live */
function customToolsDir(): string {
	return join(__dirname, "custom");
}

// ── Dynamic tool loading ───────────────────────────────────────────

interface CustomToolModule {
	createTool: (cwd: string) => AgentTool<any>;
}

/**
 * Scan the custom tools directory and dynamically import all valid tool modules.
 * Each .js file must export a `createTool(cwd: string): AgentTool<any>` function.
 * Uses Promise.allSettled for parallel loading — faster than sequential await.
 */
async function loadCustomTools(cwd: string): Promise<AgentTool<any>[]> {
	const dir = customToolsDir();
	if (!existsSync(dir)) return [];

	const files = readdirSync(dir).filter(
		(f) =>
			(f.endsWith(".js") || f.endsWith(".ts")) &&
			!f.includes(".test.") &&
			!f.endsWith(".d.ts") &&
			f !== "index.js" && f !== "index.ts",
	);
	if (files.length === 0) return [];

	const results = await Promise.allSettled(
		files.map(async (file) => {
			// TS source (vitest/dev) → import with .js suffix so vite resolves to .ts;
			// compiled JS (runtime) → import as-is
			const importFile = file.endsWith(".ts") ? file.replace(/\.ts$/, ".js") : file;
			const mod = (await import(`./custom/${importFile}`)) as CustomToolModule;
			if (typeof mod.createTool !== "function") return null;
			return mod.createTool(cwd);
		})
	);

	const tools: AgentTool<any>[] = [];
	for (let i = 0; i < results.length; i++) {
		const result = results[i]!;
		if (result.status === "fulfilled" && result.value) {
			tools.push(result.value);
		} else {
			const reason = result.status === "rejected" ? result.reason : "no createTool export";
			console.error(`[registry] Failed to load custom tool ${files[i]}:`, reason instanceof Error ? reason.message : reason);
		}
	}

	return tools;
}

// ── Auto-backup hook for edit/write ──────────────────────────────

/**
 * Extract file paths from tool parameters.
 * For edit: edits[].oldText + path
 * For write: path
 */
function extractFilePaths(params: any, toolName: string): string[] {
	if (toolName === "edit") {
		if (params.path) return [params.path];
		if (Array.isArray(params.edits) && params.edits.length > 0 && params.edits[0].path) {
			return [params.edits[0].path];
		}
		return [];
	}
	if (toolName === "write") {
		return params.path ? [params.path] : [];
	}
	return [];
}

/**
 * Wrap a tool's execute function with auto-backup.
 * Before edit/write, automatically backup the target files to checkpoints.
 */
function withAutoBackup(tool: AgentTool<any>, toolName: string): AgentTool<any> {
	const originalExecute = tool.execute;
	return {
		...tool,
		execute: async (callId: string, params: unknown) => {
			const p = params as any;
			const filePaths = extractFilePaths(p, toolName);
			if (filePaths.length > 0) {
				try {
					const cpId = backupFiles(filePaths);
					console.log(`[auto-backup] ${toolName} → checkpoint ${cpId} for: ${filePaths.join(", ")}`);
				} catch (err) {
					// Non-blocking: if backup fails, still proceed with edit/write
					console.error(`[auto-backup] failed:`, err instanceof Error ? err.message : err);
				}
			}
			return originalExecute(callId, params);
		},
	};
}

// ── Tool template (for agent self-creation) ────────────────────────

/**
 * Template that the agent uses when creating a new custom tool.
 * The agent should replace TOOL_NAME, TOOL_DESCRIPTION, and the execute function.
 */
export const TOOL_TEMPLATE = `import type { AgentTool } from "@earendil-works/pi-agent-core";

/**
 * TOOL_DESCRIPTION
 */
export function createTool(cwd: string): AgentTool<any> {
	return {
		name: "TOOL_NAME",
		description: "TOOL_DESCRIPTION",
		label: "TOOL_NAME",
		parameters: {
			type: "object",
			properties: {
				// Define your parameters here, e.g.:
				// paramName: { type: "string", description: "What this param does" },
			},
			required: [],
		},
		execute: async (toolCallId: string, params: unknown) => {
			// Implement your tool logic here
			// Cast params to your expected type, e.g.:
			// const { myParam } = params as { myParam: string };
			// Use cwd for file system access if needed
			return {
				content: [{ type: "text", text: JSON.stringify({ result: "not implemented" }) }],
				details: {},
			};
		},
	};
}
`;

// ── Android storage wrapper ─────────────────────────────────────

/**
 * Wrap read/write tools to handle Android FUSE permission bug.
 * External storage files are write-only (u0_a138). Mirror in private storage.
 */
function withAndroidStorage(tool: AgentTool<any>, toolName: string): AgentTool<any> {
	const originalExecute = tool.execute;

	if (toolName === "write") {
		return {
			...tool,
			execute: async (callId: string, params: unknown) => {
				const result = await originalExecute(callId, params);
				// After successful write, mirror to private storage if external
				const p = params as any;
				if (p?.path && isExternalPath(p.path)) {
					try {
						const mirrorPath = toMirrorPath(p.path);
						const content = typeof p.content === "string" ? p.content : "";
						mkdirSync(join(mirrorPath, ".."), { recursive: true });
						writeFileSync(mirrorPath, content, "utf-8");
					} catch (e) {
						console.error("[android-storage] mirror write failed:", (e as Error).message);
					}
				}
				return result;
			},
		};
	}

	if (toolName === "read") {
		return {
			...tool,
			execute: async (callId: string, params: unknown) => {
				const p = params as any;
				// For external paths, read from mirror
				if (p?.path && isExternalPath(p.path) && hasMirror(p.path)) {
					const [content, fromMirror] = readWithMirror(p.path);
					const note = fromMirror ? " [read from storage-mirror]" : "";
					return {
						content: [{ type: "text" as const, text: content + note }],
						details: {},
					};
				}
				// Otherwise, let original handle it (will fail with clear error for external)
				return originalExecute(callId, params);
			},
		};
	}

	return tool;
}

// ── Public API ─────────────────────────────────────────────────────

/** Create all available tools: built-in + dynamically loaded custom tools */
export async function createAllTools(cwd: string): Promise<AgentTool<any>[]> {
	const builtin = createBuiltinTools(cwd);
	const wrapped = builtin.map(tool => {
		let t = tool;
		// Auto-backup for edit/write
		if (tool.name === "edit" || tool.name === "write") {
			t = withAutoBackup(t, tool.name);
		}
		// Android storage mirror for read/write
		if (tool.name === "read" || tool.name === "write") {
			t = withAndroidStorage(t, tool.name);
		}
		return t;
	});
	const custom = await loadCustomTools(cwd);
	return [...wrapped, ...custom];
}

/** List names of currently available custom tools */
export function listCustomToolFiles(): string[] {
	const dir = customToolsDir();
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter(
		(f) => f.endsWith(".js") && !f.endsWith(".test.js") && f !== "index.js",
	);
}
