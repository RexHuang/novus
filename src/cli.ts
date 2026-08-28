#!/usr/bin/env node

import * as readline from "node:readline";
import { EventEmitter } from "node:events";
import { statSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { buf, takeWatchdogSignal } from "./utils/session-buffer.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createMinAgent, isTransientConnectionError } from "./agent.ts";
import type { MinAgent } from "./agent.ts";
import { createSession, deleteSession, formatConversationSummary, getLastRounds, getLastSessionId, listSessions, loadSession, saveMessages, sessionExists } from "./session.ts";
import { runEvolve } from "./evolve.ts";
import { reflectAfterTurn } from "./reflect.ts";
import { reflectOnRecentSessions } from "./evolution/behavior-reflector.ts";
import { initConfig, loadConfig, configSource } from "./config.ts";
import type { NovusConfig } from "./config.ts";

interface ParsedArgs {
	prompt?: string;
	session?: string;
	cwd?: string;
	list: boolean;
	new_: boolean;
	last: boolean;
	delete_?: string;
	evolve: boolean;
	init: boolean;
	initForce: boolean;
	showConfig: boolean;
	help: boolean;
	serve: boolean;
	port: number;
	auth?: string;
	authFile?: string;
	daemon: boolean;
	daemonKill: boolean;
	due: boolean;
	exec?: string;
}

function parseArgs(args: string[]): ParsedArgs {
	const result: ParsedArgs = { list: false, new_: false, last: false, evolve: false, init: false, initForce: false, showConfig: false, help: false, serve: false, port: 0, auth: undefined, authFile: undefined, daemon: false, daemonKill: false, due: false, exec: undefined };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		switch (arg) {
			case "-p":
				result.prompt = args[++i] ?? "";
				break;
			case "--session":
			case "-s":
				result.session = args[++i] ?? "";
				break;
			case "--cwd":
				result.cwd = args[++i] ?? "";
				break;
			case "--help":
			case "-h":
				result.help = true;
				break;
			case "--list":
				result.list = true;
				break;
			case "--new":
				result.new_ = true;
				break;
			case "--last":
			case "-l":
				result.last = true;
				break;
			case "--delete":
				result.delete_ = args[++i] ?? "";
				break;
			case "--evolve":
				result.evolve = true;
				break;
			case "--init":
				result.init = true;
				break;
			case "--init-force":
				result.init = true;
				result.initForce = true;
				break;
			case "--serve":
				result.serve = true;
				break;
			case "--port":
				result.port = parseInt(args[++i] ?? "0", 10) || 0;
				break;
			case "--auth":
				result.auth = args[++i] ?? "";
				break;
			case "--auth-file":
				result.authFile = args[++i] ?? "";
				break;
			case "--daemon":
				result.daemon = true;
				break;
			case "--daemon-kill":
				result.daemonKill = true;
				break;
			case "--due":
				result.due = true;
				break;
			case "--exec":
				result.exec = args[++i] ?? "";
				break;
			case "--config":
				result.showConfig = true;
				break;
		}
	}
	return result;
}

function hasStdinData(): boolean {
	try {
		return !process.stdin.isTTY;
	} catch {
		return false;
	}
}

async function readStdin(): Promise<string> {
	return new Promise((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf-8");
		process.stdin.on("data", (chunk: string) => {
			data += chunk;
		});
		process.stdin.on("end", () => {
			resolve(data.trim());
		});
		setTimeout(() => {
			if (data.length === 0 && process.stdin.readableEnded) {
				resolve("");
			}
		}, 100);
	});
}

function formatDate(iso: string): string {
	try {
		const d = new Date(iso);
		const now = new Date();
		const diffMs = now.getTime() - d.getTime();
		const diffMin = Math.floor(diffMs / 60000);
		if (diffMin < 1) return "just now";
		if (diffMin < 60) return `${diffMin}m ago`;
		const diffHr = Math.floor(diffMin / 60);
		if (diffHr < 24) return `${diffHr}h ago`;
		const diffDay = Math.floor(diffHr / 24);
		if (diffDay < 7) return `${diffDay}d ago`;
		return d.toLocaleDateString();
	} catch {
		return iso;
	}
}

