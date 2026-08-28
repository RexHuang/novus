/**
 * Smart Router tests
 */
import { describe, it, expect } from "vitest";
import {
	classifyIntent,
	matchToolChain,
	routeAdvice,
	getDetector,
	TOOL_CHAINS,
	type IntentCategory,
} from "../src/tools/custom/router.js";
import { createTool } from "../src/tools/custom/router.js";

describe("classifyIntent", () => {
	it("识别代码意图", () => {
		const results = classifyIntent("帮我修复这个 bug 并运行测试");
		expect(results.length).toBeGreaterThan(0);
		expect(results[0]!.intent).toBe("code");
		expect(results[0]!.confidence).toBeGreaterThan(0);
	});

	it("识别知识意图", () => {
		const results = classifyIntent("回忆一下之前学过的关于SQLite的知识");
		expect(results.length).toBeGreaterThan(0);
		expect(results[0]!.intent).toBe("knowledge");
	});

	it("识别系统意图", () => {
		const results = classifyIntent("同步三机节点并做健康检查");
		expect(results.length).toBeGreaterThan(0);
		const hasSystem = results.some((r: { intent: string }) => r.intent === "system");
		expect(hasSystem).toBe(true);
	});

	it("纯对话意图为chat", () => {
		const results = classifyIntent("你觉得AI的未来会怎样");
		expect(results.length).toBeGreaterThan(0);
		expect(results[0]!.intent).toBe("chat");
	});

	it("多意图识别", () => {
		const results = classifyIntent("从GitHub搜索issue然后记录贡献");
		expect(results.length).toBeGreaterThanOrEqual(2);
		const intents = results.map((r: { intent: string }) => r.intent);
		expect(intents).toContain("oss");
	});

	it("空输入返回空", () => {
		const results = classifyIntent("");
		expect(results.length).toBe(0);
	});
});

describe("matchToolChain", () => {
	it("匹配知识获取链", () => {
		const chain = matchToolChain("抓取这个页面并记住关键信息");
		expect(chain).not.toBeNull();
		expect(chain!.name).toBe("knowledge-acquire");
	});

	it("匹配代码变更链", () => {
		const chain = matchToolChain("修改代码并运行测试验证");
		expect(chain).not.toBeNull();
		expect(chain!.name).toBe("code-change");
	});

	it("匹配全量部署链", () => {
		const chain = matchToolChain("更新三机节点");
		expect(chain).not.toBeNull();
		expect(chain!.name).toBe("full-deploy");
	});

	it("不匹配纯对话", () => {
		const chain = matchToolChain("你好谢谢再见");
		expect(chain).toBeNull();
	});
});

describe("redundancyDetector", () => {
	it("检测重复调用", () => {
		const detector = getDetector();
		detector.clear();
		detector.record("bash", { command: "ls" });
		detector.record("bash", { command: "ls" });
		const warning = detector.check("bash", { command: "ls" });
		expect(warning).not.toBeNull();
		expect(warning).toContain("重复");
	});

	it("不同参数不算重复", () => {
		const detector = getDetector();
		detector.clear();
		detector.record("bash", { command: "ls" });
		const warning = detector.check("bash", { command: "pwd" });
		expect(warning).toBeNull();
	});

	it("summary 在正常调用时返回正常", () => {
		const detector = getDetector();
		detector.clear();
		detector.record("read", { path: "a.ts" });
		detector.record("bash", { command: "ls" });
		expect(detector.summary()).toBe("调用模式正常");
	});

	it("summary 检测过多调用", () => {
		const detector = getDetector();
		detector.clear();
		for (let i = 0; i < 4; i++) {
			detector.record("bash", { command: `test${i}` });
		}
		expect(detector.summary()).toContain("bash");
		expect(detector.summary()).toContain("可能过多");
	});
});

describe("routeAdvice", () => {
	it("生成路由建议", () => {
		const advice = routeAdvice("帮我修复bug并运行测试", ["read", "edit", "bash", "runtests"]);
		expect(advice).toContain("意图识别");
		expect(advice).toContain("code");
	});
});

describe("createTool (Agent Tool interface)", () => {
	it("成功创建工具", () => {
		const tool = createTool("/tmp");
		expect(tool.name).toBe("smart-router");
		expect(tool.description).toContain("智能路由");
		expect(tool.parameters.required).toContain("action");
	});

	it("route 操作返回意图分析", async () => {
		const tool = createTool("/tmp");
		const result = await tool.execute("test-1", { action: "route", input: "修复bug并测试" });
		const text = (result.content[0] as any).text;
		expect(text).toContain("intents");
		expect(text).toContain("code");
	});

	it("chains 操作返回所有工具链", async () => {
		const tool = createTool("/tmp");
		const result = await tool.execute("test-2", { action: "chains" });
		const text = (result.content[0] as any).text;
		const parsed = JSON.parse(text);
		expect(parsed.length).toBe(TOOL_CHAINS.length);
	});

	it("classify 操作仅返回意图", async () => {
		const tool = createTool("/tmp");
		const result = await tool.execute("test-3", { action: "classify", input: "同步三机" });
		const text = (result.content[0] as any).text;
		const parsed = JSON.parse(text);
		expect(parsed.length).toBeGreaterThan(0);
		expect(parsed[0].intent).toBe("system");
	});

	it("缺少 input 参数时返回错误", async () => {
		const tool = createTool("/tmp");
		const result = await tool.execute("test-4", { action: "route" });
		expect((result.content[0] as any).text).toContain("缺少");
	});
});
