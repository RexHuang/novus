/**
 * auto-manage — autonomous task management tool
 *
 * Lets novus register, view, execute and manage autonomous tasks.
 * Works with autonomous/scheduler.ts.
 *
 * Actions:
 *   register — register a new task
 *   list     — list tasks
 *   run      — manually trigger execution (prints the task instruction for the agent)
 *   complete — mark a task completed
 *   fail     — mark a task failed
 *   pause    — pause a task
 *   resume   — resume a task
 *   delete   — delete a task
 *   history  — view execution history
 *   due      — view due tasks
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
    `   connect action=learn content="<summary of key intel you found>" tags=[${learnTags}] source="task: ${task.name}"`,
    `   Store ALL non-trivial findings, not just "nothing found". If you found useful data, learn it.`,
    ``,
  ].join("\n");
}

export function createTool(cwd: string): AgentTool<any> {
  return {
    name: "auto-manage",
    description: "Autonomous task management: register, view, execute and manage autonomous tasks. Turns novus from a passive tool into a proactive agent.",
    label: "auto-manage",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "Action type",
          enum: ["register", "list", "run", "complete", "fail", "pause", "resume", "delete", "history", "due", "quality"],
        },
        // register params
        name: {
          type: "string",
          description: "Task name (required for register)",
        },
        instruction: {
          type: "string",
          description: "Task instruction — what the agent should do (required for register)",
        },
        trigger: {
          type: "string",
          description: "触发类型: on-start（启动一次）/ on-start-recurring（每次启动）/ periodic（定期）/ event（条件触发）/ delay-until（指定时间后触发一次）",
          enum: ["on-start", "on-start-recurring", "periodic", "event", "delay-until"],
        },
        intervalHours: {
          type: "number",
          description: "Interval for periodic tasks (hours), default 24",
        },
        delayUntil: {
          type: "string",
          description: "Trigger time for delay-until tasks (ISO datetime), e.g. 2026-08-07T09:00:00",
        },
        eventCondition: {
          type: "string",
          description: "Event trigger condition description",
        },
        tags: {
          type: "string",
          description: "Comma-separated tags",
        },
        // shared params
        taskId: {
          type: "string",
          description: "Task ID (required for complete/fail/pause/resume/delete)",
        },
        summary: {
          type: "string",
          description: "Execution result summary (optional, for complete/fail)",
        },
        status: {
          type: "string",
          description: "Filter by status (optional, for list)",
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
            // run: print instructions so the agent executes one or more due tasks
            const runId = p.taskId as string | undefined;

            if (runId) {
              // single task
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

            // no taskId — print all due tasks at once
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
              const streakWarn = streak >= 3 ? ` → pause risk!` : streak >= 2 ? ` → throttled` : "";
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
