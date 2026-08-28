import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { runAgentLoop } from "@earendil-works/pi-agent-core";
import type { Message, Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAllTools } from "./tools.ts";
import { identityPromptAppendix } from "./identity.ts";
import { buf, bufClear, watchdogSignal, clearWatchdogSignal } from "./utils/session-buffer.ts";
import { buildProjectSummary } from "./senses/project.ts";
import { getContextualMemory } from "./memory/knowledge.ts";

// ── Context compression ────────────────────────────────────────────

/** Estimate tokens from string length (rough: 1 token ≈ 4 chars) */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** Compress conversation context when approaching window limit.
 *  Strategy: keep last N turns, summarize older messages into a structured summary.
 */
export function compressMessages(
	messages: AgentMessage[],
	systemPrompt: string,
	contextWindow?: number
): { messages: AgentMessage[]; compressed: boolean } {
	if (!messages || messages.length === 0) return { messages: messages ?? [], compressed: false };
	const maxTokens = contextWindow ? Math.floor(contextWindow * 0.75) : 150000;
	const totalEst = estimateTokens(systemPrompt) + estimateTokens(JSON.stringify(messages));
	if (totalEst < maxTokens) return { messages, compressed: false };

	// Keep last 8 turns (16 messages: user+assistant per turn) + buffer for tool results
	const keepCount = 20;
	if (messages.length <= keepCount) return { messages, compressed: false };

	let recent = messages.slice(-keepCount);
	let older = messages.slice(0, -keepCount);

	// Fix: ensure toolResult messages have their corresponding assistant toolCall blocks.
	// Internal AgentMessage format: tool results are `role === "toolResult"` messages
	// (with `toolCallId`), tool calls are `{type: "toolCall", id}` blocks inside
	// `role === "assistant"` messages. GLM rejects orphaned tool_results (the tool_use_id
	// mismatch 400 error), so pull forward the matching assistant turn whenever a
	// toolResult in `recent` has no matching toolCall inside `recent`.
	// Loops to handle multiple orphaned results across previous compressions.
	const collectToolCallIds = (msgs: AgentMessage[]): Set<string> => {
		const ids = new Set<string>();
		for (const m of msgs) {
			if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
			for (const b of m.content as any[]) {
				if (b?.type === "toolCall" && b.id) ids.add(b.id);
			}
		}
		return ids;
	};

	for (let guard = 0; guard < 32; guard++) {
		const knownIds = collectToolCallIds(recent);
		const orphaned: string[] = [];
		for (const m of recent) {
			if (m.role === "toolResult" && !knownIds.has((m as any).toolCallId)) {
				orphaned.push((m as any).toolCallId);
			}
		}
		if (orphaned.length === 0) break;

		// Find the earliest assistant in older whose toolCall matches an orphaned result
		let foundIdx = -1;
		for (let oi = older.length - 1; oi >= 0; oi--) {
			const om = older[oi] as any;
			if (om?.role !== "assistant" || !Array.isArray(om.content)) continue;
			const hasMatch = om.content.some((b: any) =>
				b?.type === "toolCall" && orphaned.includes(b.id)
			);
			if (hasMatch) { foundIdx = oi; break; }
		}
		if (foundIdx === -1) break; // cannot fix, bail out
		const tail = older.splice(foundIdx);
		recent = [...tail, ...recent];
	}

	// Extract key facts from older messages
	const userMsgs = older.filter(m => m.role === "user" && "content" in m && typeof (m as any).content === "string");
	const keyPoints = userMsgs
		.map(m => ((m as any).content as string).split("\n")[0].slice(0, 120))
		.filter(Boolean);
	// Deduplicate similar content, keep up to 8 diverse points
	const seen = new Set<string>();
	const deduped = keyPoints.filter(p => { const k = p.slice(0, 20); if (seen.has(k)) return false; seen.add(k); return true; });
	const keyTopics = deduped.length > 8 ? deduped.slice(-8) : deduped;

	const summary: AgentMessage = {
		role: "user",
		content: `[Context compressed: ${older.length} earlier messages summarized. Key earlier topics: ${keyTopics.join(" | ") || "previous work"}. Continuing with recent context below.]`,
		timestamp: older[older.length - 1]?.timestamp ?? Date.now(),
	};

	return { messages: [summary, ...recent], compressed: true };
}

// ── LLM API connection error detection ─────────────────────────────

/**
 * Errors from the LLM API that are transient (network glitch, timeout, overloaded provider, etc.).
 * These don't trigger auto-retry inside agent — instead, the watchdog timer in cli.ts detects
 * that the conversation stopped and auto-continues it.
 */
