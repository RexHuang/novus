/**
 * plan — structured task planning tool.
 *
 * Plans are persisted to ~/.novus/plans/current.json (NOT knowledge store).
 * This avoids polluting memory with duplicate plan JSONs.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// execution-tracker state file path (shared with execution-tracker.ts)
const TRACKER_STATE_FILE = join(homedir(), ".novus", "execution-tracker", "state.json");

interface TrackerState {
	currentStep: number | null;
	toolCalls: Array<{ toolName: string; status: string; error?: string }>;
	startedAt: string | null;
}

function loadTrackerState(): TrackerState | null {
	if (!existsSync(TRACKER_STATE_FILE)) return null;
	try { return JSON.parse(readFileSync(TRACKER_STATE_FILE, "utf-8")) as TrackerState; } catch { return null; }
}

const PLAN_DIR = join(homedir(), ".novus", "plans");
const PLAN_FILE = join(PLAN_DIR, "current.json");

function ensurePlanDir(): void {
	if (!existsSync(PLAN_DIR)) mkdirSync(PLAN_DIR, { recursive: true });
}

interface PlanStep {
	number: number;
	description: string;
	status: "pending" | "in-progress" | "done";
	dependsOn: number[];
	details?: string;
}

interface Plan {
	goal: string;
	steps: PlanStep[];
	createdAt: string;
	updatedAt: string;
}

interface PlanParams {
	action: "create" | "show" | "complete" | "clear" | "auto-execute";
	goal?: string;
	steps?: string[];
	stepNumber?: number;
	result?: string;
}

function text(t: string) {
	return { type: "text" as const, text: t };
}

function formatPlan(plan: Plan): string {
	const statusIcon = (s: string) => {
		if (s === "done") return "✓";
		if (s === "in-progress") return "→";
		return "○";
	};

	const lines = [`## Plan: ${plan.goal}`, `Created: ${plan.createdAt}`, ""];

	for (const step of plan.steps) {
		const icon = statusIcon(step.status);
		const dep = step.dependsOn.length > 0 ? ` (after ${step.dependsOn.join(", ")})` : "";
		const detail = step.details ? ` — ${step.details}` : "";
		lines.push(`${icon} Step ${step.number}: ${step.description}${dep}${detail}`);
	}

	const done = plan.steps.filter((s) => s.status === "done").length;
	const total = plan.steps.length;
	lines.push("");
	lines.push(`Progress: ${done}/${total} complete`);

	return lines.join("\n");
}

/** Load plan from dedicated file */
function loadPlan(): Plan | null {
	ensurePlanDir();
	if (!existsSync(PLAN_FILE)) return null;
	try {
		const raw = readFileSync(PLAN_FILE, "utf-8");
		const plan = JSON.parse(raw) as Plan;
		if (!plan.goal || plan.steps.length === 0) return null;
		return plan;
	} catch {
		return null;
	}
}

/** Save plan to dedicated file (overwrite, no duplicates) */
function savePlan(plan: Plan): void {
	ensurePlanDir();
	writeFileSync(PLAN_FILE, JSON.stringify(plan, null, 2), "utf-8");
}

/** Delete plan file */
function deletePlan(): void {
	ensurePlanDir();
	if (existsSync(PLAN_FILE)) unlinkSync(PLAN_FILE);
}

/** Export plan for identity injection */
export function getActivePlan(): Plan | null {
	return loadPlan();
}

