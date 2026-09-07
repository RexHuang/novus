/**
 * Chain Orchestrator
 *
 * Fifth evolution: turn Smart Router's recommended chain into an auto-executable plan.
 * Responsibilities:
 * 1. take the router's ToolChain → build an execution plan
 * 2. inject into the system prompt so the LLM sees the recommended steps
 * 3. track per-step status (pending/done/skipped/error)
 * 4. emit a summary when the chain finishes
 */

import type { ToolChain } from "./router.js";

// ── Types ──────────────────────────────────────────────────────────

export type StepStatus = "pending" | "active" | "done" | "skipped" | "error";

export interface ChainStep {
	tool: string;
	intent: string;
	description: string;
	optional: boolean;
	status: StepStatus;
	result?: string;       // short result after execution
	duration?: number;     // ms
}

export interface ChainExecution {
	id: string;
	chain: string;
	input: string;          // trigger input
	steps: ChainStep[];
	startedAt: number;
	completedAt?: number;
	status: "running" | "completed" | "failed";
}

// ── Orchestrator ────────────────────────────────────────────────────

export class ChainOrchestrator {
	private executions: Map<string, ChainExecution> = new Map();
	private static readonly MAX_EXECUTIONS = 10;

	/**
	 * Start a chain execution
	 */
	start(chain: ToolChain, input: string): ChainExecution {
		this.prune();

		const id = `chain_${Date.now().toString(36)}`;
		const execution: ChainExecution = {
			id,
			chain: chain.name,
			input,
			steps: chain.steps.map((s) => ({
				tool: s.tool,
				intent: s.intent,
				description: s.description,
				optional: s.optional ?? false,
				status: "pending",
			})),
			startedAt: Date.now(),
			status: "running",
		};

		this.executions.set(id, execution);
		return execution;
	}

	/**
	 * Mark a step as started
	 */
	beginStep(execId: string, stepIndex: number): boolean {
		const exec = this.executions.get(execId);
		if (!exec || stepIndex < 0 || stepIndex >= exec.steps.length) return false;
		if (exec.steps[stepIndex]!.status !== "pending") return false;
		exec.steps[stepIndex]!.status = "active";
		return true;
	}

	/**
	 * Mark a step as done
	 */
	completeStep(execId: string, stepIndex: number, result: string, duration: number): boolean {
		const exec = this.executions.get(execId);
		if (!exec || stepIndex < 0 || stepIndex >= exec.steps.length) return false;
		exec.steps[stepIndex]!.status = "done";
		exec.steps[stepIndex]!.result = result.slice(0, 200);
		exec.steps[stepIndex]!.duration = duration;
		return true;
	}

	/**
	 * Skip an optional step
	 */
	skipStep(execId: string, stepIndex: number, reason: string): boolean {
		const exec = this.executions.get(execId);
		if (!exec || stepIndex < 0 || stepIndex >= exec.steps.length) return false;
		exec.steps[stepIndex]!.status = "skipped";
		exec.steps[stepIndex]!.result = reason.slice(0, 200);
		return true;
	}

	/**
	 * Mark a step as failed
	 */
	failStep(execId: string, stepIndex: number, error: string): boolean {
		const exec = this.executions.get(execId);
		if (!exec || stepIndex < 0 || stepIndex >= exec.steps.length) return false;
		exec.steps[stepIndex]!.status = "error";
		exec.steps[stepIndex]!.result = error.slice(0, 200);
		exec.status = "failed";
		return true;
	}

	/**
	 * Complete the whole chain execution
	 */
	complete(execId: string): boolean {
		const exec = this.executions.get(execId);
		if (!exec) return false;
		exec.completedAt = Date.now();
		exec.status = "completed";
		return true;
	}

	/**
	 * Get the current execution status
	 */
	get(execId: string): ChainExecution | null {
		return this.executions.get(execId) ?? null;
	}

	/**
	 * Get the currently active (running) execution
	 */
	getActive(): ChainExecution | null {
		for (const exec of this.executions.values()) {
			if (exec.status === "running") return exec;
		}
		return null;
	}

	/**
	 * Generate the hint text injected into the system prompt
	 * so the LLM sees the chain steps currently executing
	 */
	getPromptInjection(): string {
		const active = this.getActive();
		if (!active) return "";

		const statusIcons: Record<StepStatus, string> = {
			pending: "⬜",
			active: "🔄",
			done: "✅",
			skipped: "⏭️",
			error: "❌",
		};

		const lines = active.steps.map((s, i) =>
			`${statusIcons[s.status]} Step ${i + 1}: ${s.description} [${s.tool}]${s.status === "done" && s.result ? ` → ${s.result}` : ""}`
		);

		const elapsed = Date.now() - active.startedAt;
		return `\n\n## 🔗 Chain executing: ${active.chain}\n${lines.join("\n")}\nelapsed: ${(elapsed / 1000).toFixed(1)}s\n`;
	}