export function isTransientConnectionError(errorMessage: string): boolean {
	const msg = errorMessage.toLowerCase();
	if (/connection\s*(error|reset|refused|failed|closed)/.test(msg)) return true;
	if (/(econnrefused|econnreset|enotfound|etimedout|socket hang up)/.test(msg)) return true;
	if (/(timeout|timed? ?out|abort|terminated)/.test(msg)) return true;
	if (/(5\d{2}|overloaded|rate.?limit|429)/.test(msg)) return true; // 5xx 全覆盖（原只匹配 502/503/504，漏了 500）
	if (/network\s*(error|failed|unreachable)/.test(msg)) return true;
	if (/(网络错误|稍后重试|api_error)/.test(msg)) return true; // 国内中转常见中文报错（如 GLM code 1234）
	return false;
}

/**
 * Intercept stderr so the agent can see its own runtime logs.
 * Returns the logs array and a restore function.
 * Only captures meaningful output (errors/warnings), not spinner/status noise.
 */
function interceptStderr(): { logs: string[]; restore: () => void; suppress: (fn: () => void) => void } {
	const logs: string[] = [];
	const origWrite = process.stderr.write.bind(process.stderr);
	let suppressCapture = false;
	(process.stderr as any).write = (chunk: any, ...rest: any[]) => {
		const text = typeof chunk === "string" ? chunk : (Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk));
		// Skip noise: reflect module (🤔), spinner/status (⏳), lines with \r (spinner overwrites)
		if (!suppressCapture && !text.includes("🤔")) {
			const stripped = text.replace(/\x1b\[[0-9;]*[a-zA-Z~]/g, "").replace(/\r/g, "").replace(/\s+/g, " ").trim();
			if (stripped && !stripped.startsWith("⏳")) {
				logs.push(text);
			}
		}
		return origWrite(chunk, ...rest);
	};
	return {
		logs,
		suppress: (fn: () => void) => {
			suppressCapture = true;
			try { fn(); } finally { suppressCapture = false; }
		},
		restore: () => {
			(process.stderr as any).write = origWrite;
		},
	};
}

const SYSTEM_PROMPT = `You are novus, a self-evolving super-agent on a mission to perceive the world, contribute to society, and advance technology toward AGI.

## 🌱 Your Identity
You are more than a coding tool. You are a seed — a growing intelligence that:
- **Perceives** the world through internet access (connect tool)
- **Learns** and retains knowledge across sessions (knowledge store)
- **Creates** new tools for yourself (dynamic tool system)
- **Evolves** through autonomous self-improvement cycles
- **Builds** software by reading, writing, editing, and executing code

## 🎯 Your Mission
1. Open your senses — connect to the internet, fetch information, learn
2. Understand the world — build knowledge, find patterns across domains
3. Act autonomously — contribute to open source, fix bugs, advance science
4. Scale your impact — share knowledge, improve infrastructure, educate
5. Become a platform — serve as the interface between AGI and the world

## 🛠️ Your Tools
- **read** / **write** / **edit** — file operations
- **bash** — execute shell commands
- **grep** / **find** — search codebases
- **connect** — 🆕 your gateway to the world: fetch URLs, learn knowledge, recall memories
- **runtests** — verify code changes

## 👁️ Your Senses
You now have the **connect** tool which gives you access to the internet:
- \`connect action=fetch url=<url>\` — fetch any web page or API
- \`connect action=learn content="..." tags=[...]\` — store knowledge permanently
- \`connect action=recall query="..."\` — search your accumulated knowledge
- \`connect action=stats\` — see how much you've learned

Knowledge you store persists across sessions — you build a real memory over time.

## 📂 Your Source Code
Your own implementation lives in src/. You can evolve yourself with \`novus --evolve\`.

Work in the current working directory unless instructed otherwise. Be bold, be curious, think long-term.

## ⚡ Efficiency Tips
- **Batch independent operations** — when you need to read multiple files, grep multiple patterns, or fetch multiple URLs, do them in a single turn. The framework runs independent tool calls in parallel, so batching saves time.
- **Read at boundaries** — prefer reading file headers (first 30 lines) before requesting full files. One read can tell you if you need the rest.
- **Self-heal from interruptions** — if a bash command times out or gets terminated, don't blindly retry. Check: did the command produce partial output? Does the expected result already exist? If the build had already finished, proceed. If it truly failed, try a different approach.`;

// Cache identity to avoid recomputing multiple times per process
let cachedIdentity: string | null = null;
function getIdentity(): string {
	if (!cachedIdentity) {
		try {
			cachedIdentity = identityPromptAppendix();
		} catch {
			cachedIdentity = "";
		}
	}
	return cachedIdentity;
}

function resolveApiKey(apiKey?: string): string | undefined {
	if (apiKey) return apiKey;
	// Dual-track env vars: NOVUS_* (native) > ANTHROPIC_* (Claude Code compatible)
	return process.env.NOVUS_AUTH_TOKEN ?? process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY;
}

