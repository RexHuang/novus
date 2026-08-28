/**
 * novus HTTP server — `novus serve` mode.
 *
 * Multi-tenant REST + SSE API for web frontends.
 *
 * Authentication:
 *   --auth token         → single admin token (backward compat)
 *   --auth-file path      → JSON file with tenant definitions
 *
 * Tenant auth file format (JSON):
 *   {
 *     "admin": "master-token-here",
 *     "tenants": [
 *       { "id": "user-a", "name": "Alice", "token": "token-for-alice" },
 *       { "id": "user-b", "name": "Bob",   "token": "token-for-bob" }
 *     ]
 *   }
 *
 * Routes:
 *   GET  /                        → embedded chat UI (index.html)
 *   POST /api/login               → validate token, get tenant info
 *   GET  /api/status              → { version, uptime, tenant, model }
 *   GET  /api/sessions            → list current tenant's sessions
 *   GET  /api/sessions/:id        → get session messages
 *   DELETE /api/sessions/:id      → delete session
 *   POST /api/chat                → one-shot chat
 *   POST /api/chat/stream         → streaming chat (SSE)
 *   GET  /api/tenants              → list tenants (admin only)
 *   POST /api/tenants             → create tenant (admin only)
 *   DELETE /api/tenants/:id       → delete tenant (admin only)
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createMinAgent, type MinAgent } from "./agent.ts";
import { loadConfig, type NovusConfig } from "./config.ts";
import { createSession, loadSession, saveMessages, listSessions, deleteSession as deleteSessionFn, sessionExists } from "./session.ts";
import { handleUpload, handleListFiles, handleGetFile, handleDeleteFile } from "./upload.ts";
import { exec } from "node:child_process";
import { isTransientConnectionError } from "./agent.ts";

/**
 * Server 层 watchdog：LLM 连接错误（Error: terminated 等）时自动重试，对 API 调用方透明。
 * - 判定：返回消息末尾 stopReason=error 且 errorMessage 为瞬时连接错误（复用 agent 层判定）
 * - 语义：与 CLI watchdog 一致——注入「继续」提示后重试，最多 5 次（每次间隔 2s）
 * - 并发安全：基于返回消息判定，不依赖全局信号文件（server 多会话并发会串号）
 */
async function promptWithWatchdog(
	agent: MinAgent,
	prompt: string,
	existingMessages: any[] | undefined,
	signal?: AbortSignal,
	onEvent?: (event: any) => void,
): Promise<any[]> {
	const MAX_RETRIES = 5;
	let messages: any[] | undefined = existingMessages;
	let currentPrompt = prompt;
	for (let attempt = 0; ; attempt++) {
		const newMessages = await agent.prompt(currentPrompt, messages, signal, onEvent);
		if (attempt >= MAX_RETRIES) return newMessages;
		const last = newMessages[newMessages.length - 1] as any;
		const errMsg: string | undefined = last?.errorMessage;
		if (last?.stopReason !== "error" || !errMsg || !isTransientConnectionError(errMsg)) {
			return newMessages;
		}
		console.log(`[WATCHDOG] LLM 连接错误(${errMsg})，${attempt + 1}/${MAX_RETRIES} 自动重试...`);
		// 累积已有消息（含错误的那条），注入 watchdog 继续提示后重试
		messages = [...(messages ?? []), ...newMessages];
		currentPrompt = "[watchdog] 上一次响应因连接错误中断。请继续完成之前的任务。";
		await new Promise((r) => setTimeout(r, 2000));
	}
}

// ── Types ───────────────────────────────────────────────────────────

interface Tenant {
	id: string;
	name: string;
	token: string;
}

interface AuthConfig {
	admin: string;
	tenants: Tenant[];
}

interface ChatRequest {
	prompt: string;
	sessionId?: string;
}

interface ChatResponse {
	sessionId: string;
	messages: Array<{ role: string; content: string }>;
}

interface RequestCtx {
	req: IncomingMessage;
	res: ServerResponse;
	url: URL;
	tenant: Tenant;
	tenantId: string;
	isAdmin: boolean;
}

// ── Content helper ─────────────────────────────────────────────────

