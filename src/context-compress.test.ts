import { describe, it, expect } from "vitest";
import { compressMessages, estimateTokens } from "./agent.ts";

/** Minimal AgentMessage type, only fields used by compressMessages */
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
		// 20 messages = keepCount, should NOT compress
		const messages: TestMessage[] = Array.from({ length: 20 }, (_, i) => makeUser(`msg ${i}`, 1000 + i));
		const result = compressMessages(messages as any, "", 1);
		expect(result.compressed).toBe(false);
	});

	it("should compress when over threshold with enough messages", () => {
		// create 30 long messages, ensure total tokens exceed the threshold
		const longText = "A".repeat(200); // ~50 tokens each
		const messages: TestMessage[] = Array.from({ length: 30 }, (_, i) =>
			i % 2 === 0 ? makeUser(longText, 1000 + i) : makeAssistant(longText, 1000 + i)
		);
		// total tokens ≈ 30 * 50 = 1500, set threshold to 1000
		const result = compressMessages(messages as any, "", 1000);
		expect(result.compressed).toBe(true);
		// after compression: 1 summary + 20 recent messages
		expect(result.messages.length).toBeLessThanOrEqual(21);
		expect(result.messages.length).toBeGreaterThan(20);
	});

	it("should use contextWindow * 0.75 as threshold when contextWindow provided", () => {
		const longText = "B".repeat(200); // ~50 tokens each
		const messages: TestMessage[] = Array.from({ length: 30 }, (_, i) =>
			i % 2 === 0 ? makeUser(longText, 1000 + i) : makeAssistant(longText, 1000 + i)
		);
		// JSON-serialized 30 messages ≈ 6400 chars ≈ 1600 tokens
		// contextWindow=3000 → threshold=2250 → should NOT compress
		const result = compressMessages(messages as any, "", 3000);
		expect(result.compressed).toBe(false);

		// contextWindow=2000 → threshold=1500 → should compress
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
		// first message should be the summary
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
			// ... more messages to push total > 20
			...Array.from({ length: 20 }, (_, i) => makeUser(longText, 2000 + i)),
			...Array.from({ length: 8 }, (_, i) => makeAssistant(longText, 2001 + i)),
		];
		const result = compressMessages(messages as any, "", 1000);
		expect(result.compressed).toBe(true);
		const summary = (result.messages[0] as any).content;
		// should contain keywords from early user messages
		expect(summary).toContain("登录页面");
		expect(summary).toContain("数据库连接");
	});

	it("should keep the most recent messages intact", () => {
		const longText = "E".repeat(100); // ~25 tokens each
		const messages: TestMessage[] = Array.from({ length: 30 }, (_, i) =>
			i % 2 === 0 ? makeUser(`msg-${i}`, 1000 + i) : makeAssistant(`reply-${i}`, 1000 + i)
		);
		// Use low threshold to force compression (30 short messages ~375 tokens, need <500)
		const result = compressMessages(messages as any, "", 500);
		expect(result.compressed).toBe(true);

		// last message should stay untouched
		const last = result.messages[result.messages.length - 1] as any;
		expect(last.content).toBe("reply-29");
		// second-to-last should also be an original message
		const secondLast = result.messages[result.messages.length - 2] as any;
		expect(secondLast.content).toBe("msg-28");
	});

	it("should handle toolCall/toolResult pairs correctly", () => {
		const messages: TestMessage[] = [
			// early messages
			makeUser("检查服务器状态", 1000),
			makeAssistant("好的", 1001),
			// lots of middle messages (ensure > 20 total)
			...Array.from({ length: 18 }, (_, i) => makeUser(`task-${i}`, 2000 + i)),
			// recent toolCall + toolResult (the pair should survive in recent)
			makeUser("读取日志文件", 3000),
			makeToolCall("tc-1", "read", 3001),
			makeToolResult("tc-1", "日志内容: OK", 3002),
		];
		// 22 messages total, very low threshold to force compression
		const result = compressMessages(messages as any, "", 100);
		expect(result.compressed).toBe(true);

		// each toolResult should have its paired toolCall
		const recentMessages = result.messages.slice(1); // skip the summary
		const toolResults = recentMessages.filter(m => m.role === "toolResult");
		const toolCallIds = new Set(
			recentMessages
				.filter(m => m.role === "assistant")
				.flatMap(m => {
					const c = (m as any).content;
					return Array.isArray(c) ? c.filter((b: any) => b.type === "toolCall").map((b: any) => b.id) : [];
				})
		);
		// every toolResult should have a matching toolCall
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
		// defensive test for a real-world scenario
		const result = compressMessages(undefined as any, "", 200000);
		expect(result.compressed).toBe(false);
	});
});