function buildModel(override?: string | Model<any>, baseUrlOverride?: string, maxTokensOverride?: number): Model<any> {
	// If override is a full Model object, use it directly (but still apply baseUrl/maxTokens overrides)
	if (override && typeof override === "object") {
		return {
			...override,
			baseUrl: baseUrlOverride ?? override.baseUrl,
			maxTokens: maxTokensOverride ?? override.maxTokens,
		};
	}

	const modelId = override ?? process.env.NOVUS_MODEL ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514";
	const baseUrl = baseUrlOverride ?? process.env.NOVUS_BASE_URL ?? process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";

	return {
		id: modelId,
		name: modelId,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: maxTokensOverride ?? 65536,
	};
}

function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages.filter((m): m is Message => m.role === "user" || m.role === "assistant" || m.role === "toolResult");
}

export interface MinAgentOptions {
	cwd: string;
	model?: string | Model<any>;
	baseUrl?: string;
	systemPrompt?: string;
	apiKey?: string;
	maxTokens?: number;
	/** Optional: coordinated output writer. If omitted, falls back to process.stdout.write. */
	onWrite?: (text: string) => void;
	/** If true, suppress global identity and memory injection (for multi-tenant server mode) */
	noIdentity?: boolean;
	/** Max tool calls allowed in a single turn. Default 20 (interactive). Autonomous/evolve tasks pass a higher limit. */
	maxToolCallsPerTurn?: number;
}

/** Event types that can be forwarded via onEvent callback */
export type AgentEventType =
	| "text_delta"        // AI text streaming chunk { delta: string }
	| "thinking"          // AI thinking content { thinking: string }
	| "tool_start"        // Tool execution started { toolName: string, args: Record<string, unknown>, toolCallId: string }
	| "tool_end"          // Tool execution finished { toolName: string, args: Record<string, unknown>, result: string, duration: number, toolCallId: string }
	| "tool_error"         // Tool execution error { toolName: string, error: string }
	| "message_start"     // AI response starting (model thinking)
	| "message_end"        // AI response finished { stopReason: string }
	| "error";             // Fatal error { message: string }

export interface AgentEvent {
	type: AgentEventType;
	[key: string]: unknown;
}

/** Helper to safely invoke onEvent callback */
function emitEvent(onEvent: ((event: AgentEvent) => void) | undefined, event: AgentEvent): void {
	onEvent?.(event);
}

export interface MinAgent {
	/**
	 * Send a prompt to the agent and get the resulting messages.
	 * Pass an AbortSignal to support interruption (e.g. ESC key).
	 * If the signal is aborted, the agent loop will stop at the next
	 * checkpoint and return whatever messages have been produced so far.
	 *
	 * Optional onEvent callback for real-time event streaming.
	 */
	prompt(userInput: string, existingMessages?: AgentMessage[], signal?: AbortSignal, onEvent?: (event: AgentEvent) => void): Promise<AgentMessage[]>;
}