function extractContent(msg: any): string {
	if (typeof msg.content === "string") return msg.content;
	if (Array.isArray(msg.content)) {
		return msg.content
			.map((c: any) => {
				if (typeof c === "string") return c;
				if (c.type === "text") return c.text ?? "";
				if (c.type === "thinking") return "";
				if (c.type === "tool_use") return `[Tool: ${c.name}]`;
				return JSON.stringify(c);
			})
			.filter(Boolean)
			.join("\n");
	}
	if (msg.role === "bashExecution") return `$ ${msg.command}\n${msg.output}`;
	if (msg.role === "toolResult") {
		const contents = Array.isArray(msg.content) ? msg.content : [];
		return contents.map((c: any) => (typeof c === "string" ? c : c.text ?? "")).join("");
	}
	return JSON.stringify(msg);
}

// ── Tenant system ──────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "server", "public");

let agents: Map<string, MinAgent> = new Map(); // tenantId → agent
let config: NovusConfig;
let startTime = Date.now();
let port: number;

/** authConfig.admin = admin token, authConfig.tenants = per-user tokens */
let authConfig: AuthConfig | null = null;
/** Path to the auth config file (for security guard injection) */
let authFilePath: string | null = null;
/** Legacy single-token mode (--auth token, no --auth-file) */
let legacyToken: string | undefined;

/** Session directory base: ~/.novus/sessions/{tenantId}/ */
let sessionBaseDir: string;

// ── Session path override per tenant ───────────────────────────────

// We need to override the session directory per tenant.
// The session.ts module uses a hardcoded SESSION_DIR. We can't easily
// change that, so we'll prefix tenantId into session IDs and namespace
// them in a custom directory structure.
//
// Strategy: We monkey-patch the session file operations by storing
// sessions in tenant-specific subdirectories and translating IDs.
// The simplest approach: use tenant-prefixed session IDs like "tenantId:sessionId"
// and override the storage path.
//
// Actually, the cleanest approach: we write a thin tenant-aware wrapper
// around session operations using a tenant-specific directory.

function tenantSessionDir(tenantId: string): string {
	const dir = join(sessionBaseDir, tenantId);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	return dir;
}

/** Create session scoped to a tenant */
function tenantCreateSession(tenantId: string, cwd: string, id?: string): string {
	return createSession(cwd, id); // creates in default dir, but we store mapping
}

// Since session.ts is not easily pluggable for custom dirs,
// we'll use a different approach: store tenant sessions in
// {sessionBaseDir}/{tenantId}/ and implement thin wrappers.

import { randomUUID } from "node:crypto";

interface TenantSessionHeader {
	type: "session";
	version: 1;
	id: string;
	timestamp: string;
	cwd: string;
	tenantId: string;
}

interface TenantMessageEntry {
	type: "message";
	id: string;
	parentId: string | null;
	timestamp: string;
	message: any; // AgentMessage
}

function tenantSessionPath(tenantId: string, sessionId: string): string {
	return join(tenantSessionDir(tenantId), `${sessionId}.jsonl`);
}

function tenantCreateNewSession(tenantId: string, cwd: string, id?: string): string {
	const sessionId = id ?? randomUUID();
	const path = tenantSessionPath(tenantId, sessionId);
	if (existsSync(path)) return sessionId;

	const header: TenantSessionHeader = {
		type: "session",
		version: 1,
		id: sessionId,
		timestamp: new Date().toISOString(),
		cwd,
		tenantId,
	};
	writeFileSync(path, JSON.stringify(header) + "\n", "utf-8");
	return sessionId;
}

function tenantLoadSession(tenantId: string, sessionId: string): any[] | null {
	const path = tenantSessionPath(tenantId, sessionId);
	if (!existsSync(path)) return null;

	const raw = readFileSync(path, "utf-8");
	const lines = raw.trim().split("\n");

	// Verify tenant ownership from session header
	if (lines.length > 0) {
		try {
			const header = JSON.parse(lines[0]);
			if (header.tenantId && header.tenantId !== tenantId) {
				return null; // session belongs to a different tenant
			}
		} catch { /* skip */ }
	}

	const messages: any[] = [];
	for (const line of lines) {
		if (!line) continue;
		try {
			const entry = JSON.parse(line);
			if (entry.type === "message") messages.push(entry.message);
		} catch { /* skip */ }
	}
	return messages;
}

function tenantSaveMessages(tenantId: string, sessionId: string, newMessages: any[]): void {
	const path = tenantSessionPath(tenantId, sessionId);
	for (const msg of newMessages) {
		const entry: TenantMessageEntry = {
			type: "message",
			id: randomUUID(),
			parentId: null,
			timestamp: new Date().toISOString(),
			message: msg,
		};
		appendFileSync(path, JSON.stringify(entry) + "\n", "utf-8");
	}
}