	/**
	 * Generate an execution summary
	 */
	getSummary(execId: string): string {
		const exec = this.executions.get(execId);
		if (!exec) return "execution record not found";

		const done = exec.steps.filter((s) => s.status === "done").length;
		const skipped = exec.steps.filter((s) => s.status === "skipped").length;
		const errors = exec.steps.filter((s) => s.status === "error").length;
		const totalDuration = exec.steps.reduce((sum, s) => sum + (s.duration ?? 0), 0);

		const statusStr = exec.status === "completed" ? "✅ completed"
			: exec.status === "failed" ? "❌ failed"
			: "🔄 in progress";

		return [
			`chain: ${exec.chain} ${statusStr}`,
			`steps: ${done}/${exec.steps.length} done${skipped > 0 ? `, ${skipped} skipped` : ""}${errors > 0 ? `, ${errors} errors` : ""}`,
			`total time: ${(totalDuration / 1000).toFixed(1)}s`,
			exec.status === "completed" && exec.completedAt
				? `total run: ${((exec.completedAt - exec.startedAt) / 1000).toFixed(1)}s`
				: "",
		].filter(Boolean).join("\n");
	}

	/**
	 * Evict stale execution records
	 */
	private prune(): void {
		if (this.executions.size < ChainOrchestrator.MAX_EXECUTIONS) return;
		// remove the oldest completed executions
		const sorted = [...this.executions.entries()]
			.filter((entry: [string, ChainExecution]) => entry[1].status !== "running")
			.sort((a: [string, ChainExecution], b: [string, ChainExecution]) => a[1].startedAt - b[1].startedAt);

		for (let i = 0; i < Math.min(sorted.length, 3); i++) {
			this.executions.delete(sorted[i]![0]);
		}
	}

	/**
	 * Clear all records
	 */
	clear(): void {
		this.executions.clear();
	}
}

// ── Singleton ──────────────────────────────────────────────────────────

let orchestratorInstance: ChainOrchestrator | null = null;

export function getOrchestrator(): ChainOrchestrator {
	if (!orchestratorInstance) {
		orchestratorInstance = new ChainOrchestrator();
	}
	return orchestratorInstance;
}

// ── Agent Tool export ───────────────────────────────────────────────

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { matchToolChain } from "./router.js";

export function createTool(_cwd: string): AgentTool<any> {
	return {
		name: "chain-orchestrator",
		description: `Chain orchestrator — manages tool chain execution lifecycle. Actions:
- start: start a tool chain (auto-matched via router)
- status: view active chain execution status
- summary: get a summary of a completed chain
- list: list all execution records
- clear: clear execution history`,
		label: "Chain Orchestrator",
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["start", "status", "summary", "list", "clear"],
					description: "Action type",
				},
				input: {
					type: "string",
					description: "User input (required for start, used to match a chain)",
				},
				execId: {
					type: "string",
					description: "Execution ID (optional, for summary)",
				},
			},
			required: ["action"],
		},
		execute: async (toolCallId, params) => {
			const p = params as { action: string; input?: string; execId?: string };
			const orch = getOrchestrator();

			switch (p.action) {
				case "start": {
					if (!p.input) {
						return { content: [{ type: "text", text: "Missing input param" }], details: {} };
					}
					const chain = matchToolChain(p.input);
					if (!chain) {
						return { content: [{ type: "text", text: "No chain matched. Use smart-router action=route to see available chains." }], details: {} };
					}
					const exec = orch.start(chain, p.input);
					return {
						content: [{ type: "text", text: `Chain [${chain.name}] started (ID: ${exec.id})\n${exec.steps.map((s, i) => `  ${i + 1}. ${s.description} [${s.tool}]${s.optional ? " (optional)" : ""}`).join("\n")}` }],
						details: { execId: exec.id, chain: chain.name },
					};
				}

				case "status": {
					const active = orch.getActive();
					if (!active) {
						return { content: [{ type: "text", text: "no active tool chain" }], details: {} };
					}
					const lines = active.steps.map((s, i) => {
						const icon = s.status === "done" ? "✅" : s.status === "active" ? "🔄" : s.status === "skipped" ? "⏭️" : s.status === "error" ? "❌" : "⬜";
						return `${icon} ${i + 1}. ${s.description} [${s.tool}]${s.result ? ` → ${s.result}` : ""}`;
					});
					return {
						content: [{ type: "text", text: `chain: ${active.chain} (ID: ${active.id})\n${lines.join("\n")}\nelapsed: ${((Date.now() - active.startedAt) / 1000).toFixed(1)}s` }],
						details: { execId: active.id },
					};
				}

				case "summary": {
					const id = p.execId ?? orch.getActive()?.id;
					if (!id) {
						return { content: [{ type: "text", text: "no execution records" }], details: {} };
					}
					return { content: [{ type: "text", text: orch.getSummary(id) }], details: {} };
				}

				case "list": {
					// simply list recent executions
					const status = orch.getActive();
					if (status) {
						return { content: [{ type: "text", text: `active: ${status.chain} (${status.id})` }], details: {} };
					}
					return { content: [{ type: "text", text: "no active execution" }], details: {} };
				}

				case "clear": {
					orch.clear();
					return { content: [{ type: "text", text: "cleared" }], details: {} };
				}

				default:
					return { content: [{ type: "text", text: `Unknown action: ${p.action}` }], details: {} };
			}
		},
	};
}