export function createTool(_cwd: string): AgentTool<any> {
	return {
		name: "plan",
		description:
			"Structured task planning. Actions: create (goal + steps list), show (display plan), complete (mark step done by number), clear (delete plan). Plans persist across sessions.",
		label: "plan",

		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["create", "show", "complete", "clear", "auto-execute"],
					description: "Plan action to perform. auto-execute generates an execution script for the next pending step.",
				},
				goal: { type: "string", description: "The goal or objective (for create)" },
				steps: {
					type: "array",
					items: { type: "string" },
					description: "List of step descriptions in execution order (for create)",
				},
				stepNumber: {
					type: "number",
					description: "Step number to mark complete (for complete)",
				},
				result: {
					type: "string",
					description: "Optional result/notes for the completed step",
				},
			},
			required: ["action"],
		},

		execute: async (_callId: string, params: unknown) => {
			const p = params as PlanParams;
			const now = new Date().toISOString();

			switch (p.action) {
				case "create": {
					if (!p.goal || !p.steps || p.steps.length === 0) {
						return { content: [text("Error: 'goal' and 'steps' are required for create.")], details: {} };
					}

					const existing = loadPlan();
					if (existing) {
						return {
							content: [text("A plan already exists. Use 'show' to view it or 'clear' to delete it first.\n\n" + formatPlan(existing))],
							details: {},
						};
					}

					const steps: PlanStep[] = p.steps.map((desc, i) => ({
						number: i + 1,
						description: desc,
						status: "pending" as const,
						dependsOn: [],
					}));

					const plan: Plan = {
						goal: p.goal,
						steps,
						createdAt: now,
						updatedAt: now,
					};

					savePlan(plan);
					return { content: [text("Plan created:\n\n" + formatPlan(plan))], details: {} };
				}

				case "show": {
					const plan = loadPlan();
					if (!plan) {
						return { content: [text("No active plan. Use 'create' to make one.")], details: {} };
					}
					return { content: [text(formatPlan(plan))], details: {} };
				}

				case "complete": {
					const plan = loadPlan();
					if (!plan) {
						return { content: [text("No active plan to update.")], details: {} };
					}
					if (!p.stepNumber) {
						return { content: [text("Error: 'stepNumber' is required for complete.")], details: {} };
					}

					const step = plan.steps.find((s) => s.number === p.stepNumber);
					if (!step) {
						return { content: [text(`Error: Step ${p.stepNumber} not found.`)], details: {} };
					}

					if (step.status === "done") {
						return { content: [text(`Step ${p.stepNumber} is already done.`)], details: {} };
					}

					step.status = "done";
					if (p.result) {
						step.details = p.result;
					}

					autoUnblock(plan);
					plan.updatedAt = now;
					savePlan(plan);

					const allDone = plan.steps.every((s) => s.status === "done");
					const msg = allDone
						? "🎉 All steps complete! Plan finished.\n\n" + formatPlan(plan)
						: formatPlan(plan);

					return { content: [text(msg)], details: {} };
				}

				case "clear": {
					const plan = loadPlan();
					if (!plan) {
						return { content: [text("No active plan to clear.")], details: {} };
					}
					const was = plan.goal;
					deletePlan();
					return { content: [text(`Plan cleared. Was: "${was}" (${plan.steps.length} steps)`)], details: {} };
				}

				case "auto-execute": {
					return handleAutoExecute();
				}
				default:
					return { content: [text(`Unknown action: ${p.action}`)], details: {} };
			}
		},
	};
}

function autoUnblock(plan: Plan): void {
	const doneNumbers = new Set(plan.steps.filter((s) => s.status === "done").map((s) => s.number));
	for (const step of plan.steps) {
		if (step.status !== "pending") continue;
		const allDepsDone = step.dependsOn.every((d) => doneNumbers.has(d));
		if (allDepsDone && step.dependsOn.length > 0) {
			step.status = "in-progress";
		}
	}
}

/**
 * handleAutoExecute — 自主规划执行引擎
 *
 * 不直接调用工具（工具是flat的），而是分析当前plan状态，
 * 找到下一个待执行步骤，生成结构化的执行指令（剧本），
 * 告诉LLM应该做什么、用什么工具、传什么参数。
 *
 * 核心能力：
 *   1. 识别下一个pending步骤
 *   2. 根据步骤描述推断需要的工具和参数
 *   3. 检查前置依赖是否完成
 *   4. 生成可执行的action plan
 *   5. 失败时建议回退策略
 */
