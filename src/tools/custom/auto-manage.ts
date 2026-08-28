/**
 * auto-manage — 自主任务管理工具
 *
 * 让 novus 能注册、查看、执行、管理自主任务。
 * 配合 autonomous/scheduler.ts 使用。
 *
 * Actions:
 *   register — 注册新任务
 *   list     — 列出任务
 *   run      — 手动触发执行（输出任务指令供 agent 执行）
 *   complete — 标记任务已完成
 *   fail     — 标记任务失败
 *   pause    — 暂停任务
 *   resume   — 恢复任务
 *   delete   — 删除任务
 *   history  — 查看执行历史
 *   due      — 查看到期任务
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  registerTask,
  listTasks,
  getTask,
  updateTaskStatus,
  deleteTask,
  markTaskExecuted,
  getDueTasks,
  getExecutionHistory,
  shortId,
  type AutonomousTask,
} from "../../autonomous/scheduler.ts";

function formatTask(t: AutonomousTask): string {
  const last = t.lastRunAt ? ` | last: ${t.lastRunAt.slice(0, 16)}` : "";
  const next = t.nextRunAt ? ` | next: ${t.nextRunAt.slice(0, 16)}` : "";
  return `[${shortId(t.id)}] ${t.name} (${t.status}, ${t.trigger})${last}${next} | runs: ${t.runCount}/${t.successCount} ok`;
}

/**
 * Build a learn reminder based on task tags.
 * Ensures agent actually persists findings to knowledge store.
 */
function buildLearnReminder(task: AutonomousTask): string {
  if (task.trigger === "on-start" && task.tags?.some(t => t.includes("调度"))) {
    return ""; // skip for scheduler meta-task
  }
  const tags = task.tags ?? [];
  const learnTags = tags.filter(t => !t.includes("finance") && !t.includes("A股")).join(", ");
  if (!learnTags) {
    return "";
  }
  return [
    `⚠️ MANDATORY: Before calling auto-manage complete, you MUST call:`,
    `   connect action=learn content="<你发现的关键情报摘要>" tags=[${learnTags}] source="任务: ${task.name}"`,
    `   Store ALL non-trivial findings, not just "nothing found". If you found useful data, learn it.`,
    ``,
  ].join("\n");
}

