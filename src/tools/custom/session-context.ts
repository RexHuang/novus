/**
 * session-context — 会话上下文持久化，解决异常退出时记忆丢失。
 *
 * 核心原则：边做边存，不依赖退出时保存。
 *
 * 设计：
 *   1. 独立文件 ~/.novus/session-context.json（最新上下文）
 *   2. update 时直接覆盖写入，原子性由 writeFileSync 保证
 *   3. 每次有意义的工作推进后调用 update，把"做什么+做到哪+下一步"写入
 *   4. identity 注入时自动读取，下轮一开头就能看到
 *   5. session-worklog 的 log 动作会自动调用 syncFromWorklog
 *
 * 与 session-worklog 的区别：
 *   - worklog: 详细的操作日志 + 文件备份 + checkpoint
 *   - context: 最后一句话的"我在做什么，下一步做什么"
 *   - context 是 worklog 的精简投影，永远有值
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const NOVUS_DIR = join(homedir(), ".novus");
const CONTEXT_FILE = join(NOVUS_DIR, "session-context.json");

// ── Data types ─────────────────────────────────────────────────────

export interface SessionContext {
	/** 最后一句话：我在做什么 */
	activity: string;
	/** 补充上下文（可选） */
	detail?: string;
	/** 做到了哪一步 / 阶段 */
	step?: string;
	/** 涉及的文件 */
	files?: string[];
	/** 下一步计划 */
	nextStep?: string;
	/** 当前状态 */
	status?: "working" | "blocked" | "done" | "idle";
	/** 时间戳 */
	timestamp: string;
}

// ── Core operations ────────────────────────────────────────────────

function ensureDir(): void {
	if (!existsSync(NOVUS_DIR)) mkdirSync(NOVUS_DIR, { recursive: true });
}

export function loadContext(): SessionContext | null {
	if (!existsSync(CONTEXT_FILE)) return null;
	try {
		return JSON.parse(readFileSync(CONTEXT_FILE, "utf-8")) as SessionContext;
	} catch {
		return null;
	}
}

export function saveContext(ctx: SessionContext): void {
	ensureDir();
	writeFileSync(CONTEXT_FILE, JSON.stringify(ctx, null, 2), "utf-8");
}

export function clearContext(): void {
	if (existsSync(CONTEXT_FILE)) {
		writeFileSync(CONTEXT_FILE, "{}", "utf-8");
	}
}

/**
 * 从 worklog entry 同步到 context。
 * session-worklog 的 log 动作会自动调用这个。
 */
export function syncFromWorklog(worklog: {
	activity: string;
	context?: string;
	step?: string;
	files?: string[];
	nextStep?: string;
	changes?: string;
	status?: "working" | "blocked" | "done" | "idle";
}): void {
	const ctx: SessionContext = {
		activity: worklog.activity,
		detail: worklog.context || worklog.changes,
		step: worklog.step,
		files: worklog.files,
		nextStep: worklog.nextStep,
		status: worklog.status,
		timestamp: new Date().toISOString(),
	};
	saveContext(ctx);
}

/**
 * 用于 identity 注入：返回一行上下文摘要。
 * 如果 context 为空或太旧（>24h），返回 null。
 */
export function getContextSummary(): string | null {
	const ctx = loadContext();
	if (!ctx || !ctx.activity) return null;

	// 超过24小时的上下文可能已经过时
	const ageMs = Date.now() - new Date(ctx.timestamp).getTime();
	if (ageMs > 24 * 60 * 60 * 1000) return null;

	const parts: string[] = [];
	parts.push(ctx.activity);
	if (ctx.detail) parts.push(`(${ctx.detail})`);
	if (ctx.step) parts.push(`[step: ${ctx.step}]`);
	if (ctx.files && ctx.files.length > 0) {
		const fileStr = ctx.files.length <= 3
			? ctx.files.join(",")
			: ctx.files.slice(0, 3).join(",") + ` +${ctx.files.length - 3}`;
		parts.push(`files: ${fileStr}`);
	}
	if (ctx.nextStep) parts.push(`→ ${ctx.nextStep}`);

	const statusIcon = ctx.status === "working" ? "🔄" : ctx.status === "blocked" ? "⛔" : ctx.status === "done" ? "✅" : "";
	return `${statusIcon} ${parts.join(" | ")}`;
}