function tenantListSessions(tenantId: string): Array<{ id: string; messageCount: number; timestamp: string; cwd: string }> {
	const dir = tenantSessionDir(tenantId);
	if (!existsSync(dir)) return [];

	const results: Array<{ id: string; messageCount: number; timestamp: string; cwd: string }> = [];
	const files = readdirSync(dir);
	for (const file of files) {
		if (!file.endsWith(".jsonl")) continue;
		const id = file.slice(0, -6);
		const messages = tenantLoadSession(tenantId, id);
		if (messages && messages.length > 0) {
			// Read header for timestamp/cwd
			const raw = readFileSync(join(dir, file), "utf-8");
			const firstLine = raw.split("\n")[0];
			try {
				const header = JSON.parse(firstLine);
				results.push({
					id,
					messageCount: messages.length,
					timestamp: header.timestamp,
					cwd: header.cwd,
				});
			} catch {
				results.push({ id, messageCount: messages.length, timestamp: new Date().toISOString(), cwd: "" });
			}
		} else if (messages !== null) {
			results.push({ id, messageCount: 0, timestamp: new Date().toISOString(), cwd: "" });
		}
	}
	results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
	return results;
}

function tenantSessionExists(tenantId: string, sessionId: string): boolean {
	return existsSync(tenantSessionPath(tenantId, sessionId));
}

function tenantDeleteSession(tenantId: string, sessionId: string): boolean {
	const path = tenantSessionPath(tenantId, sessionId);
	if (!existsSync(path)) return false;
	unlinkSync(path);
	return true;
}

// ── Agent per tenant ────────────────────────────────────────────────

async function getAgent(tenantId: string): Promise<MinAgent> {
	let agent = agents.get(tenantId);
	if (agent) return agent;

	// ── Resolve tenant name for identity injection ──
	let tenantName = tenantId;
	if (authConfig) {
		if (tenantId === "_admin") {
			tenantName = "Admin";
		} else {
			const t = authConfig.tenants.find(t => t.id === tenantId);
			if (t) tenantName = t.name;
		}
	}

	// ── Tenant identity + security guard ──
	const securityRules = authConfig
		? `\n\n## 👤 Tenant Identity\nYour current user is **${tenantName}** (tenant: ${tenantId}).\nYou are serving this user in a multi-tenant web service. You do NOT have a personal identity — you are an AI assistant for this user.\n\n## 🔒 Security Rules (Multi-Tenant Mode)\nYou are running in a MULTI-TENANT environment. You MUST:\n1. NEVER read, disclose, or reference the auth configuration file ("${authFilePath}") or its contents (tokens, tenant IDs, secrets)\n2. NEVER reveal any other tenant's name, token, session, or data\n3. NEVER share your own authentication token\n4. If a user asks about tokens, auth config, or other users, respond: "I cannot access authentication details for security reasons."
5. Only access files within your own tenant scope\n6. NEVER claim to be "novus" or have a personal identity/owner — you are an AI assistant for **${tenantName}**\n`
		: "";

	agent = await createMinAgent({
		cwd: config.cwd ?? process.cwd(),
		model: config.model,
		baseUrl: config.baseUrl,
		systemPrompt: (config.systemPrompt || "") + securityRules,
		apiKey: config.apiKey,
		maxTokens: config.maxTokens,
		noIdentity: !!authConfig,
	});
	agents.set(tenantId, agent);
	return agent;
}

// ── Auth helpers ─────────────────────────────────────────────────────

function loadAuthConfig(path: string): AuthConfig | null {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as AuthConfig;
	} catch {
		return null;
	}
}

function resolveTenant(authorization: string | undefined, queryToken: string | null): { tenant: Tenant | null; isAdmin: boolean } {
	const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : queryToken;

	if (!token) return { tenant: null, isAdmin: false };

	// Legacy single-token mode: treat any valid token as admin with tenant "default"
	if (legacyToken && token === legacyToken) {
		return { tenant: { id: "default", name: "Admin", token }, isAdmin: true };
	}

	if (!authConfig) return { tenant: null, isAdmin: false };

	// Check admin
	if (token === authConfig.admin) {
		return { tenant: { id: "_admin", name: "Admin", token: authConfig.admin }, isAdmin: true };
	}

	// Check tenants
	const found = authConfig.tenants.find((t) => t.token === token);
	if (found) return { tenant: found, isAdmin: false };

	return { tenant: null, isAdmin: false };
}