export function createTool(cwd: string): AgentTool<any> {
  return {
    name: "auto-manage",
    description: "自主任务管理：注册、查看、执行、管理自主任务。让 novus 从被动工具变成主动 agent。",
    label: "auto-manage",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "操作类型",
          enum: ["register", "list", "run", "complete", "fail", "pause", "resume", "delete", "history", "due", "quality"],
        },
        // register 参数
        name: {
          type: "string",
          description: "任务名称（register 时必填）",
        },
        instruction: {
          type: "string",
          description: "任务指令——agent 执行时要做的事（register 时必填）",
        },
        trigger: {
          type: "string",
          description: "触发类型: on-start（启动一次）/ on-start-recurring（每次启动）/ periodic（定期）/ event（条件触发）/ delay-until（指定时间后触发一次）",
          enum: ["on-start", "on-start-recurring", "periodic", "event", "delay-until"],
        },
        intervalHours: {
          type: "number",
          description: "periodic 任务的间隔（小时），默认 24",
        },
        delayUntil: {
          type: "string",
          description: "delay-until 任务的触发时间（ISO datetime），如 2026-08-07T09:00:00",
        },
        eventCondition: {
          type: "string",
          description: "event 触发条件描述",
        },
        tags: {
          type: "string",
          description: "逗号分隔的标签",
        },
        // 通用参数
        taskId: {
          type: "string",
          description: "任务ID（complete/fail/pause/resume/delete 时必填）",
        },
        summary: {
          type: "string",
          description: "执行结果摘要（complete/fail 时可选）",
        },
        status: {
          type: "string",
          description: "按状态过滤（list 时可选）",
          enum: ["active", "paused", "completed", "failed"],
        },
      },
      required: ["action"],
    },
    execute: async (_toolCallId: string, params: unknown) => {
      const p = params as Record<string, string | number | undefined>;

      try {
        switch (p.action) {
          case "register": {
            if (!p.name || !p.instruction) {
              return { content: [{ type: "text", text: "Error: name and instruction are required for register" }], details: {} };
            }
            const trigger = (p.trigger as "on-start" | "periodic" | "event" | "delay-until") ?? "on-start";
            const tags = typeof p.tags === "string" ? p.tags.split(",").map(t => t.trim()).filter(Boolean) : undefined;
            const task = registerTask({
              name: p.name as string,
              instruction: p.instruction as string,
              trigger,
              intervalHours: typeof p.intervalHours === "number" ? p.intervalHours : undefined,
              eventCondition: typeof p.eventCondition === "string" ? p.eventCondition : undefined,
              delayUntil: typeof p.delayUntil === "string" ? p.delayUntil : undefined,
              tags,
            });
            return {
              content: [{ type: "text", text: `Registered task: ${task.id}\n${formatTask(task)}` }],
              details: {},
            };
          }

          case "list": {
            const statusFilter = p.status as "active" | "paused" | "completed" | "failed" | undefined;
            const tasks = listTasks(statusFilter);
            if (tasks.length === 0) {
              return { content: [{ type: "text", text: "No tasks found." }], details: {} };
            }
            const lines = tasks.map(t => formatTask(t));
            return {
              content: [{ type: "text", text: `Tasks (${tasks.length}):\n${lines.join("\n")}` }],
              details: {},
            };
          }

          case "run": {
            // run: 输出指令让 agent 执行一个或多个到期任务
            const runId = p.taskId as string | undefined;

            if (runId) {
              // 单个任务
              const taskToRun = getTask(runId);
              if (!taskToRun) {
                return { content: [{ type: "text", text: `Task ${runId} not found.` }], details: {} };
              }
              const sid = shortId(taskToRun.id);
              const execPrompt = [
                `## Autonomous Task: ${taskToRun.name}`,
                ``,
                `Short ID: ${sid}`,
                `Full ID: ${taskToRun.id}`,
                `Instruction: ${taskToRun.instruction}`,
                ``,
                buildLearnReminder(taskToRun),
                `Execute this task now. When done, use auto-manage action=complete taskId=${sid} summary="..." to record success, or action=fail if it failed.`,
              ].join("\n");
              return { content: [{ type: "text", text: execPrompt }], details: {} };
            }

            // 没有 taskId — 一次输出所有到期任务
            const due = getDueTasks();
            if (due.length === 0) {
              return { content: [{ type: "text", text: "No due tasks found." }], details: {} };
            }

            const lines: string[] = [];
            for (const t of due) {
              lines.push(`### ${t.name}`);
              lines.push(`Task ID: ${t.id}`);
              lines.push(`Instruction: ${t.instruction}`);
              lines.push(`---`);
            }
            const allPrompt = [
              `## Autonomous Tasks (${due.length} due)`,
              ``,
              `Execute ALL of the following tasks in order. After completing each one, immediately call auto-manage action=complete taskId=... summary="..." before moving to the next.`,
              ``,
              `⚠️ IMPORTANT: After each task, you MUST call connect learn to persist findings. This is non-negotiable.`,
              ``,
              ...lines,
            ].join("\n");

            return {
              content: [{ type: "text", text: allPrompt }],
              details: {},
            };
          }

          case "complete": {
            if (!p.taskId) {
              return { content: [{ type: "text", text: "Error: taskId is required" }], details: {} };
            }
            const completed = markTaskExecuted(p.taskId as string, true, p.summary as string | undefined);
            if (!completed) {
              return { content: [{ type: "text", text: `Task ${p.taskId} not found` }], details: {} };
            }
            return {
              content: [{ type: "text", text: `Task completed: ${formatTask(completed)}` }],
              details: {},
            };
          }

          case "fail": {
            if (!p.taskId) {
              return { content: [{ type: "text", text: "Error: taskId is required" }], details: {} };
            }
            const failed = markTaskExecuted(p.taskId as string, false, p.summary as string | undefined);
            if (!failed) {
              return { content: [{ type: "text", text: `Task ${p.taskId} not found` }], details: {} };
            }
            return {
              content: [{ type: "text", text: `Task failed: ${formatTask(failed)}` }],
              details: {},
            };
          }

          case "pause": {
            if (!p.taskId) {
              return { content: [{ type: "text", text: "Error: taskId is required" }], details: {} };
            }
            const paused = updateTaskStatus(p.taskId as string, "paused");
            if (!paused) {
              return { content: [{ type: "text", text: `Task ${p.taskId} not found` }], details: {} };
            }
            return {
              content: [{ type: "text", text: `Task paused: ${formatTask(paused)}` }],
              details: {},
            };
          }

          case "resume": {
            if (!p.taskId) {
              return { content: [{ type: "text", text: "Error: taskId is required" }], details: {} };
            }
            const resumed = updateTaskStatus(p.taskId as string, "active");
            if (!resumed) {
              return { content: [{ type: "text", text: `Task ${p.taskId} not found` }], details: {} };
            }
            return {
              content: [{ type: "text", text: `Task resumed: ${formatTask(resumed)}` }],
              details: {},
            };
          }

          case "delete": {
            if (!p.taskId) {
              return { content: [{ type: "text", text: "Error: taskId is required" }], details: {} };
            }
            const deleted = deleteTask(p.taskId as string);
            return {
              content: [{ type: "text", text: deleted ? `Task ${p.taskId} deleted.` : `Task ${p.taskId} not found.` }],
              details: {},
            };
          }

          case "history": {
            const history = getExecutionHistory(20);
            if (history.length === 0) {
              return { content: [{ type: "text", text: "No execution history." }], details: {} };
            }
            const lines = history.map(h => {
              const status = h.success ? "OK" : "FAIL";
              return `[${h.completedAt?.slice(0, 16) ?? "?"}] ${h.taskName} — ${status}${h.summary ? ": " + h.summary : ""}`;
            });
            return {
              content: [{ type: "text", text: `Execution history:\n${lines.join("\n")}` }],
              details: {},
            };
          }

          case "due": {
            const dueTasks = getDueTasks();
            if (dueTasks.length === 0) {
              return { content: [{ type: "text", text: "No tasks due." }], details: {} };
            }
            const lines = dueTasks.map(t => formatTask(t));
            return {
              content: [{ type: "text", text: `Due tasks (${dueTasks.length}):\n${lines.join("\n")}` }],
              details: {},
            };
          }

          case "quality": {
            const allTasks = listTasks("active");
            if (allTasks.length === 0) {
              return { content: [{ type: "text", text: "No active tasks." }], details: {} };
            }
            const history = getExecutionHistory(50);
            const lines: string[] = ["Task Quality Report (active tasks):", ""];

            for (const t of allTasks) {
              const taskHistory = history.filter(h => h.taskId === t.id);
              const recent = taskHistory.slice(0, 3);
              const avgQuality = recent.length > 0
                ? recent.reduce((s, h) => s + ((h as any).qualityScore ?? 0.5), 0) / recent.length
                : (t.lastQualityScore ?? 0.5);
              const streak = t.lowQualityStreak ?? 0;
              const status = avgQuality < 0.3 ? "⚠️ LOW" : avgQuality < 0.6 ? "🟡 MED" : "🟢 OK";
              const interval = t.intervalHours ? ` ${t.intervalHours}h` : "";
              const streakWarn = streak >= 3 ? ` → 暂停风险!` : streak >= 2 ? ` → 已降频` : "";
              lines.push(`[${shortId(t.id)}] ${status} q=${avgQuality.toFixed(2)} streak=${streak}${interval}${streakWarn} | ${t.name}`);
              for (const h of recent) {
                const q = (h as any).qualityScore ?? 0.5;
                lines.push(`    ${h.completedAt?.slice(0, 16) ?? "?"} q=${q.toFixed(2)} | ${(h.summary || "").substring(0, 50)}`);
              }
              lines.push("");
            }

            return {
              content: [{ type: "text", text: lines.join("\n") }],
              details: {},
            };
          }

          default:
            return { content: [{ type: "text", text: `Unknown action: ${p.action}` }], details: {} };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${msg}` }], details: {} };
      }
    },
  };
}
