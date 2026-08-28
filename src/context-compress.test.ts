import { describe, it, expect } from "vitest";
import { compressMessages, estimateTokens } from "./agent.ts";

/** 最小化的 AgentMessage 类型，只包含 compressMessages 用到的字段 */
interface TestMessage {
	role: string;
	content: string | Array<{ type: string; id?: string; text?: string }>;
	timestamp?: number;
	toolCallId?: string;
}

function makeUser(text: string, ts = 1000): TestMessage {
	return { role: "user", content: text, timestamp: ts };
}

function makeAssistant(text: string, ts = 1001): TestMessage {
	return { role: "assistant", content: text, timestamp: ts };
}

function makeToolCall(id: string, toolName: string, ts = 1002): TestMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: toolName }],
		timestamp: ts,
	} as any;
}

function makeToolResult(toolCallId: string, result: string, ts = 1003): TestMessage {
	return { role: "toolResult", content: result, toolCallId, timestamp: ts } as any;
}

describe("estimateTokens", () => {
	it("should estimate ~1 token per 4 chars", () => {
		expect(estimateTokens("hello world")).toBe(3); // 11 chars → ceil(11/4) = 3
		expect(estimateTokens("")).toBe(0);
		expect(estimateTokens("a")).toBe(1);
	});
});