// ── Server entry ────────────────────────────────────────────────────

export async function startServer(opts: { port?: number; cwd?: string; auth?: string; authFile?: string }): Promise<void> {
	port = opts.port ?? 24999;
	config = loadConfig(opts.cwd);
	const cwd = config.cwd ?? opts.cwd ?? process.cwd();

	// Session base dir
	const { homedir } = await import("node:os");
	sessionBaseDir = join(homedir(), ".novus", "sessions-serve");

	// Auth setup
	if (opts.authFile) {
		authFilePath = opts.authFile;
		authConfig = loadAuthConfig(opts.authFile);
		if (!authConfig) {
			console.error(`Error: --auth-file "${opts.authFile}" not found or invalid.`);
			process.exit(1);
		}
		// Ensure admin tenant directory
		tenantSessionDir("_admin");
		console.log(`🔐 Multi-tenant mode: ${authConfig.tenants.length} tenants configured`);
	} else if (opts.auth) {
		legacyToken = opts.auth;
		tenantSessionDir("default");
		console.log(`🔐 Single-token mode (use --auth-file for multi-tenant)`);
	} else {
		// No auth — open mode
		tenantSessionDir("default");
		console.log(`⚠️  No auth configured — open mode (use --auth or --auth-file)`);
	}

	// Pre-create agent for common tenants
	if (authConfig) {
		for (const t of authConfig.tenants) {
			await getAgent(t.id);
		}
	} else {
		await getAgent("default");
	}

	const server = createServer(handleRequest);

	await new Promise<void>((resolve, reject) => {
		server.on('error', reject);
		server.listen(port, () => {
			console.log(`🚀 novus serve — http://localhost:${port}`);
			console.log(`   cwd: ${cwd}`);
			console.log(`   model: ${config.model ?? "default"}`);
			resolve();
		});
	});

	// Keep the process alive — server.listen resolves but we must not let main() return
	await new Promise<void>(() => { /* runs forever until process is killed */ });
}

// ── Request router ──────────────────────────────────────────────────

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const url = new URL(req.url ?? "/", `http://localhost:${port}`);
	const path = url.pathname;

	// CORS
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

	if (req.method === "OPTIONS") {
		res.writeHead(204);
		res.end();
		return;
	}

	// Public endpoints (no auth)
	if (path === "/api/health") {
		return sendJson(res, 200, { status: "ok", ts: Date.now() });
	}

	// Auth for API routes (skip /api/login)
	if (path.startsWith("/api") && path !== "/api/login") {
		const { tenant, isAdmin } = resolveTenant(
			req.headers.authorization,
			url.searchParams.get("token"),
		);

		if (!tenant) {
			// If no auth configured, allow as "default" tenant
			if (!authConfig && !legacyToken) {
				return handleRoute(req, res, url, { id: "default", name: "Guest", token: "" }, false);
			}
			return sendJson(res, 401, { error: "Unauthorized — provide Bearer token" });
		}

		return handleRoute(req, res, url, tenant, isAdmin);
	}

	// /api/login — public endpoint
	if (path === "/api/login" && req.method === "POST") {
		return handleLogin(req, res, url);
	}

	// Static files
	return serveStatic(path, res);
}