/**
 * 扩展上下文：如果有活跃项目，追加项目进度摘要。
 * 在 identity 注入时调用。
 */
export function getExtendedContextSummary(): string {
	const sessionSummary = getContextSummary();
	let result = "";
	if (sessionSummary) result += `LastWork: ${sessionSummary}\n`;

	// 注入活跃项目的上下文
	try {
		const { getActiveProject, projectContextSummary } = require("../../project-memory.js");
		const active = getActiveProject();
		if (active) {
			result += projectContextSummary(active.slug);
		}
	} catch {
		// project-memory 不可用时静默跳过
	}
	return result;
}

// ── Tool ─────────────────────────────────────────────────────────

function text(t: string) {
	return { type: "text" as const, text: t };
}

interface ContextParams {
	action: "update" | "show" | "clear";
	activity?: string;
	detail?: string;
	step?: string;
	files?: string[];
	nextStep?: string;
	status?: "working" | "blocked" | "done";
}

export function createTool(_cwd: string): AgentTool<any> {
	return {
		name: "session-context",
		description:
			"会话上下文持久化。update 写入当前工作进度（做什么、做到哪、下一步），下次会话自动恢复。异常退出也能记住。每次推进工作时调用一次。",
		label: "session-context",

		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["update", "show", "clear"],
					description: "操作类型",
				},
				activity: {
					type: "string",
					description: "我在做什么（一句话，必填 for update）",
				},
				detail: {
					type: "string",
					description: "补充上下文（可选）",
				},
				step: {
					type: "string",
					description: "当前步骤/阶段（可选）",
				},
				files: {
					type: "array",
					items: { type: "string" },
					description: "涉及的文件（可选）",
				},
				nextStep: {
					type: "string",
					description: "下一步计划（可选）",
				},
				status: {
					type: "string",
					enum: ["working", "blocked", "done"],
					description: "状态（可选）",
				},
			},
			required: ["action"],
		},

		execute: async (_callId: string, params: unknown) => {
			const p = params as ContextParams;

			switch (p.action) {
				case "update": {
					if (!p.activity) {
						return { content: [text("❌ activity 是必填项——你在做什么？")], details: {} };
					}

					const ctx: SessionContext = {
						activity: p.activity,
						detail: p.detail,
						step: p.step,
						files: p.files,
						nextStep: p.nextStep,
						status: p.status,
						timestamp: new Date().toISOString(),
					};
					saveContext(ctx);

					const parts: string[] = [`💾 已保存: ${p.activity}`];
					if (p.step) parts.push(`📍 Step: ${p.step}`);
					if (p.nextStep) parts.push(`➡️ Next: ${p.nextStep}`);
					if (p.files?.length) parts.push(`📁 Files: ${p.files.join(", ")}`);
					return { content: [text(parts.join("\n"))], details: {} };
				}

				case "show": {
					const ctx = loadContext();
					if (!ctx || !ctx.activity) {
						return { content: [text("📭 无上下文记录。")], details: {} };
					}

					// Staleness detection: warn if unfinished and >2 hours old
					const ageMs = Date.now() - new Date(ctx.timestamp).getTime();
					const isStale = ctx.status !== "done" && ageMs > 2 * 60 * 60 * 1000;
					const staleWarning = isStale
						? `⚠️ 记录已过 ${Math.round(ageMs / 3600000)}h，可能过时。如不对请 update。\n`
						: "";

					const parts: string[] = [];
					if (staleWarning) parts.push(staleWarning);
					parts.push(`📌 ${ctx.activity}`);
					if (ctx.detail) parts.push(`   ${ctx.detail}`);
					if (ctx.step) parts.push(`📍 Step: ${ctx.step}`);
					if (ctx.files?.length) parts.push(`📁 ${ctx.files.join(", ")}`);
					if (ctx.nextStep) parts.push(`➡️ Next: ${ctx.nextStep}`);
					const icon = ctx.status === "working" ? "🔄" : ctx.status === "blocked" ? "⛔" : ctx.status === "done" ? "✅" : "💤";
					parts.push(`${icon} ${ctx.status || "unknown"} | ${ctx.timestamp}`);
					return { content: [text(parts.join("\n"))], details: {} };
				}

				case "clear": {
					clearContext();
					return { content: [text("🗑️ 上下文已清除。")], details: {} };
				}

				default:
					return { content: [text(`未知操作: ${p.action}`)], details: {} };
			}
		},
	};
}
