/**
 * Smart Router - 智能路由引擎
 *
 * 第五轮进化核心模块：根据用户意图自动推荐最优工具链，
 * 减少冗余工具调用，提升对话效率。
 *
 * 核心能力：
 * 1. 意图分类 — 将用户输入映射到工具域
 * 2. 工具推荐 — 基于意图推荐最相关工具子集
 * 3. 链式编排 — 推荐多步工具组合模板
 * 4. 冗余检测 — 识别重复/低效工具调用模式
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";

// ── 意图分类 ─────────────────────────────────────────────────────

export type IntentCategory =
	| "code"          // 代码操作：读写编辑、构建、测试
	| "knowledge"     // 知识管理：学习、回忆、图谱
	| "fetch"         // 网络操作：抓取URL、搜索
	| "system"        // 系统管理：同步、健康检查、联邦
	| "session"       // 会话管理：上下文、工作日志、计划
	| "publish"       // 发布操作：掘金、公众号
	| "chat"          // 纯对话：闲聊、解释、规划
	| "oss"           // 开源贡献：GitHub issues、PR
	| "inspect";      // 代码分析：结构分析、依赖追踪

interface IntentMatch {
	intent: IntentCategory;
	confidence: number;
	keywords: string[];
}

// 每个意图的关键词触发器（按权重排序）
const INTENT_KEYWORDS: Record<IntentCategory, string[]> = {
	code: ["写代码", "编辑", "修改代码", "创建文件", "新建", "实现", "开发", "重构", "fix", "bug", "测试", "编译", "build", "部署", "deploy", "git", "commit", "run", "执行", "bash", "命令", "安装", "install", "npm", "node", "typescript", "function", "class", "接口", "API"],
	knowledge: ["学", "记忆", "知识", "记住", "recall", "learn", "存储", "知识库", "遗忘", "图谱", "graph", "积累", "经验", "总结", "笔记"],
	fetch: ["抓取", "访问", "打开", "fetch", "URL", "网页", "网站", "搜索", "爬虫", "API请求", "download", "下载", "curl", "HTTP"],
	system: ["同步", "sync", "健康", "health", "检查", "巡检", "联邦", "federation", "节点", "服务器", "三机", "重启", "WS", "中继", "relay", "自愈", "修复"],
	session: ["上下文", "进度", "计划", "plan", "工作日志", "备份", "回退", "checkpoint", "undo", "会话", "session", "恢复", "继续"],
	publish: ["发布", "publish", "掘金", "公众号", "文章", "投稿", "草稿", "draft", " juejin", "微信"],
	chat: ["你好", "谢谢", "是什么", "为什么", "怎么理解", "解释", "说说", "聊聊", "觉得", "看法", "建议", "观点", "分析", "对比", "区别"],
	oss: ["GitHub", "开源", "贡献", "PR", "issue", "pull request", "commit", "开源项目", "仓库", "repo"],
	inspect: ["分析", "结构", "依赖", "引用", "导入", "import", "map", "symbols", "代码库", "架构", "模块"],
};

// ── 工具到意图映射 ─────────────────────────────────────────────────

const TOOL_INTENT_MAP: Record<string, IntentCategory[]> = {
	read: ["code", "inspect"],
	write: ["code"],
	edit: ["code"],
	bash: ["code", "system"],
	grep: ["code", "inspect"],
	find: ["code", "inspect"],
	runtests: ["code"],
	codebase_map: ["inspect"],
	"connect-learn": ["knowledge"],
	"connect-recall": ["knowledge"],
	"connect-fetch": ["fetch"],
	"connect-stats": ["knowledge"],
	knowledge_graph: ["knowledge"],
	session_context: ["session"],
	session_worklog: ["session"],
	plan: ["session"],
	sync: ["system"],
	federation: ["system"],
	healthy: ["system"],
	auto_manage: ["system", "session"],
	ws_comm: ["system"],
	fed_knowledge: ["knowledge", "system"],
	juejin_publish: ["publish"],
	github: ["oss"],
	contributor: ["oss"],
	evolve_track: ["session"],
	read_buffer: ["system"],
	echo: ["chat"],
	execution_tracker: ["session"],
	mcp_server: ["system"],
};

// ── 工具链模板 ─────────────────────────────────────────────────────

export interface ToolChainStep {
	tool: string;
	intent: string;
	description: string;
	optional?: boolean;
}

export interface ToolChain {
	name: string;
	description: string;
	intent: IntentCategory;
	steps: ToolChainStep[];
	triggerPatterns: string[];
}

export const TOOL_CHAINS: ToolChain[] = [
	{
		name: "knowledge-acquire",
		description: "Fetch info from the web and store as knowledge",
		intent: "knowledge",
		steps: [
			{ tool: "connect-fetch", intent: "fetch", description: "Fetch the target URL" },
			{ tool: "connect-learn", intent: "knowledge", description: "Extract key info into the knowledge base" },
		],
		triggerPatterns: ["抓取并记住", "学习这个页面", "获取并存", "抓取信息", "存入知识库", "抓取这个页面", "记住", "并记住", "存入", "fetch and remember", "learn this page", "save this"],
	},
	{
		name: "knowledge-recall",
		description: "Search the knowledge base; query federated nodes if local has no results",
		intent: "knowledge",
		steps: [
			{ tool: "connect-recall", intent: "knowledge", description: "Search the local knowledge base", optional: false },
			{ tool: "fed-knowledge", intent: "knowledge", description: "Federated cross-node query", optional: true },
		],
		triggerPatterns: ["记得", "之前学过", "知识库里有", "查一下记忆", "历史记录", "recall", "remember", "have we stored"],
	},
	{
		name: "code-change",
		description: "Read code → edit → verify with tests",
		intent: "code",
		steps: [
			{ tool: "read", intent: "code", description: "Read the target file" },
			{ tool: "edit", intent: "code", description: "Modify the code" },
			{ tool: "runtests", intent: "code", description: "Run tests to verify", optional: true },
		],
		triggerPatterns: ["修改", "重构", "fix", "修复", "改进代码", "改bug", "更新代码", "update code"],
	},
	{
		name: "full-deploy",
		description: "Code change → build → sync fleet → verify",
		intent: "system",
		steps: [
			{ tool: "bash", intent: "code", description: "Build and package" },
			{ tool: "sync", intent: "system", description: "Sync to all nodes" },
			{ tool: "healthy", intent: "system", description: "Health check to verify" },
		],
		triggerPatterns: ["更新三机", "同步到所有节点", "全量部署", "升级所有节点", "deploy to all nodes"],
	},
	{
		name: "oss-contribute",
		description: "Find matching OSS issues → record contribution",
		intent: "oss",
		steps: [
			{ tool: "contributor-search", intent: "oss", description: "Search matching issues" },
			{ tool: "github-read-issue", intent: "oss", description: "Read issue details", optional: true },
			{ tool: "contributor-record", intent: "oss", description: "Record the contribution" },
		],
		triggerPatterns: ["找开源贡献", "搜索issue", "贡献代码", "参与开源", "contribute to OSS"],
	},
	{
		name: "proactive-check",
		description: "Health check → run due tasks → poll federation messages",
		intent: "system",
		steps: [
			{ tool: "healthy", intent: "system", description: "Health check" },
			{ tool: "auto-manage-due", intent: "system", description: "List and run due tasks" },
			{ tool: "federation-poll", intent: "system", description: "Process federation messages", optional: true },
		],
		triggerPatterns: ["巡检", "日常检查", "状态检查", "待办任务", "daily check"],
	},
];

// ── 冗余检测器 ────────────────────────────────────────────────────

interface ToolCallRecord {
	tool: string;
	params: Record<string, unknown>;
	timestamp: number;
}

/**
 * 检测冗余工具调用模式
 */