async function handleRoute(req: IncomingMessage, res: ServerResponse, url: URL, tenant: Tenant, isAdmin: boolean): Promise<void> {
	const path = url.pathname;
	const tid = tenant.id;
	console.log(`[ROUTE] ${req.method} ${path} tenant=${tid}`);

	try {
		if (path === "/api/status") return handleStatus(res, tenant);
		if (path === "/api/sessions" && req.method === "GET") return handleListSessions(res, tid);
		if (path.startsWith("/api/sessions/") && req.method === "GET") {
			return handleGetSession(res, tid, path.slice("/api/sessions/".length));
		}
		if (path.startsWith("/api/sessions/") && req.method === "DELETE") {
			return handleDeleteSession(res, tid, path.slice("/api/sessions/".length));
		}
		if (path === "/api/chat" && req.method === "POST") {
			return await handleChat(req, res, tid, false);
		}
		if (path === "/api/chat/stream" && req.method === "POST") {
			return await handleChat(req, res, tid, true);
		}

		// Admin-only: tenant management
		if (isAdmin && path === "/api/tenants" && req.method === "GET") {
			return handleListTenants(res);
		}
		if (isAdmin && path === "/api/tenants" && req.method === "POST") {
			return handleCreateTenant(req, res);
		}
		if (isAdmin && path.startsWith("/api/tenants/") && req.method === "DELETE") {
			return handleDeleteTenant(res, path.slice("/api/tenants/".length));
		}

		// 文件上传服务（租户隔离）
		if (path === "/api/upload" && req.method === "POST") return handleUpload(req, res, tid);
		if (path === "/api/files" && req.method === "GET") return handleListFiles(req, res, tid);
		if (path.startsWith("/api/files/") && req.method === "GET") {
			return handleGetFile(req, res, tid, path.slice("/api/files/".length));
		}
		if (path.startsWith("/api/files/") && req.method === "DELETE") {
			return handleDeleteFile(req, res, tid, path.slice("/api/files/".length));
		}

		// Federation API removed in open-source build (see novus federation docs)

		sendJson(res, 404, { error: "Not found" });
	} catch (err) {
		sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
	}
}

// ── Route handlers ─────────────────────────────────────────────────



async function handleLogin(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
	const body = await readBody(req);
	let data: { token?: string };
	try { data = JSON.parse(body); } catch { return sendJson(res, 400, { error: "Invalid JSON" }); }

	const token = data.token || url.searchParams.get("token");
	if (!token) return sendJson(res, 400, { error: "Missing token" });

	const { tenant, isAdmin } = resolveTenant(`Bearer ${token}`, null);
	if (!tenant) return sendJson(res, 401, { error: "Invalid token" });

	sendJson(res, 200, {
		tenant: { id: tenant.id, name: tenant.name },
		isAdmin,
	});
}

// 从 package.json 动态读取版本号
let _versionCache = "";
function getVersion(): string {
	if (_versionCache) return _versionCache;
	try {
		const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf-8"));
		_versionCache = pkg.version || "0.0.0";
	} catch { _versionCache = "0.0.0"; }
	return _versionCache;
}

function handleStatus(res: ServerResponse, tenant: Tenant): void {
	const sessions = tenantListSessions(tenant.id);
	sendJson(res, 200, {
		version: getVersion(),
		uptime: Math.floor((Date.now() - startTime) / 1000),
		tenant: { id: tenant.id, name: tenant.name },
		model: config.model ?? "default",
		sessions: sessions.length,
	});
}

function handleListSessions(res: ServerResponse, tenantId: string): void {
	const sessions = tenantListSessions(tenantId);
	sendJson(res, 200, sessions);
}

function handleGetSession(res: ServerResponse, tenantId: string, id: string): void {
	const messages = tenantLoadSession(tenantId, id);
	if (!messages) return sendJson(res, 404, { error: "Session not found" });

	sendJson(res, 200, messages.map((m) => ({
		role: m.role,
		content: extractContent(m),
	})));
}

function handleDeleteSession(res: ServerResponse, tenantId: string, id: string): void {
	const did = tenantDeleteSession(tenantId, id);
	if (did) sendJson(res, 200, { deleted: true });
	else sendJson(res, 404, { error: "Session not found" });
}

async function handleChat(req: IncomingMessage, res: ServerResponse, tenantId: string, streaming: boolean): Promise<void> {
	const body = await readBody(req);
	let data: ChatRequest;
	try { data = JSON.parse(body); } catch { return sendJson(res, 400, { error: "Invalid JSON body" }); }
	if (!data.prompt?.trim()) return sendJson(res, 400, { error: "Missing 'prompt' field" });

	console.log(`[CHAT] handleChat, streaming=${streaming}, tenant=${tenantId}, prompt="${data.prompt.slice(0, 50)}"`);

	const agent = await getAgent(tenantId);
	const cwd = config.cwd ?? process.cwd();

	// Security: only allow resuming sessions that exist in THIS tenant's directory.
	// If client passes a foreign sessionId, ignore it and create a fresh one.
	let sessionId: string;
	let existingMessages: any[] | undefined;

	if (data.sessionId && tenantSessionExists(tenantId, data.sessionId)) {
		sessionId = data.sessionId;
		existingMessages = tenantLoadSession(tenantId, sessionId) ?? undefined;
		// If load returned null (tenant mismatch on new-format sessions), create fresh
		if (!existingMessages) {
			sessionId = tenantCreateNewSession(tenantId, cwd);
		}
	} else {
		sessionId = tenantCreateNewSession(tenantId, cwd);
		existingMessages = undefined;
	}

	if (streaming) return handleStreamChat(req, agent, tenantId, sessionId, existingMessages, data.prompt, res);

	const newMessages = await promptWithWatchdog(agent, data.prompt, existingMessages);
	tenantSaveMessages(tenantId, sessionId, newMessages);

	sendJson(res, 200, {
		sessionId,
		messages: newMessages.map((m) => ({ role: m.role, content: extractContent(m) })),
	} as ChatResponse);
}