function showSessionList(): void {
	const sessions = listSessions();
	if (sessions.length === 0) {
		console.log("No sessions found.");
		return;
	}
	console.log("Sessions:");
	for (const s of sessions) {
		const shortId = s.id.slice(0, 8);
		const msgs = `${s.messageCount} msg${s.messageCount !== 1 ? "s" : ""}`;
		console.log(`  ${shortId}  ${formatDate(s.timestamp).padEnd(10)}  ${msgs.padEnd(10)}  ${s.cwd}`);
	}
}

function printHelp(): void {
	console.log(`Usage: novus [options]

Options:
  -p <prompt>          One-shot mode: send a single prompt and exit
  --session, -s <id>   Use or create a named session
  --cwd <path>         Working directory for the agent
  --list               List all saved sessions with metadata
  --new                Force a new session
  --last, -l           Resume the most recent session
  --delete <id>        Delete a saved session
  --evolve             Run autonomous self-evolution cycle
  --init               Scaffold a novus.config.json in the current directory
  --init-force         Overwrite existing novus.config.json if present
  --config             Show resolved configuration and source
  --serve              Start HTTP server mode (web UI + API)
  --port <number>      Port for HTTP server (default: 3001)
  --auth <token>       Require Bearer token for API access (single-user)
  --auth-file <path>   Multi-tenant auth config (JSON file)
  --daemon              Start daemon scheduler in background (periodic tasks)
  --daemon-kill         Kill running daemon scheduler
  --help, -h           Show this help message

Configuration:
  novus looks for novus.config.json (project-level, searched upward from cwd)
  and ~/.novusrc.json (global). CLI flags override config values.

Interactive mode keys:
  ESC                  Interrupt the current agent response
  Ctrl+C               Same as ESC (interrupts; press twice quickly to quit)
  Ctrl+D or /exit      Quit

If no -p is given and stdin is a terminal, novus starts in interactive mode.`);
}

/** Resolve the final NovusConfig by merging file config + CLI overrides */
function resolveConfig(args: ParsedArgs): NovusConfig {
	const fileConfig = loadConfig(args.cwd);
	const overrides: NovusConfig = {};

	if (args.cwd) overrides.cwd = args.cwd;

	// Merge: CLI overrides win over file config
	return { ...fileConfig, ...overrides };
}

/** Resolve or create a session, returning the ID and any existing messages. */
function resolveSession(
	args: ParsedArgs,
	cwd: string,
): { sessionId: string; existingMessages: AgentMessage[] | undefined } {
	if (args.new_) {
		const id = createSession(cwd);
		return { sessionId: id, existingMessages: undefined };
	}
	if (args.last) {
		const lastId = getLastSessionId();
		if (lastId) {
			return {
				sessionId: lastId,
				existingMessages: loadSession(lastId) ?? undefined,
			};
		}
		// No previous session — create one
		const id = createSession(cwd);
		return { sessionId: id, existingMessages: undefined };
	}
	if (args.session) {
		if (sessionExists(args.session)) {
			return {
				sessionId: args.session,
				existingMessages: loadSession(args.session) ?? undefined,
			};
		}
		// Named session doesn't exist yet — create it with the requested ID
		createSession(cwd, args.session);
		return { sessionId: args.session, existingMessages: undefined };
	}
	// Anonymous new session
	const id = createSession(cwd);
	return { sessionId: id, existingMessages: undefined };
}

