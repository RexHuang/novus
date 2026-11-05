/**
 * 独立 Verifier 核验层（RSIAgent 机制④⑤移植，2026-09-24）
 *
 * 背景：novus 自评是"运动员兼裁判"（同一模型写记忆又自证）。
 * RSIAgent（arXiv 2609.15364）的答案：Verifier 与 Actor 分离，且跨模型对偶
 * （GLM-5.3 Actor ↔ Kimi K3 Verifier，升级段互换）。全量对偶成本高，本模块
 * 先落地最小闭环：experience 写入时独立核验。
 *
 * 三层独立性：
 * 1. 信息隔离：prompt 只含经验条目本身 + 静态判据。不含 agent 推理链、
 *    会话上下文、其他记忆（对应 RSIAgent verifier_hide_actor_memory）。
 * 2. 模型隔离（可选）：设 VERIFIER_BASE_URL / VERIFIER_MODEL /
 *    VERIFIER_AUTH_TOKEN 即用独立模型（如 deepseek：api.deepseek.com/anthropic）；
 *    未配置时回退 ANTHROPIC_*（同款模型，信息隔离仍有价值）。
 * 3. 失败开放（fail-open）：核验不可用绝不阻塞写入，只标 skipped/unverified。
 *
 * RSIAgent 纪律：
 * - Verifier 只判定"证据是否支撑结论"，因果归因归 Actor（verdict 不解释为什么）
 * - 证据不足 → unverified，保留不确定性，禁止猜测
 * - 失败/受阻被记成"成功/已解决" → rejected（机制⑤：FAIL 可入记忆但不可记成 verified success）
 */

// ── Types ───────────────────────────────────────────────────────────

export type VerifierStatus = "verified" | "unverified" | "rejected" | "skipped";

export interface VerificationResult {
	/** verified=证据支撑结论 / unverified=证据不足 / rejected=结论与证据矛盾 / skipped=核验未执行 */
	status: VerifierStatus;
	/** 一句话理由 */
	reason: string;
	/** 核验用模型（可溯源） */
	model?: string;
	/** 核验时间 */
	checkedAt: string;
}

/** 可核验的经验目标（有意不含 reasoning/session 字段——信息隔离从类型层强制） */
export interface VerifierTarget {
	title: string;
	scenario: string;
	situation: string;
	actions: string[];
	outcome: string;
	lessons: string[];
}

// ── Prompt 构建（信息隔离的落点）───────────────────────────────────

/** 构建核验 prompt：只含条目内容 + 静态判据，无任何执行侧上下文 */
export function buildVerifierPrompt(target: VerifierTarget): string {
	return `你是独立核验员（Verifier）。你只能看到一段工作记录的客观内容，看不到记录者的推理过程、会话上下文或其他记忆。

请判定：记录中的「结果」与「教训」断言，是否被「行动」与「结果描述」中的证据支撑。

判定纪律：
1. 你只判定证据是否支撑结论，不做因果解释——归因是记录者自己的事。
2. 证据不足、无法判定时必须输出 unverified，保留不确定性，禁止猜测。
3. 若结论声称「成功/已解决/验证有效」但行动记录无法支撑（如把失败/受阻/未验证记成成功），输出 rejected。
4. 若证据与结论一致且充分，输出 verified。

记录内容：
- 标题: ${target.title}
- 场景: ${target.scenario || "（无）"}
- 问题: ${target.situation || "（无）"}
- 行动: ${target.actions.join("; ") || "（无）"}
- 结果: ${target.outcome || "（无）"}
- 教训: ${target.lessons.join("; ") || "（无）"}

只输出一行 JSON，格式：{"status":"verified","reason":"一句话理由"}
status 只能是 verified / unverified / rejected 三者之一。不要输出任何其他文字。`;
}

// ── Verdict 解析（鲁棒：容忍围栏/前后缀/坏枚举）────────────────────

