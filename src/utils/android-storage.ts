/**
 * Android Storage Compatibility Layer
 *
 * On Android 12+ (Huawei BRE-AL00b), the FUSE filesystem at /storage/emulated/0
 * assigns files to u0_a138:media_rw regardless of which app creates them.
 * Termux runs as u0_a234, so it can WRITE but not READ files in external storage.
 *
 * Strategy:
 *   - All files in ~/.novus/storage-mirror/ ← always readable (private storage)
 *   - External storage ← write-only, for sharing with other apps
 *   - On write to external path → also write mirror copy
 *   - On read from external path → return mirror copy if exists
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, normalize } from "node:path";

// ── Constants ──────────────────────────────────────────────────

/** Root of private mirror: mirrors the external storage structure */
const MIRROR_ROOT = join(homedir(), ".novus", "storage-mirror");

/** Paths considered "external storage" */
const EXTERNAL_ROOTS = [
	"/storage/emulated/0",
	"/sdcard",
	"/storage/self/primary",
	"/mnt/sdcard",
	join(homedir(), "storage", "shared"),
	join(homedir(), "storage", "dcim"),
	join(homedir(), "storage", "downloads"),
	join(homedir(), "storage", "movies"),
	join(homedir(), "storage", "music"),
	join(homedir(), "storage", "pictures"),
];

/** Track mirror timestamps for freshness checks */
const _mirrorMeta = new Map<string, number>();

// ── Path utilities ─────────────────────────────────────────────

/** Normalize a path (resolve symlinks, .. etc) */
function norm(p: string): string {
	try {
		return resolve(normalize(p));
	} catch {
		return p;
	}
}

/** Check if a path is in external storage */
export function isExternalPath(filePath: string): boolean {
	const n = norm(filePath);
	for (const root of EXTERNAL_ROOTS) {
		const r = norm(root);
		if (n === r || n.startsWith(r + "/")) return true;
	}
	return false;
}

/** Convert external path → private mirror path */
export function toMirrorPath(filePath: string): string {
	const n = norm(filePath);
	let rel = "";
	for (const root of EXTERNAL_ROOTS) {
		const r = norm(root);
		if (n === r) {
			rel = ".";
			break;
		}
		if (n.startsWith(r + "/")) {
			rel = n.slice(r.length + 1);
			break;
		}
	}
	return join(MIRROR_ROOT, rel);
}

/** Check if a mirrored copy exists for an external path */
export function hasMirror(filePath: string): boolean {
	return existsSync(toMirrorPath(filePath));
}

// ── Core operations ────────────────────────────────────────────

/**
 * Write content to file, with automatic mirroring for external paths.
 *
 * @returns true if content was also mirrored
 */
export function writeWithMirror(filePath: string, content: string | Buffer): boolean {
	const ext = isExternalPath(filePath);
	if (ext) {
		const mirrorPath = toMirrorPath(filePath);
		mkdirSync(join(mirrorPath, ".."), { recursive: true });
		writeFileSync(mirrorPath, content);
		_mirrorMeta.set(mirrorPath, Date.now());
	}
	return ext;
}

/**
 * Read file content. For external paths, reads from mirror if available.
 *
 * @returns [content, fromMirror]
 */
export function readWithMirror(filePath: string): [string, boolean] {
	if (!isExternalPath(filePath)) {
		return [readFileSync(filePath, "utf-8"), false];
	}

	// Try mirror first
	const mirrorPath = toMirrorPath(filePath);
	if (existsSync(mirrorPath)) {
		return [readFileSync(mirrorPath, "utf-8"), true];
	}

	// Fallback: try original (likely fails on Android)
	try {
		return [readFileSync(filePath, "utf-8"), false];
	} catch {
		throw new Error(
			`Cannot read "${filePath}": Android FUSE permission denied.\n` +
			`File was likely created by another app. Use "termux-storage-get" to import it first.\n` +
			`Mirror not found at: ${mirrorPath}`
		);
	}
}

/**
 * Check if a file exists (checks mirror for external paths).
 */
export function existsWithMirror(filePath: string): boolean {
	if (!isExternalPath(filePath)) return existsSync(filePath);
	return existsSync(toMirrorPath(filePath)) || existsSync(filePath);
}

/**
 * Stat a file (uses mirror for external paths if available).
 */
export function statWithMirror(filePath: string) {
	if (!isExternalPath(filePath)) return statSync(filePath);
	const mirrorPath = toMirrorPath(filePath);
	if (existsSync(mirrorPath)) return statSync(mirrorPath);
	return statSync(filePath);
}

/**
 * Sync a file FROM shared storage INTO private mirror.
 * Only works for files we created ourselves (via writeWithMirror).
 * For files from other apps, the user must use termux-storage-get.
 */
export function syncFromShared(filePath: string): boolean {
	if (!isExternalPath(filePath)) return false;
	const mirrorPath = toMirrorPath(filePath);
	if (existsSync(mirrorPath)) return true; // already synced

	// Try direct read (usually fails)
	try {
		const content = readFileSync(filePath);
		mkdirSync(join(mirrorPath, ".."), { recursive: true });
		writeFileSync(mirrorPath, content);
		return true;
	} catch {
		return false;
	}
}

/**
 * Push a file from private mirror to shared storage (one-way).
 */
export function pushToShared(filePath: string): boolean {
	const mirrorPath = toMirrorPath(filePath);
	if (!existsSync(mirrorPath)) return false;

	try {
		mkdirSync(join(filePath, ".."), { recursive: true });
		writeFileSync(filePath, readFileSync(mirrorPath));
		return true;
	} catch {
		return false;
	}
}

/**
 * Get mirror stats for debugging.
 */
export function mirrorStats() {
	if (!existsSync(MIRROR_ROOT)) return { root: MIRROR_ROOT, fileCount: 0 };
	const countFiles = (dir: string): number => {
		let count = 0;
		const { readdirSync } = require("node:fs");
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.isDirectory()) count += countFiles(join(dir, entry.name));
			else count++;
		}
		return count;
	};
	return {
		root: MIRROR_ROOT,
		fileCount: countFiles(MIRROR_ROOT),
	};
}