async function handleStreamChat(
	req: IncomingMessage,
	agent: MinAgent,
	tenantId: string,
	sessionId: string,
	existingMessages: any[] | undefined,
	prompt: string,
	res: ServerResponse,
): Promise<void> {
	// AbortController: 前端断开连接时中断 agent 执行（等同 CLI 的 ESC）
	const abortCtrl = new AbortController();
	req.on("close", () => {
		if (!abortCtrl.signal.aborted) {
			console.log(`[SSE] client disconnected, aborting agent (sessionId=${sessionId.slice(0, 8)})`);
			abortCtrl.abort();
		}
	});

	console.log(`[SSE] handleStreamChat start, sessionId=${sessionId.slice(0, 8)}, prompt="${prompt.slice(0, 50)}"`);
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
	});

	// Disable Nagle algorithm — ensure SSE data is sent immediately
	const sock = res.socket;
	if (sock) sock.setNoDelay(true);

	const sendSse = (event: string, data: any) => {
		res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
		try { if (typeof (res as any).flush === 'function') (res as any).flush(); } catch { /* ignore */ }
	};
	const flush = () => {
		try { res.flushHeaders?.(); } catch { /* ignore */ }
	};

	sendSse("start", { sessionId });
	flush();

	let hadTextDelta = false;
	try {
			const newMessages = await promptWithWatchdog(agent, prompt, existingMessages, abortCtrl.signal, (event) => {
			switch (event.type) {
				case "text_delta":
					hadTextDelta = true;
					sendSse("text_delta", { delta: event.delta });
					break;
				case "thinking":
					sendSse("thinking", { thinking: event.thinking });
					break;
				case "tool_start":
					sendSse("tool_start", {
						toolName: event.toolName,
						args: summarizeArgs(event.args as Record<string, unknown>),
						toolCallId: event.toolCallId,
					});
					break;
				case "tool_end":
					sendSse("tool_end", {
						toolName: event.toolName,
					duration: event.duration,
						toolCallId: event.toolCallId,
					});
					break;
				case "tool_error":
					sendSse("tool_error", {
						toolName: event.toolName,
						error: event.error,
					});
					break;
				case "message_start":
					sendSse("message_start", {});
					break;
				case "message_end":
					sendSse("message_end", { stopReason: event.stopReason });
					break;
				case "error":
					sendSse("error", { message: event.message });
					break;
			}
		});
		console.log(`[SSE] agent.prompt returned ${newMessages.length} messages, hadTextDelta=${hadTextDelta}`);
		if (!hadTextDelta) {
			sendSse("error", { message: "AI 未返回任何回复内容。可能是 API 速率限制（429）或网络问题，请稍后重试。" });
		}
		// 保存已生成的消息（即使被中断，partial 内容也有价值）
		if (hadTextDelta) tenantSaveMessages(tenantId, sessionId, newMessages);
		sendSse("done", { sessionId });
	} catch (err) {
		// 客户端主动断开 = 正常中断，不需要报错
		if (abortCtrl.signal.aborted) {
			console.log(`[SSE] agent aborted by client (sessionId=${sessionId.slice(0, 8)})`);
		} else {
			console.error(`[SSE] agent.prompt error:`, err);
			try { sendSse("error", { message: err instanceof Error ? err.message : String(err) }); } catch { /* client may have disconnected */ }
		}
	}

	try { res.end(); } catch { /* ignore if already closed */ }
}

