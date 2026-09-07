/**
 * Daemon Scheduler — background scheduled-task runner
 *
 * Runs as a separate process (novus --daemon), checks due tasks on an interval via setInterval,
 * and executes each task's instruction via a headless agent.
 *
 * Features:
 *   - no cron needed, pure Node.js
 *   - PID file prevents double-start
 *   - updates scheduling after running due tasks
 *   - graceful shutdown
 *   - Termux-friendly: low CPU usage
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// disable buf() writes in daemon mode to avoid a read-buffer feedback loop
process.env.NOVUS_DAEMON = '1';

const NOVUS_DIR = join(homedir(), ".novus");
const PID_FILE = join(NOVUS_DIR, "daemon.pid");

// check interval: 60s (light enough)
const CHECK_INTERVAL_MS = 60_000;

// ws-comm event-driven listener: poll the notify file every 1s (readdirSync is dirt cheap)
const WS_NOTIFY_INTERVAL_MS = 1_000;
const WS_NOTIFY_PREFIX = "novus-ws-notify-";

/**
 * Get the current daemon PID, if running.
 */
export function getDaemonPid(): number | null {
	if (!existsSync(PID_FILE)) return null;
	try {
		const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
		if (isNaN(pid)) return null;
		// check the process actually exists
		try {
			process.kill(pid, 0); // signal 0 = no kill, existence check only
			return pid;
		} catch {
			// process gone — clean up the stale PID file
			unlinkSync(PID_FILE);
			return null;
		}
	} catch {
		return null;
	}
}

/**
 * Write the PID file, preventing double-start.
 */
function writePidFile(): void {
	writeFileSync(PID_FILE, process.pid.toString(), "utf-8");
}

/**
 * Remove the PID file.
 */
function removePidFile(): void {
	try { unlinkSync(PID_FILE); } catch { /* ignore */ }
}

/**
 * Graceful shutdown handling.
 */
function setupGracefulShutdown(): void {
	const cleanup = () => {
		removePidFile();
		process.exit(0);
	};
	process.on("SIGINT", cleanup);
	process.on("SIGTERM", cleanup);
	process.on("SIGHUP", cleanup);
}

/**
 * Start the daemon scheduling loop.
 *
 * @param cwd - working directory (used by the agent when running tasks)
 * @returns a stop function that halts the scheduling loop
 */
