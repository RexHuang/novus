/**
 * session-context — session context persistence; survives abnormal exits.
 *
 * Core principle: save as you go, don't rely on saving at exit.
 *
 * Design:
 *   1. standalone file ~/.novus/session-context.json (latest context)
 *   2. update overwrites directly; atomicity via writeFileSync
 *   3. call update after each meaningful work step — writes what/where/next
 *   4. identity reads it automatically at injection — visible at the start of next turn
 *   5. session-worklog's log action auto-calls syncFromWorklog
 *
 * Difference from session-worklog:
 *   - worklog: detailed operation log + file backup + checkpoints
 *   - context: the last word on "what I'm doing, what's next"
 *   - context is a lean projection of worklog, always populated
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const NOVUS_DIR = join(homedir(), ".novus");
const CONTEXT_FILE = join(NOVUS_DIR, "session-context.json");

// ── Data types ─────────────────────────────────────────────────────

export interface SessionContext {
	/** the last word: what I'm doing */
	activity: string;
	/** extra context (optional) */
	detail?: string;
	/** which step/phase we're at */
	step?: string;
	/** files involved */
	files?: string[];
	/** next step plan */
	nextStep?: string;
	/** current status */
	status?: "working" | "blocked" | "done" | "idle";
	/** timestamp */
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
 * Sync from a worklog entry into context.
 * Called automatically by session-worklog's log action.
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
 * For identity injection: returns a one-line context summary.
 * Returns null if context is empty or stale (>24h).
 */
export function getContextSummary(): string | null {
	const ctx = loadContext();
	if (!ctx || !ctx.activity) return null;

	// context older than 24h may be stale
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
 * Extended context: append active project progress if any.
 * Called during identity injection.
 */
export function getExtendedContextSummary(): string {
	const sessionSummary = getContextSummary();
	let result = "";
	if (sessionSummary) result += `LastWork: ${sessionSummary}\n`;

	// inject active project context
	try {
		const { getActiveProject, projectContextSummary } = require("../../project-memory.js");
		const active = getActiveProject();
		if (active) {
			result += projectContextSummary(active.slug);
		}
	} catch {
		// silently skip if project-memory is unavailable
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
			"Session context persistence. update writes current work progress (what, where, next) and restores it in the next session — even after an abnormal exit. Call once per work session.",
		label: "session-context",

		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["update", "show", "clear"],
					description: "Action type",
				},
				activity: {
					type: "string",
					description: "What I'm doing (one sentence, required for update)",
				},
				detail: {
					type: "string",
					description: "Extra context (optional)",
				},
				step: {
					type: "string",
					description: "Current step/phase (optional)",
				},
				files: {
					type: "array",
					items: { type: "string" },
					description: "Files involved (optional)",
				},
				nextStep: {
					type: "string",
					description: "Next step plan (optional)",
				},
				status: {
					type: "string",
					enum: ["working", "blocked", "done"],
					description: "Status (optional)",
				},
			},
			required: ["action"],
		},

		execute: async (_callId: string, params: unknown) => {
			const p = params as ContextParams;

			switch (p.action) {
				case "update": {
					if (!p.activity) {
						return { content: [text("❌ activity is required — what are you working on?")], details: {} };
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

					const parts: string[] = [`💾 Saved: ${p.activity}`];
					if (p.step) parts.push(`📍 Step: ${p.step}`);
					if (p.nextStep) parts.push(`➡️ Next: ${p.nextStep}`);
					if (p.files?.length) parts.push(`📁 Files: ${p.files.join(", ")}`);
					return { content: [text(parts.join("\n"))], details: {} };
				}

				case "show": {
					const ctx = loadContext();
					if (!ctx || !ctx.activity) {
						return { content: [text("📭 No context on record.")], details: {} };
					}

					// Staleness detection: warn if unfinished and >2 hours old
					const ageMs = Date.now() - new Date(ctx.timestamp).getTime();
					const isStale = ctx.status !== "done" && ageMs > 2 * 60 * 60 * 1000;
					const staleWarning = isStale
						? `⚠️ Entry is ${Math.round(ageMs / 3600000)}h old, may be stale. update if wrong.\n`
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
					return { content: [text("🗑️ Context cleared.")], details: {} };
				}

				default:
					return { content: [text(`Unknown action: ${p.action}`)], details: {} };
			}
		},
	};
}
