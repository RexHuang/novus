/**
 * evolve-track — evolution tracking tool
 *
 * Lets novus log its own evolution events in real time during conversations,
 * and query the capability dashboard.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  logEvolution,
  buildEvolutionDashboard,
  buildGrowthSummary,
  getCapabilitySnapshot,
  loadEvolutions,
  updateCapabilitySnapshot,
} from "../../evolution/tracker.ts";
import type { EvolutionType } from "../../evolution/tracker.ts";

interface EvolveTrackParams {
  action: "log" | "dashboard" | "snapshot" | "history";
  type?: EvolutionType;
  title?: string;
  description?: string;
  trigger?: "user-request" | "self-discovery" | "task-driven" | "proactive";
  files?: string[];
}

function text(t: string) {
  return { type: "text" as const, text: t };
}

export function createTool(_cwd: string): AgentTool<any> {
  return {
    name: "evolve-track",
    description:
      "Track and display self-evolution. Actions: log (record an evolution event), dashboard (show capability dashboard), snapshot (take & show capability snapshot), history (show evolution history).",
    label: "evolve-track",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "Action: 'log', 'dashboard', 'snapshot', or 'history'",
          enum: ["log", "dashboard", "snapshot", "history"],
        },
        type: {
          type: "string",
          description: "Evolution type (for log): new-tool, tool-improvement, new-module, bug-fix, performance, knowledge, prompt-engineering, self-reflection, architecture, capability-new",
        },
        title: { type: "string", description: "One-line summary of what evolved (for log)" },
        description: { type: "string", description: "Detailed description (for log)" },
        trigger: { type: "string", description: "Trigger: user-request, self-discovery, task-driven, proactive (for log)" },
        files: { type: "array", items: { type: "string" }, description: "Files changed (for log)" },
      },
      required: ["action"],
    },
    execute: async (_toolCallId: string, params: unknown) => {
      const p = params as EvolveTrackParams;

      switch (p.action) {
        case "log":
          return handleLog(p);
        case "dashboard":
          return { content: [text(buildEvolutionDashboard())], details: {} };
        case "snapshot":
          const snap = updateCapabilitySnapshot();
          return { content: [text(formatSnapshot(snap))], details: snap };
        case "history":
          return { content: [text(formatHistory())], details: {} };
        default:
          return { content: [text(`Unknown action: ${p.action}`)], details: {} };
      }
    },
  };
}

function handleLog(p: EvolveTrackParams) {
  if (!p.type || !p.title) {
    return {
      content: [text("Error: 'type' and 'title' are required for log action.")],
      details: {},
    };
  }

  const event = logEvolution({
    type: p.type,
    title: p.title,
    description: p.description ?? "",
    trigger: p.trigger ?? "self-discovery",
    files: p.files,
  });

  return {
    content: [text(`🧬 Evolution logged #${event.id}
${event.title}
trigger: ${event.trigger}
type: ${event.type}`)],
    details: event,
  };
}

function formatSnapshot(snap: ReturnType<typeof updateCapabilitySnapshot>): string {
  const lines = [`Capability snapshot [${snap.timestamp.slice(0, 16)}]`, `
overall: ${snap.totalScore}/100`, `tools: ${snap.toolCount} | knowledge: ${snap.knowledgeCount} | evolutions: ${snap.evolutionCount}`, ""];

  for (const dim of snap.dimensions) {
    const bar = "█".repeat(Math.round(dim.score / 5)) + "░".repeat(20 - Math.round(dim.score / 5));
    lines.push(`${dim.name.padEnd(8)} ${bar} ${dim.score}`);
    lines.push(`         ${dim.level}`);
    if (dim.recentEvolution) {
      lines.push(`         latest: ${dim.recentEvolution}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatHistory(): string {
  const evolutions = loadEvolutions();
  if (evolutions.length === 0) {
    return "No evolution records yet. Use evolve-track action=log to record the first one.";
  }

  const lines = [`Evolution history (${evolutions.length} total)`, ""];

  // newest first
  const sorted = [...evolutions].reverse();
  for (const evo of sorted) {
    const date = evo.timestamp.slice(0, 16);
    const triggerMap: Record<string, string> = {
      "user-request": "user request",
      "self-discovery": "self-discovery",
      "task-driven": "task-driven",
      proactive: "proactive",
    };
    const trigger = triggerMap[evo.trigger] ?? evo.trigger;
    lines.push(`[${date}] ${evo.title}`);
    lines.push(`  type: ${evo.type} | trigger: ${trigger}`);
    if (evo.description) {
      lines.push(`  ${evo.description.slice(0, 100)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