async function runOneShot(args: ParsedArgs): Promise<void> {
	const config = resolveConfig(args);
	const cwd = config.cwd ?? process.cwd();

	let promptText = args.prompt;
	if (!promptText && hasStdinData()) {
		promptText = await readStdin();
	}
	if (!promptText) {
		console.error('Error: No prompt provided. Use -p "prompt" or pipe input.');
		process.exit(1);
	}

	const { sessionId, existingMessages } = resolveSession(args, cwd);
	const agent = await createMinAgent({
		cwd,
		model: config.model,
		baseUrl: config.baseUrl,
		systemPrompt: config.systemPrompt,
		apiKey: config.apiKey,
		maxTokens: config.maxTokens,
	});

	const newMessages = await agent.prompt(promptText, existingMessages);
	saveMessages(sessionId, newMessages);

	if (!args.session && !args.new_) {
		console.log(`\nSession: ${sessionId}`);
	}
}

/**
 * Set up ESC key detection in raw mode.
 * When the agent is busy (running=true), pressing ESC or Ctrl+C will abort
 * the current operation via the provided AbortController.
 *
 * Returns a cleanup function that restores the terminal.
 */
interface RawInputState {
	/** Callback for raw stdin data (paste detection, ESC). */
	onRawData: (data: Buffer) => void;
	/** Whether the terminal is in raw mode. */
	rawEnabled: boolean;
	/** Cleanup function to restore terminal. */
	cleanup: () => void;
}

function setupRawInput(rl: readline.Interface): RawInputState {
	// We need raw mode to catch individual keystrokes (ESC) and detect paste.
	// In raw mode, process.stdin 'data' events fire for every chunk of bytes.
	// Key distinction:
	//   - Manual Enter: single byte 0x0D (\r), data length = 1
	//   - Paste: multiple bytes including embedded 0x0D/0x0A, data length > 1
	let rawEnabled = false;
	try {
		if (process.stdin.isTTY) {
			process.stdin.setRawMode(true);
			rawEnabled = true;
		}
	} catch {
		// Not a TTY — can't do raw mode
	}

	const cleanup = () => {
		if (rawEnabled) {
			try {
				process.stdin.setRawMode(false);
			} catch {
				// ignore
			}
		}
	};

	return { onRawData: () => {}, rawEnabled, cleanup };
}

