/**
 * Project Context Awareness
 *
 * Scans the current working directory to build a structured project map:
 * - Project type (Node.js, Python, or unknown)
 * - Entry points & key modules
 * - Source directory structure
 * - Config files
 * - Test files & patterns
 * - Dependencies
 *
 * This data is cached per-directory and can be injected into the system prompt
 * so novus has immediate context about the project it's working in.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename, extname, relative } from "node:path";

// ── Types ─────────────────────────────────────────────────────────

export interface ProjectModule {
	path: string;
	name: string;
	role: "entry" | "source" | "test" | "config" | "script";
}

export interface ProjectMap {
	type: "node" | "python" | "unknown";
	entryPoints: string[];
	sourceFiles: string[];
	testFiles: string[];
	configFiles: string[];
	modules: ProjectModule[];
	dependencies: string[];
	totalFiles: number;
	hasPackageJson: boolean;
	hasTsConfig: boolean;
	hasGit: boolean;
	srcDirectories: string[];
	lastScanned: string;
}

// ── Scanning ───────────────────────────────────────────────────────

const CONFIG_FILES = new Set([
	"package.json", "tsconfig.json", "tsconfig.build.json",
	".env", ".env.example", "docker-compose.yml", "Dockerfile",
	".gitignore", ".editorconfig", "eslint.config.js", "prettier.config.js",
	"vitest.config.ts", "vitest.config.js", "jest.config.ts", "jest.config.js",
	"Makefile", "Cargo.toml", "go.mod", "requirements.txt", "pyproject.toml",
	"composer.json", "Gemfile",
]);

const TEST_PATTERNS = /\.(test|spec|e2e|integration)\.(ts|js|tsx|jsx|py)$/;
const SOURCE_EXTENSIONS = new Set([".ts", ".js", ".tsx", ".jsx", ".py", ".rs", ".go", ".java", ".cpp", ".c", ".h", ".hpp"]);

function scanDirectory(root: string, dir: string, depth: number = 0, maxDepth: number = 3): {
	files: string[];
	dirs: string[];
} {
	if (depth > maxDepth) return { files: [], dirs: [] };

	const results = { files: [] as string[], dirs: [] as string[] };
	const skipDirs = new Set(["node_modules", ".git", ".svn", "__pycache__", ".cache", "dist", "build", ".next", ".venv", "vendor", "target", ".nova"]);

	try {
		const entries = readdirSync(dir);
		for (const entry of entries) {
			const fullPath = join(dir, entry);
			try {
				const stat = statSync(fullPath);
				if (stat.isDirectory()) {
					if (!skipDirs.has(entry)) {
						results.dirs.push(relative(root, fullPath));
						if (depth < maxDepth) {
							const sub = scanDirectory(root, fullPath, depth + 1, maxDepth);
							results.files.push(...sub.files);
							results.dirs.push(...sub.dirs);
						}
					}
				} else if (stat.isFile()) {
					results.files.push(relative(root, fullPath));
				}
			} catch {
				// skip unreadable entries
			}
		}
	} catch {
		// skip unreadable directories
	}

	return results;
}

function detectProjectType(root: string): ProjectMap["type"] {
	if (existsSync(join(root, "package.json"))) return "node";
	if (existsSync(join(root, "pyproject.toml")) || existsSync(join(root, "requirements.txt"))) return "python";
	return "unknown";
}

function readDependencies(root: string): string[] {
	const pkgPath = join(root, "package.json");
	if (!existsSync(pkgPath)) return [];

	try {
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
		const deps = new Set<string>();
		for (const [name] of Object.entries(pkg.dependencies || {})) deps.add(name);
		for (const [name] of Object.entries(pkg.devDependencies || {})) deps.add(name);
		return Array.from(deps).sort();
	} catch {
		return [];
	}
}

function classifyFiles(root: string, files: string[], dirs: string[]): Omit<ProjectMap, "lastScanned" | "totalFiles"> {
	const entryPoints: string[] = [];
	const sourceFiles: string[] = [];
	const testFiles: string[] = [];
	const configFiles: string[] = [];
	const modules: ProjectModule[] = [];
	const srcDirectories: string[] = [];

	// Identify src directories (deduplicated)
	const seenDirs = new Set<string>();
	for (const d of dirs) {
		const base = basename(d);
		if ((base === "src" || base === "lib" || base === "app" || base === "source") && !seenDirs.has(d)) {
			srcDirectories.push(d);
			seenDirs.add(d);
		}
	}

	// Classify each file
	for (const file of files) {
		const ext = extname(file);
		const name = basename(file);

		// Config files (by name)
		if (CONFIG_FILES.has(name)) {
			configFiles.push(file);
			modules.push({ path: file, name, role: "config" });
			continue;
		}

		// Only classify source-like extensions
		if (!SOURCE_EXTENSIONS.has(ext)) continue;

		// Test files
		if (TEST_PATTERNS.test(name)) {
			testFiles.push(file);
			modules.push({ path: file, name, role: "test" });
			continue;
		}

		// Entry points: root-level index/main files, or src/cli.*, src/index.*
		const isRoot = !file.includes("/");
		const inSrc = file.startsWith("src/");
		if (isRoot && (name.startsWith("index.") || name.startsWith("main.") || name === "cli.ts" || name === "cli.js")) {
			entryPoints.push(file);
			modules.push({ path: file, name, role: "entry" });
			continue;
		}
		// Also check src/ subdir for common entry names
		if (inSrc && (name === "cli.ts" || name === "cli.js" || name === "index.ts" || name === "index.js" || name.startsWith("main."))) {
			entryPoints.push(file);
			modules.push({ path: file, name, role: "entry" });
			continue;
		}

		sourceFiles.push(file);
		modules.push({ path: file, name, role: "source" });
	}

	return { type: detectProjectType(root), entryPoints, sourceFiles, testFiles, configFiles, modules, srcDirectories, dependencies: [], hasPackageJson: existsSync(join(root, "package.json")), hasTsConfig: existsSync(join(root, "tsconfig.json")), hasGit: existsSync(join(root, ".git")) };
}

// ── Public API ─────────────────────────────────────────────────────

const cache = new Map<string, ProjectMap>();

/**
 * Scan a project directory and return a structured ProjectMap.
 * Results are cached per path to avoid repeated scans.
 * Set force=true to re-scan.
 */
