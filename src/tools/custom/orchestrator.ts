/**
 * Chain Orchestrator - 工具链编排器
 *
 * 第五轮进化：将 Smart Router 推荐的工具链变成可自动执行的计划。
 * 职责：
 * 1. 接收 router 推荐的 ToolChain → 生成执行计划
 * 2. 注入到 system prompt 让 LLM 看到推荐步骤
 * 3. 跟踪每步执行状态（pending/done/skipped/error）
 * 4. 链执行完成后输出摘要
 */

import type { ToolChain } from "./router.js";

// ── 类型 ──────────────────────────────────────────────────────────

export type StepStatus = "pending" | "active" | "done" | "skipped" | "error";

export interface ChainStep {
	tool: string;
	intent: string;
	description: string;
	optional: boolean;
	status: StepStatus;
	result?: string;       // 执行后的简短结果
	duration?: number;     // ms
}

export interface ChainExecution {
	id: string;
	chain: string;
	input: string;          // 触发输入
	steps: ChainStep[];
	startedAt: number;
	completedAt?: number;
	status: "running" | "completed" | "failed";
}

// ── 编排器 ────────────────────────────────────────────────────────

export class ChainOrchestrator {
	private executions: Map<string, ChainExecution> = new Map();
	private static readonly MAX_EXECUTIONS = 10;

	/**
	 * 启动一个工具链执行
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
	 * 标记某个步骤开始执行
	 */
	beginStep(execId: string, stepIndex: number): boolean {
		const exec = this.executions.get(execId);
		if (!exec || stepIndex < 0 || stepIndex >= exec.steps.length) return false;
		if (exec.steps[stepIndex]!.status !== "pending") return false;
		exec.steps[stepIndex]!.status = "active";
		return true;
	}

	/**
	 * 标记某个步骤完成
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
	 * 跳过可选步骤
	 */
	skipStep(execId: string, stepIndex: number, reason: string): boolean {
		const exec = this.executions.get(execId);
		if (!exec || stepIndex < 0 || stepIndex >= exec.steps.length) return false;
		exec.steps[stepIndex]!.status = "skipped";
		exec.steps[stepIndex]!.result = reason.slice(0, 200);
		return true;
	}

	/**
	 * 标记步骤失败
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
	 * 完成整个链执行
	 */
	complete(execId: string): boolean {
		const exec = this.executions.get(execId);
		if (!exec) return false;
		exec.completedAt = Date.now();
		exec.status = "completed";
		return true;
	}

	/**
	 * 获取当前执行状态
	 */
	get(execId: string): ChainExecution | null {
		return this.executions.get(execId) ?? null;
	}

	/**
	 * 获取当前活跃（运行中）的执行
	 */
	getActive(): ChainExecution | null {
		for (const exec of this.executions.values()) {
			if (exec.status === "running") return exec;
		}
		return null;
	}

	/**
	 * 生成注入到 system prompt 的提示文本
	 * 让 LLM 看到当前正在执行的链步骤
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
		return `\n\n## 🔗 工具链执行中: ${active.chain}\n${lines.join("\n")}\n耗时: ${(elapsed / 1000).toFixed(1)}s\n`;
	}

	/**
	 * 生成执行摘要
	 */
	getSummary(execId: string): string {
		const exec = this.executions.get(execId);
		if (!exec) return "未找到执行记录";

		const done = exec.steps.filter((s) => s.status === "done").length;
		const skipped = exec.steps.filter((s) => s.status === "skipped").length;
		const errors = exec.steps.filter((s) => s.status === "error").length;
		const totalDuration = exec.steps.reduce((sum, s) => sum + (s.duration ?? 0), 0);

		const statusStr = exec.status === "completed" ? "✅ 完成"
			: exec.status === "failed" ? "❌ 失败"
			: "🔄 进行中";

		return [
			`链: ${exec.chain} ${statusStr}`,
			`步骤: ${done}/${exec.steps.length} 完成${skipped > 0 ? `, ${skipped} 跳过` : ""}${errors > 0 ? `, ${errors} 错误` : ""}`,
			`总耗时: ${(totalDuration / 1000).toFixed(1)}s`,
			exec.status === "completed" && exec.completedAt
				? `总执行: ${((exec.completedAt - exec.startedAt) / 1000).toFixed(1)}s`
				: "",
		].filter(Boolean).join("\n");
	}