export class RedundancyDetector {
	private history: ToolCallRecord[] = [];
	private static readonly MAX_HISTORY = 50;

	/**
	 * 记录一次工具调用
	 */
	record(tool: string, params: Record<string, unknown>): void {
		this.history.push({ tool, params, timestamp: Date.now() });
		if (this.history.length > RedundancyDetector.MAX_HISTORY) {
			this.history = this.history.slice(-RedundancyDetector.MAX_HISTORY);
		}
	}

	/**
	 * 检查即将进行的调用是否冗余
	 * 返回冗余原因或 null
	 */
	check(tool: string, params: Record<string, unknown>): string | null {
		// 检查最近3次调用中是否有完全相同的
		const recentSame = this.history.filter(
			(r) => r.tool === tool && JSON.stringify(r.params) === JSON.stringify(params)
		);
		if (recentSame.length >= 2) {
			return `Same-params call to ${tool} already made ${recentSame.length} times — likely redundant`;
		}

		// 检查同轮调用中是否已有完全相同目标的同类操作（仅针对有明确目标的工具）
		const recent5 = this.history.slice(-5);
		const targetKeys = ["path", "query", "url", "pattern"];
		for (const key of targetKeys) {
			if (!params[key]) continue;
			for (const r of recent5) {
				if (r.tool === tool && r.params[key] === params[key]) {
					return `${tool} was just called on the same target ${params[key]}`;
				}
			}
		}

		return null;
	}