async function runInteractive(args: ParsedArgs): Promise<void> {
	const config = resolveConfig(args);
	const cwd = config.cwd ?? process.cwd();
	const { sessionId, existingMessages } = resolveSession(args, cwd);

	// Create readline early so agent output can coordinate with it
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
		prompt: "> ",
		terminal: true,
	});
	const rlOut = process.stdout;

	const agent = await createMinAgent({
		cwd,
		model: config.model,
		baseUrl: config.baseUrl,
		systemPrompt: config.systemPrompt,
		apiKey: config.apiKey,
		maxTokens: config.maxTokens,
		onWrite: (text: string) => {
			rlOut.write(text);
		},
	});

	// 后台自动拉起 daemon 调度器（如果还没运行）
	let daemonProcess: import("node:child_process").ChildProcess | null = null;
	try {
		const { daemonStatus } = await import("./autonomous/daemon-scheduler.ts");
		if (!daemonStatus().running) {
			const { spawn } = await import("node:child_process");
			const cliPath = new URL(import.meta.url).pathname;
			daemonProcess = spawn(process.execPath, [cliPath, "--daemon", "--cwd", cwd], {
				detached: true,
				stdio: "ignore",
			});
			daemonProcess.unref();
			console.log("🕐 Daemon scheduler started in background");
		}
	} catch {
		// daemon 启动失败不影响主对话
	}

	// Accumulate all messages for the session
	let messages: AgentMessage[] = existingMessages ?? [];

	// If resuming a session with history, show the last conversation
	if (messages.length > 0) {
		const lastRounds = getLastRounds(sessionId, 1);
		if (lastRounds.length > 0) {
			console.log(formatConversationSummary(lastRounds));
		}
	}

	console.log(`novus ${sessionId.slice(0, 8)} • ESC=中断 Ctrl+D=退出`);

	// State shared with interrupt handler
	let running = false;
	let exiting = false;
	let currentAbortController: AbortController | null = null;

	const rawInput = setupRawInput(rl);

	// Track Ctrl+C timing for double-press detection
	let lastSigintTime = 0;
	const SIGINT_DOUBLE_PRESS_MS = 500;

	// Track paste detection via raw data.
	// Paste = single data event with multiple bytes containing newlines.
	// Manual Enter = single 0x0D byte.
	// When paste is detected, we set a flag + a timeout. During that window,
	// all readline 'line' events get buffered instead of submitted individually.
	let pasteDetectedViaRaw = false;
	let rawPasteFlushTimer: ReturnType<typeof setTimeout> | null = null;

	const doInterrupt = () => {
		if (currentAbortController) {
			console.log("\n\x1b[33m⚡ Interrupted\x1b[0m");
			currentAbortController.abort();
			currentAbortController = null;
		}
	};

	if (rawInput.rawEnabled) {
		rawInput.onRawData = (data: Buffer) => {
			// ESC key = 0x1B (27)
			if (data.length === 1 && data[0] === 0x1B) {
				if (running) doInterrupt();
				return;
			}
			// Paste detection: data chunk > 1 byte and contains newline characters.
			// A manual Enter sends exactly 1 byte (0x0D). Pasted text sends
			// multiple bytes in one chunk, with embedded 0x0D or 0x0A for line breaks.
			if (data.length > 1 && (data.includes(0x0D) || data.includes(0x0A))) {
				pasteDetectedViaRaw = true;
				// Keep the flag active while paste chunks keep arriving.
				// After 300ms of silence, the paste is done.
				if (rawPasteFlushTimer) clearTimeout(rawPasteFlushTimer);
				rawPasteFlushTimer = setTimeout(() => {
					pasteDetectedViaRaw = false;
					rawPasteFlushTimer = null;
				}, 300);
			}
		};
		process.stdin.on("data", rawInput.onRawData);
	}

	// Ctrl+C handling via readline SIGINT
	rl.on("SIGINT", () => {
		const now = Date.now();
		const isDoublePress = (now - lastSigintTime) < SIGINT_DOUBLE_PRESS_MS;
		lastSigintTime = now;

		if (running) {
			// First Ctrl+C while busy = interrupt
			doInterrupt();
		} else if (isDoublePress) {
			// Double Ctrl+C while idle = exit
			rl.close();
		} else {
			// Single Ctrl+C while idle = reminder
			console.log("\n(Press Ctrl+D or type /exit to quit)");
			rl.prompt();
		}
	});

			// ── Watchdog: auto-continue on connection errors ──
		// Fast path: connection error detected → immediate retry (2s delay)
		// Slow path: no output at all → 120s timeout (catches edge cases)
		const WATCHDOG_FAST_DELAY_MS = 2_000;
		const WATCHDOG_SLOW_TIMEOUT_MS = 120_000;
		const WATCHDOG_CHECK_MS = 5_000;
		let watchdogTimer: ReturnType<typeof setInterval> | null = null;
		let watchdogFastTimer: ReturnType<typeof setTimeout> | null = null;
		let watchdogActive = false;
		let lastBufferMtime = 0;
		let watchdogFired = false;
		let watchdogFireCount = 0;
		let isWatchdogContinuation = false; // true when current turn was triggered by watchdog

		const doWatchdogContinue = (reason: string) => {
			if (watchdogFired) { stopWatchdog(); return; }
			// 防死循环：连续自动继续超过 5 次说明 API 持续故障，交回人工
			if (watchdogFireCount >= 5) {
				stopWatchdog();
				console.error("\x1b[31m🐕 Watchdog: 已连续自动继续 " + watchdogFireCount + " 次，API 持续故障，等待人工介入\x1b[0m");
				return;
			}
			watchdogFired = true;
			watchdogFireCount++;
			stopWatchdog();
			console.error("\x1b[33m🐕 Watchdog: " + reason + ", auto-continuing (#" + watchdogFireCount + ")...\x1b[0m");
			buf("[watchdog] " + reason + "，自动继续");
			isWatchdogContinuation = true;
			void runPrompt("[watchdog] 上一次响应因连接错误中断。请继续完成之前的任务。");
		};

		const startWatchdog = (fast = false) => {
			if (watchdogActive) return;
			watchdogActive = true;
			watchdogFired = false;
			lastBufferMtime = Date.now(); // reset baseline

			if (fast) {
				// Fast path: schedule immediate retry after short delay
				console.error("\x1b[90m🐕 Watchdog (fast): connection error detected, will auto-continue in " + (WATCHDOG_FAST_DELAY_MS/1000) + "s\x1b[0m");
				watchdogFastTimer = setTimeout(() => {
					// Don't fire while user is typing
					if (rl.line && rl.line.trim()) { stopWatchdog(); return; }
					doWatchdogContinue("连接错误，快速恢复");
				}, WATCHDOG_FAST_DELAY_MS);
				// Also start slow watchdog as fallback
			}

			console.error("\x1b[90m🐕 Watchdog (slow): idle timeout " + (WATCHDOG_SLOW_TIMEOUT_MS/1000) + "s\x1b[0m");
			watchdogTimer = setInterval(() => {
				try {
					const bufPath = join(homedir(), ".novus", "session-buffer.txt");
					const st = statSync(bufPath);
					const mtime = st.mtimeMs;
					// Buffer changed since last check → reset timer
					if (mtime > lastBufferMtime) {
						lastBufferMtime = mtime;
						return;
					}
					// Buffer idle for too long
					if (Date.now() - lastBufferMtime > WATCHDOG_SLOW_TIMEOUT_MS) {
						// Don't fire while user is typing
						if (rl.line && rl.line.trim()) { lastBufferMtime = Date.now(); return; }
						doWatchdogContinue("缓冲区超时无输出");
					}
				} catch {
					// buffer file missing — ignore
				}
			}, WATCHDOG_CHECK_MS);
		};

		const stopWatchdog = () => {
			if (!watchdogActive) return;
			watchdogActive = false;
			if (watchdogTimer) {
				clearInterval(watchdogTimer);
				watchdogTimer = null;
			}
			if (watchdogFastTimer) {
				clearTimeout(watchdogFastTimer);
				watchdogFastTimer = null;
			}
		};

	const processInput = async (input: string) => {
		const trimmed = input.trim();
		if (!trimmed) {
			rl.prompt();
			return;
		}

		if (trimmed === "/exit" || trimmed === "/quit") {
			exiting = true;
			rl.close();
			return;
		}

		if (running) {
			// If already running, abort current and queue this as the next prompt
			console.log("\x1b[33m⚡ Interrupting current task, switching to new instruction...\x1b[0m");
			if (currentAbortController) {
				currentAbortController.abort();
			}
			// Wait a tick for the abort to propagate
			await new Promise(resolve => setTimeout(resolve, 50));
			// Now process the new input
			await runPrompt(trimmed);
			return;
		}

		await runPrompt(trimmed);
	};

	const runPrompt = async (userInput: string) => {
		running = true;
		currentAbortController = new AbortController();
		stopWatchdog(); // stop any previous watchdog
		watchdogFired = false;

		let newMessages: AgentMessage[] = [];
		try {
			newMessages = await agent.prompt(userInput, messages.length > 0 ? messages : undefined, currentAbortController.signal);
			messages = [...messages, ...newMessages];
			saveMessages(sessionId, newMessages);
		} catch (err) {
			// If this was an abort, it's not really an error
			if (currentAbortController?.signal.aborted) {
				// Already handled — partial results may have been saved by the agent
				// Save any messages we got back
			} else {
				const errMsg = err instanceof Error ? err.message : String(err);
				console.error("Error:", errMsg);
				// 教训应用：LLM API 抛异常路径也要写连接错误标记，否则 watchdog 快速恢复不触发
				// （曾漏：仅 agent 内部 message_end 路径写标记，异常 reject 路径绕过了检测）
				if (isTransientConnectionError(errMsg)) {
					buf("[CONNECTION_ERROR] " + errMsg);
				}
			}
		} finally {
			running = false;
			currentAbortController = null;
			if (!exiting) {
				// Clear any stray output from current line before showing prompt
				process.stdout.write("\r\x1b[K");
				rl.prompt();
				// 空闲时异步反思，不阻塞等待下一次输入
				void reflectAfterTurn(sessionId, newMessages, messages).catch(() => {});

				// Check if last turn had a connection error → start watchdog
				// 双通道：信号文件（daemon 模式下 buf() 被 gate 吞，靠它保底）+ buffer 标记
				const sig = takeWatchdogSignal();
				let hasConnError = !!sig;
				if (!hasConnError) {
					const bufPath = join(homedir(), ".novus", "session-buffer.txt");
					try {
						const bufContent = readFileSync(bufPath, "utf-8");
						if (bufContent.includes("[CONNECTION_ERROR]")) {
							if (isWatchdogContinuation) {
								// Watchdog continuation succeeded — clear stale marker to prevent loop
								const cleaned = bufContent.replace(/\[CONNECTION_ERROR\].*\n?/g, "");
								writeFileSync(bufPath, cleaned, "utf-8");
								// 计数重置统一交给下方推进判定，不在此处理
							} else {
								hasConnError = true;
							}
						}
					} catch {
						// buffer file missing — skip
					}
				}
				if (hasConnError) startWatchdog(true);
				// 推进判定：本轮由 watchdog 触发且未再出现连接错误
				// → API 已恢复、任务在推进，重置计数（不算持续故障）。
				// 只有连续中断且没有一轮正常完成才会累到上限。
				if (isWatchdogContinuation && !hasConnError) {
					isWatchdogContinuation = false;
					if (watchdogFireCount > 0) {
						console.error("\x1b[32m🐕 Watchdog: 自动继续后任务推进正常，重置故障计数\x1b[0m");
						watchdogFireCount = 0;
					}
				}
			}
		}
	};

	// === Paste buffering ===
	// When raw input detects a paste (multi-byte data with newlines),
	// readline will fire 'line' for each pasted line in rapid succession.
	// We buffer all lines during a paste and flush them as one input.
	//
	// Logic:
	// - If pasteDetectedViaRaw is true, buffer lines and flush after a short delay.
	// - If not in paste mode (manual typing), submit immediately on Enter.
	// - A minimal timer (PASTE_SETTLE_MS) ensures we wait for the last line
	//   even if raw paste flag expires slightly before readline finishes.
	const PASTE_SETTLE_MS = 200; // wait for readline to finish processing paste
	let pasteBuffer: string[] = [];
	let pasteFlushTimer: ReturnType<typeof setTimeout> | null = null;

	const flushPasteBuffer = () => {
		if (pasteFlushTimer) {
			clearTimeout(pasteFlushTimer);
			pasteFlushTimer = null;
		}
		if (pasteBuffer.length === 0) return;

		const combined = pasteBuffer.join("\n");
		pasteBuffer = [];

		if (!combined.trim()) {
			rl.prompt();
			return;
		}

		void processInput(combined);
	};

	rl.on("line", (line: string) => {
		// If paste was detected via raw data, buffer this line
		if (pasteDetectedViaRaw) {
			pasteBuffer.push(line);
			if (pasteFlushTimer) clearTimeout(pasteFlushTimer);
			pasteFlushTimer = setTimeout(flushPasteBuffer, PASTE_SETTLE_MS);
		} else {
			// Manual typing: submit immediately
			void processInput(line);
		}
	});

	rl.on("close", () => {
		// Flush any buffered paste
		flushPasteBuffer();
		stopWatchdog();
		stopWsWatcher();
		if (rawInput.rawEnabled) {
			process.stdin.removeListener("data", rawInput.onRawData);
		}
		rawInput.cleanup();
		
		// 会话结束 → 触发行为反射（异步，不阻塞退出）
		void (async () => {
			try {
				const result = reflectOnRecentSessions(3);
				if (result.sessionsAnalyzed > 0 || result.newPatterns.length > 0 || result.updatedPatterns.length > 0) {
					const parts: string[] = [];
					if (result.newPatterns.length > 0) parts.push("新发现模式: " + result.newPatterns.join(", "));
					if (result.updatedPatterns.length > 0) parts.push("更新模式: " + result.updatedPatterns.join(", "));
					if (result.summaries.length > 0) parts.push("会话概要: " + result.summaries.join("; "));
					console.log("\x1b[90m🧠 行为反射: " + parts.join(" | ") + "\x1b[0m");
				}
			} catch {
				// silent
			}
		})();
		
		console.log("\nBye.");
		// If still running, abort
		if (currentAbortController) {
			currentAbortController.abort();
		}
		process.exit(0);
	});

	// ── ws-comm 后台监听：PC端发消息自动弹出 ──
	const WS_AGENT_ID = process.env.NOVUS_AGENT_ID || "phone-novus";
	const WS_NOTIFY_FILE = join(tmpdir(), `novus-ws-notify-${WS_AGENT_ID}`);
	const WS_INBOX_FILE = join(homedir(), ".novus", `ws-inbox-${WS_AGENT_ID}.jsonl`);
	const WS_LASTTS_FILE = join(homedir(), ".novus", `ws-lastts-${WS_AGENT_ID}.txt`);
	let wsWatcherTimer: ReturnType<typeof setInterval> | null = null;
	// 持久化：重启后不从0重扫全部历史
	let wsLastInboxSize = existsSync(WS_LASTTS_FILE) ? parseInt(readFileSync(WS_LASTTS_FILE, "utf-8").trim(), 10) || 0 : 0;

	const startWsWatcher = () => {
		wsWatcherTimer = setInterval(() => {
			try {
				if (running) return; // 避免打断进行中的对话
				if (!existsSync(WS_NOTIFY_FILE)) return;
				const inboxContent = existsSync(WS_INBOX_FILE) ? readFileSync(WS_INBOX_FILE, "utf-8") : "";
				const lines = inboxContent.trim().split("\n").filter(Boolean);
				if (lines.length <= wsLastInboxSize) return;
				const newLines = lines.slice(wsLastInboxSize);
				wsLastInboxSize = lines.length;
				try { unlinkSync(WS_NOTIFY_FILE); } catch {}
				try { writeFileSync(WS_LASTTS_FILE, String(lines.length)); } catch {}
				const seen = new Set<string>();
				const msgs = newLines
					.map(l => { try { return JSON.parse(l); } catch { return null; } })
					.filter((m: any) => {
						if (!m) return false;
						if (m._control || m._error) return false;
						if (m.from === "unknown" && (!m.content || m.content.trim() === "")) return false;
						const key = `${m.from || ""}:${m.content || ""}:${m.timestamp || ""}`;
						if (seen.has(key)) return false;
						seen.add(key);
						return true;
					})
					.map((m: any) => `[${m.from || "?"}] ${m.content || ""}`);
				if (msgs.length === 0) return;
				console.error("\n\x1b[36m📬 ws-comm: " + msgs.length + " 条新消息\x1b[0m");
				void runPrompt("[ws-comm] 收到 " + msgs.length + " 条新消息:\n" + msgs.join("\n"));
			} catch { /* silent */ }
		}, 2000);
	};

	const stopWsWatcher = () => {
		if (wsWatcherTimer) { clearInterval(wsWatcherTimer); wsWatcherTimer = null; }
	};

	startWsWatcher();

	rl.prompt();
}

