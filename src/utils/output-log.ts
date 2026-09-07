/**
 * output-log — interactive output logger
 *
 * Goal: write full interaction content to a file; the UI keeps only a compact one-pager.
 * The chat UI won't drown in raw output, but full content stays one command away.
 *
 * Usage:
 *   import { log } from "./output-log.ts";
 *   const id = log.start("task name");
 *   log.append(id, fetchResult);    // full content goes to the file
 *   log.append(id, bashOutput);     // same
 *   log.done(id);                   // finish
 *   
 *   UI shows only: "[log:id] task name — N lines recorded, `view-log` to view"
 *   for details: view-log id=xxx
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_DIR = join(homedir(), ".novus", "logs");

function ensureDir(): void {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
}

let seq = 0;

/** Start a log session, returns a logId */
export function start(name: string): string {
  ensureDir();
  seq++;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const safeName = name.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, "_").slice(0, 40);
  const logId = `${ts}_${seq}_${safeName}`;
  const header = `>>> ${name} | started ${new Date().toISOString()}\n`;
  writeFileSync(join(LOG_DIR, logId + ".log"), header, "utf-8");
  return logId;
}

/** Lesson applied lsn_mt8w4cese6u12h (from the federation): auto-rotate above 50MB to prevent unbounded growth */
const MAX_LOG_BYTES = 50 * 1024 * 1024;
function rotateIfLarge(path: string): void {
  try { if (statSync(path).size > MAX_LOG_BYTES) renameSync(path, path + ".1"); } catch {}
}

/** Append full content to the log file */
export function append(logId: string, label: string, content: string): void {
  ensureDir();
  const path = join(LOG_DIR, logId + ".log");
  rotateIfLarge(path);
  const block = `\n--- ${label} ---\n${content}\n`;
  appendFileSync(path, block, "utf-8");
}

/** Finish the log */
export function done(logId: string): void {
  ensureDir();
  const footer = `<<< END | ${new Date().toISOString()}\n`;
  rotateIfLarge(join(LOG_DIR, logId + ".log"));
  appendFileSync(join(LOG_DIR, logId + ".log"), footer, "utf-8");
}

/** Full path of the log file */
export function pathOf(logId: string): string {
  return join(LOG_DIR, logId + ".log");
}

/** Read the full log */
export function read(logId: string): string {
  const path = join(LOG_DIR, logId + ".log");
  if (!existsSync(path)) return `[log ${logId} not found]`;
  return readFileSync(path, "utf-8");
}

/** Count lines */
export function lineCount(logId: string): number {
  const path = join(LOG_DIR, logId + ".log");
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf-8").split("\n").length;
}

/** List recent log IDs */
export function recent(n: number = 10): string[] {
  ensureDir();
  return readdirSync(LOG_DIR)
    .filter(f => f.endsWith(".log"))
    .sort()
    .reverse()
    .slice(0, n)
    .map(f => f.replace(/\.log$/, ""));
}

/** Build the compact UI display text (first few lines + last few lines) */
export function preview(logId: string, maxLines: number = 15): string {
  const path = join(LOG_DIR, logId + ".log");
  if (!existsSync(path)) return `[log ${logId} not found]`;

  const lines = readFileSync(path, "utf-8").split("\n");
  const total = lines.length;

  if (total <= maxLines + 3) {
    return lines.join("\n");
  }

  const head = lines.slice(0, Math.floor(maxLines / 2));
  const tail = lines.slice(-Math.floor(maxLines / 2));
  return [
    ...head,
    `... (${total - head.length - tail.length} middle lines folded, ${total} total)`,
    ...tail,
  ].join("\n");
}

/** Build the compact UI quote text */
export function ref(logId: string, name: string): string {
  const lc = lineCount(logId);
  return `📋 [${logId}] ${name} — ${lc} lines recorded.\`view-log id=${logId}\` to view full content`;
}
