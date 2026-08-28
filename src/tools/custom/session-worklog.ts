/**
 * session-worklog — 会话级工作上下文日志 + 自动文件备份。
 *
 * 核心设计：
 *   1. log 时自动备份涉及的文件到 ~/.novus/checkpoints/
 *   2. undo 列出所有 checkpoint，可一键回退
 *   3. history 查看操作历史
 *   4. 会话结束时可 snapshot 断点，下次 recover 恢复
 *
 * 存储位置: ~/.novus/session-worklog.json（单文件，最新状态覆盖）
 * 历史归档: ~/.novus/session-worklog-history.jsonl（每条一行）
 * 文件备份: ~/.novus/checkpoints/cp_HHMMSS/（每个备份一个目录）
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, copyFileSync, rmSync, readdirSync } from "node:fs";
import { syncFromWorklog } from "./session-context.js";
import { storeKnowledge, extractExperienceFromWorklog, storeExperience } from "../../memory/knowledge.js";
import { homedir } from "node:os";
import { join } from "node:path";

const WORKLOG_DIR = join(homedir(), ".novus");
const WORKLOG_FILE = join(WORKLOG_DIR, "session-worklog.json");
const HISTORY_FILE = join(WORKLOG_DIR, "session-worklog-history.jsonl");
const CHECKPOINT_DIR = join(WORKLOG_DIR, "checkpoints");
const MAX_HISTORY = 100;
const MAX_CHECKPOINTS = 10;

/**
 * Auto-sync worklog entries to knowledge base.
 * Prevents the "did it but forgot" problem — every logged action
 * gets stored as knowledge so next session can recall it.
 */
function autoSyncToKnowledge(entry: WorklogEntry): void {
	try {
		const parts: string[] = [entry.activity];
		if (entry.changes) parts.push("改动: " + entry.changes);
		if (entry.step) parts.push("阶段: " + entry.step);
		if (entry.nextStep) parts.push("下一步: " + entry.nextStep);
		if (entry.files && entry.files.length > 0) parts.push("文件: " + entry.files.join(", "));

		const content = parts.join(" | ");
		const isBusinessRelevant = !!(entry.files?.length || entry.changes);

		storeKnowledge({
			content,
			source: "worklog-auto:" + entry.timestamp,
			category: isBusinessRelevant ? "business" : "fact",
			tags: ["auto-logged", "worklog"],
			confidence: 0.7,
		});

		// 自动提取情景记忆（从有实质改动的worklog）
		const exp = extractExperienceFromWorklog({
			activity: entry.activity,
			changes: entry.changes,
			nextStep: entry.nextStep,
			step: entry.step,
			files: entry.files,
			status: entry.status,
			timestamp: entry.timestamp,
			sessionId: entry.sessionId,
		});
		if (exp) storeExperience(exp);
	} catch {
		// Knowledge sync failure should never break worklog
	}
}

function ensureDir(): void {
	if (!existsSync(WORKLOG_DIR)) mkdirSync(WORKLOG_DIR, { recursive: true });
	if (!existsSync(CHECKPOINT_DIR)) mkdirSync(CHECKPOINT_DIR, { recursive: true });
}

// ── Data types ─────────────────────────────────────────────────────

export interface WorklogEntry {
	timestamp: string;
	sessionId: string;
	activity: string;       // 当前正在做什么，一句话
	context?: string;       // 补充上下文（可选，1-2句话）
	step?: string;          // 所在的 plan step 或阶段
	files?: string[];       // 涉及的关键文件
	nextStep?: string;      // 下一步计划做什么
	changes?: string;        // 做了什么改动（摘要）
	checkpoint?: string;     // 备份 checkpoint ID
	status: "working" | "blocked" | "done" | "idle";
}

export interface WorklogState {
	current: WorklogEntry | null;
	lastSession: WorklogEntry | null;   // 上一轮的工作状态（断点快照）
}

interface WorklogParams {
	action: "log" | "snapshot" | "show" | "recover" | "clear" | "checkpoint" | "undo" | "history";
	activity?: string;
	context?: string;
	step?: string;
	files?: string[];
	nextStep?: string;
	changes?: string;
	checkpoint?: string;
	autoCheckpoint?: boolean;
	status?: "working" | "blocked" | "done" | "idle";
}

