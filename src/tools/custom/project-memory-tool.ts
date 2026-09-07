/**
 * project-memory tool — 让 agent 能读写项目档案
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	loadProject, saveProject, listProjects, touchProject,
	updateModule, addDecision, addTodo, getActiveProject, projectContextSummary,
} from "../../project-memory.js";
import type { ProjectProfile } from "../../project-memory.js";

function textResult(t: string) {
	return { content: [{ type: "text" as const, text: t }], details: {} as Record<string, never> };
}

export function createTool(_cwd: string): AgentTool<any> {
	return {
		name: "project-memory",
		description: "Project-level persistent memory. Records project progress, decisions and todos; restores context automatically across sessions. Call update after each work session to keep it current.",
		label: "project-memory",

		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["update","status","module","decision","todo","list","create"], description: "Action type" },
				slug: { type: "string", description: "Project slug (defaults to the active project)" },
				name: { type: "string", description: "Project name (required for create)" },
				description: { type: "string", description: "Project description (required for create)" },
				techStack: { type: "array", items: { type: "string" }, description: "Tech stack" },
				lastWork: { type: "string", description: "Current work in progress" },
				nextStep: { type: "string", description: "Next step plan" },
				lastFiles: { type: "array", items: { type: "string" }, description: "Files involved" },
				moduleName: { type: "string", description: "Module name" },
				moduleStatus: { type: "string", enum: ["done","in-progress","not-started"] },
				moduleDetail: { type: "string", description: "Module details" },
				decision: { type: "string", description: "The decision" },
				reason: { type: "string", description: "Why the decision was made" },
				item: { type: "string", description: "Todo item" },
			},
			required: ["action"],
		},

		execute: async (_toolCallId: string, raw: unknown) => {
			const p = raw as Record<string, any>;
			const slug = p.slug || getActiveProject()?.slug || "default";

			switch (p.action) {
				case "create": {
					if (!p.name || !p.description) return textResult("❌ name and description are required");
					const profile: ProjectProfile = {
						slug, name: p.name, description: p.description,
						techStack: p.techStack || [], modules: [], decisions: [], todo: [],
						lastFiles: [], lastWork: "", nextStep: "",
						createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
					};
					saveProject(profile);
					return textResult(`✅ Project created: ${p.name} (${slug})`);
				}
				case "update": {
					touchProject(slug, { lastWork: p.lastWork, nextStep: p.nextStep, lastFiles: p.lastFiles });
					return textResult(`✅ Project ${slug} updated`);
				}
				case "status": {
					const proj = loadProject(slug);
					if (!proj) return textResult(`❌ Project ${slug} not found`);
					return textResult(projectContextSummary(slug));
				}
				case "module": {
					if (!p.moduleName || !p.moduleStatus) return textResult("❌ moduleName and moduleStatus are required");
					updateModule(slug, p.moduleName, p.moduleStatus, p.moduleDetail);
					return textResult(`✅ ${p.moduleName} → ${p.moduleStatus}`);
				}
				case "decision": {
					if (!p.decision || !p.reason) return textResult("❌ decision and reason are required");
					addDecision(slug, p.decision, p.reason);
					return textResult(`✅ Decision recorded: ${p.decision}`);
				}
				case "todo": {
					if (!p.item) return textResult("❌ item is required");
					addTodo(slug, p.item);
					return textResult(`✅ Todo added: ${p.item}`);
				}
				case "list": {
					const slugs = listProjects();
					if (slugs.length === 0) return textResult("no projects yet");
					const lines = slugs.map(s => { const pr = loadProject(s); return pr ? `${s}: ${pr.name} (${pr.updatedAt.slice(0,10)})` : s; });
					return textResult(lines.join("\n"));
				}
				default: return textResult(`❌ Unknown action: ${p.action}`);
			}
		},
	};
}