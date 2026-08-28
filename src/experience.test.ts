import { describe, it, expect, afterAll, vi } from "vitest";
import { storeExperience, recallExperience, extractExperienceFromWorklog, experienceStats, metaMemory } from "./memory/knowledge.js";
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const EXP_FILE = join(homedir(), ".novus", "knowledge", "experience.jsonl");
const testIds: string[] = [];

afterAll(() => {
	// Clean up test entries by rewriting without them
	if (!existsSync(EXP_FILE)) return;
	const { readFileSync, writeFileSync } = require("node:fs");
	const lines = readFileSync(EXP_FILE, "utf-8").trim().split("\n");
	const kept = lines.filter((line: string) => {
		if (!line) return true;
		try {
			const obj = JSON.parse(line);
			return !testIds.includes(obj.id);
		} catch { return true; }
	});
	writeFileSync(EXP_FILE, kept.join("\n") + "\n", "utf-8");
});

describe("情景记忆 - extractExperienceFromWorklog", () => {
	it("从有改动的done worklog提取经历", () => {
		const result = extractExperienceFromWorklog({
			activity: "修复175 relay进程堆积问题",
			changes: "pkill -9 杀掉6个重复进程, 重启单实例",
			status: "done",
			step: "阶段2",
			timestamp: "2026-08-17T08:00:00Z",
		});
		expect(result).not.toBeNull();
		expect(result!.title).toBe("修复175 relay进程堆积问题");
		expect(result!.tags).toContain("debug");
		expect(result!.outcome).toBe("成功");
	});

	it("idle条目返回null", () => {
		expect(extractExperienceFromWorklog({
			activity: "等待中", status: "idle",
		})).toBeNull();
	});

	it("无改动条目返回null", () => {
		expect(extractExperienceFromWorklog({
			activity: "只是看看", status: "done",
		})).toBeNull();
	});

	it("推断正确标签", () => {
		const result = extractExperienceFromWorklog({
			activity: "ssh到175优化file_drop_server.js",
			changes: "加PID锁和日志轮转",
			status: "done", step: "优化",
			files: ["file_drop_server.js"],
		});
		expect(result!.tags).toContain("ssh");
		expect(result!.tags).toContain("optimize");
	});

	it("从changes提取教训", () => {
		const result = extractExperienceFromWorklog({
			activity: "修复175 relay连接超时问题",
			changes: "改为pkill -f杀全部进程, 避免lsof只杀worker导致进程堆积",
			status: "done",
		});
		expect(result!.lessons.length).toBeGreaterThan(0);
	});
});

describe("情景记忆 - storeExperience + recallExperience", () => {
	it("存储并按关键词检索", () => {
		const e = storeExperience({
			title: "测试relay进程修复经历",
			scenario: "ssh远程修复175服务器",
			situation: "自愈机制反复重启导致6个进程",
			actions: ["pkill -9 杀全部进程", "重启单实例"],
			outcome: "成功",
			lessons: ["自愈命令要用pkill -f而非lsof"],
			tags: ["ssh", "debug"],
			timestamp: "2026-08-17T08:00:00Z",
			confidence: 0.9,
		});
		testIds.push(e.id);

		const results = recallExperience({ keyword: "relay进程" });
		expect(results.length).toBeGreaterThanOrEqual(1);
		expect(results[0].title).toContain("relay");
	});

	it("按标签检索", () => {
		const results = recallExperience({ tags: ["ssh"] });
		expect(results.length).toBeGreaterThanOrEqual(1);
	});

	it("title+scenario去重保留最新", () => {
		const e1 = storeExperience({
			title: "UNIQUE_DEDUP_MARKER_AAAA", scenario: "场景X",
			situation: "版本1", actions: [], outcome: "成功",
			lessons: [], tags: ["test"],
			timestamp: "2026-08-17T09:00:00Z", confidence: 0.8,
		});
		testIds.push(e1.id);

		const e2 = storeExperience({
			title: "UNIQUE_DEDUP_MARKER_AAAA", scenario: "场景X",
			situation: "版本2", actions: ["新行动"], outcome: "成功",
			lessons: ["教训更新"], tags: ["test"],
			timestamp: "2026-08-17T10:00:00Z", confidence: 0.9,
		});
		testIds.push(e2.id);

		const results = recallExperience({ keyword: "UNIQUE_DEDUP_MARKER_AAAA" });
		expect(results.length).toBe(1);
		expect(results[0].situation).toBe("版本2");
	});

	it("无匹配时返回空并显示统计", () => {
		const results = recallExperience({ keyword: "zzzqqqxxx999nonexistent" });
		expect(results.length).toBe(0);
	});
});