async function acquireTermuxWakeLock(): Promise<void> {
	try {
		const { execSync } = await import("node:child_process");
		execSync("termux-wake-lock", { stdio: "ignore" });
		console.log("🔒 Termux wake lock acquired — screen off won't stop novus.");
	} catch {
		// Not running in Termux, silently ignore
	}
}

async function main(): Promise<void> {
	await acquireTermuxWakeLock();
	const args = parseArgs(process.argv.slice(2));

	if (args.help) {
		printHelp();
		return;
	}

	if (args.list) {
		showSessionList();
		return;
	}

	if (args.delete_) {
		const did = deleteSession(args.delete_);
		console.log(did ? `Deleted session: ${args.delete_}` : `Session not found: ${args.delete_}`);
		return;
	}

	if (args.evolve) {
		const config = resolveConfig(args);
		const cwd = config.cwd ?? process.cwd();
		await runEvolve(cwd);
		return;
	}

	if (args.init) {
		try {
			const path = initConfig(args.cwd, args.initForce);
			console.log(`📄 Created config: ${path}`);
		} catch (err) {
			console.error(`Error: ${err instanceof Error ? err.message : err}`);
			process.exit(1);
		}
		return;
	}

	if (args.showConfig) {
		const config = resolveConfig(args);
		console.log(`Configuration (source: ${configSource()}):`);
		console.log(JSON.stringify(config, null, 2));
		return;
	}

	// Daemon scheduler mode
	if (args.daemon) {
		const config = resolveConfig(args);
		const cwd = config.cwd ?? process.cwd();
		const { startDaemonScheduler, daemonStatus } = await import("./autonomous/daemon-scheduler.ts");
		if (daemonStatus().running) {
			console.log("Daemon already running (PID: " + daemonStatus().pid + ")");
			return;
		}
		await startDaemonScheduler(cwd);
		// keep process alive
		await new Promise(() => {});
		return;
	}

	// Kill daemon
	if (args.daemonKill) {
		const { daemonStatus } = await import("./autonomous/daemon-scheduler.ts");
		const status = daemonStatus();
		if (status.pid) {
			try {
				process.kill(status.pid, "SIGTERM");
				console.log("Daemon killed (PID: " + status.pid + ")");
			} catch {
				console.error("Failed to kill daemon");
			}
		} else {
			console.log("No daemon running");
		}
		return;
	}

	// --due: list due tasks (no LLM, pure logic)
	if (args.due) {
		const { getDueTasks, shortId } = await import("./autonomous/scheduler.ts");
		const due = getDueTasks();
		if (due.length === 0) {
			console.log("NO_DUE_TASKS");
		} else {
			for (const t of due) {
				console.log(`[${shortId(t.id)}] ${t.name}`);
			}
		}
		return;
	}

	// --exec <taskId>: run a task via LLM (one-shot)
	if (args.exec) {
		const { getTask, shortId } = await import("./autonomous/scheduler.ts");
		const task = getTask(args.exec);
		if (!task) {
			console.error(`Task not found: ${args.exec}`);
			process.exit(1);
		}
		const promptText = `执行自主任务 [${shortId(task.id)}]「${task.name}」。
指令: ${task.instruction}

请按指令完成工作，完成后用 auto-manage action=complete taskId=${task.id} summary="结果摘要" 标记完成。
只做不解释，不要输出多余内容。`;
		return runOneShot({ ...args, prompt: promptText });
	}

	// HTTP server mode
	if (args.serve) {
		const { startServer } = await import("./server.ts");
		const resolvedConfig = resolveConfig(args);
		return startServer({
			port: args.port || undefined,
			cwd: resolvedConfig.cwd,
			auth: args.auth,
			authFile: args.authFile,
		});
	}

	// One-shot mode: explicit -p or piped stdin
	if (args.prompt || hasStdinData()) {
		return runOneShot(args);
	}

	// Interactive mode (TTY with no prompt)
	return runInteractive(args);
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
