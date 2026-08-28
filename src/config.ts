import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export interface NovusConfig {
	/** Default model ID (e.g. "claude-sonnet-4-20250514") */
	model?: string;
	/** API base URL override */
	baseUrl?: string;
	/** API key (discouraged in config — prefer env vars) */
	apiKey?: string;
	/** Custom system prompt */
	systemPrompt?: string;
	/** Default working directory for the agent */
	cwd?: string;
	/** Max output tokens */
	maxTokens?: number;
}

// ── Config file locations ──────────────────────────────────────────

/** Local (project-level) config file name */
const LOCAL_CONFIG = "novus.config.json";
/** Global (home directory) config file name */
const HOME_CONFIG = ".novusrc.json";

// ── Cache ───────────────────────────────────────────────────────────

let cachedConfig: NovusConfig | null = null;
let cachedFrom: string | null = null;

/** Clear the config cache (useful when config file changes at runtime) */
export function clearConfigCache(): void {
	cachedConfig = null;
	cachedFrom = null;
}

// ── Load ────────────────────────────────────────────────────────────

/**
 * Load resolved config by merging global (~/.novusrc.json) and local
 * (novus.config.json, searched upward from cwd). Results are cached.
 */
export function loadConfig(cwd?: string): NovusConfig {
	if (cachedConfig) return cachedConfig;

	const [localConfig, localPath] = findLocalConfig(cwd);
	const [homeConfig, homePath] = findHomeConfig();

	// Merge: home config is base, local config overrides
	const merged: NovusConfig = { ...homeConfig, ...localConfig };
	cachedConfig = merged;
	cachedFrom = localPath ?? homePath ?? "defaults";
	return merged;
}

// ── Search helpers ──────────────────────────────────────────────────

function findLocalConfig(cwd?: string): [NovusConfig, string | null] {
	const searchPath = cwd ?? process.cwd();
	let dir = searchPath;

	while (true) {
		const configPath = join(dir, LOCAL_CONFIG);
		if (existsSync(configPath)) {
			const parsed = parseConfigFile(configPath);
			if (parsed) return [parsed, configPath];
		}

		const parent = dirname(dir);
		if (parent === dir) break; // reached filesystem root
		dir = parent;
	}

	return [{}, null];
}

function findHomeConfig(): [NovusConfig, string | null] {
	const configPath = join(homedir(), HOME_CONFIG);
	if (existsSync(configPath)) {
		const parsed = parseConfigFile(configPath);
		if (parsed) return [parsed, configPath];
	}
	return [{}, null];
}

function parseConfigFile(path: string): NovusConfig | null {
	try {
		const raw = readFileSync(path, "utf-8");
		return JSON.parse(raw) as NovusConfig;
	} catch {
		return null;
	}
}

// ── Init ────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: NovusConfig = {
	model: "claude-sonnet-4-20250514",
	maxTokens: 65536,
};

/**
 * Scaffold a novus.config.json in the given directory (defaults to cwd).
 * Returns the path written. Does NOT overwrite existing files by default.
 */
export function initConfig(cwd?: string, force = false): string {
	const dir = cwd ?? process.cwd();
	const configPath = join(dir, LOCAL_CONFIG);

	if (existsSync(configPath) && !force) {
		throw new Error(`Config already exists at ${configPath}. Use --force to overwrite.`);
	}

	const content = JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n";
	writeFileSync(configPath, content, "utf-8");

	// Clear cache so next load picks up the new file
	clearConfigCache();

	return configPath;
}

// ── Info ────────────────────────────────────────────────────────────

/** Return a human-readable description of the current config source */
export function configSource(): string {
	loadConfig(); // ensure cache is populated
	return cachedFrom ?? "defaults";
}