describe("compressMessages", () => {
	it("should not compress when under threshold", () => {
		const messages: TestMessage[] = [makeUser("hi"), makeAssistant("hello")];
		const result = compressMessages(messages as any, "", 100000);
		expect(result.compressed).toBe(false);
		expect(result.messages).toHaveLength(2);
	});

	it("should not compress when under dynamic contextWindow threshold", () => {
		const messages: TestMessage[] = [makeUser("hi"), makeAssistant("hello")];
		const result = compressMessages(messages as any, "", 200000);
		expect(result.compressed).toBe(false);
	});

	it("should not compress when messages <= keepCount", () => {
		// 20 条消息 = keepCount，不应该压缩
		const messages: TestMessage[] = Array.from({ length: 20 }, (_, i) => makeUser(`msg ${i}`, 1000 + i));
		const result = compressMessages(messages as any, "", 1);
		expect(result.compressed).toBe(false);
	});

	it("should compress when over threshold with enough messages", () => {
		// 创建 30 条长消息，确保总 token 超过阈值
		const longText = "A".repeat(200); // 每条约 50 tokens
		const messages: TestMessage[] = Array.from({ length: 30 }, (_, i) =>
			i % 2 === 0 ? makeUser(longText, 1000 + i) : makeAssistant(longText, 1000 + i)
		);
		// 总 token ≈ 30 * 50 = 1500，设阈值为 1000
		const result = compressMessages(messages as any, "", 1000);
		expect(result.compressed).toBe(true);
		// 压缩后应该 = 1 条摘要 + 20 条最近消息
		expect(result.messages.length).toBeLessThanOrEqual(21);
		expect(result.messages.length).toBeGreaterThan(20);
	});

	it("should use contextWindow * 0.75 as threshold when contextWindow provided", () => {
		const longText = "B".repeat(200); // 每条约 50 tokens
		const messages: TestMessage[] = Array.from({ length: 30 }, (_, i) =>
			i % 2 === 0 ? makeUser(longText, 1000 + i) : makeAssistant(longText, 1000 + i)
		);
		// JSON化后30条 ≈ 6400 chars ≈ 1600 tokens
		// contextWindow=3000 → 阈值=2250 → 不压缩
		const result = compressMessages(messages as any, "", 3000);
		expect(result.compressed).toBe(false);

		// contextWindow=2000 → 阈值=1500 → 应该压缩
		const result2 = compressMessages(messages as any, "", 2000);
		expect(result2.compressed).toBe(true);
	});

	it("should produce a summary message as first element", () => {
		const longText = "C".repeat(200);
		const messages: TestMessage[] = Array.from({ length: 30 }, (_, i) =>
			i % 2 === 0 ? makeUser(longText, 1000 + i) : makeAssistant(longText, 1000 + i)
		);
		const result = compressMessages(messages as any, "", 1000);
		expect(result.compressed).toBe(true);
		// 第一条应该是摘要消息
		const first = result.messages[0] as any;
		expect(first.role).toBe("user");
		expect(first.content).toContain("Context compressed");
	});

	it("should include key topics from older user messages in summary", () => {
		const longText = "填充内容使token超过阈值".repeat(5);
		const messages: TestMessage[] = [
			makeUser("帮我修复登录页面的bug"),
			makeAssistant("好的，我来检查登录页面"),
			makeUser("检查一下数据库连接"),
			makeAssistant("数据库连接正常"),
			// ... 更多消息让总数 > 20
			...Array.from({ length: 20 }, (_, i) => makeUser(longText, 2000 + i)),
			...Array.from({ length: 8 }, (_, i) => makeAssistant(longText, 2001 + i)),
		];
		const result = compressMessages(messages as any, "", 1000);
		expect(result.compressed).toBe(true);
		const summary = (result.messages[0] as any).content;
		// 应该包含早期用户消息的关键词
		expect(summary).toContain("登录页面");
		expect(summary).toContain("数据库连接");
	});

	it("should keep the most recent messages intact", () => {
		const longText = "E".repeat(100); // 每条约 25 tokens
		const messages: TestMessage[] = Array.from({ length: 30 }, (_, i) =>
			i % 2 === 0 ? makeUser(`msg-${i}`, 1000 + i) : makeAssistant(`reply-${i}`, 1000 + i)
		);
		// Use low threshold to force compression (30 short messages ~375 tokens, need <500)
		const result = compressMessages(messages as any, "", 500);
		expect(result.compressed).toBe(true);

		// 最后一条消息应该保持不变
		const last = result.messages[result.messages.length - 1] as any;
		expect(last.content).toBe("reply-29");
		// 倒数第二条也应该是原始消息
		const secondLast = result.messages[result.messages.length - 2] as any;
		expect(secondLast.content).toBe("msg-28");
	});

	it("should handle toolCall/toolResult pairs correctly", () => {
		const messages: TestMessage[] = [
			// 早期消息
			makeUser("检查服务器状态", 1000),
			makeAssistant("好的", 1001),
			// 大量中间消息（确保超过 20 条）
			...Array.from({ length: 18 }, (_, i) => makeUser(`task-${i}`, 2000 + i)),
			// 最近的 toolCall + toolResult（应该在 recent 中保留配对）
			makeUser("读取日志文件", 3000),
			makeToolCall("tc-1", "read", 3001),
			makeToolResult("tc-1", "日志内容: OK", 3002),
		];
		// 总 22 条，阈值设为很低以强制压缩
		const result = compressMessages(messages as any, "", 100);
		expect(result.compressed).toBe(true);

		// toolResult 应该有配对的 toolCall
		const recentMessages = result.messages.slice(1); // 跳过摘要
		const toolResults = recentMessages.filter(m => m.role === "toolResult");
		const toolCallIds = new Set(
			recentMessages
				.filter(m => m.role === "assistant")
				.flatMap(m => {
					const c = (m as any).content;
					return Array.isArray(c) ? c.filter((b: any) => b.type === "toolCall").map((b: any) => b.id) : [];
				})
		);
		// 每个 toolResult 都应有对应的 toolCall
		for (const tr of toolResults) {
			expect(toolCallIds.has((tr as any).toolCallId)).toBe(true);
		}
	});

	it("should not lose messages when total is small", () => {
		const messages: TestMessage[] = [
			makeUser("你好"),
			makeAssistant("你好！"),
			makeUser("再见"),
			makeAssistant("再见！"),
		];
		const result = compressMessages(messages as any, "", 200000);
		expect(result.compressed).toBe(false);
		expect(result.messages).toHaveLength(4);
	});

	it("should handle empty messages array", () => {
		const result = compressMessages([] as any, "", 100000);
		expect(result.compressed).toBe(false);
		expect(result.messages).toHaveLength(0);
	});

	it("should handle undefined existingMessages gracefully", () => {
		// 这是实际场景中的防御性测试
		const result = compressMessages(undefined as any, "", 200000);
		expect(result.compressed).toBe(false);
	});
});
