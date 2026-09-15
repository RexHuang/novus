/**
 * Vitest global setup — runs before test files load.
 * Isolates the knowledge store into a temp dir so tests never touch the
 * real ~/.novus/knowledge, and parallel test files don't share state.
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Per-worker dir: parallel test files each run this setup and would otherwise
// rmSync a shared dir out from under a sibling worker mid-write (ENOENT race).
const TEST_KNOWLEDGE_DIR = join(
	tmpdir(),
	`novus-test-knowledge-${process.env.VITEST_POOL_ID ?? process.pid}`,
);

// Must be set before any src module is imported (knowledge.ts reads it at call time)
process.env.NOVUS_KNOWLEDGE_DIR = TEST_KNOWLEDGE_DIR;

// Clean slate
try {
	rmSync(TEST_KNOWLEDGE_DIR, { recursive: true, force: true });
} catch {
	/* dir missing or undeletable — ignore */
}
mkdirSync(TEST_KNOWLEDGE_DIR, { recursive: true });
