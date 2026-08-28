/**
 * execution-tracker — 追踪 plan step 的工具调用链，记录结果，支持失败回退。
 *
 * 存储位置: ~/.novus/execution-tracker/log.jsonl（每行一条记录）
 * 与 plan.ts 配合使用：plan complete 时自动记录步骤结果。
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TRACKER_DIR = join(homedir(), ".novus", "execution-tracker");
const LOG_FILE = join(TRACKER_DIR, "log.jsonl");
const STATE_FILE = join(TRACKER_DIR, "state.json");
const MAX_LOG_ENTRIES = 500;

function ensureDir(): void {
	if (!existsSync(TRACKER_DIR)) mkdirSync(TRACKER_DIR, { recursive: true });
}

// ── Data types ─────────────────────────────────────────────────────

interface ExecutionEntry {
	id: string;
	timestamp: string;
	planStep: number;
	toolName: string;
	input: Record<string, unknown>;
	output: Record<string, unknown>;
	status: "success" | "error";
	duration?: number;
	error?: string;
}

interface ExecutionState {
	currentStep: number | null;
	toolCalls: ExecutionEntry[];
	startedAt: string | null;
}

interface TrackerParams {
	action: "start" | "log" | "complete" | "rollback" | "show" | "history" | "clear";
	planStep?: number;
	toolName?: string;
	input?: Record<string, unknown>;
	output?: Record<string, unknown>;
	status?: "success" | "error";
	duration?: number;
	error?: string;
	limit?: number;
}

// ── Helpers ───────────────────────────────────────────────────────

function text(t: string) {
	return { type: "text" as const, text: t };
}

function genId(): string {
	return `et_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function loadState(): ExecutionState {
	ensureDir();
	if (!existsSync(STATE_FILE)) {
		return { currentStep: null, toolCalls: [], startedAt: null };
	}
	try {
		return JSON.parse(readFileSync(STATE_FILE, "utf-8")) as ExecutionState;
	} catch {
		return { currentStep: null, toolCalls: [], startedAt: null };
	}
}

function saveState(state: ExecutionState): void {
	ensureDir();
	writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

function appendLog(entry: ExecutionEntry): void {
	ensureDir();
	appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n", "utf-8");
	// Rotate log if too large
	rotateLogIfNeeded();
}

function rotateLogIfNeeded(): void {
	if (!existsSync(LOG_FILE)) return;
	const lines = readFileSync(LOG_FILE, "utf-8").split("\n").filter(Boolean);
	if (lines.length > MAX_LOG_ENTRIES) {
		const trimmed = lines.slice(lines.length - MAX_LOG_ENTRIES);
		writeFileSync(LOG_FILE, trimmed.join("\n") + "\n", "utf-8");
	}
}

function readLog(limit: number = 20): ExecutionEntry[] {
	ensureDir();
	if (!existsSync(LOG_FILE)) return [];
	const lines = readFileSync(LOG_FILE, "utf-8").split("\n").filter(Boolean);
	const trimmed = lines.slice(-limit);
	return trimmed.map((l) => {
		try { return JSON.parse(l) as ExecutionEntry; } catch { return null; }
	}).filter(Boolean) as ExecutionEntry[];
}

// ── Format ─────────────────────────────────────────────────────────

function formatState(state: ExecutionState): string {
	if (!state.currentStep) {
		return "No active execution tracking.";
	}
	const lines = [
		`📊 Tracking Step ${state.currentStep}`,
		`   Started: ${state.startedAt || "unknown"}`,
		`   Tool calls: ${state.toolCalls.length}`,
	];
	for (const call of state.toolCalls) {
		const icon = call.status === "success" ? "✓" : "✗";
		lines.push(`   ${icon} ${call.toolName}${call.error ? ` — ${call.error}` : ""}`);
	}
	return lines.join("\n");
}

function formatHistory(entries: ExecutionEntry[]): string {
	if (entries.length === 0) return "No execution history.";
	const lines = ["📜 Execution History (recent)", ""];
	for (const entry of entries.reverse()) {
		const icon = entry.status === "success" ? "✓" : "✗";
		lines.push(`${icon} [${entry.timestamp}] step#${entry.planStep} → ${entry.toolName}${entry.error ? ` — ${entry.error}` : ""}`);
	}
	return lines.join("\n");
}

// ── Tool ───────────────────────────────────────────────────────────

export function createTool(_cwd: string): AgentTool<any> {
	return {
		name: "execution-tracker",
		description:
			"Plan execution tracker: records tool calls per plan step, supports failure rollback. Actions: start (begin tracking a step), log (record a tool call result), complete (finish step successfully), rollback (undo current step), show (current tracking state), history (past entries), clear (reset).",
		label: "execution-tracker",

		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["start", "log", "complete", "rollback", "show", "history", "clear"],
					description: "Tracker action",
				},
				planStep: { type: "number", description: "Plan step number (for start/log/complete)" },
				toolName: { type: "string", description: "Tool name being called (for log)" },
				input: { type: "object", description: "Tool input params (for log)" },
				output: { type: "object", description: "Tool output result (for log)" },
				status: { type: "string", enum: ["success", "error"], description: "Tool call status (for log)" },
				duration: { type: "number", description: "Duration in ms (for log)" },
				error: { type: "string", description: "Error message if failed (for log)" },
				limit: { type: "number", description: "Max history entries to show (for history, default 20)" },
			},
			required: ["action"],
		},

		execute: async (_callId: string, params: unknown) => {
			const p = params as TrackerParams;

			switch (p.action) {
				case "start": {
					if (!p.planStep) {
						return { content: [text("Error: planStep is required for start.")], details: {} };
					}
					const state = loadState();
					if (state.currentStep) {
						return {
							content: [text(`Already tracking step ${state.currentStep}. Complete or rollback first.\n\n` + formatState(state))],
							details: {},
						};
					}
					state.currentStep = p.planStep;
					state.toolCalls = [];
					state.startedAt = new Date().toISOString();
					saveState(state);
					return { content: [text(`🎯 Started tracking Step ${p.planStep}`)], details: {} };
				}

				case "log": {
					if (!p.toolName || !p.status) {
						return { content: [text("Error: toolName and status are required for log.")], details: {} };
					}
					const state = loadState();
					if (!state.currentStep) {
						return { content: [text("No active tracking session. Use 'start' first.")], details: {} };
					}

					const entry: ExecutionEntry = {
						id: genId(),
						timestamp: new Date().toISOString(),
						planStep: state.currentStep,
						toolName: p.toolName,
						input: p.input || {},
						output: p.output || {},
						status: p.status,
						duration: p.duration,
						error: p.error,
					};

					state.toolCalls.push(entry);
					saveState(state);
					appendLog(entry);

					const icon = entry.status === "success" ? "✓" : "✗";
					return {
						content: [text(`${icon} Logged: ${p.toolName} → ${p.status} (step ${state.currentStep}, ${state.toolCalls.length} calls total)`)],
						details: {},
					};
				}

				case "complete": {
					const state = loadState();
					if (!state.currentStep) {
						return { content: [text("No active tracking session to complete.")], details: {} };
					}
					const step = state.currentStep;
					const calls = state.toolCalls.length;
					const errors = state.toolCalls.filter((c) => c.status === "error").length;
					state.currentStep = null;
					state.toolCalls = [];
					state.startedAt = null;
					saveState(state);
					return {
						content: [text(`✅ Step ${step} tracking complete. ${calls} tool calls, ${errors} errors.`)],
						details: {},
					};
				}

				case "rollback": {
					const state = loadState();
					if (!state.currentStep) {
						return { content: [text("No active tracking session to rollback.")], details: {} };
					}
					const step = state.currentStep;
					const calls = state.toolCalls.length;
					// Log rollback event
					const entry: ExecutionEntry = {
						id: genId(),
						timestamp: new Date().toISOString(),
						planStep: step,
						toolName: "rollback",
						input: {},
						output: {},
						status: "error",
						error: `Rolled back step ${step} (${calls} tool calls undone)`,
					};
					appendLog(entry);
					state.currentStep = null;
					state.toolCalls = [];
					state.startedAt = null;
					saveState(state);
					return {
						content: [text(`⏪ Step ${step} rolled back. ${calls} tool calls discarded.`)],
						details: {},
					};
				}

				case "show": {
					const state = loadState();
					return { content: [text(formatState(state))], details: {} };
				}

				case "history": {
					const entries = readLog(p.limit || 20);
					return { content: [text(formatHistory(entries))], details: {} };
				}

				case "clear": {
					const state = loadState();
					state.currentStep = null;
					state.toolCalls = [];
					state.startedAt = null;
					saveState(state);
					if (existsSync(LOG_FILE)) unlinkSync(LOG_FILE);
					return { content: [text("Execution tracker cleared.")], details: {} };
				}

				default:
					return { content: [text(`Unknown action: ${p.action}`)], details: {} };
			}
		},
	};
}
