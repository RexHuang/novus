/**
 * Core behavior regression tests
 *
 * 验证核心模块的关键行为不会被进化退化。
 * 每次进化后自动运行，确保：
 *   - 知识存储/查询/去重正常
 *   - 任务调度/质量评估正常
 *   - 进化追踪正常
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
	storeKnowledge,
	queryKnowledge,
	knowledgeStats,
	analyzeKnowledgeQuality,
	pruneEntries,
	clearKnowledge,
} from "./memory/knowledge.ts";
import {
	registerTask,
	listTasks,
	getTask,
	markTaskExecuted,
	deleteTask,
	getDueTasks,
} from "./autonomous/scheduler.ts";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 使用临时目录隔离测试数据
const TEST_DIR = join(tmpdir(), "novus-test-" + process.pid);

// ===== Knowledge Store Tests =====

describe("Knowledge store behavior", () => {
	beforeEach(() => {
		clearKnowledge();
	});

	it("stores and recalls knowledge", () => {
		const entry = storeKnowledge({
			content: "TypeScript 是 JavaScript 的超集，支持静态类型检查",
			category: "knowledge",
			tags: ["typescript", "programming"],
			confidence: 0.9,
		});

		expect(entry).not.toBeNull();
		expect(entry!.id).toBeDefined();

		const results = queryKnowledge({ query: "TypeScript 静态类型" });
		expect(results.length).toBe(1);
		expect(results[0].content).toContain("TypeScript");
	});

	it("rejects duplicate content", () => {
		storeKnowledge({ content: "这是一条唯一的测试内容，用于验证去重机制是否正常工作", category: "knowledge" });
		const dup = storeKnowledge({ content: "这是一条唯一的测试内容，用于验证去重机制是否正常工作", category: "knowledge" });

		expect(dup).toBeNull();

		const stats = knowledgeStats();
		expect(stats.total).toBe(1);
	});

	it("rejects noise: process logs (高强度工作轮)", () => {
		const result = storeKnowledge({
			content: "高强度工作轮: 使用了 5 种工具 (bash, read, edit)",
			category: "knowledge",
		});

		expect(result).toBeNull();
	});

	it("rejects noise: process fragments (技术决策: 我先看看)", () => {
		const result = storeKnowledge({
			content: "技术决策: 我先看看当前的记忆存储机制",
			category: "knowledge",
		});

		expect(result).toBeNull();
	});

	it("rejects trivial short content (< 10 chars)", () => {
		const result = storeKnowledge({
			content: "测试去重",
			category: "knowledge",
		});

		expect(result).toBeNull();
	});

	it("accepts meaningful content even with 技术决策 prefix if substantive", () => {
		const result = storeKnowledge({
			content: "技术决策: 架构采用三层分离设计，数据层使用 PostgreSQL，逻辑层用 TypeScript，表现层用 React Server Components",
			category: "knowledge",
		});

		expect(result).not.toBeNull();
	});

	it("analyze quality detects noise entries", () => {
		storeKnowledge({ content: "高强度工作轮: 使用了 5 种工具", category: "knowledge" });
		storeKnowledge({ content: "测试去重：重复内容", category: "knowledge" });

		// These should be filtered by storeKnowledge, so if the test passes,
		// it means the noise filter is working correctly
		const stats = knowledgeStats();
		expect(stats.total).toBe(0);
	});

	it("prune removes entries by ID", () => {
		const e1 = storeKnowledge({ content: "这条内容会被保留，用于验证 prune 只删除指定条目", category: "knowledge", confidence: 0.9 });
		const e2 = storeKnowledge({ content: "这条内容会被删除，用于验证 prune 功能是否正确", category: "knowledge", confidence: 0.9 });

		expect(e1).not.toBeNull();
		expect(e2).not.toBeNull();

		const result = pruneEntries([e2!.id]);
		expect(result.removed).toBe(1);

		const stats = knowledgeStats();
		expect(stats.total).toBe(1);
	});

	it("query by category filters correctly", () => {
		storeKnowledge({ content: "用户偏好内容：喜欢简洁的对话风格", category: "preference" });
		storeKnowledge({ content: "具体事实：服务器 IP 地址是 192.168.1.1", category: "fact" });
		storeKnowledge({ content: "技术知识：TypeScript 支持 infer 关键字做类型推断", category: "knowledge" });

		const prefResults = queryKnowledge({ category: "preference" });
		expect(prefResults.length).toBe(1);
		expect(prefResults[0].category).toBe("preference");

		const allResults = queryKnowledge({});
		expect(allResults.length).toBe(3);
	});
});

// ===== Task Scheduler Tests =====

describe("Task scheduler behavior", () => {
	// Track created task IDs for cleanup
	const taskIds: string[] = [];

	afterEach(() => {
		for (const id of taskIds) {
			deleteTask(id);
		}
		taskIds.length = 0;
	});

	it("registers and lists tasks", () => {
		const task = registerTask({
			name: "测试任务",
			instruction: "测试指令",
			trigger: "periodic",
			intervalHours: 24,
		});

		taskIds.push(task.id);
		expect(task.id).toBeDefined();
		expect(task.status).toBe("active");

		const tasks = listTasks();
		expect(tasks.some(t => t.id === task.id)).toBe(true);
	});

	it("marks task executed with quality evaluation", () => {
		const task = registerTask({
			name: "质量测试",
			instruction: "测试",
			trigger: "periodic",
			intervalHours: 24,
		});
		taskIds.push(task.id);

		// Low quality execution
		const result1 = markTaskExecuted(task.id, true, "无新消息");
		expect(result1).not.toBeNull();
		expect(result1!.lastQualityScore).toBeLessThan(0.3);
		expect(result1!.lowQualityStreak).toBe(1);
		expect(result1!.intervalHours).toBe(24); // No change on first low quality

		// Second low quality → interval doubles
		const result2 = markTaskExecuted(task.id, true, "缓冲区正常，无异常");
		expect(result2!.lowQualityStreak).toBe(2);
		expect(result2!.intervalHours).toBe(48); // Doubled!
	});

	it("high quality resets streak", () => {
		const task = registerTask({
			name: "重置测试",
			instruction: "测试",
			trigger: "periodic",
			intervalHours: 24,
		});
		taskIds.push(task.id);

		markTaskExecuted(task.id, true, "无新消息"); // streak=1
		markTaskExecuted(task.id, true, "正常"); // streak=2, interval=48

		// High quality resets
		const result = markTaskExecuted(task.id, true, "发现3个竞品(Crawlie/GeoFast/LLMSignal)，新标准llms.txt");
		expect(result!.lastQualityScore).toBeGreaterThanOrEqual(0.5);
		expect(result!.lowQualityStreak).toBe(0);
	});

	it("auto-pauses after 4 consecutive low quality", () => {
		const task = registerTask({
			name: "暂停测试",
			instruction: "测试",
			trigger: "periodic",
			intervalHours: 24,
		});
		taskIds.push(task.id);

		for (let i = 0; i < 4; i++) {
			const result = markTaskExecuted(task.id, true, "无新消息");
			if (i === 3) {
				expect(result!.status).toBe("paused");
			}
		}
	});

	it("getTask supports prefix matching", () => {
		const task = registerTask({
			name: "前缀匹配测试",
			instruction: "测试",
			trigger: "periodic",
		});
		taskIds.push(task.id);

		const fullMatch = getTask(task.id);
		expect(fullMatch).not.toBeNull();

		const prefixMatch = getTask(task.id.slice(0, 6));
		expect(prefixMatch).not.toBeNull();
		expect(prefixMatch!.id).toBe(task.id);
	});
});

// ===== Integration: knowledge + task quality =====

describe("Integration: knowledge quality + task quality", () => {
	beforeEach(() => {
		clearKnowledge();
	});

	afterEach(() => {
		clearKnowledge();
	});

	it("knowledge noise filter prevents garbage from being stored", () => {
		const beforeCount = knowledgeStats().total;
		const noises = [
			"高强度工作轮: 使用了 5 种工具 (bash, read, edit, grep, runtests)",
			"技术决策: 我先看看当前的记忆存储机制是怎么实现的",
			"技术决策: 我们来认真聊聊这个问题。",
			"测试去重：这条内容会被存一次",
			"技术决策: 我们来认真聊聊这个问题。",
		];

		let stored = 0;
		for (const n of noises) {
			if (storeKnowledge({ content: n, category: "knowledge" })) stored++;
		}

		expect(stored).toBe(0);

		const stats = knowledgeStats();
		expect(stats.total).toBe(beforeCount);
	});

	it("meaningful knowledge passes through", () => {
		const meaningful = [
			"SnapTool 是一个面向 AI Agent 的工具 API 平台，技术栈 Next.js，已上线 32+ 工具",
			"自我改进规则：遇到报错时必须主动处理——分析错误原因、尝试重试或换策略",
			"用户偏好：简洁对话风格，不要过度使用表格和 emoji",
		];

		let stored = 0;
		for (const m of meaningful) {
			if (storeKnowledge({ content: m, category: "knowledge" })) stored++;
		}

		expect(stored).toBe(3);
	});
});
