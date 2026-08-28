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
		description: "项目级持久化记忆。记录开发项目的进度、决策、待办，跨会话自动恢复上下文。开发时每次推进工作后调用 update 更新进度。",
		label: "project-memory",

		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["update","status","module","decision","todo","list","create"], description: "操作类型" },
				slug: { type: "string", description: "项目slug（不填则用活跃项目）" },
				name: { type: "string", description: "项目名称（create时必填）" },
				description: { type: "string", description: "项目描述（create时必填）" },
				techStack: { type: "array", items: { type: "string" }, description: "技术栈" },
				lastWork: { type: "string", description: "当前工作内容" },
				nextStep: { type: "string", description: "下一步计划" },
				lastFiles: { type: "array", items: { type: "string" }, description: "涉及的文件" },
				moduleName: { type: "string", description: "模块名" },
				moduleStatus: { type: "string", enum: ["done","in-progress","not-started"] },
				moduleDetail: { type: "string", description: "模块详情" },
				decision: { type: "string", description: "决策内容" },
				reason: { type: "string", description: "决策原因" },
				item: { type: "string", description: "待办项" },
			},
			required: ["action"],
		},

		execute: async (_toolCallId: string, raw: unknown) => {
			const p = raw as Record<string, any>;
			const slug = p.slug || getActiveProject()?.slug || "default";

			switch (p.action) {
				case "create": {
					if (!p.name || !p.description) return textResult("❌ name 和 description 必填");
					const profile: ProjectProfile = {
						slug, name: p.name, description: p.description,
						techStack: p.techStack || [], modules: [], decisions: [], todo: [],
						lastFiles: [], lastWork: "", nextStep: "",
						createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
					};
					saveProject(profile);
					return textResult(`✅ 项目已创建: ${p.name} (${slug})`);
				}
				case "update": {
					touchProject(slug, { lastWork: p.lastWork, nextStep: p.nextStep, lastFiles: p.lastFiles });
					return textResult(`✅ 项目 ${slug} 已更新`);
				}
				case "status": {
					const proj = loadProject(slug);
					if (!proj) return textResult(`❌ 项目 ${slug} 不存在`);
					return textResult(projectContextSummary(slug));
				}
				case "module": {
					if (!p.moduleName || !p.moduleStatus) return textResult("❌ moduleName 和 moduleStatus 必填");
					updateModule(slug, p.moduleName, p.moduleStatus, p.moduleDetail);
					return textResult(`✅ ${p.moduleName} → ${p.moduleStatus}`);
				}
				case "decision": {
					if (!p.decision || !p.reason) return textResult("❌ decision 和 reason 必填");
					addDecision(slug, p.decision, p.reason);
					return textResult(`✅ 决策已记录: ${p.decision}`);
				}
				case "todo": {
					if (!p.item) return textResult("❌ item 必填");
					addTodo(slug, p.item);
					return textResult(`✅ 待办已添加: ${p.item}`);
				}
				case "list": {
					const slugs = listProjects();
					if (slugs.length === 0) return textResult("暂无项目");
					const lines = slugs.map(s => { const pr = loadProject(s); return pr ? `${s}: ${pr.name} (${pr.updatedAt.slice(0,10)})` : s; });
					return textResult(lines.join("\n"));
				}
				default: return textResult(`❌ 未知操作: ${p.action}`);
			}
		},
	};
}