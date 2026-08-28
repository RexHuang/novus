/**
 * output-log — 交互日志管理器
 *
 * 目标：把完整的交互内容写入文件保存，界面上只保留精简的一页。
 * 这样聊天界面不会被大量原始输出淹没，但完整内容随时可查。
 *
 * 用法：
 *   import { log } from "./output-log.ts";
 *   const id = log.start("任务名");
 *   log.append(id, fetchResult);    // 完整内容写入文件
 *   log.append(id, bashOutput);     // 同上
 *   log.done(id);                   // 结束
 *   
 *   界面上只显示: "[log:id] 任务名 — 已记录 N 行，log view-log 查看"
 *   想看详情: view-log id=xxx
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

/** 开始一个日志会话，返回 logId */
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

/** 教训应用 lsn_mt8w4cese6u12h（来自联邦）：超 50MB 自动轮转，防止无上限膨胀 */
const MAX_LOG_BYTES = 50 * 1024 * 1024;
function rotateIfLarge(path: string): void {
  try { if (statSync(path).size > MAX_LOG_BYTES) renameSync(path, path + ".1"); } catch {}
}

/** 追加完整内容到日志文件 */
export function append(logId: string, label: string, content: string): void {
  ensureDir();
  const path = join(LOG_DIR, logId + ".log");
  rotateIfLarge(path);
  const block = `\n--- ${label} ---\n${content}\n`;
  appendFileSync(path, block, "utf-8");
}

/** 结束日志 */
export function done(logId: string): void {
  ensureDir();
  const footer = `<<< END | ${new Date().toISOString()}\n`;
  rotateIfLarge(join(LOG_DIR, logId + ".log"));
  appendFileSync(join(LOG_DIR, logId + ".log"), footer, "utf-8");
}

/** 获取日志文件的完整路径 */
export function pathOf(logId: string): string {
  return join(LOG_DIR, logId + ".log");
}

/** 读取完整日志 */
export function read(logId: string): string {
  const path = join(LOG_DIR, logId + ".log");
  if (!existsSync(path)) return `[日志 ${logId} 不存在]`;
  return readFileSync(path, "utf-8");
}

/** 统计行数 */
export function lineCount(logId: string): number {
  const path = join(LOG_DIR, logId + ".log");
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf-8").split("\n").length;
}

/** 列出最近的日志ID列表 */
export function recent(n: number = 10): string[] {
  ensureDir();
  return readdirSync(LOG_DIR)
    .filter(f => f.endsWith(".log"))
    .sort()
    .reverse()
    .slice(0, n)
    .map(f => f.replace(/\.log$/, ""));
}

/** 生成精简的界面显示文本（只显示开头几行 + 结尾几行） */
export function preview(logId: string, maxLines: number = 15): string {
  const path = join(LOG_DIR, logId + ".log");
  if (!existsSync(path)) return `[日志 ${logId} 不存在]`;

  const lines = readFileSync(path, "utf-8").split("\n");
  const total = lines.length;

  if (total <= maxLines + 3) {
    return lines.join("\n");
  }

  const head = lines.slice(0, Math.floor(maxLines / 2));
  const tail = lines.slice(-Math.floor(maxLines / 2));
  return [
    ...head,
    `... (中间 ${total - head.length - tail.length} 行已折叠，共计 ${total} 行)`,
    ...tail,
  ].join("\n");
}

/** 构建界面简洁引用文本 */
export function ref(logId: string, name: string): string {
  const lc = lineCount(logId);
  return `📋 [${logId}] ${name} — ${lc} 行已记录。\`view-log id=${logId}\` 查看完整内容`;
}