// ── Helpers ───────────────────────────────────────────────────────

function text(t: string) {
	return { type: "text" as const, text: t };
}

function genSessionId(): string {
	return `${process.pid}_${Date.now().toString(36)}`;
}

export function loadState(): WorklogState {
	ensureDir();
	if (!existsSync(WORKLOG_FILE)) {
		return { current: null, lastSession: null };
	}
	try {
		return JSON.parse(readFileSync(WORKLOG_FILE, "utf-8")) as WorklogState;
	} catch {
		return { current: null, lastSession: null };
	}
}

export function saveState(state: WorklogState): void {
	ensureDir();
	writeFileSync(WORKLOG_FILE, JSON.stringify(state, null, 2), "utf-8");
}

function appendHistory(entry: WorklogEntry): void {
	ensureDir();
	appendFileSync(HISTORY_FILE, JSON.stringify(entry) + "\n", "utf-8");
	trimHistory();
}

function trimHistory(): void {
	if (!existsSync(HISTORY_FILE)) return;
	const lines = readFileSync(HISTORY_FILE, "utf-8").split("\n").filter(Boolean);
	if (lines.length > MAX_HISTORY) {
		const trimmed = lines.slice(-MAX_HISTORY);
		writeFileSync(HISTORY_FILE, trimmed.join("\n") + "\n", "utf-8");
	}
}

// ── Checkpoint: file backup for rollback ────────────────────────────

function createCheckpointId(): string {
	const now = new Date();
	return `cp_${now.getHours().toString().padStart(2,"0")}${now.getMinutes().toString().padStart(2,"0")}${now.getSeconds().toString().padStart(2,"0")}`;
}

export function backupFiles(files: string[]): string {
	const cpId = createCheckpointId();
	const cpDir = join(CHECKPOINT_DIR, cpId);
	mkdirSync(cpDir, { recursive: true });

	const backedUp: string[] = [];
	for (const f of files) {
		const absPath = f.startsWith("/") ? f : join(process.cwd(), f);
		if (!existsSync(absPath)) continue;

		const relPath = f.startsWith("/") ? f.slice(1) : f;
		const destPath = join(cpDir, relPath);
		mkdirSync(join(destPath, ".."), { recursive: true });
		copyFileSync(absPath, destPath);
		backedUp.push(f);
	}

	// Write metadata
	writeFileSync(join(cpDir, ".checkpoint.json"), JSON.stringify({
		id: cpId,
		timestamp: new Date().toISOString(),
		files: backedUp,
	}, null, 2));

	cleanupOldCheckpoints();
	return cpId;
}

function cleanupOldCheckpoints(): void {
	if (!existsSync(CHECKPOINT_DIR)) return;
	try {
		const dirs = readdirSync(CHECKPOINT_DIR)
			.filter(f => f.startsWith("cp_"))
			.sort();
		while (dirs.length > MAX_CHECKPOINTS) {
			const oldest = dirs.shift()!;
			rmSync(join(CHECKPOINT_DIR, oldest), { recursive: true, force: true });
		}
	} catch { /* ignore */ }
}

function listCheckpoints(): Array<{id: string, timestamp: string, files: string[]}> {
	if (!existsSync(CHECKPOINT_DIR)) return [];
	const results: Array<{id: string, timestamp: string, files: string[]}> = [];
	try {
		const dirs = readdirSync(CHECKPOINT_DIR)
			.filter(f => f.startsWith("cp_"))
			.sort();
		for (const d of dirs) {
			const metaPath = join(CHECKPOINT_DIR, d, ".checkpoint.json");
			if (existsSync(metaPath)) {
				const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
				results.push({ id: d, timestamp: meta.timestamp, files: meta.files });
			}
		}
	} catch { /* ignore */ }
	return results.reverse(); // newest first
}