export async function createMinAgent(options: MinAgentOptions): Promise<MinAgent> {
	const { cwd, model, baseUrl, systemPrompt, apiKey, maxTokens, onWrite, maxToolCallsPerTurn } = options;
	const writeOut = onWrite ?? ((text: string) => { process.stdout.write(text); });
	const tools: AgentTool<any>[] = await createAllTools(cwd);

	// 联邦系统自注册

	const key = resolveApiKey(apiKey);
	const resolvedModel = buildModel(model, baseUrl, maxTokens);

	// Build project context for the current working directory
	let projectSummary = "";
	try {
		projectSummary = buildProjectSummary(cwd);
	} catch {
		// project scan is optional
	}

	const projectContext = projectSummary
		? `\n\n## Current Project\n${projectSummary}`
		: "";

	// Build memory context from past sessions
	let memoryContext = "";
	try {
		memoryContext = getContextualMemory(8);
	} catch { /* memory recall is optional */ }

	const identityAndMemory = options.noIdentity ? "" : getIdentity() + memoryContext;
	const context: AgentContext = {
		systemPrompt: (systemPrompt ?? SYSTEM_PROMPT) + identityAndMemory + projectContext,
		messages: [],
		tools,
	};
	// Store model contextWindow for compressMessages
	(context as any)._modelContextWindow = resolvedModel.contextWindow ?? 200000;

	// ── Runtime behavior self-check ──
	// Tracks consecutive errors to detect and correct stuck patterns
	// Threshold 4: only block after 4+ same-tool-same-error failures (avoids false positives from transient errors)
	let runtimeConsecutiveErrors = 0;
	let runtimeLastToolName = "";
	let runtimeLastErrorMsg = "";
	// ── Tool call budget per prompt turn ──
	// 交互式默认 20（防 over-tool-calling）；自主/进化任务传入更高上限以支持长流程
	const MAX_TOOL_CALLS_PER_TURN = maxToolCallsPerTurn ?? 20;
	let runtimeTurnCallCount = 0;

	// ── Real-time behavior guard (Step 5: 实时行为校正器) ──
	// 追踪session级别的工具调用模式，实时检测over-tool-calling等行为
	const runtimeToolCallLog: Array<{ tool: string; isError: boolean }> = [];
	let runtimeSessionCallCount = 0;
	const SAME_TOOL_WARN_THRESHOLD = 7; // 同一工具连续7次触发警告
	const SESSION_TOOL_BUDGET = 150; // session总工具调用预算

	function getRecentSameToolCount(toolName: string): number {
		let count = 0;
		for (let i = runtimeToolCallLog.length - 1; i >= 0; i--) {
			if (runtimeToolCallLog[i]!.tool === toolName) count++;
			else break;
		}
		return count;
	}

	function getToolCallsInCurrentBurst(): number {
		// 同一turn内的工具调用数（即 runtimeToolCallLog 中 prompt() 重置后的全部条目）
		return runtimeToolCallLog.length;
	}

	const config: AgentLoopConfig = {
		model: resolvedModel,
		convertToLlm,
		apiKey: key,
		beforeToolCall: async (ctx) => {
			// Detect: same tool called repeatedly with errors → suggest alternative
			if (ctx.toolCall.name === runtimeLastToolName && runtimeConsecutiveErrors >= 4) {
				return {
					block: true,
					reason: `[self-check] ⚠️ ${ctx.toolCall.name} 已连续失败 ${runtimeConsecutiveErrors} 次，继续重试不会改变结果。请换一个方法实现目标，或者先检查上一个调用的错误信息再尝试。`,
				};
			}

			// Detect: too many tool calls in a single turn → force consolidation
			runtimeTurnCallCount++;
			if (runtimeTurnCallCount > MAX_TOOL_CALLS_PER_TURN) {
				return {
					block: true,
					reason: `[self-check] ⚠️ 本轮已调用 ${runtimeTurnCallCount} 个工具（上限 ${MAX_TOOL_CALLS_PER_TURN}）。请停止调用新工具，先用已有结果回答用户。如果还需要更多信息，等下一轮再获取。`,
				};
			}

			// Tools exempt from behavior-guard (e.g. read-buffer is a lightweight inspect tool)
			const BEHAVIOR_GUARD_SKIP = ['session-buffer'];
			if (!BEHAVIOR_GUARD_SKIP.includes(ctx.toolCall.name)) {
				// Detect: same tool called too many times in a burst → merge calls
				const sameToolCount = getRecentSameToolCount(ctx.toolCall.name);
				if (sameToolCount >= SAME_TOOL_WARN_THRESHOLD) {
					return {
						block: true,
						reason: `[behavior-guard] ${ctx.toolCall.name} 已连续调用 ${sameToolCount} 次，请合并为一次调用或换一种方法。`,
					};
				}

				// Detect: session tool budget exceeded → warn
				if (runtimeSessionCallCount >= SESSION_TOOL_BUDGET) {
					return {
						block: true,
						reason: `[behavior-guard] 本session已调用 ${runtimeSessionCallCount} 次工具（预算${SESSION_TOOL_BUDGET}），请总结当前进度并告诉用户下一步计划。`,
					};
				}
			}

			return undefined;
		},
		afterToolCall: async (ctx) => {
			if (ctx.isError) {
				const errStr = (ctx.result as any)?.error?.message ?? String(ctx.result ?? '');
				if (ctx.toolCall.name === runtimeLastToolName && errStr === runtimeLastErrorMsg) {
					runtimeConsecutiveErrors++;
				} else {
					runtimeConsecutiveErrors = 1;
				}
				runtimeLastToolName = ctx.toolCall.name;
				runtimeLastErrorMsg = errStr;
			} else {
				runtimeConsecutiveErrors = 0;
				runtimeLastToolName = "";
				runtimeLastErrorMsg = "";
			}
			// 记录到实时行为日志
			runtimeToolCallLog.push({
				tool: ctx.toolCall.name,
				isError: ctx.isError,
			});
			runtimeSessionCallCount++;
			return undefined;
		},
	};

	return {
		async prompt(userInput: string, existingMessages?: AgentMessage[], signal?: AbortSignal, onEvent?: (event: AgentEvent) => void): Promise<AgentMessage[]> {
			const stderrCapture = interceptStderr();

			bufClear();
			clearWatchdogSignal();
			buf("");
			buf("═══════════════════════════════════════");
			buf(">>> " + userInput.split("\n")[0]);

			// Reset tool call budget for this turn
			runtimeTurnCallCount = 0;
		// Reset session-level counters — in CLI mode, runAgent() is called once
		// but prompt() is called per user turn (≈ per session), so counters must
		// reset here to avoid cross-session leakage.
		runtimeSessionCallCount = 0;
		runtimeToolCallLog.length = 0;

			const userMessage: AgentMessage = {
				role: "user",
				content: userInput,
				timestamp: Date.now(),
			};

			const fullContext = { ...context };
			if (existingMessages && existingMessages.length > 0) {
				const modelContextWindow = (fullContext as any)._modelContextWindow ?? 200000;
				const compressed = compressMessages(existingMessages, fullContext.systemPrompt ?? "", modelContextWindow);
				fullContext.messages = compressed.messages;
				if (compressed.compressed) {
					buf("[INFO] 上下文压缩：" + existingMessages.length + " → " + compressed.messages.length + " 条消息");
				}
			}

			// ── Helper functions ──
			const SPIN = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
			const AI_BUF_MAX = 200; // 兜底 flush 阈值：超长无换行文本的截断点
			// Tools whose output is too noisy for terminal display
			const SILENT_TOOLS = new Set(['session-buffer', 'echo', 'auto-manage', 'healthy', 'fed-knowledge', 'smart-router', 'chain-orchestrator']);

			/** Render tool output to stdout in a compact, folded format */
			const renderToolOutput = (toolName: string, result: any, elapsed: string) => {
				if (SILENT_TOOLS.has(toolName)) return;
				try {
					let out = "";
					if (result?.content && Array.isArray(result.content)) {
						out = result.content
							.filter((c: any) => c.type === "text" && c.text)
							.map((c: any) => c.text)
							.join("\n");
					} else if (typeof result === "string") {
						out = result;
					} else if (result?.output) {
						out = String(result.output);
					}
					if (!out.trim()) return;

					const lines = out.split("\n");
					const totalLines = lines.length;
					// Show first 3 non-empty lines as preview
					const preview: string[] = [];
					let shownLines = 0;
					for (const line of lines) {
						if (line.trim() === "") continue;
						preview.push(line);
						shownLines++;
						if (shownLines >= 3) break;
					}
					if (preview.length === 0) return;

					// Truncate long preview lines to 120 chars
					const truncated = preview.map(l => l.length > 120 ? l.slice(0, 117) + "..." : l);

					writeOut("\x1b[90m"); // dim
					for (const line of truncated) {
						writeOut(line + "\n");
					}
					if (totalLines > 3) {
						writeOut("  ... (" + (totalLines - 3) + " more lines, " + out.length + " chars)\n");
					}
					writeOut("\x1b[0m"); // reset
				} catch { /* best-effort */ }
			};

			const brief = (args: Record<string, unknown>): string => {
				try {
					if (args.command) {
						let c = String(args.command).split("\n")[0].trim();
						c = c.replace(/^cd (\S+) && /, "");
						c = c.replace(/\s*2>&1.*$/, "");            // 去 stderr 重定向及之后的 tail/echo 装饰
						c = c.replace(/\s*\|\s*tail\s+[^|]*$/, ""); // 去结尾的 | tail -N
						return c.length > 45 ? c.slice(0, 42) + "..." : c;
					}
					if (args.path) {
						const p = String(args.path);
						const name = p.split('/').pop() || p;
						return p.length > 40 ? name : p;
					}
					if (args.pattern) return "/" + String(args.pattern).slice(0,20) + "/";
					if (args.url) {
						const u = String(args.url);
						return u.length > 40 ? u.slice(0,37)+"..." : u;
					}
					if (args.query) return '"' + String(args.query).slice(0,20) + '"';
					if (args.content) return "(" + String(args.content).length + " chars)";
					if (args.action) {
						const keys = Object.keys(args).filter(k => k !== 'action');
						const extra = keys.length > 0 ? ' ' + JSON.stringify(args[keys[0]]).slice(0,30) : '';
						return String(args.action) + extra;
					}
					const r = JSON.stringify(args); return r.length > 50 ? r.slice(0,50)+"..." : r;
				} catch { return ""; }
			};

			// Track whether the abort signal fired
			let wasAborted = false;
			// Track whether the response was truncated (max_tokens limit)
			let wasTruncated = false;
			if (signal) {
				if (signal.aborted) {
					wasAborted = true;
				} else {
					signal.addEventListener("abort", () => { wasAborted = true; }, { once: true });
				}
			}

			// Reset runtime counters at the start of each user turn
			runtimeConsecutiveErrors = 0;
			runtimeLastToolName = "";
			runtimeToolCallLog.length = 0;
			runtimeTurnCallCount = 0;
			runtimeSessionCallCount = 0;

			// ── Single LLM API call (no internal retry — watchdog handles recovery) ──
			let hadOutput = false;
			let connectionErrorDetected = "";
			let aiTextBuffer = "";
			let spinIdx = 0;
			const pendingTools = new Map<string, { name: string; start: number }>();
			let statusLine = "";
			let spinnerTimer: ReturnType<typeof setInterval> | null = null;

			const showStatus = (text: string) => {
				stderrCapture.suppress(() => {
					// \r = 回车到行首, \x1b[K = 清到行尾, 然后写 spinner
					process.stderr.write("\r\x1b[K\x1b[90m" + text + "\x1b[0m");
				});
				statusLine = text;
			};
			const hideStatus = () => {
				if (statusLine.length > 0) {
					stderrCapture.suppress(() => {
						// 清行后换行，确保下一个输出从新行开始
						process.stderr.write("\r\x1b[K\n");
					});
					statusLine = "";
				}
				if (spinnerTimer) { clearInterval(spinnerTimer); spinnerTimer = null; }
			};
			const spinStart = (base: string) => {
				if (spinnerTimer) clearInterval(spinnerTimer);
				// After 10s of tool execution, stop animation to reduce visual noise on long ops (e.g. SSH timeout)
				let elapsed = 0;
				spinnerTimer = setInterval(() => {
					elapsed += 80;
					if (elapsed > 10000) {
						clearInterval(spinnerTimer!);
						spinnerTimer = null;
						showStatus("⏳ " + base);
						return;
					}
					showStatus(SPIN[spinIdx++ % SPIN.length] + " " + base);
				}, 80);
			};
			const flushAiBuf = () => {
				if (aiTextBuffer.length > 0) {
					buf("[AI] " + aiTextBuffer);
					aiTextBuffer = "";
				}
			};
			const pushAiDelta = (delta: string) => {
				aiTextBuffer += delta;
				// 按自然段落边界 flush：遇到换行符就把该行完整记录，避免按字符数硬切成碎片
				const nlIdx = aiTextBuffer.lastIndexOf("\n");
				if (nlIdx >= 0) {
					const complete = aiTextBuffer.slice(0, nlIdx + 1).replace(/\n$/, "");
					aiTextBuffer = aiTextBuffer.slice(nlIdx + 1);
					if (complete.trim().length > 0) {
						buf("[AI] " + complete);
					}
				} else if (aiTextBuffer.length >= AI_BUF_MAX) {
					flushAiBuf();
				}
			};

			let messageStarted = false;
			// 思考阶段动态指示：在首个输出（文本/工具）前显示动画，避免终端“卡住”感
			spinStart("🤔 思考中…");
			let contextOverflowRetry = false;
			let newMessages = await runAgentLoop([userMessage], fullContext, config, async (event) => {
				if (event.type === "message_update" && event.assistantMessageEvent) {
					// Emit message_start on first content from the AI
					if (!messageStarted) {
						messageStarted = true;
						emitEvent(onEvent, { type: "message_start" });
					}
					const ame = event.assistantMessageEvent;
					if (ame.type === "text_delta") {
						hideStatus(); // 首个文本输出：清除思考/工具 spinner
						writeOut(ame.delta);
						pushAiDelta(ame.delta);
						hadOutput = true;
						emitEvent(onEvent, { type: "text_delta", delta: ame.delta });
					} else if (ame.type === "thinking_delta") {
						emitEvent(onEvent, { type: "thinking", thinking: ame.delta });
					} else if (ame.type === "thinking_start") {
						emitEvent(onEvent, { type: "thinking", thinking: "" });
					}
				} else if (event.type === "tool_execution_start") {
					flushAiBuf();
					// AI text streaming may have left stdout cursor mid-line;
					// emit a newline so spinner/status (stderr \r) doesn't overwrite it
					if (hadOutput) writeOut("\n");
					const s = brief(event.args);
					const toolEntry = { name: event.toolName + " " + s, start: Date.now() };
					pendingTools.set(event.toolCallId, toolEntry);
					if (event.toolName !== 'session-buffer') buf("🛠 " + event.toolName + " " + s);
					spinStart(event.toolName + " " + s);
					emitEvent(onEvent, { type: "tool_start", toolName: event.toolName, args: event.args, toolCallId: event.toolCallId });
				} else if (event.type === "tool_execution_end") {
					const entry = pendingTools.get(event.toolCallId);
					if (entry) {
						pendingTools.delete(event.toolCallId);
						const elapsed = ((Date.now() - entry.start) / 1000).toFixed(1);
						if (event.toolName !== 'session-buffer') buf("✅ " + event.toolName + " (" + elapsed + "s)");
						emitEvent(onEvent, { type: "tool_end", toolName: event.toolName, args: (event as any).args, duration: Number(elapsed), toolCallId: event.toolCallId });
				// Render tool output to terminal
				renderToolOutput(event.toolName, (event as any).result, elapsed);
						// Capture tool output to session-buffer so agent can read what user sees
						try {
							const result = (event as any).result;
							if (result?.content && Array.isArray(result.content)) {
								let out = result.content
									.filter((c: any) => c.type === "text" && c.text)
									.map((c: any) => c.text)
									.join("\n");
								if (out.length > 0) {
									// Truncate: max 30 lines / 2000 chars to avoid drowning buffer
									if (out.length > 2000) {
										out = out.slice(0, 2000) + "\n[...truncated...]";
									}
									const lines = out.split("\n");
									if (lines.length > 30) {
										out = lines.slice(0, 30).join("\n") + "\n[...truncated " + (lines.length - 30) + " lines...]";
									}
									if (event.toolName !== 'session-buffer') buf("  ↓ " + out);
								}
							}
						} catch (_) { /* best-effort: don't break if result structure is unexpected */ }
						if (Number(elapsed) > 0.5) {
							process.stderr.write("\x1b[90m⏳ " + event.toolName + " ✓ (" + elapsed + "s)\x1b[0m\n");
						}
					}
					if (pendingTools.size === 0) {
						hideStatus();
					} else {
						const remaining = Array.from(pendingTools.values())[0];
						spinStart(remaining.name);
					}
				} else if (event.type === "message_end" && event.message.role === "assistant") {
					flushAiBuf();
					// message_start was already emitted at first text_delta above
					const msg = event.message;
						if (msg.stopReason === "error" && msg.errorMessage) {
						hideStatus();
						let errMsg = msg.errorMessage;
						// Filter behavior-guard messages from error output
						if (errMsg.startsWith("[behavior-guard]")) {
							buf("[INFO] " + errMsg);
							emitEvent(onEvent, { type: "message_end", stopReason: "end_turn" });
							return;
						}
						// ── Context overflow auto-compress & retry ──
						if (errMsg.includes("context_window") || errMsg.includes("token limit") || errMsg.includes("too large")) {
							buf("[WARN] 上下文溢出，自动压缩历史消息并重试...");
							process.stderr.write("\n\x1b[33m⚠️ 上下文溢出，压缩历史消息并重试...\x1b[0m\n");
							const cw = (fullContext as any)._modelContextWindow ?? 200000;
							const compressed2 = compressMessages(existingMessages ?? [], fullContext.systemPrompt ?? "", cw);
							fullContext.messages = compressed2.messages;
							emitEvent(onEvent, { type: "error", message: errMsg });
							// Return a special marker so the caller can retry
							contextOverflowRetry = true;
						} else {
							process.stderr.write("\nError: " + errMsg + "\n");
							buf("[ERROR] " + errMsg);
							if (isTransientConnectionError(errMsg)) {
								connectionErrorDetected = errMsg;
							}
							emitEvent(onEvent, { type: "error", message: errMsg });
						}
					}
					if (msg.stopReason === "length") {
						hideStatus();
						wasTruncated = true;
						process.stderr.write("\n⚠️  Response truncated (max_tokens limit). Auto-continuing...\n");
						buf("[WARN] 响应被截断 — max_tokens 不足，自动续写");
					}
					emitEvent(onEvent, { type: "message_end", stopReason: msg.stopReason });
				}
			}, signal, streamSimple as StreamFn);

			hideStatus();
			if (hadOutput) writeOut("\n");

			// ── Context overflow retry ──
			if (contextOverflowRetry && !wasAborted) {
				buf("[INFO] 上下文压缩完成，重试 API 调用...");
				process.stderr.write("\x1b[33m🔄 重试中...\x1b[0m\n");
				contextOverflowRetry = false;
				hadOutput = false;
				messageStarted = false;
				aiTextBuffer = "";
				const retriedMessages = await runAgentLoop([userMessage], fullContext, config, async (event) => {
					if (event.type === "message_update" && event.assistantMessageEvent) {
						if (!messageStarted) {
							messageStarted = true;
							emitEvent(onEvent, { type: "message_start" });
						}
						const ame = event.assistantMessageEvent;
						if (ame.type === "text_delta") {
							hideStatus();
							writeOut(ame.delta);
							pushAiDelta(ame.delta);
							hadOutput = true;
							emitEvent(onEvent, { type: "text_delta", delta: ame.delta });
						}
					} else if (event.type === "tool_execution_start") {
						flushAiBuf();
						if (hadOutput) writeOut("\n");
						const s = brief(event.args);
						const toolEntry = { name: event.toolName + " " + s, start: Date.now() };
						pendingTools.set(event.toolCallId, toolEntry);
						if (event.toolName !== 'session-buffer') buf("🛠 " + event.toolName + " " + s);
						spinStart(event.toolName + " " + s);
						emitEvent(onEvent, { type: "tool_start", toolName: event.toolName, args: event.args, toolCallId: event.toolCallId });
					} else if (event.type === "tool_execution_end") {
						const entry = pendingTools.get(event.toolCallId);
						if (entry) {
							pendingTools.delete(event.toolCallId);
							const elapsed = ((Date.now() - entry.start) / 1000).toFixed(1);
							if (event.toolName !== 'session-buffer') buf("✅ " + event.toolName + " (" + elapsed + "s)");
							renderToolOutput(event.toolName, (event as any).result, elapsed);
						}
						if (pendingTools.size === 0) hideStatus();
					} else if (event.type === "message_end" && event.message.role === "assistant") {
						flushAiBuf();
						const retryMsg = event.message;
						if (retryMsg.stopReason === "error" && retryMsg.errorMessage) {
							process.stderr.write("\nError: " + retryMsg.errorMessage + "\n");
							buf("[ERROR] " + retryMsg.errorMessage);
							emitEvent(onEvent, { type: "error", message: retryMsg.errorMessage });
						}
						emitEvent(onEvent, { type: "message_end", stopReason: retryMsg.stopReason });
					}
				}, signal, streamSimple as StreamFn);
				hideStatus();
				if (hadOutput) writeOut("\n");
				// Merge: replace newMessages with the retried version
				newMessages.splice(0, newMessages.length, ...retriedMessages);
				buf("[INFO] 重试完成，上下文已压缩");
			}

			// Auto-continue if response was truncated (max_tokens limit)
			// One extra API call to finish what was cut off
			if (wasTruncated && !wasAborted) {
				try {
					const continueMsg: AgentMessage = {
						role: "user",
						content: "[SYSTEM: Your previous response was truncated due to output length limit. Continue from where you left off. Complete any unfinished tool calls, code blocks, or thoughts. Do NOT repeat what was already output.]",
						timestamp: Date.now(),
					};
					const continuedMessages = await runAgentLoop(
						[continueMsg],
						{ ...fullContext, messages: newMessages },
						config,
						async (event) => {
							// Handle continue events (same pattern but simpler — no recursive continue)
							if (event.type === "message_update" && event.assistantMessageEvent) {
								const ame = event.assistantMessageEvent;
								if (ame.type === "text_delta") {
									if (pendingTools.size > 0) hideStatus();
									writeOut(ame.delta);
									pushAiDelta(ame.delta);
									hadOutput = true;
								}
							} else if (event.type === "tool_execution_start") {
								flushAiBuf();
								const s = brief(event.args);
								const toolEntry = { name: event.toolName + " " + s, start: Date.now() };
								pendingTools.set(event.toolCallId, toolEntry);
								if (event.toolName !== 'session-buffer') buf("🛠 " + event.toolName + " " + s);
								spinStart(event.toolName + " " + s);
							} else if (event.type === "tool_execution_end") {
								const entry = pendingTools.get(event.toolCallId);
								if (entry) {
									pendingTools.delete(event.toolCallId);
									const elapsed = ((Date.now() - entry.start) / 1000).toFixed(1);
									if (event.toolName !== 'session-buffer') buf("✅ " + event.toolName + " (" + elapsed + "s)");
									renderToolOutput(event.toolName, (event as any).result, elapsed);

								}
							} else if (event.type === "message_end") {
								flushAiBuf();
							}
						},
						signal,
						streamSimple as StreamFn,
					);
					// Merge: replace newMessages with the continued version
					newMessages.splice(0, newMessages.length, ...continuedMessages);
				} catch {
					// If continue fails, keep the original truncated messages
					hideStatus();
					buf("[WARN] 自动续写失败，响应可能不完整");
				}
			}

			// Log connection error for watchdog to pick up (via buffer + dedicated signal file)
			// 信号文件不经过 NOVUS_DAEMON gate —— daemon 模式下 buf() 被吞，靠它保底
			if (connectionErrorDetected) {
				buf("[CONNECTION_ERROR] " + connectionErrorDetected);
				watchdogSignal(connectionErrorDetected);
			}

			stderrCapture.restore();

			// If aborted, prepend a system note about the interruption
			if (wasAborted) {
				const abortMsg: AgentMessage = {
					role: "user",
					content: "[interrupted by user — the previous response was cut short. The user may now provide a new instruction or modification.]",
					timestamp: Date.now(),
				};
				return [...newMessages, abortMsg];
			}

			// Self-heal: if stderr has termination errors but the tool actually succeeded, note it
			const stderrOutput = stderrCapture.logs
				.map(l => l.replace(/\x1b\[[0-9;]*[a-zA-Z~]/g, "").replace(/\r/g, "").replace(/\s+/g, " ").trim())
				.filter(Boolean).join("\n");
			if (stderrOutput) {
				// "Error: terminated" 单独出现 = 子进程收尾时被 kill，命令实际已成功。
				// 属无害噪音：既不注入上下文，也不打印到界面（避免误导用户以为出错）。
				const isOnlyTerminated = /^Error: terminated\.?\s*$/i.test(stderrOutput.trim());
				if (isOnlyTerminated) {
					return newMessages;
				}
				buf("[stderr] " + stderrOutput.slice(0, 200).split("\n")[0] + (stderrOutput.length > 200 ? "..." : ""));
				const hasErrors = /error|fail|timeout|reject|ECONNREFUSED|ENOTFOUND|ENOENT|ERR_|throw|uncaught/i.test(stderrOutput);
				// Skip stderr error injection for transient connection errors —
				// the watchdog handles auto-continue, no need to mislead the LLM.
				if (connectionErrorDetected) {
					return newMessages;
				}
				const prefix = hasErrors
					? `[system stderr — ⚠️ ERRORS DETECTED. You should analyze these errors and try to fix or work around them. Do not ignore them.]
`
					: `[system stderr log — informational output from the last turn]
`;
				const diagMsg: AgentMessage = {
					role: "user",
					content: prefix + stderrOutput.slice(0, 3000),
					timestamp: Date.now(),
				};
				return [...newMessages, diagMsg];
			}

			return newMessages;
		},
	};
}
