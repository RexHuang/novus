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
		: "no prerequisites";

	// Generate execution script
	const script: string[] = [
		`📋 Autonomous execution — Step ${nextStep.number}/${plan.steps.length}`,
		`Goal: ${plan.goal}`,
		``,
		`▶ Current step: ${desc}`,
		``,
		`📥 Inferred tool chain:`,
	];
	for (const action of inferred.actions) {
		script.push(`  → ${action}`);
	}

	if (inferred.fallback) {
		script.push(``, `🔄 On failure: ${inferred.fallback}`);
	}

	script.push(``, `📦 Prerequisite context:`, context);
	script.push(``, `💡 Execution advice:`, inferred.advice);

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
	let fallback = "Check the previous step's result, confirm environment state, then retry";
	let advice = "Confirm environment and dependencies are ready before the main operation.";

	// Pattern matching on step descriptions
	if (/ssh|远程|服务器|175|93/.test(lower)) {
		actions.push("bash: sshpass -p '<password>' ssh ubuntu@<target-ip> '<command>'");
		actions.push("healthy: check node status");
		fallback = "Check SSH connectivity, confirm the target server is online";
	}
	if (/修复|fix|bug|错误|error/.test(lower)) {
		actions.push("bash/read: 诊断问题（查看日志/错误信息）");
		actions.push("edit/write: fix the code");
		actions.push("runtests: verify the fix");
		fallback = "If the fix fails, roll back to the last known-good version";
	}
	if (/编译|build|tsc|deploy|部署|发布/.test(lower)) {
		actions.push("bash: cd ~/novus && npx tsc");
		actions.push("bash: deploy command");
		fallback = "If the build fails, check TypeScript errors and fix them";
	}
	if (/测试|test|验证/.test(lower)) {
		actions.push("runtests: run the tests");
		fallback = "If tests fail, inspect failure details and locate the bug";
	}
	if (/抓取|fetch|crawl|新闻|news/.test(lower)) {
		actions.push("connect fetch: fetch the URL");
		actions.push("connect learn: store valuable knowledge");
	}
	if (/知识|knowledge|recall|learn/.test(lower)) {
		actions.push("connect recall: search related knowledge");
		actions.push("connect learn: store new knowledge");
	}
	if (/监控|巡检|health|check|检查/.test(lower)) {
		actions.push("healthy check: check fleet status");
		actions.push("federation status: view federation status");
	}
	if (/联邦|federation|ws-comm|同步/.test(lower)) {
		actions.push("federation: federation operations");
		actions.push("ws-comm: message communication");
	}
	if (/优化|improve|refactor|重构/.test(lower)) {
		actions.push("read: read current code");
		actions.push("edit/write: modify and improve");
		actions.push("runtests: verify no regression");
	}
	if (/存储|store|connect|知识/.test(lower) && /写入|save|写/.test(lower)) {
		actions.push("connect learn: store knowledge/experience");
	}

	if (actions.length === 0) {
		actions.push("bash/read: analyze current state");
		actions.push("Decide the next tool based on the analysis");
		advice = "This is an open-ended step — handle flexibly based on the actual situation";
	}

	// Generate contextual advice based on step position
	if (/步骤|Step/i.test(desc) && /1|第一|初始/.test(desc)) {
		advice = "This is the first step — confirm the environment is ready before starting.";
	}

	return { actions, fallback, advice };
}