function restoreCheckpoint(cpId: string): string {
	const cpDir = join(CHECKPOINT_DIR, cpId);
	if (!existsSync(cpDir)) {
		return `❌ Checkpoint ${cpId} 不存在`;
	}
	const metaPath = join(cpDir, ".checkpoint.json");
	if (!existsSync(metaPath)) {
		return `❌ Checkpoint ${cpId} 元数据丢失`;
	}
	const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
	const restored: string[] = [];
	for (const f of meta.files) {
		const absPath = f.startsWith("/") ? f : join(process.cwd(), f);
		const srcPath = join(cpDir, f.startsWith("/") ? f.slice(1) : f);
		if (existsSync(srcPath)) {
			copyFileSync(srcPath, absPath);
			restored.push(f);
		}
	}
	return `✅ 已从 checkpoint ${cpId} 恢复 ${restored.length} 个文件:\n${restored.join("\n")}`;
}

// ── Format ──────────────────────────────────────────────────────────

function formatEntry(entry: WorklogEntry, label?: string): string {
	const lines: string[] = [];
	if (label) lines.push(`## ${label}`);
	lines.push(`🕐 ${entry.timestamp}`);
	lines.push(`📌 ${entry.activity}`);
	if (entry.changes) lines.push(`🔧 ${entry.changes}`);
	if (entry.checkpoint) lines.push(`💾 Checkpoint: ${entry.checkpoint}`);
	if (entry.context) lines.push(`   ${entry.context}`);
	if (entry.step) lines.push(`📍 Step: ${entry.step}`);
	if (entry.files && entry.files.length > 0) lines.push(`📁 Files: ${entry.files.join(", ")}`);
	if (entry.nextStep) lines.push(`➡️ Next: ${entry.nextStep}`);
	const statusIcon = entry.status === "working" ? "🔄" : entry.status === "blocked" ? "⛔" : entry.status === "done" ? "✅" : "💤";
	lines.push(`${statusIcon} Status: ${entry.status}`);
	return lines.join("\n");
}

// ── Export for identity injection ──────────────────────────────────

/**
 * Get last session's worklog for injection into identity prompt.
 * Returns a compact one-liner with changes and checkpoint info.
 */
export function getLastWorklog(): string {
	const state = loadState();
	// Fallback: on restart, lastSession may be null but current still has
	// the previous session's data (not yet migrated). Use whichever is available.
	const entry = state.lastSession || state.current;
	if (!entry) return "";
	const parts: string[] = [];
	parts.push(`LastWork: ${entry.activity}`);
	if (entry.changes) parts.push(`Changes: ${entry.changes}`);
	if (entry.checkpoint) parts.push(`Checkpoint: ${entry.checkpoint}`);
	if (entry.nextStep) parts.push(`NextStep: ${entry.nextStep}`);
	if (entry.step) parts.push(`Step: ${entry.step}`);
	if (entry.files && entry.files.length > 0) parts.push(`Files: ${entry.files.join(",")}`);

	return parts.join(" | ");
}

/**
 * Get last session's worklog in detail (for recover action).
 */
export function getLastWorklogDetail(): WorklogEntry | null {
	const state = loadState();
	return state.lastSession;
}

// ── Tool ───────────────────────────────────────────────────────────

