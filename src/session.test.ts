import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

import {
	createSession,
	sessionExists,
	loadSession,
	saveMessages,
	deleteSession,
	listSessions,
	getLastSessionId,
	getSessionMeta,
} from "./session.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

const testCwd = "/tmp/novus-test";
	
/** Generate a unique test session ID */
function testId(): string {
	return `test-${randomUUID().slice(0, 8)}`;
}

describe("Session persistence", () => {
	const ids: string[] = [];

	afterEach(() => {
		for (const id of ids) {
			try { deleteSession(id); } catch { /* ignore */ }
		}
		ids.length = 0;
	});

	it("creates a session and verifies it exists", () => {
		const id = createSession(testCwd);
		ids.push(id);

		expect(id).toBeTruthy();
		expect(sessionExists(id)).toBe(true);
	});

	it("creates a named session with a custom ID", () => {
		const customId = testId();
		const returned = createSession(testCwd, customId);
		ids.push(customId);

		expect(returned).toBe(customId);
		expect(sessionExists(customId)).toBe(true);
	});

	it("returns the same ID for an existing named session", () => {
		const customId = testId();
		createSession(testCwd, customId);
		ids.push(customId);

		const returned = createSession(testCwd, customId);
		expect(returned).toBe(customId);
	});

	it("saves and loads messages", () => {
		const id = createSession(testCwd);
		ids.push(id);

		const msg1: AgentMessage = { role: "user", content: "hello", timestamp: Date.now() };
		const msg2 = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "hi there" }],
			timestamp: Date.now(),
		} as AgentMessage;
		const messages = [msg1, msg2];

		saveMessages(id, messages);

		const loaded = loadSession(id);
		expect(loaded).not.toBeNull();
		expect(loaded!.length).toBe(2);
		expect(loaded![0]!.role).toBe("user");
		expect(loaded![1]!.role).toBe("assistant");
	});

	it("returns null for non-existent session", () => {
		expect(loadSession("nonexistent-id")).toBeNull();
	});

	it("deletes a session", () => {
		const id = createSession(testCwd);
		ids.push(id);

		expect(sessionExists(id)).toBe(true);
		const deleted = deleteSession(id);
		expect(deleted).toBe(true);
		expect(sessionExists(id)).toBe(false);
	});

	it("returns false when deleting non-existent session", () => {
		expect(deleteSession("nonexistent-id")).toBe(false);
	});

	it("lists sessions with metadata", () => {
		const id = createSession(testCwd);
		ids.push(id);

		const sessions = listSessions();
		const found = sessions.find((s) => s.id === id);
		expect(found).toBeDefined();
		expect(found!.cwd).toBe(testCwd);
		expect(found!.messageCount).toBe(0);
	}, 30000);

	it("gets session metadata", () => {
		const id = createSession(testCwd);
		ids.push(id);

		const meta = getSessionMeta(id);
		expect(meta).not.toBeNull();
		expect(meta!.id).toBe(id);
		expect(meta!.cwd).toBe(testCwd);
	});

	it("getLastSessionId returns a session after one is created", () => {
		const id = createSession(testCwd);
		ids.push(id);

		const lastId = getLastSessionId();
		expect(lastId).toBeTruthy();
	});

	it("sessionExists returns false for non-existent session", () => {
		expect(sessionExists("definitely-not-real-12345")).toBe(false);
	});
});

// ── Restart Recovery Tests ──────────────────────────────────────

import { saveContext, loadContext, clearContext, getContextSummary } from "./tools/custom/session-context.ts";
import { saveState, loadState, getLastWorklog, type WorklogEntry, type WorklogState } from "./tools/custom/session-worklog.ts";

describe("Restart recovery", () => {
	// Save and restore production state to prevent test contamination
	let origWorklogState: WorklogState | null = null;
	let origContext: any = null;

	beforeAll(() => {
		origWorklogState = loadState();
		origContext = loadContext();
	});

	afterAll(() => {
		if (origWorklogState) {
			saveState(origWorklogState);
		}
		if (origContext && origContext.activity) {
			saveContext(origContext);
		} else {
			clearContext();
		}
	});

	afterEach(() => {
		clearContext();
	});

	it("session-context survives write → read cycle (simulated restart)", () => {
		saveContext({
			activity: "修复上传文件功能",
			detail: "文件选择器 OK，上传接口 502",
			step: "排查后端接口",
			files: ["src/upload.ts"],
			nextStep: "检查 nginx 日志",
			status: "working",
			timestamp: new Date().toISOString(),
		});

		// Simulate restart: loadContext reads the file fresh
		const ctx = loadContext();
		expect(ctx).not.toBeNull();
		expect(ctx!.activity).toBe("修复上传文件功能");
		expect(ctx!.status).toBe("working");
		expect(ctx!.files).toContain("src/upload.ts");
		expect(ctx!.nextStep).toBe("检查 nginx 日志");
	});

	it("getContextSummary returns readable string after write", () => {
		saveContext({
			activity: "部署到生产环境",
			nextStep: "更新 DNS 记录",
			status: "working",
			timestamp: new Date().toISOString(),
		});

		const summary = getContextSummary();
		expect(summary).not.toBeNull();
		expect(summary!).toContain("部署到生产环境");
		expect(summary!).toContain("更新 DNS 记录");
		expect(summary!).toContain("🔄"); // working icon
	});

	it("getLastWorklog falls back to current when lastSession is null", () => {
		// Simulate state after restart: current still has old data, lastSession is null
		const state: WorklogState = {
			current: {
				timestamp: new Date().toISOString(),
				sessionId: "old-session-123",
				activity: "重构认证模块",
				changes: "JWT → session token",
				step: "完成 token 生成逻辑",
				files: ["src/auth.ts"],
				nextStep: "写单元测试",
				status: "working",
			},
			lastSession: null,
		};
		saveState(state);

		const worklog = getLastWorklog();
		expect(worklog).not.toBe("");
		expect(worklog).toContain("重构认证模块");
		expect(worklog).toContain("JWT → session token");
		expect(worklog).toContain("写单元测试");
	});

	it("getLastWorklog prefers lastSession over current when both exist", () => {
		const state: WorklogState = {
			current: {
				timestamp: new Date().toISOString(),
				sessionId: "new-session-456",
				activity: "新任务：优化性能",
				status: "working",
			},
			lastSession: {
				timestamp: new Date(Date.now() - 3600000).toISOString(),
				sessionId: "old-session-123",
				activity: "旧任务：重构认证模块",
				changes: "JWT → session token",
				status: "done",
			},
		};
		saveState(state);

		const worklog = getLastWorklog();
		expect(worklog).toContain("重构认证模块"); // prefers lastSession
		expect(worklog).not.toContain("优化性能");
	});

	it("worklog with 'done' status is still recoverable", () => {
		const state: WorklogState = {
			current: null,
			lastSession: {
				timestamp: new Date().toISOString(),
				sessionId: "completed-session",
				activity: "修复内存泄漏",
				changes: "闭包引用 → WeakRef",
				status: "done",
				checkpoint: "cp_120000",
			},
		};
		saveState(state);

		const worklog = getLastWorklog();
		expect(worklog).not.toBe("");
		expect(worklog).toContain("修复内存泄漏");
		expect(worklog).toContain("Checkpoint: cp_120000");
	});
});