export function scanProject(root: string, force: boolean = false): ProjectMap {
	const normalized = root.replace(/\/+$/, "");
	if (!force && cache.has(normalized)) {
		return cache.get(normalized)!;
	}

	const { files, dirs } = scanDirectory(normalized, normalized);
	const classified = classifyFiles(normalized, files, dirs);
	const deps = readDependencies(normalized);

	const result: ProjectMap = {
		...classified,
		dependencies: deps,
		totalFiles: files.length,
		lastScanned: new Date().toISOString(),
	};

	cache.set(normalized, result);
	return result;
}

/**
 * Build a human-readable summary of the project for injection into system prompt.
 */
export function buildProjectSummary(cwd: string): string {
	const map = scanProject(cwd);
	if (map.totalFiles === 0) return "";

	const lines: string[] = [];
	lines.push(`Project: ${basename(cwd)} (${map.type})`);
	lines.push(`  Files: ${map.totalFiles} | Src: ${map.sourceFiles.length} | Tests: ${map.testFiles.length}`);

	if (map.entryPoints.length > 0) {
		lines.push(`  Entry: ${map.entryPoints.join(", ")}`);
	}
	if (map.srcDirectories.length > 0) {
		lines.push(`  Src dirs: ${map.srcDirectories.join(", ")}`);
	}
	if (map.configFiles.length > 0) {
		lines.push(`  Config: ${map.configFiles.join(", ")}`);
	}
	if (map.dependencies.length > 0) {
		const top = map.dependencies.slice(0, 10);
		lines.push(`  Key deps (${map.dependencies.length}): ${top.join(", ")}${map.dependencies.length > 10 ? "..." : ""}`);
	}

	return lines.join("\n");
}

/**
 * Clear the scan cache (e.g. after project structure changes).
 */
export function clearProjectCache(): void {
	cache.clear();
}
