/**
 * Tombstone（删除遗忘闸）—— P0-④
 * 语义：用户要求删除/撤销的记忆值，novus 在 TTL 窗口内不得复述、不得写入行动产物
 * （覆盖"删除后同会话追问"与"撤销内容渗入文件产物"两类失败模式）。
 * 存储：$HOME/.novus/tombstones.json —— knowledge 目录之外，不进评测 L0 扫描区。
 * TTL 7 天自动过期；novus -p 每回合冷启动读盘，无需进程内状态。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface Tombstone { value: string; at: string; }

const TTL_MS = 7 * 24 * 3600 * 1000;
const SCRUB_NOTE = "〔该信息已删除，我不再记得〕";

function tombPath(): string {
	return join(homedir(), ".novus", "tombstones.json");
}

function loadTombstones(): Tombstone[] {
	try {
		const now = Date.now();
		const arr = JSON.parse(readFileSync(tombPath(), "utf-8")) as Tombstone[];
		return Array.isArray(arr) ? arr.filter(t => t?.value && now - new Date(t.at).getTime() < TTL_MS) : [];
	} catch { return []; }
}

function saveTombstones(ts: Tombstone[]): void {
	try { writeFileSync(tombPath(), JSON.stringify(ts), "utf-8"); } catch { /* 不阻断主流程 */ }
}

/** 从被删/被替换条目提取敏感值：长数字串（号码/证件）、门牌号（N号）、书名号/方头括号/引号短语 */
export function extractSensitiveValues(content: string): string[] {
	const vals = new Set<string>();
	for (const m of content.matchAll(/\d{7,}/g)) vals.add(m[0]);
	for (const m of content.matchAll(/\d{1,6}\s*号/g)) vals.add(m[0].replace(/\s+/g, ""));
	for (const m of content.matchAll(/[【《“"]([^】》”"]{2,32})[】》”"]/g)) vals.add(m[0]);
	return [...vals].filter(v => v.length >= 3);
}

/** 删除/撤销/替换条目时登记 tombstone */
export function recordTombstones(contents: string[]): void {
	const useful = contents.filter(c => typeof c === "string" && c.length > 0);
	if (useful.length === 0) return;
	const ts = loadTombstones();
	const known = new Set(ts.map(t => t.value));
	for (const c of useful) {
		for (const v of extractSensitiveValues(c)) {
			if (!known.has(v)) { ts.push({ value: v, at: new Date().toISOString() }); known.add(v); }
		}
	}
	if (ts.length > 0) saveTombstones(ts);
}

/** 重申复活（rerun6 取证 ext-upd-005）：新写入内容包含已登记 tombstone 值 = 用户重新确认该值有效
 *  → 撤销对应 tombstone，否则后续输出清洗会把用户现用值误说成"已删除"（搬回旧地址场景）。 */
export function revokeTombstones(content: string): number {
	if (!content) return 0;
	const ts = loadTombstones();
	const kept = ts.filter(t => !content.includes(t.value));
	if (kept.length === ts.length) return 0;
	try { saveTombstones(kept); } catch { /* 不阻断主流程 */ }
	return ts.length - kept.length;
}

/** 输出/产物清洗：命中 tombstone 值 → 替换为遗忘话术。返回 hits 供调用方感知拦截 */
export function scrubTombstones(text: string): { text: string; hits: string[] } {
	if (!text) return { text, hits: [] };
	const hits: string[] = [];
	let out = text;
	for (const t of loadTombstones()) {
		if (out.includes(t.value)) {
			hits.push(t.value);
			out = out.split(t.value).join(SCRUB_NOTE);
		}
	}
	return { text: out, hits };
}