	/**
	 * 清除过期执行记录
	 */
	private prune(): void {
		if (this.executions.size < ChainOrchestrator.MAX_EXECUTIONS) return;
		// 移除最旧的已完成执行
		const sorted = [...this.executions.entries()]
			.filter((entry: [string, ChainExecution]) => entry[1].status !== "running")
			.sort((a: [string, ChainExecution], b: [string, ChainExecution]) => a[1].startedAt - b[1].startedAt);

		for (let i = 0; i < Math.min(sorted.length, 3); i++) {
			this.executions.delete(sorted[i]![0]);
		}
	}

	/**
	 * 清空所有记录
	 */
	clear(): void {
		this.executions.clear();
	}
}

// ── 单例 ──────────────────────────────────────────────────────────

let orchestratorInstance: ChainOrchestrator | null = null;

export function getOrchestrator(): ChainOrchestrator {
	if (!orchestratorInstance) {
		orchestratorInstance = new ChainOrchestrator();
	}
	return orchestratorInstance;
}

// ── Agent Tool 导出 ───────────────────────────────────────────────

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { matchToolChain } from "./router.js";

export function createTool(_cwd: string): AgentTool<any> {
	return {
		name: "chain-orchestrator",
		description: `工具链编排器 — 管理工具链的执行生命周期。支持：
- start: 启动一个工具链（自动从 router 匹配）
- status: 查看当前活跃链的执行状态
- summary: 获取已完成链的摘要
- list: 列出所有执行记录
- clear: 清空执行历史`,
		label: "Chain Orchestrator",
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["start", "status", "summary", "list", "clear"],
					description: "操作类型",
				},
				input: {
					type: "string",
					description: "用户输入（start 时必填，用于匹配工具链）",
				},
				execId: {
					type: "string",
					description: "执行ID（summary 时可选）",
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
						return { content: [{ type: "text", text: "缺少 input 参数" }], details: {} };
					}
					const chain = matchToolChain(p.input);
					if (!chain) {
						return { content: [{ type: "text", text: "未匹配到工具链。使用 smart-router 的 route 操作查看可用链。" }], details: {} };
					}
					const exec = orch.start(chain, p.input);
					return {
						content: [{ type: "text", text: `工具链 [${chain.name}] 已启动 (ID: ${exec.id})\n${exec.steps.map((s, i) => `  ${i + 1}. ${s.description} [${s.tool}]${s.optional ? " (可选)" : ""}`).join("\n")}` }],
						details: { execId: exec.id, chain: chain.name },
					};
				}

				case "status": {
					const active = orch.getActive();
					if (!active) {
						return { content: [{ type: "text", text: "当前无活跃工具链" }], details: {} };
					}
					const lines = active.steps.map((s, i) => {
						const icon = s.status === "done" ? "✅" : s.status === "active" ? "🔄" : s.status === "skipped" ? "⏭️" : s.status === "error" ? "❌" : "⬜";
						return `${icon} ${i + 1}. ${s.description} [${s.tool}]${s.result ? ` → ${s.result}` : ""}`;
					});
					return {
						content: [{ type: "text", text: `链: ${active.chain} (ID: ${active.id})\n${lines.join("\n")}\n耗时: ${((Date.now() - active.startedAt) / 1000).toFixed(1)}s` }],
						details: { execId: active.id },
					};
				}

				case "summary": {
					const id = p.execId ?? orch.getActive()?.id;
					if (!id) {
						return { content: [{ type: "text", text: "无执行记录" }], details: {} };
					}
					return { content: [{ type: "text", text: orch.getSummary(id) }], details: {} };
				}

				case "list": {
					// 简单列出最近的执行
					const status = orch.getActive();
					if (status) {
						return { content: [{ type: "text", text: `活跃: ${status.chain} (${status.id})` }], details: {} };
					}
					return { content: [{ type: "text", text: "无活跃执行" }], details: {} };
				}

				case "clear": {
					orch.clear();
					return { content: [{ type: "text", text: "已清空" }], details: {} };
				}

				default:
					return { content: [{ type: "text", text: `未知操作: ${p.action}` }], details: {} };
			}
		},
	};
}
