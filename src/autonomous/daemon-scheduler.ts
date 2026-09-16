/**
 * Daemon Scheduler — 后台定时任务调度器
 *
 * 作为独立进程运行（novus --daemon），用 setInterval 定期检查到期任务，
 * 并通过 headless agent 执行任务的 instruction。
 *
 * 特点：
 *   - 不依赖 cron，纯 Node.js
 *   - PID 文件防重复启动
 *   - 执行完到期任务后更新调度时间
 *   - 支持优雅退出
 *   - Termux 友好：低 CPU 占用
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// daemon 模式下禁用 buf() 写入，避免 read-buffer 死循环
process.env.NOVUS_DAEMON = '1';

const NOVUS_DIR = join(homedir(), ".novus");
const PID_FILE = join(NOVUS_DIR, "daemon.pid");

// 检查间隔：60 秒（足够轻量）
const CHECK_INTERVAL_MS = 60_000;

// ws-comm 事件驱动监听：1 秒检测一次 notify 文件（readdirSync 开销极低）
const WS_NOTIFY_INTERVAL_MS = 1_000;
const WS_NOTIFY_PREFIX = "novus-ws-notify-";

/**
 * 获取当前 daemon 的 PID，如果正在运行的话。
 */
export function getDaemonPid(): number | null {
	if (!existsSync(PID_FILE)) return null;
	try {
		const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
		if (isNaN(pid)) return null;
		// 检查进程是否真的存在
		try {
			process.kill(pid, 0); // 信号 0 = 不杀，只检查
			return pid;
		} catch {
			// 进程不存在，清理残留 PID 文件
			unlinkSync(PID_FILE);
			return null;
		}
	} catch {
		return null;
	}
}

/**
 * 写入 PID 文件，防止重复启动。
 */
function writePidFile(): void {
	writeFileSync(PID_FILE, process.pid.toString(), "utf-8");
}

/**
 * 清理 PID 文件。
 */
function removePidFile(): void {
	try { unlinkSync(PID_FILE); } catch { /* ignore */ }
}

/**
 * 优雅退出处理。
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
 * 启动 daemon 调度循环。
 *
 * @param cwd - 工作目录（agent 执行任务时使用）
 * @returns 一个 stop 函数，调用后停止调度循环
 */
export async function startDaemonScheduler(cwd: string): Promise<() => void> {
	// 防重复
	if (getDaemonPid() !== null) {
		console.error("⚠️  Daemon scheduler is already running (PID: " + getDaemonPid() + ")");
		return () => {};
	}

	writePidFile();
	setupGracefulShutdown();

	// 延迟导入 agent，避免循环依赖
	const { getDueTasks, markTaskExecuted } = await import("./scheduler.ts");
	const { createMinAgent } = await import("../agent.ts");

	console.log("🕐 Daemon scheduler started (PID: " + process.pid + ", check interval: " + (CHECK_INTERVAL_MS / 1000) + "s)");

	// 跟踪正在执行的任务，避免并发执行同一个
	const runningTaskIds = new Set<string>();

	const tick = async () => {
		const due = getDueTasks().filter(t => !runningTaskIds.has(t.id));
		if (due.length === 0) return;

		for (const task of due) {
			if (runningTaskIds.has(task.id)) continue;
			runningTaskIds.add(task.id);

			const startTime = Date.now();
			console.log("▶ 执行任务: " + task.name + " [" + task.id.slice(0, 6) + "]");

			try {
				// 创建 headless agent 执行任务
				const agent = await createMinAgent({ cwd, maxToolCallsPerTurn: 200 });
				const prompt = `执行以下自主任务。完成后用 auto-manage action=complete 记录结果（包含 summary）。\n\n## 任务\n名称: ${task.name}\n指令:\n${task.instruction}\n\n注意：这是后台自动执行，不需要输出给用户看。安静地执行，完成即可。`;
				await agent.prompt(prompt);
				// markTaskExecuted 由 agent 在执行 auto-manage complete 时调用
				// 但如果 agent 没调 complete，我们兜底标记成功
				console.log("✅ 任务完成: " + task.name + " (" + ((Date.now() - startTime) / 1000).toFixed(1) + "s)");
			} catch (err) {
				console.error("❌ 任务失败: " + task.name + " — " + (err instanceof Error ? err.message : err));
				markTaskExecuted(task.id, false, "daemon execution error: " + (err instanceof Error ? err.message : String(err)));
			} finally {
				runningTaskIds.delete(task.id);
			}
		}
	};

	// ── ws-comm 事件驱动监听：检测 notify 文件，秒级响应新消息 ──
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
const prompt = `【必须回复】你收到了来自节点 ${replyTo} 的 ws-comm 消息。

消息内容：
${msgsText}

回复方法（必做）：调用 ws-comm 工具，参数：action=send, myId=${agentId}, to=${replyTo}, type=result, content=你的回复内容

规则：
1. question 和 request 类型 → 必须用 ws-comm action=send 回复到 ${replyTo}
2. result 和 alert 类型 → 不用回复，忽略即可
3. 绝对不要只输出文字不调用工具`
					await agent.prompt(prompt);
					console.log("✅ ws-comm 消息已处理: " + agentId + " (" + msgs.length + " 条)");
				} finally {
					wsProcessing = false;
				}
			}
		} catch {
			// silent —— ws-notify 检测失败不阻断主调度循环
		}
	};

	// 立即执行一次
	tick().catch(err => console.error("Daemon tick error:", err));
	void checkWsNotify();

	// 定期检查
	const timer = setInterval(() => tick().catch(err => console.error("Daemon tick error:", err)), CHECK_INTERVAL_MS);
	// 允许进程不被 timer 阻止退出
	if (timer.unref) timer.unref();

	// ws-comm 秒级监听
	const wsTimer = setInterval(() => { void checkWsNotify(); }, WS_NOTIFY_INTERVAL_MS);
	if (wsTimer.unref) wsTimer.unref();

	return () => {
		clearInterval(timer);
		clearInterval(wsTimer);
		removePidFile();
	};
}

/**
 * 检查 daemon 是否正在运行，返回状态信息。
 */
export function daemonStatus(): { running: boolean; pid: number | null } {
	const pid = getDaemonPid();
	return { running: pid !== null, pid };
}