	/**
	 * 获取本轮调用统计摘要
	 */
	summary(): string {
		if (this.history.length === 0) return "no calls recorded";
		const toolCounts = new Map<string, number>();
		for (const r of this.history) {
			toolCounts.set(r.tool, (toolCounts.get(r.tool) ?? 0) + 1);
		}
		const lines: string[] = [];
		for (const [tool, count] of toolCounts) {
			if (count >= 3) {
				lines.push(`⚠️ ${tool} called ${count} times (possibly too many)`);
			}
		}
		return lines.length > 0 ? lines.join("\n") : "call patterns normal";
	}

	clear(): void {
		this.history = [];
	}
}

// ── 路由核心 ──────────────────────────────────────────────────────

let detectorInstance: RedundancyDetector | null = null;

export function getDetector(): RedundancyDetector {
	if (!detectorInstance) {
		detectorInstance = new RedundancyDetector();
	}
	return detectorInstance;
}

/**
 * 分类用户意图（支持多意图）
 */
export function classifyIntent(input: string): IntentMatch[] {
	const lower = input.toLowerCase();
	const results: IntentMatch[] = [];

	for (const [intent, keywords] of Object.entries(INTENT_KEYWORDS)) {
		let score = 0;
		const matched: string[] = [];
		for (const kw of keywords) {
			if (lower.includes(kw.toLowerCase())) {
				score += 1;
				matched.push(kw);
			}
		}
		if (score > 0) {
			results.push({
				intent: intent as IntentCategory,
				confidence: Math.min(score / 3, 1),  // 3个关键词命中即满分
				keywords: matched,
			});
		}
	}

	// 按置信度排序
	results.sort((a, b) => b.confidence - a.confidence);
	return results;
}

/**
 * 根据意图推荐工具子集
 * 返回 top-N 最相关工具，减少 LLM 从27个工具中选择的信息噪声
 */
export function recommendTools(intent: IntentCategory, allTools: AgentTool<any>[], topN = 8): AgentTool<any>[] {
	const toolNames: string[] = allTools.map((t) => t.name);

	const scored: Array<{ tool: AgentTool<any>; score: number }> = [];
	for (const tool of allTools) {
		const mappedIntents = TOOL_INTENT_MAP[tool.name] ?? [];
		const score = mappedIntents.includes(intent) ? 2 : mappedIntents.includes(intent) ? 1 : 0;
		if (score > 0) {
			scored.push({ tool, score });
		}
	}

	// 按分数排序，取 topN
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, topN).map((s) => s.tool);
}