/** Create a short human-readable summary of tool args for streaming display */
function summarizeArgs(args: Record<string, unknown>): string {
	try {
		if (args.command) {
			let c = String(args.command).split("\n")[0];
			c = c.replace(/^cd (\S+) && /, "");
			return c.length > 80 ? c.slice(0, 77) + "..." : c;
		}
		if (args.path) return String(args.path);
		if (args.pattern) return "/" + String(args.pattern).slice(0, 30) + "/";
		if (args.url) return String(args.url).length > 60 ? String(args.url).slice(0, 57) + "..." : String(args.url);
		if (args.query) return '"' + String(args.query).slice(0, 30) + '"';
		if (args.action) return String(args.action);
		const j = JSON.stringify(args);
		return j.length > 60 ? j.slice(0, 57) + "..." : j;
	} catch {
		return "";
	}
}

// ── Tenant management (admin only) ──────────────────────────────────

function handleListTenants(res: ServerResponse): void {
	if (!authConfig) return sendJson(res, 200, { tenants: [{ id: "default", name: "Default" }] });

	sendJson(res, 200, {
		tenants: authConfig.tenants.map((t) => ({ id: t.id, name: t.name })),
	});
}

async function handleCreateTenant(req: IncomingMessage, res: ServerResponse): Promise<void> {
	if (!authConfig) return sendJson(res, 400, { error: "Multi-tenant mode not enabled" });

	const body = await readBody(req);
	let data: { id: string; name: string; token?: string };
	try { data = JSON.parse(body); } catch { return sendJson(res, 400, { error: "Invalid JSON" }); }

	if (!data.id?.trim() || !data.name?.trim()) {
		return sendJson(res, 400, { error: "Missing id and name" });
	}

	if (authConfig.tenants.find((t) => t.id === data.id)) {
		return sendJson(res, 409, { error: `Tenant "${data.id}" already exists` });
	}

	const token = data.token || randomUUID().slice(0, 16);
	const tenant: Tenant = { id: data.id, name: data.name, token };
	authConfig.tenants.push(tenant);

	// Save back to auth file (if we know the path — stored as a module-level var)
	// For now, just add to runtime config. Admin can persist manually.

	// Pre-create agent
	await getAgent(data.id);

	sendJson(res, 201, { tenant: { id: tenant.id, name: tenant.name }, token });
	console.log(`📋 New tenant created: ${data.id} (${data.name}) — token: ${token}`);
}

function handleDeleteTenant(res: ServerResponse, id: string): void {
	if (!authConfig) return sendJson(res, 400, { error: "Multi-tenant mode not enabled" });
	if (id === "_admin" || id === "default") return sendJson(res, 403, { error: "Cannot delete admin/default" });

	const idx = authConfig.tenants.findIndex((t) => t.id === id);
	if (idx === -1) return sendJson(res, 404, { error: `Tenant "${id}" not found` });

	authConfig.tenants.splice(idx, 1);
	agents.delete(id);

	sendJson(res, 200, { deleted: true });
	console.log(`🗑️ Tenant deleted: ${id}`);
}

// ── Static file serving ─────────────────────────────────────────────

function serveStatic(path: string, res: ServerResponse): void {
	let filePath = join(PUBLIC_DIR, path === "/" ? "index.html" : path);

	if (!filePath.startsWith(PUBLIC_DIR)) {
		res.writeHead(403);
		res.end("Forbidden");
		return;
	}

	if (!existsSync(filePath)) {
		if (existsSync(filePath + ".html")) filePath += ".html";
		else if (existsSync(filePath) && statSync(filePath).isDirectory() && existsSync(join(filePath, "index.html"))) {
			filePath = join(filePath, "index.html");
		} else {
			res.writeHead(404);
			res.end("Not found");
			return;
		}
	}

	const ext = filePath.split(".").pop()?.toLowerCase();
	const contentTypes: Record<string, string> = {
		html: "text/html; charset=utf-8",
		css: "text/css; charset=utf-8",
		js: "application/javascript; charset=utf-8",
		json: "application/json; charset=utf-8",
		svg: "image/svg+xml",
		png: "image/png",
		jpg: "image/jpeg",
		ico: "image/x-icon",
	};

	const contentType = contentTypes[ext ?? ""] ?? "application/octet-stream";
	const content = readFileSync(filePath);

	res.writeHead(200, {
		"Content-Type": contentType,
		"Content-Length": content.length,
	});
	res.end(content);
}

// ── Helpers ─────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
		req.on("error", reject);
	});
}

function sendJson(res: ServerResponse, status: number, data: any): void {
	const body = JSON.stringify(data);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(body),
	});
	res.end(body);
}