describe("情景记忆 - experienceStats", () => {
	it("返回统计信息", () => {
		const stats = experienceStats();
		expect(stats.total).toBeGreaterThanOrEqual(0);
		expect(typeof stats.byTag).toBe("object");
	});
});

describe("元记忆 - metaMemory", () => {
	it("返回完整报告结构", () => {
		const report = metaMemory();
		expect(report.summary.total).toBeGreaterThanOrEqual(0);
		expect(report.summary.core).toBeGreaterThanOrEqual(0);
		expect(report.summary.experiences).toBeGreaterThanOrEqual(0);
		expect(report.categories).toBeDefined();
		expect(report.tagCloud.length).toBeGreaterThanOrEqual(0);
		expect(report.health.avgConfidence).toBeGreaterThanOrEqual(0);
		expect(report.health.knowledgeFreshness).toBeGreaterThanOrEqual(0);
	});

	it("查询命中检测", () => {
		const report = metaMemory("relay");
		expect(report.queryHit.query).toBe("relay");
		expect(typeof report.queryHit.hit).toBe("boolean");
		expect(typeof report.queryHit.score).toBe("number");
	});

	it("盲区检测返回miss", () => {
		const report = metaMemory("ZZZZZ_NONEXISTENT_TOPIC_ZZZZZ");
		expect(report.queryHit.hit).toBe(false);
		expect(report.queryHit.hitCount).toBe(0);
	});
});

describe("自主执行引擎 - auto-execute", () => {
	// Dynamic tool loading is slow on Termux; give generous timeout
	const TIMEOUT = 30_000;
	// Auto-execute is tested via plan tool, but we test inferActions directly
	// by importing from the compiled JS. Since it's not exported, we test
	// via the plan tool integration.

	it("plan auto-execute on empty plan returns error", async () => {
		vi.setConfig({ testTimeout: TIMEOUT });
		const { createAllTools } = await import("./tools.js");
		const tools = await createAllTools("/tmp");
		const planTool = tools.find((t: any) => t.name === "plan")!;

		// Clear any existing plan first
		await planTool.execute("clear-pre", { action: "clear" });
		const result = await planTool.execute("test-1", { action: "auto-execute" });
		expect((result.content[0] as any).text).toContain("No active plan");
	});

	it("plan auto-execute creates execution script", async () => {
		vi.setConfig({ testTimeout: TIMEOUT });
		const { createAllTools } = await import("./tools.js");
		const tools = await createAllTools("/tmp");
		const planTool = tools.find((t: any) => t.name === "plan")!;

		// Clear any existing plan first
		await planTool.execute("clear-pre-2", { action: "clear" });
		// Create a plan
		await planTool.execute("test-2", {
			action: "create",
			goal: "测试自主执行",
			steps: ["SSH到175检查磁盘空间", "修复磁盘空间不足问题", "验证修复结果"],
		});

		// Auto-execute
		const result = await planTool.execute("test-3", { action: "auto-execute" });
		const text = (result.content[0] as any).text as string;
		expect(text).toContain("Step 1/3");
		expect(text).toContain("SSH");
		expect(text).toContain("推断的工具链");

		// Cleanup
		await planTool.execute("test-4", { action: "clear" });
	});

	it("inferActions matches debug patterns", async () => {
		vi.setConfig({ testTimeout: TIMEOUT });
		const { createAllTools } = await import("./tools.js");
		const tools = await createAllTools("/tmp");
		const planTool = tools.find((t: any) => t.name === "plan")!;

		await planTool.execute("clear-pre-3", { action: "clear" });
		await planTool.execute("test-5", {
			action: "create",
			goal: "修复bug",
			steps: ["诊断175服务器relay超时bug", "修复代码", "运行测试验证"],
		});

		const result = await planTool.execute("test-6", { action: "auto-execute" });
		const text = (result.content[0] as any).text as string;
		expect(text).toContain("修复");

		await planTool.execute("test-7", { action: "clear" });
	});
});