export async function startDaemonScheduler(cwd: string): Promise<() => void> {
	// guard against double-start
	if (getDaemonPid() !== null) {
		console.error("⚠️  Daemon scheduler is already running (PID: " + getDaemonPid() + ")");
		return () => {};
	}

	writePidFile();
	setupGracefulShutdown();

	// lazy-import agent to avoid circular dependency
	const { getDueTasks, markTaskExecuted } = await import("./scheduler.ts");
	const { createMinAgent } = await import("../agent.ts");

	console.log("🕐 Daemon scheduler started (PID: " + process.pid + ", check interval: " + (CHECK_INTERVAL_MS / 1000) + "s)");

	// track in-flight tasks, avoid running the same one concurrently
	const runningTaskIds = new Set<string>();

	const tick = async () => {
		const due = getDueTasks().filter(t => !runningTaskIds.has(t.id));
		if (due.length === 0) return;

		for (const task of due) {
			if (runningTaskIds.has(task.id)) continue;
			runningTaskIds.add(task.id);

			const startTime = Date.now();
			console.log("▶ Executing task: " + task.name + " [" + task.id.slice(0, 6) + "]");

			try {
				// spawn a headless agent to run the task
				const agent = await createMinAgent({ cwd, maxToolCallsPerTurn: 200 });
				const prompt = `Execute the following autonomous task. When done, record the result (including a summary) with auto-manage action=complete.\n\n## Task\nName: ${task.name}\nInstruction:\n${task.instruction}\n\nNote: this runs in the background, no output for the user. Execute quietly and finish.`;
				await agent.prompt(prompt);
				// markTaskExecuted is called by the agent on auto-manage complete,
				// but if it never calls complete, we mark success as a fallback
				console.log("✅ Task completed: " + task.name + " (" + ((Date.now() - startTime) / 1000).toFixed(1) + "s)");
			} catch (err) {
				console.error("❌ Task failed: " + task.name + " — " + (err instanceof Error ? err.message : err));
				markTaskExecuted(task.id, false, "daemon execution error: " + (err instanceof Error ? err.message : String(err)));
			} finally {
				runningTaskIds.delete(task.id);
			}
		}
	};

	// ── ws-comm event-driven listener: watch the notify file, react to new messages in seconds ──
	let wsProcessing = false;
	const checkWsNotify = async () => {
		if (wsProcessing) return;
		try {
			const notifyFiles = readdirSync(tmpdir()).filter((f) => f.startsWith(WS_NOTIFY_PREFIX));
			if (notifyFiles.length === 0) return;

			for (const f of notifyFiles) {
				const agentId = f.slice(WS_NOTIFY_PREFIX.length);
				const notifyFile = join(tmpdir(), f);
				const inboxFile = join(NOVUS_DIR, `ws-inbox-${agentId}.jsonl`);
				const lastSizeFile = join(NOVUS_DIR, `ws-lastts-${agentId}.txt`);

				if (!existsSync(inboxFile)) {
					try { unlinkSync(notifyFile); } catch {}
					continue;
				}
				const lines = readFileSync(inboxFile, "utf-8").trim().split("\n").filter(Boolean);
				const lastSize = existsSync(lastSizeFile) ? parseInt(readFileSync(lastSizeFile, "utf-8").trim(), 10) || 0 : 0;
				if (lines.length <= lastSize) {
					try { unlinkSync(notifyFile); } catch {}
					continue;
				}
				const newLines = lines.slice(lastSize);
				writeFileSync(lastSizeFile, String(lines.length));
				try { unlinkSync(notifyFile); } catch {}

				const msgs = newLines
					.map((l) => { try { return JSON.parse(l); } catch { return null; } })
					.filter(Boolean);
				if (msgs.length === 0) continue;

				wsProcessing = true;
				try {
					const agent = await createMinAgent({ cwd, maxToolCallsPerTurn: 200 });
					const msgsText = msgs
						.map((m: any) => `[${m.from || "?"}] ${m.type || "msg"}: ${String(m.content || m.raw || "").slice(0, 500)}`)
						.join("\n");
					const replyTo = msgs[0]?.from || agentId;
const prompt = `[REPLY REQUIRED] You received a ws-comm message from node ${replyTo}.

Message content:
${msgsText}

How to reply (required): call the ws-comm tool with action=send, myId=${agentId}, to=${replyTo}, type=result, content=your reply

Rules:
1. question and request types → must reply via ws-comm action=send to ${replyTo}
2. result and alert types → no reply needed, ignore
3. Never just print text without calling the tool`
					await agent.prompt(prompt);
					console.log("✅ ws-comm message processed: " + agentId + " (" + msgs.length + " message(s))");
				} finally {
					wsProcessing = false;
				}
			}
		} catch {
			// silent — ws-notify failures must not block the main scheduling loop
		}
	};

	// run once immediately
	tick().catch(err => console.error("Daemon tick error:", err));
	void checkWsNotify();

	// periodic checks
	const timer = setInterval(() => tick().catch(err => console.error("Daemon tick error:", err)), CHECK_INTERVAL_MS);
	// keep the timer from keeping the process alive
	if (timer.unref) timer.unref();

	// ws-comm second-level listener
	const wsTimer = setInterval(() => { void checkWsNotify(); }, WS_NOTIFY_INTERVAL_MS);
	if (wsTimer.unref) wsTimer.unref();

	return () => {
		clearInterval(timer);
		clearInterval(wsTimer);
		removePidFile();
	};
}

/**
 * Check whether the daemon is running, return status info.
 */
export function daemonStatus(): { running: boolean; pid: number | null } {
	const pid = getDaemonPid();
	return { running: pid !== null, pid };
}