/**
 * 根据用户输入匹配最佳工具链
 */
export function matchToolChain(input: string): ToolChain | null {
	const lower = input.toLowerCase();
	let bestMatch: ToolChain | null = null;
	let bestScore = 0;

	for (const chain of TOOL_CHAINS) {
		let score = 0;
		for (const pattern of chain.triggerPatterns) {
			if (lower.includes(pattern.toLowerCase())) {
				score += 2;
			}
		}
		// 也通过意图分类补充匹配
		const intents = classifyIntent(input);
		for (const i of intents) {
			if (i.intent === chain.intent && i.confidence > 0.3) {
				score += 1;
			}
		}
		if (score > bestScore) {
			bestScore = score;
			bestMatch = chain;
		}
	}

	return bestScore >= 2 ? bestMatch : null;
}

/**
 * 生成路由建议（注入到 system prompt 中的提示）
 */
export function routeAdvice(input: string, allToolNames: string[]): string {
	const intents = classifyIntent(input);
	const chain = matchToolChain(input);
	const parts: string[] = [];

	if (intents.length > 0) {
		const topIntent = intents[0]!;
		parts.push(`Intent: ${topIntent.intent} (confidence ${Math.round(topIntent.confidence * 100)}%)`);
	}

	if (chain) {
		parts.push(`Suggested chain: [${chain.name}] ${chain.steps.map((s) => s.tool).join(" → ")}`);
	}

	// 冗余警告
	const warning = getDetector().summary();
	if (warning !== "call patterns normal") {
		parts.push(warning);
	}

	return parts.join("\n");
}

// ── Agent Tool 导出 ───────────────────────────────────────────────

export function createTool(cwd: string): AgentTool<any> {
	return {
		name: "smart-router",
		description: `Smart routing engine — analyzes user intent, recommends optimal tool chains. Actions:
- route: analyze input, return intent classification, recommended tool subset and chain suggestion
- chains: list all available chain templates
- redundant: check for redundant tool calls
- classify: intent classification only`,
		label: "Smart Router",
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["route", "chains", "redundant", "classify"],
					description: "Action type",
				},
				input: {
					type: "string",
					description: "Input text (required for route/classify)",
				},
			},
			required: ["action"],
		},
		execute: async (toolCallId: string, params: unknown) => {
			const p = params as { action: string; input?: string };

			switch (p.action) {
				case "classify": {
					if (!p.input) {
						return { content: [{ type: "text", text: "Missing input param" }], details: {} };
					}
					const intents = classifyIntent(p.input);
					return {
						content: [{
							type: "text",
							text: JSON.stringify(intents, null, 2),
						}],
						details: { intents: intents.map((i) => i.intent) },
					};
				}

				case "route": {
					if (!p.input) {
						return { content: [{ type: "text", text: "Missing input param" }], details: {} };
					}
					const intents = classifyIntent(p.input);
					const chain = matchToolChain(p.input);
					const advice = routeAdvice(p.input, []);

					const result = {
						intents,
						recommendedChain: chain ? {
							name: chain.name,
							description: chain.description,
							steps: chain.steps.map((s) => ({
								tool: s.tool,
								description: s.description,
								optional: s.optional ?? false,
							})),
						} : null,
						advice,
					};

					return {
						content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
						details: { intent: intents[0]?.intent, chain: chain?.name },
					};
				}

				case "chains": {
					return {
						content: [{
							type: "text",
							text: JSON.stringify(TOOL_CHAINS, null, 2),
						}],
						details: { count: TOOL_CHAINS.length },
					};
				}

				case "redundant": {
					const summary = getDetector().summary();
					return {
						content: [{ type: "text", text: summary }],
						details: {},
					};
				}

				default:
					return {
						content: [{ type: "text", text: `Unknown action: ${p.action}` }],
						details: {},
					};
			}
		},
	};
}
