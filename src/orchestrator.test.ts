/**
 * Chain Orchestrator tests
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
	ChainOrchestrator,
	getOrchestrator,
	type ChainExecution,
} from "../src/tools/custom/orchestrator.js";
import type { ToolChain } from "../src/tools/custom/router.js";

const mockChain: ToolChain = {
	name: "test-chain",
	description: "测试工具链",
	intent: "code",
	steps: [
		{ tool: "read", intent: "code", description: "读取文件" },
		{ tool: "edit", intent: "code", description: "修改代码" },
		{ tool: "runtests", intent: "code", description: "运行测试", optional: true },
	],
	triggerPatterns: ["测试链"],
};

describe("ChainOrchestrator", () => {
	let orch: ChainOrchestrator;

	beforeEach(() => {
		orch = new ChainOrchestrator();
	});

	it("启动工具链执行", () => {
		const exec = orch.start(mockChain, "测试输入");
		expect(exec.id).toMatch(/^chain_/);
		expect(exec.chain).toBe("test-chain");
		expect(exec.status).toBe("running");
		expect(exec.steps).toHaveLength(3);
		expect(exec.steps[0]!.status).toBe("pending");
	});

	it("标记步骤执行流程", () => {
		const exec = orch.start(mockChain, "测试");
		expect(orch.beginStep(exec.id, 0)).toBe(true);
		expect(exec.steps[0]!.status).toBe("active");

		expect(orch.completeStep(exec.id, 0, "文件已读取", 50)).toBe(true);
		expect(exec.steps[0]!.status).toBe("done");
		expect(exec.steps[0]!.result).toBe("文件已读取");
		expect(exec.steps[0]!.duration).toBe(50);
	});

	it("跳过可选步骤", () => {
		const exec = orch.start(mockChain, "测试");
		expect(orch.skipStep(exec.id, 2, "测试环境未配置")).toBe(true);
		expect(exec.steps[2]!.status).toBe("skipped");
		expect(exec.steps[2]!.result).toBe("测试环境未配置");
	});

	it("标记步骤失败", () => {
		const exec = orch.start(mockChain, "测试");
		expect(orch.failStep(exec.id, 1, "文件不存在")).toBe(true);
		expect(exec.steps[1]!.status).toBe("error");
		expect(exec.status).toBe("failed");
	});

	it("完成整个链", () => {
		const exec = orch.start(mockChain, "测试");
		orch.beginStep(exec.id, 0);
		orch.completeStep(exec.id, 0, "OK", 10);
		orch.beginStep(exec.id, 1);
		orch.completeStep(exec.id, 1, "OK", 20);
		orch.skipStep(exec.id, 2, "skip");
		orch.complete(exec.id);

		expect(exec.status).toBe("completed");
		expect(exec.completedAt).toBeDefined();
	});

	it("边界检查：无效索引返回false", () => {
		const exec = orch.start(mockChain, "测试");
		expect(orch.beginStep(exec.id, 99)).toBe(false);
		expect(orch.completeStep(exec.id, -1, "x", 0)).toBe(false);
	});

	it("getActive 返回运行中的执行", () => {
		const exec = orch.start(mockChain, "测试");
		expect(orch.getActive()?.id).toBe(exec.id);

		orch.complete(exec.id);
		expect(orch.getActive()).toBeNull();
	});

	it("getPromptInjection 包含链状态", () => {
		orch.start(mockChain, "测试");
		const injection = orch.getPromptInjection();
		expect(injection).toContain("test-chain");
		expect(injection).toContain("⬜ Step 1");
		expect(injection).toContain("read");
	});

	it("无活跃执行时 PromptInjection 为空", () => {
		expect(orch.getPromptInjection()).toBe("");
	});

	it("getSummary 包含统计信息", () => {
		const exec = orch.start(mockChain, "测试");
		orch.completeStep(exec.id, 0, "done", 100);
		orch.skipStep(exec.id, 1, "skip");
		orch.complete(exec.id);

		const summary = orch.getSummary(exec.id);
		expect(summary).toContain("1/3");
		expect(summary).toContain("1 跳过");
		expect(summary).toContain("✅ 完成");
	});

	it("prune 清理旧记录", () => {
		// 填满并触发清理
		for (let i = 0; i < 12; i++) {
			const exec = orch.start(mockChain, `测试${i}`);
			orch.complete(exec.id);
		}
		expect(orch.getActive()).toBeNull();
	});

	it("clear 清空所有", () => {
		orch.start(mockChain, "测试");
		orch.clear();
		expect(orch.getActive()).toBeNull();
	});
});

describe("getOrchestrator 单例", () => {
	it("返回同一实例", () => {
		const a = getOrchestrator();
		const b = getOrchestrator();
		expect(a).toBe(b);
	});
});