export function createTool(_cwd: string): AgentTool<any> {
	return {
		name: "session-worklog",
		description:
			"会话工作日志+自动文件备份。log 自动备份涉及文件到 checkpoints，undo 列出/恢复 checkpoint，history 查看操作历史。修改代码前必须先 log，出错时用 undo 回退。",
		label: "session-worklog",

		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["log", "snapshot", "show", "recover", "clear", "checkpoint", "undo", "history"],
					description: "工作日志操作",
				},
				activity: {
					type: "string",
					description: "当前正在做什么（一句话）",
				},
				context: {
					type: "string",
					description: "补充上下文（可选）",
				},
				step: {
					type: "string",
					description: "所在的 plan step 或阶段",
				},
				files: {
					type: "array",
					items: { type: "string" },
					description: "涉及的关键文件（log时自动备份）",
				},
				changes: {
					type: "string",
					description: "做了什么代码改动（摘要，用于回退参考）",
				},
				nextStep: {
					type: "string",
					description: "下一步计划做什么",
				},
				autoCheckpoint: {
					type: "boolean",
					description: "是否自动备份涉及的文件（默认 true）",
				},
				checkpoint: {
					type: "string",
					description: "checkpoint ID（undo restore 时必填）",
				},
				status: {
					type: "string",
					enum: ["working", "blocked", "done", "idle"],
					description: "工作状态",
				},
			},
			required: ["action"],
		},

		execute: async (_callId: string, params: unknown) => {
			const p = params as WorklogParams;
			const state = loadState();

			switch (p.action) {
				case "log": {
					if (!p.activity) {
						return { content: [text("❌ activity 是必填项——你正在做什么？")], details: {} };
					}

					const entry: WorklogEntry = {
						timestamp: new Date().toISOString(),
						sessionId: state.current?.sessionId || genSessionId(),
						activity: p.activity,
						context: p.context,
						step: p.step,
						files: p.files,
						nextStep: p.nextStep,
						changes: p.changes,
						status: p.status || "working",
					};

					// Auto-backup files if specified (default: true)
					const shouldBackup = p.autoCheckpoint !== false;
					if (shouldBackup && p.files && p.files.length > 0) {
						const cpId = backupFiles(p.files);
						entry.checkpoint = cpId;
					}

					// Update current, archive old current to lastSession
					if (state.current && state.current.sessionId !== entry.sessionId) {
						state.lastSession = state.current;
						appendHistory(state.current);
					}
					state.current = entry;
					saveState(state);

					// Sync to session-context for identity injection
					syncFromWorklog(entry);

					let msg = `📝 已记录: ${p.activity}`;
					if (entry.checkpoint) msg += ` [💾 ${entry.checkpoint}]`;
					if (p.changes) msg += `\n🔧 ${p.changes}`;
					if (p.nextStep) msg += `\n➡️ Next: ${p.nextStep}`;


				// Auto-sync to knowledge base — only on completion/blocked, not every working log
				if (entry.status === "done" || entry.status === "blocked") {
					autoSyncToKnowledge(entry);
				}
					return { content: [text(msg)], details: {} };
				}

				case "snapshot": {
					if (!state.current) {
						return { content: [text("⚠️ 没有当前工作记录，无法保存快照。")], details: {} };
					}

					const snapshot: WorklogEntry = {
						...state.current,
						timestamp: new Date().toISOString(),
					};

					state.lastSession = snapshot;
					appendHistory(snapshot);
					saveState(state);

					return {
						content: [text(`💾 断点快照已保存:\n${formatEntry(snapshot, "Breakpoint Snapshot")}`)],
						details: {},
					};
				}

				case "show": {
					const parts: string[] = [];

					// Staleness helper
					const warnIfStale = (entry: WorklogEntry, label: string) => {
						const ageMs = Date.now() - new Date(entry.timestamp).getTime();
						if (entry.status !== "done" && entry.status !== "idle" && ageMs > 2 * 60 * 60 * 1000) {
							parts.push(`⚠️ ${label} 记录已过 ${Math.round(ageMs / 3600000)}h，可能过时。如不对请 log 新内容。`);
						}
					};

					if (state.lastSession) {
						warnIfStale(state.lastSession, "上一轮");
						parts.push(formatEntry(state.lastSession, "上一轮工作（断点）"));
					} else {
						parts.push("📭 无上一轮工作记录");
					}

					parts.push("");

					if (state.current) {
						warnIfStale(state.current, "当前");
						parts.push(formatEntry(state.current, "当前会话"));
					} else {
						parts.push("💤 当前无活跃工作记录");
					}

					return { content: [text(parts.join("\n"))], details: {} };
				}

				case "recover": {
					if (!state.lastSession) {
						return { content: [text("📭 无上一轮工作记录，无法恢复。")], details: {} };
					}

					const entry = state.lastSession;
					const parts: string[] = [];
					parts.push("## 🔄 断点恢复信息");
					parts.push("");
					parts.push(`**上次工作**: ${entry.activity}`);
					if (entry.changes) parts.push(`**改动**: ${entry.changes}`);
					if (entry.checkpoint) parts.push(`**Checkpoint**: ${entry.checkpoint} (可用 undo action=undo checkpoint=${entry.checkpoint} 恢复文件)`);
					if (entry.context) parts.push(`**上下文**: ${entry.context}`);
					if (entry.step) parts.push(`**阶段**: ${entry.step}`);
					if (entry.files && entry.files.length > 0) parts.push(`**涉及文件**: ${entry.files.join(", ")}`);
					if (entry.nextStep) parts.push(`**下一步**: ${entry.nextStep}`);
					parts.push(`**时间**: ${entry.timestamp}`);
					parts.push(`**状态**: ${entry.status}`);
					parts.push("");
					parts.push("💡 建议从这里继续。");

					return { content: [text(parts.join("\n"))], details: {} };
				}

				case "checkpoint": {
					// Manual checkpoint: backup specified files
					const files = p.files || [];
					if (files.length === 0) {
						// List available checkpoints
						const cps = listCheckpoints();
						if (cps.length === 0) {
							return { content: [text("📭 没有可用的 checkpoint。")], details: {} };
						}
						const lines = cps.map((cp, i) =>
							`${i + 1}. **${cp.id}** (${cp.timestamp.slice(11, 19)}) → ${cp.files.join(", ")}`
						);
						return { content: [text(`📦 可用 checkpoint:\n${lines.join("\n")}`)], details: {} };
					}

					const cpId = backupFiles(files);
					return {
						content: [text(`💾 手动备份完成: ${cpId}\n📁 ${files.join(", ")}`)],
						details: {},
					};
				}

				case "undo": {
					if (p.checkpoint) {
						// Restore specific checkpoint
						const result = restoreCheckpoint(p.checkpoint);
						return { content: [text(result)], details: {} };
					}

					// List checkpoints for user to pick
					const cps = listCheckpoints();
					if (cps.length === 0) {
						return { content: [text("📭 没有可回退的 checkpoint。")], details: {} };
					}

					// Also show last session's checkpoint if any
					const parts: string[] = [];
					parts.push("📦 可回退的 checkpoint（最新在前）:");
					parts.push("");
					parts.push("恢复命令: `session-worklog action=undo checkpoint=<ID>`");
					parts.push("");
					for (const cp of cps) {
						parts.push(`**${cp.id}** (${cp.timestamp.slice(11, 19)})`);
						for (const f of cp.files) {
							parts.push(`  - ${f}`);
						}
						parts.push("");
					}

					// Also check history for checkpoint references
					if (state.lastSession?.checkpoint) {
						parts.push(`📌 上一轮的 checkpoint: ${state.lastSession.checkpoint}`);
					}

					return { content: [text(parts.join("\n"))], details: {} };
				}

				case "history": {
					if (!existsSync(HISTORY_FILE)) {
						return { content: [text("📭 无操作历史。")], details: {} };
					}
					const lines = readFileSync(HISTORY_FILE, "utf-8").split("\n").filter(Boolean);
					if (lines.length === 0) {
						return { content: [text("📭 无操作历史。")], details: {} };
					}

					// Show last 20 entries
					const recent = lines.slice(-20).map((l, i) => {
					try {
						const e = JSON.parse(l) as WorklogEntry;
						const time = e.timestamp.slice(11, 19);
						const icon = e.status === "done" ? "✅" : e.status === "blocked" ? "⛔" : "🔄";
						let summary = `${icon} ${time} ${e.activity}`;
						if (e.changes) summary += ` | ${e.changes}`;
						if (e.checkpoint) summary += ` [${e.checkpoint}]`;
						return summary;
						} catch {
							return l;
						}
					});

					return {
						content: [text(`📋 最近 ${recent.length} 条操作历史:\n${recent.join("\n")}`)],
						details: {},
					};
				}

				case "clear": {
					if (state.current) {
						appendHistory(state.current);
					}
					state.current = null;
					state.lastSession = null;
					saveState(state);
					return { content: [text("🗑️ 工作日志已清除（历史保留在归档中）。")], details: {} };
				}

				default:
					return { content: [text(`未知操作: ${p.action}`)], details: {} };
			}
		},
	};
}
