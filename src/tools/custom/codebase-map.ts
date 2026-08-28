/**
 * codebase-map — 代码地图工具
 *
 * 深度分析代码库结构：
 *   - map: 扫描目录结构 + 模块间依赖关系
 *   - deps: 分析指定文件的 import/require 依赖链
 *   - symbols: 提取文件中的导出函数/类/类型签名
 *
 * 比 project.ts 更深入：project.ts 做启动时的浅层扫描，
 * codebase-map 做按需的深度分析。
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename, extname, relative } from "node:path";

// ===== Types =====

interface ModuleInfo {
	path: string;
	name: string;
	exports: string[];
	imports: string[];
	loc: number;
}

interface DepChain {
	from: string;
	to: string;
	type: "import" | "require" | "dynamic";
}

// ===== Scanning =====

const SKIP_DIRS = new Set([
	"node_modules", ".git", ".svn", "__pycache__", ".cache",
	"dist", "build", ".next", ".venv", "vendor", "target",
]);

function scanSrcFiles(root: string, maxDepth: number = 4): string[] {
	const files: string[] = [];
	const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

	while (queue.length > 0) {
		const { dir, depth } = queue.shift()!;
		if (depth > maxDepth) continue;

		try {
			const entries = readdirSync(dir);
			for (const entry of entries) {
				const fullPath = join(dir, entry);
				try {
					const stat = statSync(fullPath);
					if (stat.isDirectory()) {
						if (!SKIP_DIRS.has(entry)) {
							queue.push({ dir: fullPath, depth: depth + 1 });
						}
					} else if (stat.isFile()) {
						const ext = extname(entry);
						if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
							files.push(fullPath);
						}
					}
				} catch { /* skip */ }
			}
		} catch { /* skip */ }
	}

	return files;
}

/** 提取文件中的 import 语句 */
function extractImports(content: string, filePath: string): string[] {
	const imports: string[] = [];
	const lines = content.split("\n");

	for (const line of lines) {
		const trimmed = line.trim();

		// import ... from "..."
		const importMatch = trimmed.match(/^import\s+(?:type\s+)?(?:\{[^}]*\}|[\w*]+)\s+from\s+['"]([^'"]+)['"]/);
		if (importMatch) {
			imports.push(importMatch[1]);
			continue;
		}

		// import "..." (side-effect)
		const sideEffectMatch = trimmed.match(/^import\s+['"]([^'"]+)['"]/);
		if (sideEffectMatch) {
			imports.push(sideEffectMatch[1]);
			continue;
		}

		// require("...")
		const requireMatch = trimmed.match(/(?:const|let|var)\s+\w+\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
		if (requireMatch) {
			imports.push(requireMatch[1]);
		}

		// dynamic import: import("...")
		const dynamicMatch = trimmed.match(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/);
		if (dynamicMatch) {
			imports.push(dynamicMatch[1]);
		}
	}

	return imports;
}

/** 提取文件中的 export 签名 */
function extractExports(content: string): string[] {
	const exports: string[] = [];
	const lines = content.split("\n");

	for (const line of lines) {
		const trimmed = line.trim();

		// export function/class/interface/type
		const namedMatch = trimmed.match(/^export\s+(function|class|interface|type|enum|const|let|var|default)\s+(\w+)/);
		if (namedMatch) {
			exports.push(`${namedMatch[2]} (${namedMatch[1]})`);
			continue;
		}

		// export { a, b, c }
		const destructureMatch = trimmed.match(/^export\s+\{([^}]+)\}/);
		if (destructureMatch) {
			const names = destructureMatch[1].split(",").map(s => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
			exports.push(...names);
		}
	}

	return exports;
}

/** 分析单个文件 */
function analyzeFile(filePath: string): ModuleInfo {
	const content = existsSync(filePath) ? readFileSync(filePath, "utf-8") : "";
	const loc = content.split("\n").length;

	return {
		path: filePath,
		name: basename(filePath),
		exports: extractExports(content),
		imports: extractImports(content, filePath),
		loc,
	};
}

// ===== Tool =====

interface CodebaseMapParams {
	action: "map" | "deps" | "symbols";
	/** File path to analyze (for deps/symbols) */
	path?: string;
	/** Max scan depth (for map) */
	depth?: number;
	/** Only show files matching pattern */
	filter?: string;
}

function text(t: string) {
	return { type: "text" as const, text: t };
}

export function createTool(cwd: string): AgentTool<any> {
	return {
		name: "codebase-map",
		description:
			"Code structure analyzer. Actions: map (scan directory structure + dependencies), deps (analyze file's import chain), symbols (extract exports/functions/types from a file).",
		label: "codebase-map",
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					description: "Action: 'map', 'deps', or 'symbols'",
					enum: ["map", "deps", "symbols"],
				},
				path: { type: "string", description: "File path to analyze (for deps/symbols)" },
				depth: { type: "number", description: "Max scan depth for map (default 4)" },
				filter: { type: "string", description: "Only show files matching this pattern (for map)" },
			},
			required: ["action"],
		},
		execute: async (_toolCallId: string, params: unknown) => {
			const p = params as CodebaseMapParams;

			switch (p.action) {
				case "map":
					return handleMap(cwd, p);
				case "deps":
					return handleDeps(cwd, p);
				case "symbols":
					return handleSymbols(cwd, p);
				default:
					return { content: [text(`Unknown action: ${p.action}`)], details: {} };
			}
		},
	};
}

