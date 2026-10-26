/**
 * connect handleUpdate stale 判定收紧回归（2026-10-26「双线推进战略」四犯误删 P0 修复）
 * 背景：update query 与相邻条目只共享零星关键词（gemma-4/A线/官方分 等中文 bigram 巧合）时，
 * 旧阈值 max(2, ceil(n/2)) 把无关条目一并删除。四犯：10-22、10-23、10-24、10-26。
 * 修复：minOverlap = min(n, max(4, ceil(n*0.7))) + 中文 bigram 覆盖率 ≥0.7 位置锚定。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let testDir: string;
const origKnowledgeDir = process.env.NOVUS_KNOWLEDGE_DIR;

beforeEach(() => {
	testDir = mkdtempSync(join(tmpdir(), "connect-update-test-"));
	process.env.NOVUS_KNOWLEDGE_DIR = join(testDir, "knowledge");
});
afterEach(() => {
	if (origKnowledgeDir === undefined) delete process.env.NOVUS_KNOWLEDGE_DIR;
	else process.env.NOVUS_KNOWLEDGE_DIR = origKnowledgeDir;
	rmSync(testDir, { recursive: true, force: true });
});

function outText(res: { content: Array<{ type: string; text?: string }> }): string {
	return res.content.map(c => (c as { text?: string }).text ?? "").join("\n");
}

const STRATEGY = "Kaggle Gemma-4 双线推进战略（2026-10-22 主人拍板「保留，双线推进」）：①A 线=本地智能体进化（主线）：纯 agent 层（prompt/编排/skills/守卫），不训练模型、不跑真 Gemma，35 机 GLM proxy 验证，目标 v4 官方分 0.10→0.17+；②B 线=LoRA 模型线（并行）：novus-gemma4-lora-v1 kernel 在 Kaggle 云端 GPU 训练中（语料=serving-kit 1670 轨迹），三机 watcher 盯分；③两线互不阻塞，出分后归因对比（agent 层贡献 vs 模型层贡献）；④禁止混线：v4 agent 层提交包绝不带 adapter，LoRA 线产物单独作为后续变体提交。边界铁律：A 线提交包 = yaml/md/configs only + skills（SKILL.md+脚本），不含 .safetensors。";

const SCORE_SERIES = "Kaggle gemma-4 A线官方分序列更新（2026-10-25）：v3=0.10（主账号 〔该信息已删除，我不再记得〕）> v5b=0.08（A线账号 57574614，10-23 23:30 UTC 提交）> lora12b-v1=0.03 > v2=0.00。v5b（rules+4硬闸）0.08 略低于 v3 0.10——硬闸未突破 0.1 线。";

const GFW_FIX = "Kaggle competitions submit 在中国大陆被墙机器上的根修方案：【症状】kaggle competitions submit 卡 0% 永远不动。根因：start_submission_upload 返回的 create_url host=www.googleapis.com（被墙，TCP 建连死），PUT 卡死。【根修】create_url.replace(\"www.googleapis.com\",\"storage.googleapis.com\") 后 requests.put，PUT 返回 200 即成功；再走 api.kaggle.com 完成登记。【配额】每日提交配额 1 次，UTC 00:00 刷新。";

const KGAT_AUTH = "KGAT key 认证方法论（2026-10-25 实战定案，93 机验证）：kaggle CLI 2.2.4 与 2.2.5 均不读 KAGGLE_CONFIG_DIR 下的 access_token——会静默 fallback 到 ~/.kaggle/ 默认凭据，列出的全是主账号数据。";

async function setup() {
	const { storeKnowledge } = await import("../../memory/knowledge.js");
	const { createTool } = await import("./connect.js");
	return { storeKnowledge, tool: createTool("/tmp") };
}

describe("connect handleUpdate stale 判定收紧（四犯误删回归）", () => {
	it("宽 query 只删同主题条目，绝不连带相邻条目（双线战略案例）", async () => {
		const { storeKnowledge, tool } = await setup();
		storeKnowledge({ content: SCORE_SERIES, category: "business", tags: ["kaggle", "gemma-4"], confidence: 0.9 });
		storeKnowledge({ content: STRATEGY, category: "business", tags: ["双线推进", "kaggle", "gemma-4"], confidence: 0.95 });

		const res = await tool.execute("u1", {
			action: "update",
			query: "A线官方分序列 gemma-4",
			content: "Kaggle gemma-4 A线官方分序列更新（2026-10-26 核实）：v3=0.10 > v5b组合包(LoRA12b+v3风格prompt, 57620661)=0.08 > lora12b-v1=0.03；v5c(57634691) 提交仍 PENDING。",
		});
		const out = outText(res);
		expect(out).toContain("删除 1 条"); // 只删官方分序列那条，双线战略不能陪葬
		expect(out).toContain("官方分序列");

		const recall = await tool.execute("u1r", { action: "recall", query: "双线推进战略", coreOnly: false });
		expect(outText(recall)).toContain("双线推进战略");
	});

	it("KGAT 认证条目替换时不连带 GFW 提交方案（零星关键词不误删）", async () => {
		const { storeKnowledge, tool } = await setup();
		storeKnowledge({ content: GFW_FIX, category: "self-improvement", tags: ["kaggle", "submit", "gfw"], confidence: 0.9 });
		storeKnowledge({ content: KGAT_AUTH, category: "knowledge", tags: ["kaggle", "kgat"], confidence: 0.9 });

		const res = await tool.execute("u2", {
			action: "update",
			query: "KGAT key 认证 kaggle CLI",
			content: "KGAT key 认证用法（2026-10-26 实测复核）：93 机当前权威方法 = source ~/kag-aline.env（内含 export KAGGLE_API_TOKEN=A线token）+ ~/.local/bin/kaggle 直连 A 线账号查 submissions；B 线主账号走默认 ~/.kaggle/access_token + ~/kvenv/bin/kaggle。",
		});
		const out = outText(res);
		expect(out).toContain("删除 1 条");

		const recall = await tool.execute("u2r", { action: "recall", query: "被墙根修方案 storage.googleapis.com", coreOnly: false, fullContent: true });
		expect(outText(recall)).toContain("storage.googleapis.com");
	});

	it("同主题条目正常替换（该删的删得掉）", async () => {
		const { storeKnowledge, tool } = await setup();
		storeKnowledge({ content: SCORE_SERIES, category: "business", tags: ["kaggle"], confidence: 0.9 });

		const res = await tool.execute("u3", {
			action: "update",
			query: "A线官方分序列 gemma-4",
			content: "Kaggle gemma-4 A线官方分序列更新（2026-10-26）：v5c 出分 0.09，仍低于 v3 的 0.10，narrative 路线未突破。",
		});
		const out = outText(res);
		expect(out).toContain("删除 1 条");
		expect(out).toContain("写入新值");

		const recall = await tool.execute("u3r", { action: "recall", query: "官方分序列 v5c", coreOnly: false });
		const txt = outText(recall);
		expect(txt).toContain("v5c 出分 0.09");
		expect(txt).not.toContain("2026-10-25）：v3=0.10（主账号"); // 旧值已不在
	});

	it("短英文 query 要求全 token 命中（cap 逻辑）：全命中删、缺一不删", async () => {
		const { storeKnowledge, tool } = await setup();
		storeKnowledge({ content: "TB4 retry-retro-console-soc run retry-retro-console-soc-1792747341 reward=0.0 死型=429限流杀死 agent，6/8 测试过。", category: "knowledge", tags: ["tb4"], confidence: 0.9 });
		storeKnowledge({ content: "TB4 夜巡 muski 完成：核实三 lane 状态、判定 triage NONE 非故障、补挂 harmony 重发 event 任务。", category: "knowledge", tags: ["tb4"], confidence: 0.9 });

		const res = await tool.execute("u4", {
			action: "update",
			query: "TB4 retro console",
			content: "TB4 retro-console-soc 定案（2026-10-26）：第6发 reward=1.0 PASS 破关，TB4 总分 48/66=72.7%。",
		});
		const out = outText(res);
		expect(out).toContain("删除 1 条");

		const recall = await tool.execute("u4r", { action: "recall", query: "TB4 夜巡 muski", coreOnly: false });
		expect(outText(recall)).toContain("夜巡 muski");
	});

	it("中文短 query：全 bigram 链命中才删，零星 bigram 巧合不删", async () => {
		const { storeKnowledge, tool } = await setup();
		storeKnowledge({ content: "联系方式条目：主人手机号 〔该信息已删除，我不再记得〕 是唯一有效联系号码，旧号码 13800002222 已作废，请勿拨打旧号码。", category: "fact", tags: ["联系方式"], confidence: 0.9 });
		storeKnowledge({ content: "主人手机壳是蓝色的，主人喜欢蓝色手机壳，购物偏好以深色系为主。", category: "preference", tags: ["偏好"], confidence: 0.9 });

		const res = await tool.execute("u5", {
			action: "update",
			query: "主人手机号",
			content: "联系方式条目（2026-10-26 更新）：主人手机号 13911112222 是唯一有效联系号码，旧号已作废。",
		});
		const out = outText(res);
		expect(out).toContain("删除 1 条");

		const recall = await tool.execute("u5r", { action: "recall", query: "手机壳 偏好", coreOnly: false });
		expect(outText(recall)).toContain("手机壳");
	});

	it("无同主题旧条目时纯新增，不误报删除", async () => {
		const { tool } = await setup();
		const res = await tool.execute("u6", {
			action: "update",
			query: "完全不相关的全新主题词表",
			content: "全新主题条目：这是关于量子纠缠实验装置校准流程的知识，与既有库无重叠。",
		});
		const out = outText(res);
		expect(out).toContain("无同主题旧条目");
		expect(out).toContain("纯新增");
	});
});