function handleAutoExecute() {
	const plan = loadPlan();
	if (!plan) {
		return { content: [text("No active plan. Create one first.")], details: {} };
	}

	// Find next pending step
	const nextStep = plan.steps.find(s => s.status === "pending");
	if (!nextStep) {
		// Check if all done
		const allDone = plan.steps.every(s => s.status === "done");
		if (allDone) {
			return { content: [text("🎉 Plan complete! All steps finished.\n\n" + formatPlan(plan))], details: { planComplete: true } };
		}
		// Some in-progress — report status
		const inProgress = plan.steps.filter(s => s.status === "in-progress");
		return { content: [text(`⏳ Steps in progress: ${inProgress.map(s => "Step " + s.number).join(", ")}\nWaiting for completion. Use 'complete' to mark them done.\n\n` + formatPlan(plan))], details: { waiting: true } };
	}

	// Analyze step description to infer actions
	const desc = nextStep.description;
	const inferred = inferActions(desc);

	// Check what's been done (for context)
	const doneSteps = plan.steps.filter(s => s.status === "done");
	const context = doneSteps.length > 0
		? doneSteps.map(s => `[${s.number}] ${s.description}${s.details ? ": " + s.details.slice(0, 100) : ""}`).join("\n")
		: "无前置步骤";

	// Generate execution script
	const script: string[] = [
		`📋 自主执行 — Step ${nextStep.number}/${plan.steps.length}`,
		`目标: ${plan.goal}`,
		``,
		`▶ 当前步骤: ${desc}`,
		``,
		`📥 推断的工具链:`,
	];
	for (const action of inferred.actions) {
		script.push(`  → ${action}`);
	}

	if (inferred.fallback) {
		script.push(``, `🔄 失败回退: ${inferred.fallback}`);
	}

	script.push(``, `📦 前置上下文:`, context);
	script.push(``, `💡 执行建议:`, inferred.advice);

	// Auto-mark as in-progress
	nextStep.status = "in-progress";
	plan.updatedAt = new Date().toISOString();
	savePlan(plan);

	return {
		content: [text(script.join("\n"))],
		details: {
			stepNumber: nextStep.number,
			description: desc,
			inferredActions: inferred.actions,
			fallback: inferred.fallback,
			context: doneSteps.map(s => ({ number: s.number, description: s.description, details: s.details })),
		},
	};
}

/** 从步骤描述推断需要的行动 */
function inferActions(desc: string): { actions: string[]; fallback: string; advice: string } {
	const lower = desc.toLowerCase();
	const actions: string[] = [];
	let fallback = "检查上一个步骤的结果，确认环境状态后重试";
	let advice = "先确认环境和依赖就绪，再执行主要操作。";

	// Pattern matching on step descriptions
	if (/ssh|远程|服务器|175|93/.test(lower)) {
		actions.push("bash: sshpass -p '密码' ssh ubuntu@目标IP '命令'");
		actions.push("healthy: 检查节点状态");
		fallback = "检查SSH连通性，确认目标服务器在线";
	}
	if (/修复|fix|bug|错误|error/.test(lower)) {
		actions.push("bash/read: 诊断问题（查看日志/错误信息）");
		actions.push("edit/write: 修复代码");
		actions.push("runtests: 验证修复");
		fallback = "如果修复失败，尝试回退到上一个已知好的版本";
	}
	if (/编译|build|tsc|deploy|部署|发布/.test(lower)) {
		actions.push("bash: cd ~/novus && npx tsc");
		actions.push("bash: 部署命令");
		fallback = "如果编译失败，检查TypeScript错误并修复";
	}
	if (/测试|test|验证/.test(lower)) {
		actions.push("runtests: 运行测试");
		fallback = "如果测试失败，查看失败详情，定位bug";
	}
	if (/抓取|fetch|crawl|新闻|news/.test(lower)) {
		actions.push("connect fetch: 抓取URL");
		actions.push("connect learn: 存储有价值的知识");
	}
	if (/知识|knowledge|recall|learn/.test(lower)) {
		actions.push("connect recall: 搜索相关知识");
		actions.push("connect learn: 存储新知识");
	}
	if (/监控|巡检|health|check|检查/.test(lower)) {
		actions.push("healthy check: 检查三机状态");
		actions.push("federation status: 查看联邦状态");
	}
	if (/联邦|federation|ws-comm|同步/.test(lower)) {
		actions.push("federation: 联邦操作");
		actions.push("ws-comm: 消息通信");
	}
	if (/优化|improve|refactor|重构/.test(lower)) {
		actions.push("read: 读取当前代码");
		actions.push("edit/write: 修改优化");
		actions.push("runtests: 验证无回归");
	}
	if (/存储|store|connect|知识/.test(lower) && /写入|save|写/.test(lower)) {
		actions.push("connect learn: 存储知识/经历");
	}

	if (actions.length === 0) {
		actions.push("bash/read: 分析当前状态");
		actions.push("根据分析结果决定下一步工具");
		advice = "这是一个开放性步骤，需要根据实际情况灵活处理";
	}

	// Generate contextual advice based on step position
	if (/步骤|Step/i.test(desc) && /1|第一|初始/.test(desc)) {
		advice = "这是第一步，先确认环境就绪再开始。";
	}

	return { actions, fallback, advice };
}