function handleMap(cwd: string, p: CodebaseMapParams) {
	const maxDepth = p.depth ?? 4;
	const targetDir = p.filter ? join(cwd, p.filter) : cwd;
	const files = scanSrcFiles(targetDir, maxDepth);

	if (files.length === 0) {
		return { content: [text("No source files found.")], details: {} };
	}

	const modules = files.map(f => analyzeFile(f));

	// 按目录分组
	const byDir = new Map<string, ModuleInfo[]>();
	for (const m of modules) {
		const dir = relative(targetDir, m.path).includes("/")
			? relative(targetDir, m.path).split("/").slice(0, -1).join("/")
			: "(root)";
		if (!byDir.has(dir)) byDir.set(dir, []);
		byDir.get(dir)!.push(m);
	}

	// 统计总依赖
	const totalImports = modules.reduce((s, m) => s + m.imports.length, 0);
	const totalExports = modules.reduce((s, m) => s + m.exports.length, 0);
	const totalLoc = modules.reduce((s, m) => s + m.loc, 0);

	const lines: string[] = [
		`Codebase Map: ${files.length} files, ${totalLoc} LOC, ${totalExports} exports, ${totalImports} imports`,
		"",
	];

	for (const [dir, mods] of byDir) {
		lines.push(`📁 ${dir}/`);
		for (const m of mods) {
			const shortPath = relative(targetDir, m.path);
			const expStr = m.exports.length > 0 ? ` → ${m.exports.slice(0, 3).join(", ")}${m.exports.length > 3 ? "..." : ""}` : "";
			lines.push(`  ${m.name} (${m.loc}L${expStr})`);
		}
		lines.push("");
	}

	// 高连接模块（被引用最多的）
	const importCounts = new Map<string, number>();
	for (const m of modules) {
		for (const imp of m.imports) {
			const base = basename(imp);
			importCounts.set(base, (importCounts.get(base) || 0) + 1);
		}
	}
	const topImports = [...importCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
	if (topImports.length > 0) {
		lines.push("🔗 Most referenced modules:");
		for (const [name, count] of topImports) {
			lines.push(`  ${name}: ${count} imports`);
		}
	}

	return {
		content: [text(lines.join("\n"))],
		details: { files: files.length, totalLoc, totalExports, totalImports },
	};
}

function handleDeps(cwd: string, p: CodebaseMapParams) {
	if (!p.path) {
		return { content: [text("Error: 'path' is required for deps action.")], details: {} };
	}

	const fullPath = join(cwd, p.path);
	if (!existsSync(fullPath)) {
		return { content: [text(`File not found: ${p.path}`)], details: {} };
	}

	const info = analyzeFile(fullPath);

	if (info.imports.length === 0) {
		return { content: [text(`${basename(fullPath)}: no imports found.`)], details: {} };
	}

	const lines: string[] = [
		`Dependencies of ${basename(fullPath)} (${info.imports.length} imports):`,
		"",
	];

	for (const imp of info.imports) {
		const isLocal = imp.startsWith(".") || imp.startsWith("/");
		const isPackage = !isLocal;
		const tag = isLocal ? "📦 local" : "🌐 npm";
		lines.push(`  ${tag} ${imp}`);
	}

	return {
		content: [text(lines.join("\n"))],
		details: { imports: info.imports },
	};
}

function handleSymbols(cwd: string, p: CodebaseMapParams) {
	if (!p.path) {
		return { content: [text("Error: 'path' is required for symbols action.")], details: {} };
	}

	const fullPath = join(cwd, p.path);
	if (!existsSync(fullPath)) {
		return { content: [text(`File not found: ${p.path}`)], details: {} };
	}

	const info = analyzeFile(fullPath);

	const lines: string[] = [
		`Symbols in ${basename(fullPath)} (${info.loc} lines):`,
		"",
	];

	if (info.exports.length === 0) {
		lines.push("  (no named exports found)");
	} else {
		for (const exp of info.exports) {
			lines.push(`  ▸ ${exp}`);
		}
	}

	if (info.imports.length > 0) {
		lines.push("");
		lines.push(`Imports (${info.imports.length}):`);
		for (const imp of info.imports.slice(0, 15)) {
			lines.push(`  ← ${imp}`);
		}
		if (info.imports.length > 15) {
			lines.push(`  ... +${info.imports.length - 15} more`);
		}
	}

	return {
		content: [text(lines.join("\n"))],
		details: { exports: info.exports, imports: info.imports, loc: info.loc },
	};
}