/** 从模型回复中解析三态判定；任何解析失败都安全落回 unverified（绝不猜测） */
export function parseVerdict(raw: string): VerificationResult {
	const checkedAt = new Date().toISOString();
	const statusSet = new Set(["verified", "unverified", "rejected"]);
	try {
		// 去掉 markdown 围栏，取第一个 { 到最后一个 }
		const cleaned = raw.replace(/```(?:json)?/g, "");
		const start = cleaned.indexOf("{");
		const end = cleaned.lastIndexOf("}");
		if (start < 0 || end <= start) throw new Error("no JSON object");
		const obj = JSON.parse(cleaned.slice(start, end + 1)) as { status?: string; reason?: string };
		const status = String(obj.status || "").toLowerCase();
		if (!statusSet.has(status)) throw new Error(`bad status: ${status}`);
		return {
			status: status as VerifierStatus,
			reason: String(obj.reason || "").slice(0, 500) || "（无理由）",
			checkedAt,
		};
	} catch {
		return {
			status: "unverified",
			reason: `核验输出不可解析，保留不确定性。原文片段: ${raw.slice(0, 120)}`,
			checkedAt,
		};
	}
}

// ── 核验执行（Anthropic 兼容端点，fail-open）───────────────────────

interface VerifierLlmConfig {
	baseUrl: string;
	model: string;
	token: string;
}

/** 读取 Verifier 模型配置：VERIFIER_* 优先，回退 ANTHROPIC_*（同款模型模式） */
export function getVerifierLlmConfig(): VerifierLlmConfig | null {
	const baseUrl = process.env.VERIFIER_BASE_URL || process.env.ANTHROPIC_BASE_URL || "";
	const model = process.env.VERIFIER_MODEL || process.env.ANTHROPIC_MODEL || "";
	const token = process.env.VERIFIER_AUTH_TOKEN || process.env.VERIFIER_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || "";
	if (!baseUrl || !model || !token) return null;
	return { baseUrl: baseUrl.replace(/\/+$/, ""), model, token };
}

/**
 * 核验一条经验。任何失败（无配置/网络/超时/坏输出）都 fail-open：
 * 返回 skipped 或 unverified，绝不抛错、绝不阻塞写入。
 */
export async function verifyExperience(target: VerifierTarget, timeoutMs = 30000): Promise<VerificationResult> {
	const cfg = getVerifierLlmConfig();
	if (!cfg) {
		return { status: "skipped", reason: "未配置 Verifier 模型（VERIFIER_* / ANTHROPIC_* 缺失）", checkedAt: new Date().toISOString() };
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(`${cfg.baseUrl}/v1/messages`, {
			method: "POST",
			signal: controller.signal,
			headers: {
				"content-type": "application/json",
				"x-api-key": cfg.token,
				"authorization": `Bearer ${cfg.token}`,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify({
				model: cfg.model,
				// 4096：glm-5.3 系默认带 thinking 块，1024 会被思考耗尽导致 text 块缺失（2026-09-24 实测）
				max_tokens: 4096,
				// 判官要确定性（RSIAgent：Actor temp 1.0 / Verifier temp 0.0）
				temperature: 0,
				messages: [{ role: "user", content: buildVerifierPrompt(target) }],
			}),
		});
		if (!res.ok) {
			return {
				status: "unverified",
				reason: `核验端点 HTTP ${res.status}，保留不确定性`,
				model: cfg.model,
				checkedAt: new Date().toISOString(),
			};
		}
		const data = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
		const text = (data.content || []).filter(c => c.type === "text").map(c => c.text || "").join("");
		const verdict = parseVerdict(text);
		return { ...verdict, model: cfg.model };
	} catch (err) {
		return {
			status: "unverified",
			reason: `核验调用失败（${err instanceof Error ? err.name : "unknown"}），保留不确定性`,
			model: cfg.model,
			checkedAt: new Date().toISOString(),
		};
	} finally {
		clearTimeout(timer);
	}
}

// ── 机制①：记忆对账（learn 碰撞时判定新旧关系，2026-09-24）────────
//
// RSIAgent 纪律："禁止只追加新条目而把被矛盾的旧建议留成事实"。
// novus 落地：learn 写入前本地 query 同主题旧条目（零 LLM），命中才调对账员；
// supersede=自动替换旧条目（与 update 动作同款"删旧写新"语义）；
// duplicate=疑似重复提示；coexist/任何失败=保守并存（宁多存不误删）。

export type ReconcileRelation = "supersede" | "duplicate" | "coexist";

export interface ReconcileResult {
	relation: ReconcileRelation;
	/** 被 supersede 的旧条目 id（已过滤为候选集子集，防幻觉 id） */
	targetIds: string[];
	reason: string;
	model?: string;
	checkedAt: string;
}

export interface ReconcileCandidate {
	id: string;
	content: string;
}

/** 构建对账 prompt：只含新旧条目内容 + 保守判定规则（信息隔离同核验层） */
export function buildReconcilePrompt(newContent: string, candidates: ReconcileCandidate[]): string {
	const list = candidates.map(c => `- [#${c.id}] ${c.content}`).join("\n");
	return `你是记忆库对账员（Reconciler）。记忆库将写入一条新知识，但库中已存在语义相近的旧条目。请判定新条目与旧条目的关系：

新条目:
${newContent}

旧条目:
${list}

判定规则（保守优先，不确定一律 coexist）：
1. supersede：新条目是对同一事实/状态的更新（如地址变更、端口变更、结论推翻旧结论、状态从"进行中"变"已完成"）——旧条目应被替换，绝不允许新旧并存。
2. duplicate：新条目与某旧条目表达同一事实，无新信息。
3. coexist：看似相似但实为不同事实（不同对象/不同环境/不同范围的并行事实），或无法确定——都保留。

只输出一行 JSON：{"relation":"supersede","targets":["旧条目id"],"reason":"一句话理由"}
relation 只能是 supersede / duplicate / coexist；targets 只能从上面旧条目的 id 中选。不要输出任何其他文字。`;
}

/** 解析对账判定；任何解析失败返回 null（上层 fail-open 到 coexist） */
export function parseReconcileVerdict(raw: string): { relation: ReconcileRelation; targets: string[]; reason: string } | null {
	try {
		const cleaned = raw.replace(/```(?:json)?/g, "");
		const start = cleaned.indexOf("{");
		const end = cleaned.lastIndexOf("}");
		if (start < 0 || end <= start) throw new Error("no json");
		const obj = JSON.parse(cleaned.slice(start, end + 1)) as { relation?: string; targets?: unknown; reason?: string };
		const rel = String(obj.relation || "").toLowerCase();
		if (rel !== "supersede" && rel !== "duplicate" && rel !== "coexist") throw new Error(`bad relation: ${rel}`);
		const targets = Array.isArray(obj.targets) ? obj.targets.map(t => String(t)) : [];
		return { relation: rel, targets, reason: String(obj.reason || "").slice(0, 300) };
	} catch {
		return null;
	}
}

/**
 * 对账：新条目 vs 相似旧条目。任何失败（无配置/网络/超时/坏输出）都
 * fail-open 到 coexist——宁多存不误删，绝不阻塞写入。
 */
export async function reconcileWithStore(newContent: string, candidates: ReconcileCandidate[], timeoutMs = 30000): Promise<ReconcileResult> {
	const failOpen = (reason: string): ReconcileResult => ({ relation: "coexist", targetIds: [], reason, checkedAt: new Date().toISOString() });
	if (candidates.length === 0) return failOpen("无相似旧条目，纯新增");
	const cfg = getVerifierLlmConfig();
	if (!cfg) return failOpen("未配置对账模型，保守并存");

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(`${cfg.baseUrl}/v1/messages`, {
			method: "POST",
			signal: controller.signal,
			headers: {
				"content-type": "application/json",
				"x-api-key": cfg.token,
				"authorization": `Bearer ${cfg.token}`,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify({
				model: cfg.model,
				// 4096：glm-5.3 系 thinking 块耗 token（见 verifyExperience 同款注释）
				max_tokens: 4096,
				temperature: 0,
				messages: [{ role: "user", content: buildReconcilePrompt(newContent, candidates) }],
			}),
		});
		if (!res.ok) return failOpen(`对账端点 HTTP ${res.status}`);
		const data = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
		const text = (data.content || []).filter(c => c.type === "text").map(c => c.text || "").join("");
		const parsed = parseReconcileVerdict(text);
		if (!parsed) return failOpen("对账输出不可解析，保守并存");
		// targets 必须是候选集子集（防模型幻觉出不存在的 id）
		const validIds = new Set(candidates.map(c => c.id));
		const targetIds = parsed.targets.filter(t => validIds.has(t));
		return { relation: parsed.relation, targetIds, reason: parsed.reason, model: cfg.model, checkedAt: new Date().toISOString() };
	} catch (err) {
		return failOpen(`对账调用失败（${err instanceof Error ? err.name : "unknown"}），保守并存`);
	} finally {
		clearTimeout(timer);
	}
}
