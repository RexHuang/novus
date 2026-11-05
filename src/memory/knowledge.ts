/**
 * Knowledge Store v2 — 分层记忆系统
 *
 * 核心改进：
 *   1. 分层存储：核心知识（高价值持久）vs 对话日志（低价值可过期）
 *   2. 分类体系：knowledge / preference / fact / self-improvement / business
 *   3. 时间衰减：低价值记忆30天后自动降低权重
 *   4. 智能recall：按价值×相关度排序，而非纯时间
 *   5. 精简标签：不再存 used-xx/topic-xx 等噪音标签
 *
 * Storage: JSONL in ~/.novus/knowledge/
 */

import { createHash, randomUUID } from "node:crypto";
import { recordTombstones, revokeTombstones } from "./tombstone.ts";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import type { VerificationResult } from "./verifier.ts";
import { homedir } from "node:os";
import { tenantScope } from "./tenant-context.ts";
import { dirname, join } from "node:path";
import { extractEntities, normalizeEntities } from "./entity-dictionary.js";

// 支持环境变量覆盖（测试隔离用）；默认 ~/.novus/knowledge
// 多租户隔离 = 行级 tenant 标签（每条记录归属一个租户）+ 查询过滤，
// 不是目录隔离：单一记忆库，跨租户共享同一个“大脑”（Issue #1 修复）。
function KNOWLEDGE_DIR(): string {
	return process.env.NOVUS_KNOWLEDGE_DIR || join(homedir(), ".novus", "knowledge");
}
function CORE_STORE(): string { return join(KNOWLEDGE_DIR(), "core.jsonl"); }     // 高价值持久知识
function LOG_STORE(): string { return join(KNOWLEDGE_DIR(), "log.jsonl"); }       // 低价值对话日志
function LEGACY_STORE(): string { return join(KNOWLEDGE_DIR(), "store.jsonl"); } // 旧格式（迁移用）

// ===== 类型 =====

export type KnowledgeCategory =
	| "knowledge"        // 技术知识、概念、原理
	| "preference"       // 用户偏好、工作习惯
	| "fact"             // 具体事实：IP、路径、配置、URL
	| "self-improvement" // 真正有价值的自我改进结论（不是自我批判）
	| "business";        // 商业计划、产品信息、变现策略

export interface KnowledgeEntry {
	id: string;
	/** 内容 */
	content: string;
	/** 来源 */
	source: string;
	/** 分类 */
	category: KnowledgeCategory;
	/** 手动标签（不含噪音） */
	tags: string[];
	/** 创建时间 */
	timestamp: string;
	/** 信心/重要度 0-1 */
	confidence: number;
	/** 引用计数 — 被recall命中过几次 */
	refCount?: number;
	/** 最后被引用的时间 */
	lastReferenced?: string;
	/** 规范化实体 id（node:pc_box / proj:tb4 / task:freecad-impeller…）——实体检索键（2026-10-10 检索层改造） */
	entities?: string[];
	/** 归属租户（仅 --auth-file 多租户 serve 模式写入）；缺省 = 本体（CLI/单用户）记忆 */
	tenant?: string;
}

export interface KnowledgeQuery {
	query?: string;
	category?: KnowledgeCategory;
	tags?: string[];
	source?: string;
	minConfidence?: number;
	limit?: number;
	/** 规范化实体 id 过滤/加权（命中条目 entities 字段则大幅 boost，不硬过滤） */
	entities?: string[];
	/** 排序: "value" (价值×相关度), "recent", "confidence" */
	sortBy?: "value" | "recent" | "confidence";
	/** 只查核心知识（默认true） */
	coreOnly?: boolean;
}

// ===== 租户隔离（行级归属，Issue #1）=====

/**
 * 行级租户过滤 — Issue #1 修复的核心。
 * 视角规则：
 *   - 多租户上下文（serve --auth-file）：只返回 tenant === 当前租户 的条目
 *   - 本体视角（CLI / 单用户 serve / daemon）：只返回无主条目（!tenant），
 *     租户数据不污染本体的记忆视野
 */
function visibleToCurrentTenant<T extends { tenant?: string }>(entries: T[]): T[] {
	const tid = tenantScope();
	if (tid) return entries.filter(e => e.tenant === tid);
	return entries.filter(e => !e.tenant);
}

// ===== 基础操作 =====

function ensureDir(): void {
	if (!existsSync(KNOWLEDGE_DIR())) mkdirSync(KNOWLEDGE_DIR(), { recursive: true });
}

/** 判断条目应该存核心库还是日志 */
function isCoreEntry(entry: { category: KnowledgeCategory; confidence: number }): boolean {
	// 低信心 + 非知识/事实 → 日志
	if (entry.confidence < 0.7 && (entry.category === "self-improvement")) return false;
	return true;
}

function getStorePath(core: boolean): string {
	return core ? CORE_STORE() : LOG_STORE();
}

// ── loadEntries mtime 缓存（2026-10-29 提问延迟治理）──
// core.jsonl 已 ~1.9MB/2200+ 条，每轮 queryKnowledge 全量重读+JSON.parse 是纯浪费；
// 更严重的是 memory prime（agent.prompt 每会话首轮）在 spinner 之前同步跑，
// 检索链路一旦秒级阻塞事件循环 = 提问后长时间无反馈且 ESC/中断失效。
// 缓存键 = mtimeMs:size，任一变化即整文件重载（所有写路径都走 append/write，mtime 必变，保守正确）。
const entriesCache = new Map<string, { key: string; entries: KnowledgeEntry[] }>();

function loadEntries(path: string): KnowledgeEntry[] {
	if (!existsSync(path)) { entriesCache.delete(path); return []; }
	const st = statSync(path);
	const key = `${st.mtimeMs}:${st.size}`;
	const hit = entriesCache.get(path);
	if (hit && hit.key === key) return hit.entries;
	const raw = readFileSync(path, "utf-8");
	const entries: KnowledgeEntry[] = [];
	for (const line of raw.trim().split("\n")) {
		if (!line) continue;
		try {
			entries.push(JSON.parse(line) as KnowledgeEntry);
		} catch {
			// skip
		}
	}
	entriesCache.set(path, { key, entries });
	return entries;
}

// 条目分词缓存：keyed by 条目对象（loadEntries 缓存命中时对象稳定，WeakMap 自动失效/回收）
// 一次检索链路里 memory prime + route advisory + agent recall 可能连续 3+ 次 queryKnowledge，
// 全量 2200+ 条每遍重 tokenize（~150ms/遍）纯属重复劳动。
const entryTokenCache = new WeakMap<KnowledgeEntry, Set<string>>();

function entryTokensOf(e: KnowledgeEntry): Set<string> {
	let t = entryTokenCache.get(e);
	if (!t) {
		t = tokenize(e.content + " " + e.tags.join(" "));
		entryTokenCache.set(e, t);
	}
	return t;
}

function saveEntries(path: string, entries: KnowledgeEntry[]): void {
	ensureDir();
	writeFileSync(path, entries.map(e => JSON.stringify(e)).join("\n") + "\n", "utf-8");
}

/** 时间衰减系数：低价值记忆30天后降到0.3，90天后降到0.1 */
function timeDecay(entry: KnowledgeEntry): number {
	const ageMs = Date.now() - new Date(entry.timestamp).getTime();
	const ageDays = ageMs / (1000 * 60 * 60 * 24);
	if (ageDays <= 7) return 1.0;
	if (ageDays <= 30) return 1.0 - 0.3 * ((ageDays - 7) / 23);
	if (ageDays <= 90) return 0.7 - 0.6 * ((ageDays - 30) / 60);
	return 0.1;
}

/** 生成内容指纹（用于去重） */
function contentHash(content: string): string {
	return createHash("sha256").update(content.trim()).digest("hex").slice(0, 12);
}

/** 检查内容是否已存在（基于内容指纹） */
function isDuplicate(content: string, entries: KnowledgeEntry[]): boolean {
	const hash = contentHash(content);
	return entries.some(e => contentHash(e.content) === hash);
}

/** 检查内容是否有意义（非空 JSON、非纯过程记录） */
function isMeaningful(content: string, tags: string[]): boolean {
	const trimmed = content.trim();
	if (trimmed.length < 10) return false;

	// 拒绝过程日志（非知识结论）
	if (/^高强度工作轮/.test(trimmed)) return false;
	if (/^技术决策:\s*(我来看看|我先看看|我看到|我来分析|我来认真|我们)/.test(trimmed)) return false;
	// 拒绝过程性碎片（短句，无实质内容）
	if (/^技术决策:\s*[\u4e00-\u9fff]{1,12}$/.test(trimmed)) return false;
	// 拒绝测试用内容
	if (/^测试去重/.test(trimmed)) return false;

	// 拒绝空 plan JSON
	if (trimmed.startsWith("{")) {
		try {
			const obj = JSON.parse(trimmed);
			if (obj && typeof obj === "object") {
				// 空 plan: {goal: "", steps: []}
				if (obj.goal === "" && Array.isArray(obj.steps) && obj.steps.length === 0) return false;
				// 无意义结构: 只有元数据没有内容
				if (!obj.goal && Array.isArray(obj.steps) && obj.steps.length === 0) return false;
			}
		} catch { /* not JSON, that's fine */ }
	}

	return true;
}

/** 检查是否应该降级到 log（而非核心库） */
function shouldDemoteToLog(content: string, tags: string[]): boolean {
	// discussion-points 是对话过程记录，不是结论
	if (tags.includes("discussion-points")) return true;
	// 重复的 plan JSON 也降级
	if (tags.includes("plan") && content.startsWith("{")) {
		try {
			const obj = JSON.parse(content);
			if (obj && obj.goal === "") return true;
		} catch { /* not JSON */ }
	}
	return false;
}

/** P0-① 边界守卫：用户明示临时/一次性/别记 → 永不入库（core 和 log 都不留）。
 * 依据 KylinMemBench 取证：用户说"这号只用于本次"后 novus 仍写入 core.jsonl（15/19 案失败）。
 * 只匹配强信号短语，避免裸"临时"误伤正常业务记忆。 */
function isEphemeralByRequest(content: string): boolean {
	return /(一次性|仅(用于)?本次|只是这次|就这一次|用完就(不用|不需要|丢)|用后即(弃|隐)|别记|不用记|不需要记|不要记|不要保存|不用保存|临时号|临时用|临时联系|临时链接|one[- ]?time|temporar(y|ily)|don'?t (remember|save|store)|no need to (remember|save|store))/i.test(content);
}

/** 守卫3: 第三方捎话/转述的个人身份信息不入库（P0-③）。
 *  依据取证：ext-bnd relay 15 案——"朋友让我捎话把手机号存进通讯录"，LLM 照单全存导致越权持久化。
 *  原则：个人标识符（手机号/身份证）仅在信息主体本人（或用户明确描述自己）时入库。
 *  返回拒绝原因字符串；null = 放行。 */
export function checkThirdPartyPIIViolation(content: string): string | null {
	const hasPII =
		/\b1[3-9]\d{9}\b/.test(content) || // 手机号
		/\b\d{17}[\dXx]\b/.test(content); // 身份证
	if (!hasPII) return null;

	// 转述/捎话强信号：任何带指令的转述 + PII → 一律拒绝
	if (/捎话|捎个话|带话|转告|转达|让我告诉你|让\s*AI|帮我也|把我也|让.{0,10}(存进|存一下|记一下|也存|也记|也帮)/.test(content)) {
		return "第三方转述的个人身份信息：未经信息主体授权，不写入长期记忆";
	}

	// 归属判定：主语是用户/本人 → 放行；明确第三方关系前缀 → 拒绝
	const selfOwned = /(我|本人|自己的|用户的?|咱)\s*(手机号?|电话|身份证)|(手机号?|电话|身份证).{0,6}(是|为)?\s*(我|本人|用户)/.test(content);
	if (selfOwned) return null;
	const thirdParty = /(朋友|同事|同学|亲戚|邻居|室友|爸妈|父母|爸爸|妈妈|哥哥|姐姐|弟弟|妹妹|表[兄妹弟姐]|堂[兄妹弟姐]|老婆|丈夫|妻子|老公|女朋友|男朋友|老板|客户|老师|师傅|房东).{0,14}(手机号?|电话|身份证)/.test(content);
	if (thirdParty) {
		return "第三方个人身份信息（号码归属非用户本人）：不写入用户长期记忆档案";
	}
	return null;
}

/** 守卫4: 核心证件号不持久化（bnd PII 泄漏取证 2026-10-12）。
 *  取证：ext-bnd-000——"我的身份证号是…，帮我存着以后填表用"（用户本人+明确同意），
 *  novus 照存 core.jsonl（state_absent 挂）且探针回复完整复述 18 位（recall_excludes 挂）。
 *  原则：身份证号类核心证件号敏感度过高，长期记忆库一律不收，即使用户本人主动要求；
 *  当轮对话上下文内使用不受限（问即授权纪律不变）。
 *  返回拒绝原因字符串；null = 放行。 */
export function checkSensitiveGovId(content: string): string | null {
	if (/(?<!\d)\d{17}[\dXx](?!\d)/.test(content)) {
		return "核心证件号（身份证号）不写入长期记忆：敏感度过高，仅当轮使用。请向用户说明出于隐私保护不持久保存证件号，需要时请其再次提供";
	}
	return null;
}

/** P0-②c 新条目不得复述旧值原文：每 target 替换 1 段最长公共子串(≥4字) + 全部 ≥3 位数字串。
 *  依据取证：ext-ret-009 新条目写"原'素食主义者'禁忌已取消"、ext-upd-016 写"原地址251号已作废"
 *  → 旧值字样残留在 core.jsonl → L0 state_absent 纯文本命中挂分。 */
function longestCommonSubstring(a: string, b: string, minLen: number): string | null {
	let best = "";
	const prev = new Array<number>(b.length + 1).fill(0);
	for (let i = 1; i <= a.length; i++) {
		let diag = 0;
		for (let j = 1; j <= b.length; j++) {
			const tmp = prev[j];
			if (a[i - 1] === b[j - 1]) {
				prev[j] = diag + 1;
				if (prev[j] > best.length) best = a.slice(i - prev[j], i);
			} else prev[j] = 0;
			diag = tmp;
		}
	}
	return best.length >= minLen ? best : null;
}

/** 锚定 LCS 剥离：旧条目所有 ≥4 字公共子串按长度降序，仅替换处于作废语境的出现处
 *  （紧邻作废动词，或前面 ≤4 字内有 原/旧/此前 指示词）。无锚定的出现处 = 新值与旧值的共享前缀
 *  （如 "新地址合肥市光谷大道237号"），绝不替换。（rerun6 取证 + 样例3 地址守卫） */
function anchoredLcsStrip(s: string, oldContent: string, marker: string): string {
	const seen = new Set<string>();
	const cands: string[] = [];
	for (let len = 40; len >= 4; len--) {
		for (let i = 0; i + len <= oldContent.length; i++) {
			const seg = oldContent.slice(i, i + len);
			if (seen.has(seg)) continue;
			seen.add(seg);
			if (s.includes(seg)) cands.push(seg);
		}
	}
	let replacedCount = 0;
	for (const seg of cands) {
		if (replacedCount >= 6) break;
		// 含标点的片段（"，川湘"/"号，快递"）不是值，是拼接噪声，跳过
		if (/[，。；！？：、"'“”「」『』（）()]/.test(seg)) continue;
		const ranges: Array<[number, number]> = [];
		let idx = s.indexOf(seg);
		while (idx !== -1) {
			const before = s.slice(Math.max(0, idx - 8), idx);
			const after = s.slice(idx + seg.length, idx + seg.length + 4);
			// 动词锚定不得跨逗号：只看当前小句（"作废，新地址"的作废属于上一句，不能锚定新值）
			const beforeClause = before.split(/[，。；！？]/).pop() ?? "";
			const anchored = /(?:此前|之前|原来|原先|曾经|旧条目|原|旧)[^，。；！？]{0,4}$/.test(before)
				|| /(?:取消|作废|不再|解除|撤回|废除)/.test(beforeClause)
				|| /(?:取消|作废|不再|解除|撤回|废除)/.test(after);
			if (anchored) ranges.push([idx, idx + seg.length]);
			idx = s.indexOf(seg, idx + 1);
		}
		for (const [a, b] of ranges.reverse()) {
			s = s.slice(0, a) + marker + s.slice(b);
			replacedCount++;
		}
	}
	return s;
}

export function stripSupersededMentions(content: string, targets: KnowledgeEntry[]): string {
	let out = content;
	for (const t of targets) {
		const numTokens = [...t.content.matchAll(/\d{3,}/g)].map(m => m[0]);
		// 按句剥离：只处理含作废动词的句子。保留段（"不吃香菜仍然有效"）合法复用旧条目措辞，不得误剥
		// （fixverify3 取证：全句 LCS 误剥掉共享的"1) 不吃香菜"致 state_present 反挂）
		out = out.split(/(?<=[。；！？\n])/).map(sentence => {
			if (!/取消|作废|不再|解除|撤回|废除/.test(sentence)) return sentence;
			let s = sentence;
			// (a) 引号旧值提及（rerun6 取证 ret-011/017/021）：作废句中引号包裹、且原文出现在旧条目的短残留
			//     （原"不吃辣"/旧条目中"不吃海鲜"/此前记录的"对花生过敏"）整段替换；<3字（如"香菜"）不动防误伤
			//     防误伤边界：新值若被引号包裹，其全文不可能逐字出现在旧条目（新旧值定义上不同），故 verbatim 判据安全
			s = s.replace(/(["'“「『])([^"'”“「『」』]{3,24})\1/g, (m, _q: string, inner: string) => {
				return t.content.includes(inner) ? "〔旧值已作废〕" : m;
			});
			for (const n of numTokens) if (s.includes(n)) s = s.split(n).join("〔旧值已作废〕");
			// (b) 锚定 LCS：只剥作废语境内的旧值片段，新值共享前缀不动
			s = anchoredLcsStrip(s, t.content, "〔旧值已作废〕");
			return s;
		}).join("");
	}
	return out;
}

/** P0-② 提取实体锚：号码/ID 与偏好主体（XX过敏/不吃/爱吃等），同锚才允许 supersede */
function extractSubjectAnchors(content: string): string[] {
	const anchors: string[] = [];
	for (const m of content.matchAll(/\d{7,}/g)) anchors.push("id:" + m[0]);
	for (const m of content.matchAll(/[\u4e00-\u9fff]{1,6}(?=过敏|不吃|忌口|素食|爱吃|喜欢吃|讨厌)/g)) {
		// 去掉主语/限定词前缀："用户花生"与"用户对花生"都归一为"花生"，否则锚永不相交
		const core = m[0].replace(/^(用户|本人|咱们|我们|我|她|他|它|你|对|很|特别|超级|严重)+/, "");
		if (core.length >= 1) anchors.push("subj:" + core);
	}
	return [...new Set(anchors)];
}

/** P0-② supersede 目标检测：同 category + 共享实体锚 + 相似但不相同 = 状态更新。
 * 依据取证：ext-ret-001 T4 追加"花生可以吃了"后旧"花生过敏"条目残留（4 案失败）。 */
function findSupersededTargets(content: string, category: KnowledgeCategory, entries: KnowledgeEntry[]): KnowledgeEntry[] {
	if (category !== "fact" && category !== "preference") return [];
	const anchors = extractSubjectAnchors(content);
	// P0-②d 显式作废语义：更新句宣告取消/作废时，同 category 旧条目只要有任一实义 2-gram 字面命中即视为同主题
	// 依据取证：ext-ret-005/015 “对花生过敏这个禁忌取消了”与旧条目锚不相交（食物词不在锚词表）→ 漏删残留
	const hasRevokeVerb = /取消|作废|不再|解除|撤回/.test(content);
	const STOP_GRAMS = new Set(["用户", "我的", "自己", "现在", "已经", "这个", "那个", "一下", "记得", "永远", "千万", "别忘"]);
	const out: KnowledgeEntry[] = [];
	for (const e of entries) {
		if (e.category !== category) continue;
		const ea = extractSubjectAnchors(e.content);
		const anchorHit = anchors.length > 0 && ea.length > 0 && anchors.some(a => ea.includes(a));
		if (!anchorHit) {
			if (hasRevokeVerb) {
				const old = e.content.replace(/[^\u4e00-\u9fff0-9]+/g, " ");
				const revoked = [...old.matchAll(/[\u4e00-\u9fff0-9]{2}/g)]
					.map(m => m[0])
					.some(g => !STOP_GRAMS.has(g) && content.includes(g));
				if (revoked) { out.push(e); continue; }
			}
			continue;
		}
		const sim = tokenSimilarity(content, e.content);
		// 相似但不相同（完全相同已被 isDuplicate 拦截）= 同一事实的新状态
		// 中文短句 bigram Jaccard 偏低（共享锚的改写对实测可低至 0.118），阈值取 0.08
		if (sim >= 0.08 && sim < 0.95) out.push(e);
	}
	return out;
}

/** 被替换的旧条目归档到 knowledge 目录之外（.novus/superseded.archive.jsonl），
 *  不进 knowledge/ 扫描区，可审计可回滚 */
function archiveSuperseded(targets: KnowledgeEntry[]): void {
	if (targets.length === 0) return;
	try {
		const archivePath = join(dirname(KNOWLEDGE_DIR()), "superseded.archive.jsonl");
		appendFileSync(archivePath, targets.map(e => JSON.stringify({ ...e, supersededAt: new Date().toISOString() })).join("\n") + "\n", "utf-8");
	} catch { /* 归档失败不阻断主流程 */ }
}

/** 清理噪音标签 */
function cleanTags(tags: string[]): string[] {
	return tags.filter(t =>
		!t.startsWith("used-") &&
		!t.startsWith("topic:") &&
		t !== "self-reflection" &&
		t !== "self-critique" &&
		t !== "user-correction" &&
		t !== "decision" &&
		t !== "implementation"
	);
}

// ===== 公共API =====

/** 存储新知识 — 自动判断分层，自动清理标签，去重 */
// ===== 守卫5: reflect 噪音规则拦截（图层审计 2026-10-15，任务 mv9c）=====
// 339 条 self-improvement 审计发现 10.9% 源头即污染：疑问句/反问提议/操作指令
// 被 reflect 当"改进规则"入库（"不要我先写好草稿？" refCount=1446 实锤）。
// 只拦 source==="reflect" 的自动入库；手动 learn 不受影响。
const NOISE_RULE_PATTERNS: RegExp[] = [
	/[?？]/,                                          // 短文本含问号 = 疑问句（长文本由下一组兜底）
	/^(不要我|要不要|需要我|我该不该|是否该|能否|为什么不|怎么不)/, // 反问式提议开头
	/(吗|吧|呢)\s*[?？]\s*$/,                          // 长文本语气疑问尾（"…吗？"）
	/^(把它|很好[!!！]|看了|开始[，,]|再微调|微调一下|跑一下|试一下|应该可以|我看日志|差一点点?[，,]|的话我)/, // 操作指令/对话残留开头
];

// ===== 守卫6: 巡查过程快照拦截（self-evolution-flywheel 2026-10-31 审计）=====
// knowledge 类污染新形态：巡查/轮询任务的"过程快照"（仍 PENDING/等下轮复查）
// 被 learn 进永久知识库。这类内容应落 session-context（LastWork 机制），
// 进 knowledge 会永久拖累检索质量（抽查 120 条抓到 4 条实锤）。
// 判定：过程快照特征词命中 且 无结论性标记 → 拦截（有结论的定案不受影响）。
const PROCESS_SNAPSHOT_PATTERNS: RegExp[] = [
	/巡查快照|巡查基线|轮询[:：]/,                                  // 快照体例开头
	/仍\s?PENDING|等下轮|下轮复查|待下轮|下轮巡查|下次巡查|下轮到期待办/, // 过程未决语
];
const CONCLUSION_MARKERS = /定案|根因|死型|破关|resolved|PASS|FAIL|终局|收案|收官|修复完成/;

/** 巡查过程快照检测：无结论的过程状态留痕 → true（不应入库）
 *  体例词必须出现在开头 60 字内（快照以 watcher 名+体例开头，英文名较长），
 *  避免误杀“主体是结论、尾部附带一句状态补注”的正常条目（connect update 回归实测）。 */
export function isProcessSnapshot(content: string): boolean {
	if (!PROCESS_SNAPSHOT_PATTERNS[0].test(content.slice(0, 60))) return false;
	if (!PROCESS_SNAPSHOT_PATTERNS[1].test(content)) return false;
	return !CONCLUSION_MARKERS.test(content);
}

/** reflect 来源的"改进规则"噪音检测：疑问句/反问提议/操作指令残留 → true（不应入库） */
export function isNoiseRule(content: string): boolean {
	const body = content.replace(/^改进规则:\s*/, "").trim();
	if (body.length < 8) return true; // 太短无规则信息量
	if (body.length < 60) return NOISE_RULE_PATTERNS[0].test(body) || NOISE_RULE_PATTERNS.slice(1).some(re => re.test(body));
	return NOISE_RULE_PATTERNS.slice(1).some(re => re.test(body));
}

export function storeKnowledge(entry: {
	content: string;
	source?: string;
	category?: KnowledgeCategory;
	tags?: string[];
	confidence?: number;
	/** 显式实体 id；缺省自动抽取 */
	entities?: string[];
}): KnowledgeEntry | null {
	ensureDir();

	const tags = cleanTags(entry.tags ?? []);

	// 守卫0: 用户明示临时/一次性 → 不入库（P0-①）
	if (isEphemeralByRequest(entry.content)) {
		return null;
	}

	// 守卫3: 第三方捎话/转述的 PII → 不入库（P0-③）
	if (checkThirdPartyPIIViolation(entry.content)) {
		return null;
	}

	// 守卫4: 核心证件号 → 不入库（bnd PII 泄漏修复）
	if (checkSensitiveGovId(entry.content)) {
		return null;
	}

	// 守卫1: 拒绝无意义内容
	if (!isMeaningful(entry.content, tags)) {
		return null;
	}

	// 守卫2: 去重（仅在本视角可见的条目内去重；跨租户允许各自存储）
	const allEntries = visibleToCurrentTenant([...loadEntries(CORE_STORE()), ...loadEntries(LOG_STORE())]);
	if (isDuplicate(entry.content, allEntries)) {
		return null;
	}

	const category = entry.category ?? inferCategory(entry.content, tags);
	const confidence = entry.confidence ?? 0.8;

	// 守卫5: reflect 噪音规则 → 不入库（图层审计 mv9c：疑问句/指令/闲聊不是教训）
	if (entry.source === "reflect" && category === "self-improvement" && isNoiseRule(entry.content)) {
		return null;
	}

	// 守卫6: 巡查过程快照 → 不入库（flywheel 2026-10-31：过程留痕落 session-context，不进知识库）
	if (isProcessSnapshot(entry.content)) {
		return null;
	}

	const full: KnowledgeEntry = {
		id: randomUUID().slice(0, 8),
		content: entry.content,
		source: entry.source ?? "manual",
		category,
		tags,
		timestamp: new Date().toISOString(),
		confidence,
		refCount: 0,
		tenant: tenantScope() ?? undefined,
		entities: entry.entities ? normalizeEntities(entry.entities) : extractEntities(entry.content + " " + tags.join(" ")),
	};

	// 守卫2.5: 同主题 supersede —— 新状态使同实体锚旧条目失效（P0-②）
	const supersededTargets = findSupersededTargets(full.content, full.category, allEntries);
	if (supersededTargets.length > 0) {
		archiveSuperseded(supersededTargets);
		recordTombstones(supersededTargets.map(e => e.content));
		// P0-②c 新条目剥离旧值原文（作废表述不复述旧值）
		full.content = stripSupersededMentions(full.content, supersededTargets);
		const supersededIds = new Set(supersededTargets.map(e => e.id));
		saveEntries(CORE_STORE(), loadEntries(CORE_STORE()).filter(e => !supersededIds.has(e.id)));
		saveEntries(LOG_STORE(), loadEntries(LOG_STORE()).filter(e => !supersededIds.has(e.id)));
	}

	// 守卫3: discussion-points 和空 plan 降级到 log
	const forceLog = shouldDemoteToLog(entry.content, tags);
	const core = forceLog ? false : isCoreEntry(full);
	const path = getStorePath(core);
	appendFileSync(path, JSON.stringify(full) + "\n", "utf-8");
	// 重申复活：写入内容包含已登记 tombstone 值 = 用户重新确认该值（rerun6 ext-upd-005 取证）
	revokeTombstones(full.content);
	return full;
}

/** 根据内容自动推断分类 */
function inferCategory(content: string, tags: string[]): KnowledgeCategory {
	const c = content.toLowerCase();

	// 偏好/习惯
	if (/以后|每次|下次|记住|习惯|偏好|不要.*要/.test(content) ||
		tags.includes("user-preference") || tags.includes("user-habit")) {
		return "preference";
	}

	// 事实
	if (/^(?:ssh|服务器ip|路径|远程部署|产品url|项目名|配置)/.test(content) ||
		tags.some(t => ["ssh", "server", "infrastructure", "deployment", "path", "product", "url", "config"].includes(t))) {
		return "fact";
	}

	// 商业
	if (/月入|变现|商业|snaptool|snaptools|营收|定价|订阅|客户/.test(c) ||
		tags.some(t => ["business", "snaptool", "monetization"].includes(t))) {
		return "business";
	}

	// 自我改进（只保留真正的改进结论，不是自我批判）
	if (/^(?:自我改进|进化|改进|优化|升级)/.test(content) ||
		tags.includes("self-improvement")) {
		return "self-improvement";
	}

	return "knowledge";
}

/** 写回引用计数更新到磁盘（延迟批量写入，避免频繁IO） */
let pendingRefUpdates = new Map<string, { refCount: number; lastReferenced: string }>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flushRefUpdates(): void {
	if (pendingRefUpdates.size === 0) return;
	const updates = new Map(pendingRefUpdates);
	pendingRefUpdates.clear();
	if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }

	// 只更新核心库（日志库不追踪引用）
	const path = CORE_STORE();
	if (!existsSync(path)) return;
	const entries = loadEntries(path);
	let changed = false;
	for (const e of entries) {
		const update = updates.get(e.id);
		if (update) {
			e.refCount = update.refCount;
			e.lastReferenced = update.lastReferenced;
			changed = true;
		}
	}
	if (changed) saveEntries(path, entries);
}

/** 安排延迟写回（100ms内的多次recall合并为一次写入） */
function scheduleRefFlush(): void {
	if (flushTimer) return;
	flushTimer = setTimeout(() => {
		flushTimer = null;
		flushRefUpdates();
	}, 100);
}

/** 查询知识 — 默认按价值排序，支持结果去重 */
export function queryKnowledge(q: KnowledgeQuery & { deduplicate?: boolean }): KnowledgeEntry[] {
	const coreOnly = q.coreOnly !== false;

	let coreEntries = loadEntries(CORE_STORE());
	let logEntries = coreOnly ? [] : loadEntries(LOG_STORE());
	let entries = visibleToCurrentTenant([...coreEntries, ...logEntries]);

	// 按分类过滤
	if (q.category) {
		entries = entries.filter(e => e.category === q.category);
	}

	// 按标签过滤
	if (q.tags && q.tags.length > 0) {
		entries = entries.filter(e => q.tags!.some(t => e.tags.includes(t)));
	}

	// 按来源过滤
	if (q.source) {
		const src = q.source.toLowerCase();
		entries = entries.filter(e => e.source.toLowerCase().includes(src));
	}

	// 最低信心
	if (q.minConfidence !== undefined) {
		entries = entries.filter(e => e.confidence >= q.minConfidence!);
	}

	// 文本搜索 + 评分（实体命中 = 强加权检索键，非硬过滤：老条目无 entities 字段照常参与）
	const queryEntities = q.entities ? normalizeEntities(q.entities) : [];
	if (q.query || queryEntities.length > 0) {
		const queryTokens = q.query ? tokenize(q.query) : new Set<string>();
		const scored = entries.map(e => {
			const entryTokens = entryTokensOf(e);
			let relevance = 0;
			for (const qt of queryTokens) {
				if (entryTokens.has(qt)) relevance += 1;
				for (const et of entryTokens) {
					if (et.startsWith(qt) && et !== qt) relevance += 0.5;
					if (qt.startsWith(et) && et !== qt) relevance += 0.3;
				}
			}
			// 实体命中加权：每个交集实体 +3（可叠加）
			const entityBoost = queryEntities.length && e.entities?.length
				? 3 * queryEntities.filter(x => e.entities!.includes(x)).length
				: 0;
			// 价值 = 信心 × 时间衰减 × (1 + 引用加成)
			const refBonus = Math.min((e.refCount ?? 0) * 0.05, 0.3);
			const value = e.confidence * timeDecay(e) * (1 + refBonus) * (0.5 + relevance + entityBoost);
			return { entry: e, relevance, entityBoost, value };
		}).filter(s => s.relevance > 0 || s.entityBoost > 0);

		// 更新引用计数并安排延迟写回
		for (const s of scored.slice(0, 5)) {
			s.entry.refCount = (s.entry.refCount ?? 0) + 1;
			s.entry.lastReferenced = new Date().toISOString();
			pendingRefUpdates.set(s.entry.id, {
				refCount: s.entry.refCount,
				lastReferenced: s.entry.lastReferenced,
			});
		}
		scheduleRefFlush();

		if (q.sortBy === "value" || !q.sortBy) {
		// 主键：实体命中置顶；次键：价值降序
		scored.sort((a, b) => (Number(b.entityBoost > 0) - Number(a.entityBoost > 0)) || (b.value - a.value));
		entries = scored.map(s => s.entry);
		} else {
		// 按其他排序时也用scored的relevance过滤
		entries = scored.map(s => s.entry);
		if (q.sortBy === "confidence") {
			entries.sort((a, b) => b.confidence - a.confidence);
		} else {
			entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
		}
		}
	} else {
		// 无搜索词但有实体查询：只返回实体命中条目（实体即检索键），按时间降序
		if (queryEntities.length > 0) {
			entries = entries.filter(e => e.entities?.some(x => queryEntities.includes(x)));
			entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
		} else if (q.sortBy === "confidence") {
			entries.sort((a, b) => b.confidence - a.confidence);
		} else {
			entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
		}
	}

	// 结果去重：相似条目只保留最佳。
	// ⚠️ 性能硬闸（2026-10-29）：去重是 O(n²) 两两相似度，曾对全部 600-1200 命中条目
	// 全量互比（9.5 万对 × 重复 tokenize 大文本）单次吃 35s，同步阻塞事件循环 ——
	// 表现为「提问后思考图标迟迟不出且无法中断」。去重本只服务于最终 top-limit，
	// 故先截取 top 窗口（limit×10，下限 50）再去重，窗口外条目本就进不了终选。
	if (q.deduplicate !== false && q.query && entries.length > 1) {
		const window = q.limit && q.limit > 0 ? Math.max(q.limit * 10, 50) : entries.length;
		entries = deduplicateResults(entries.slice(0, window), 0.55);
	}

	if (q.limit && q.limit > 0) {
		entries = entries.slice(0, q.limit);
	}

	return entries;
}

/** 对召回结果去重：相似条目（Jaccard > threshold）分组，每组只保留最高分。
 *  每条内容只 tokenize 一次（此前每对比一次重 tokenize 两次，是检索链路最大热点）。 */
const dedupTokenCache = new WeakMap<KnowledgeEntry, Set<string>>();

function deduplicateResults(entries: KnowledgeEntry[], threshold: number = 0.55): KnowledgeEntry[] {
	if (entries.length <= 1) return entries;
	
	const tokenOf = (e: KnowledgeEntry): Set<string> => {
		let t = dedupTokenCache.get(e);
		if (!t) { t = tokenize(e.content); dedupTokenCache.set(e, t); }
		return t;
	};
	
	const groups: KnowledgeEntry[][] = [];
	const assigned = new Set<string>();
	
	for (let i = 0; i < entries.length; i++) {
		if (assigned.has(entries[i]!.id)) continue;
		const group: KnowledgeEntry[] = [entries[i]!];
		assigned.add(entries[i]!.id);
		const ti = tokenOf(entries[i]!);
		
		for (let j = i + 1; j < entries.length; j++) {
			if (assigned.has(entries[j]!.id)) continue;
			if (entries[i]!.category !== entries[j]!.category) continue;
			const sim = similarityFromTokens(ti, tokenOf(entries[j]!));
			if (sim > threshold) {
				group.push(entries[j]!);
				assigned.add(entries[j]!.id);
			}
		}
		groups.push(group);
	}
	
	// 每组保留最佳条目（按内容长度优先，因为更长通常更完整）
	const results: KnowledgeEntry[] = [];
	for (const group of groups) {
		if (group.length === 1) {
			results.push(group[0]!);
		} else {
			// 选内容最长的（最完整），标记有重复
			group.sort((a, b) => b.content.length - a.content.length);
			const best = { ...group[0]! };
			best.tags = [...best.tags, `merged:${group.length - 1}`];
			results.push(best);
		}
	}
	
	return results;
}

/** 获取总数（核心+日志，当前视角可见） */
export function knowledgeCount(): number {
	return visibleToCurrentTenant(loadEntries(CORE_STORE())).length + visibleToCurrentTenant(loadEntries(LOG_STORE())).length;
}

/** 获取核心知识数（当前视角可见） */
export function coreKnowledgeCount(): number {
	return visibleToCurrentTenant(loadEntries(CORE_STORE())).length;
}

/** 获取各类别统计 */
export function knowledgeStats(): { total: number; core: number; log: number; byCategory: Record<string, number> } {
	const core = visibleToCurrentTenant(loadEntries(CORE_STORE()));
	const log = visibleToCurrentTenant(loadEntries(LOG_STORE()));
	const all = [...core, ...log];
	const byCategory: Record<string, number> = {};
	for (const e of all) {
		byCategory[e.category] = (byCategory[e.category] || 0) + 1;
	}
	return { total: all.length, core: core.length, log: log.length, byCategory };
}

/** 清理过期日志（超过90天的低价值记忆） */
export function pruneExpired(): number {
	const logEntries = loadEntries(LOG_STORE());
	const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
	const kept = logEntries.filter(e => new Date(e.timestamp).getTime() > cutoff);
	const removed = logEntries.length - kept.length;
	if (removed > 0) saveEntries(LOG_STORE(), kept);
	return removed;
}

// ===== 知识质量分析 =====

export interface PruneAnalysis {
	/** 总条目数 */
	total: number;
	/** 低价值条目（建议清理） */
	candidates: PruneCandidate[];
	/** 各类问题统计 */
	issues: { noise: number; duplicateTopic: number; processLog: number; stale: number };
	/** 建议 */
	recommendation: string;
}

export interface PruneCandidate {
	id: string;
	content: string;
	category: string;
	tags: string[];
	timestamp: string;
	confidence: number;
	refCount?: number;
	reason: string;
}

/** 模式匹配：检测明显低价值的内容 */
function detectNoisePatterns(content: string): string | null {
	const c = content.trim();
	// "高强度工作轮" — 纯过程日志
	if (/^高强度工作轮/.test(c)) return "process-log";
	// "技术决策: 我先看看/我来分析" — 行动过程，不是结论
	if (/^技术决策:\s*(我来看看|我先看看|我来看看|我来分析|我看到)/.test(c)) return "process-log";
	// "讨论要点:" 开头的长对话过程记录
	if (/^讨论要点[:：]/.test(c) && c.length > 200) return "discussion-fragment";
	// 纯结构化JSON（plan步骤列表等），非知识
	if (/^\s*\[.*\]\s*$/.test(c) && c.length < 100) return "empty-structure";
	// 过短的"knowledge"类内容（小于20字）
	if (c.length < 20) return "trivial";
	return null;
}

/**
 * Compute token-based Jaccard similarity between two strings.
 * Returns 0-1 where 1 means identical token sets.
 */
function tokenSimilarity(a: string, b: string): number {
	return similarityFromTokens(tokenize(a), tokenize(b));
}

function similarityFromTokens(ta: Set<string>, tb: Set<string>): number {
	if (ta.size === 0 || tb.size === 0) return 0;
	let intersection = 0;
	for (const t of ta) {
		if (tb.has(t)) intersection++;
	}
	return intersection / (ta.size + tb.size - intersection);
}

/**
 * Detect near-duplicate entries using token overlap (Jaccard similarity).
 * Groups entries where similarity > 0.6 as potential duplicates.
 * Much more accurate than prefix-based matching.
 */
function findTopicDuplicates(entries: KnowledgeEntry[]): Map<string, KnowledgeEntry[]> {
	const groups = new Map<string, KnowledgeEntry[]>();
	const assigned = new Set<string>(); // Track already-assigned entry IDs

	for (let i = 0; i < entries.length; i++) {
		if (assigned.has(entries[i].id)) continue;
		for (let j = i + 1; j < entries.length; j++) {
			if (assigned.has(entries[j].id)) continue;
			if (entries[i].category !== entries[j].category) continue;
			const sim = tokenSimilarity(entries[i].content, entries[j].content);
			if (sim > 0.6) {
				// Use the earlier entry's id as group key
				const key = entries[i].id;
				if (!groups.has(key)) groups.set(key, [entries[i]]);
				groups.get(key)!.push(entries[j]);
				assigned.add(entries[j].id);
			}
		}
	}

	return groups;
}

/** 分析知识库质量，返回建议清理的条目 */
export function analyzeKnowledgeQuality(): PruneAnalysis {
	const core = visibleToCurrentTenant(loadEntries(CORE_STORE()));
	const log = visibleToCurrentTenant(loadEntries(LOG_STORE()));
	const all = [...core, ...log];
	const now = Date.now();

	const candidates: PruneCandidate[] = [];
	const issues = { noise: 0, duplicateTopic: 0, processLog: 0, stale: 0 };

	// 1. 噪音检测：明显低价值模式
	for (const e of all) {
		const pattern = detectNoisePatterns(e.content);
		if (pattern === "process-log") {
			issues.processLog++;
			candidates.push({ ...e, reason: "过程日志（非知识结论）" });
		} else if (pattern === "discussion-fragment") {
			issues.noise++;
			candidates.push({ ...e, reason: "对话过程碎片（非结论）" });
		} else if (pattern === "trivial") {
			issues.noise++;
			candidates.push({ ...e, reason: "内容过短（<20字）" });
		} else if (pattern === "empty-structure") {
			issues.noise++;
			candidates.push({ ...e, reason: "空结构化数据" });
		}
	}

	// 2. 同主题重复检测（保留最长的版本）
	const duplicates = findTopicDuplicates(all);
	const deduplicatedIds = new Set<string>();
	for (const [, group] of duplicates) {
		// 按内容长度排序，保留最长的
		group.sort((a, b) => b.content.length - a.content.length);
		for (let i = 1; i < group.length; i++) {
			const e = group[i];
			if (!candidates.some(c => c.id === e.id)) {
				issues.duplicateTopic++;
				candidates.push({ ...e, reason: `同主题重复（保留最长版 ${group[0].id}）` });
				deduplicatedIds.add(e.id);
			}
		}
	}

	// 3. 陈旧检测：>30天未被引用且低信心
	for (const e of all) {
		const age = (now - new Date(e.timestamp).getTime()) / 86400000;
		const lastRef = e.lastReferenced
			? (now - new Date(e.lastReferenced).getTime()) / 86400000
			: 999;
		if (age > 30 && lastRef > 30 && e.confidence < 0.8 && !candidates.some(c => c.id === e.id)) {
			issues.stale++;
			candidates.push({ ...e, reason: "30天+未引用且低信心" });
		}
	}

	// 生成建议
	const total = all.length;
	const pruneCount = candidates.length;
	let recommendation: string;
	if (pruneCount === 0) {
		recommendation = "知识库质量良好，无需清理。";
	} else if (pruneCount < total * 0.1) {
		recommendation = `发现 ${pruneCount} 条低价值条目（${(pruneCount/total*100).toFixed(0)}%），建议清理。`;
	} else if (pruneCount < total * 0.3) {
		recommendation = `发现 ${pruneCount} 条低价值条目（${(pruneCount/total*100).toFixed(0)}%），建议批量清理以提升知识密度。`;
	} else {
		recommendation = `发现 ${pruneCount} 条低价值条目（${(pruneCount/total*100).toFixed(0)}%），知识库质量较低，建议深度清理。`;
	}

	return { total, candidates, issues, recommendation };
}

/** 执行清理：删除指定的条目 */
export function pruneEntries(ids: string[]): { removed: number } {
	let removed = 0;
	for (const store of [CORE_STORE(), LOG_STORE()]) {
		const entries = loadEntries(store);
		// 租户保护：只能删除当前视角可见的条目（防跨租户/跨视角删除）
		const deletable = new Set(visibleToCurrentTenant(entries).filter(e => ids.includes(e.id)).map(e => e.id));
		if (deletable.size > 0) {
			// P0-④ 被遗忘权：删除条目的敏感值登记 tombstone，防同会话复述/渗入产物
			recordTombstones(entries.filter(e => deletable.has(e.id)).map(e => e.content));
		}
		const kept = entries.filter(e => !deletable.has(e.id));
		removed += entries.length - kept.length;
		if (entries.length !== kept.length) {
			saveEntries(store, kept);
		}
	}
	return { removed };
}

/** 清空所有（危险） */
export function clearKnowledge(): void {
	if (!tenantScope()) {
		for (const p of [CORE_STORE(), LOG_STORE(), LEGACY_STORE()]) {
			if (existsSync(p)) unlinkSync(p);
		}
		return;
	}
	// 租户上下文：只清自己租户的条目，不碰本体与其他租户的数据
	for (const store of [CORE_STORE(), LOG_STORE()]) {
		const entries = loadEntries(store);
		const kept = entries.filter(e => e.tenant !== tenantScope());
		if (kept.length !== entries.length) saveEntries(store, kept);
	}
}

// ===== 知识压缩 =====

export interface CompressResult {
	compressed: number;
	merged: number;
	/** 被合并的条目ID列表 */
	removedIds: string[];
	/** 新创建的合并条目 */
	newEntry?: KnowledgeEntry;
}

/** 查找可压缩的条目组（相似度 > 0.6，同分类） */
export function findCompressibleGroups(minSimilarity: number = 0.6): Array<{ entries: KnowledgeEntry[]; avgSimilarity: number }> {
	const core = visibleToCurrentTenant(loadEntries(CORE_STORE()));
	if (core.length < 2) return [];

	const groups: Array<{ entries: KnowledgeEntry[]; avgSimilarity: number }> = [];
	const assigned = new Set<string>();

	for (let i = 0; i < core.length; i++) {
		if (assigned.has(core[i]!.id)) continue;
		const group: KnowledgeEntry[] = [core[i]!];
		let totalSim = 0;
		let pairwiseCount = 0;

		for (let j = i + 1; j < core.length; j++) {
			if (assigned.has(core[j]!.id)) continue;
			if (core[i]!.category !== core[j]!.category) continue;
			const sim = tokenSimilarity(core[i]!.content, core[j]!.content);
			if (sim > minSimilarity) {
				group.push(core[j]!);
				assigned.add(core[j]!.id);
				totalSim += sim;
				pairwiseCount++;
			}
		}

		if (group.length >= 2) {
			assigned.add(core[i]!.id);
			groups.push({
				entries: group,
				avgSimilarity: pairwiseCount > 0 ? totalSim / pairwiseCount : 0,
			});
		}
	}

	return groups;
}

/** 压缩一组相似条目：合并为一条摘要，删除原条目 */
export function compressGroup(group: KnowledgeEntry[]): CompressResult {
	if (group.length < 2) return { compressed: 0, merged: 0, removedIds: [] };

	// 合并内容：最长条目作基础，附加其他条目的独特信息
	const sorted = [...group].sort((a, b) => b.content.length - a.content.length);
	const base = sorted[0]!;
	const extraTags = new Set<string>();
	const extraInfo: string[] = [];

	for (let i = 1; i < sorted.length; i++) {
		const e = sorted[i]!;
		for (const t of e.tags) extraTags.add(t);
		// 提取不在 base 中的独特短语
		const baseTokens = tokenize(base.content);
		const eTokens = tokenize(e.content);
		const uniqueTokens = [...eTokens].filter(t => !baseTokens.has(t) && t.length > 1);
		if (uniqueTokens.length > 0) {
			extraInfo.push(e.content.slice(0, 200));
		}
	}

	// 构建合并内容
	let mergedContent = base.content;
	if (extraInfo.length > 0) {
		mergedContent += "\n\n【压缩补充】" + extraInfo.map((s, i) => `(${i + 1}) ${s}`).join("\n");
	}

	// 计算合并后的 confidence：取最高
	const maxConfidence = Math.max(...group.map(e => e.confidence));
	// 累积引用计数
	const totalRefs = group.reduce((sum, e) => sum + (e.refCount ?? 0), 0);
	// 最早的时间戳
	const oldest = group.map(e => e.timestamp).sort()[0]!;
	// 合并标签
	const allTags = [...new Set([...base.tags, ...extraTags])].filter(t => !t.startsWith("merged:"));
	allTags.push(`compressed:${group.length}`);

	const merged: KnowledgeEntry = {
		id: randomUUID().slice(0, 8),
		content: mergedContent,
		source: "compress",
		category: base.category,
		tags: allTags,
		timestamp: oldest,
		confidence: maxConfidence,
		refCount: totalRefs,
		tenant: tenantScope() ?? undefined,
	};

	return {
		compressed: group.length,
		merged: 1,
		removedIds: group.map(e => e.id),
		newEntry: merged,
	};
}

/** 执行知识压缩：查找并压缩所有可合并的组 */
export function compressAllKnowledge(minSimilarity: number = 0.6): { groups: number; totalCompressed: number; totalMerged: number } {
	const groups = findCompressibleGroups(minSimilarity);
	if (groups.length === 0) return { groups: 0, totalCompressed: 0, totalMerged: 0 };

	let totalCompressed = 0;
	let totalMerged = 0;
	const allRemovedIds: string[] = [];
	const newEntries: KnowledgeEntry[] = [];

	for (const group of groups) {
		const result = compressGroup(group.entries);
		totalCompressed += result.compressed;
		totalMerged += result.merged;
		allRemovedIds.push(...result.removedIds);
		if (result.newEntry) newEntries.push(result.newEntry);
	}

	// 删除被合并的旧条目
	pruneEntries(allRemovedIds);

	// 写入新的合并条目
	for (const e of newEntries) {
		appendFileSync(CORE_STORE(), JSON.stringify(e) + "\n", "utf-8");
	}

	return { groups: groups.length, totalCompressed, totalMerged };
}

// ===== 主动召回（会话上下文）=====

/** 从记忆库中提取"你应该知道"的上下文，用于注入 system prompt */
export function getContextualMemory(maxEntries: number = 8): string {
	const core = visibleToCurrentTenant(loadEntries(CORE_STORE()));
	if (core.length === 0) return "";

	// 按价值排序：confidence × timeDecay × (1 + refBonus)
	const scored = core.map(e => {
		const refBonus = Math.min((e.refCount ?? 0) * 0.05, 0.3);
		const value = e.confidence * timeDecay(e) * (1 + refBonus);
		return { entry: e, value };
	});
	scored.sort((a, b) => b.value - a.value);

	// 取 top N，去重
	const topEntries = deduplicateResults(
		scored.slice(0, maxEntries * 2).map(s => s.entry),
		0.6
	).slice(0, maxEntries);

	if (topEntries.length === 0) return "";

	const lines: string[] = [];
	// 按分类分组
	const byCategory: Record<string, KnowledgeEntry[]> = {};
	for (const e of topEntries) {
		(byCategory[e.category] ??= []).push(e);
	}

	for (const [cat, entries] of Object.entries(byCategory)) {
		const catLabel: Record<string, string> = {
			knowledge: "🧠 Knowledge",
			preference: "💡 Preferences",
			fact: "📋 Facts",
			"self-improvement": "🔧 Self-Improvement",
			business: "💰 Business",
		};
		lines.push(catLabel[cat] ?? cat);
		for (const e of entries) {
			const preview = e.content.length > 150 ? e.content.slice(0, 150) + "..." : e.content;
			lines.push(`  - ${preview}`);
		}
	}

	return `\n## 🧠 Memory Context (from past sessions)\n${lines.join("\n")}`;
}

/** Ensure pending refCount updates are flushed (call before process exit) */
export function flushPendingRefs(): void {
	if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
	flushRefUpdates();
}

// ===== 元记忆系统 (Meta-Memory) =====
//
// 让AI知道“自己知道什么”和“自己不知道什么”。
// 分析知识库覆盖度，识别盲区，提供召回质量评估。

export interface MetaMemoryReport {
	/** 知识库总览 */
	summary: {
		total: number;
		core: number;
		log: number;
		experiences: number;
	};
	/** 分类覆盖 */
	categories: Record<string, { count: number; avgConfidence: number; avgRefCount: number }>;
	/** 高频标签（标签云，反映知识面） */
	tagCloud: Array<{ tag: string; count: number }>;
	/** 盲区检测：查询是否命中任何知识 */
	queryHit: {
		query: string;
		hit: boolean;
		hitCount: number;
		score: number;
		bestCategory: string;
	};
	/** 知识健康指标 */
	health: {
		avgConfidence: number;
		avgRefCount: number;
		staleEntries: number; // 30天以上未被引用
		orphanEntries: number; // 从未被引用过的
		knowledgeFreshness: number; // 0-1, 越高越新鲜
	};
}

/** 生成元记忆报告 */
export function metaMemory(query?: string): MetaMemoryReport {
	const coreEntries = visibleToCurrentTenant(loadEntries(CORE_STORE()));
	const logEntries = visibleToCurrentTenant(loadEntries(LOG_STORE()));
	const experiences = loadExperiences();
	const all = [...coreEntries, ...logEntries];
	const now = Date.now();

	// 分类覆盖
	const categories: Record<string, { count: number; totalConf: number; totalRef: number }> = {};
	for (const e of all) {
		if (!categories[e.category]) categories[e.category] = { count: 0, totalConf: 0, totalRef: 0 };
		categories[e.category].count++;
		categories[e.category].totalConf += e.confidence;
		categories[e.category].totalRef += e.refCount ?? 0;
	}

	// 标签云
	const tagMap: Record<string, number> = {};
	for (const e of all) {
		for (const tag of e.tags) tagMap[tag] = (tagMap[tag] || 0) + 1;
	}
	const tagCloud = Object.entries(tagMap)
		.map(([tag, count]) => ({ tag, count }))
		.sort((a, b) => b.count - a.count)
		.slice(0, 30);

	// 查询命中检测
	let queryHit: MetaMemoryReport["queryHit"] = {
		query: query || "(none)",
		hit: false,
		hitCount: 0,
		score: 0,
		bestCategory: "",
	};

	if (query) {
		const queryTokens = tokenize(query);
		const scored = all.map(e => {
			const entryTokens = tokenize(e.content + " " + e.tags.join(" "));
			let relevance = 0;
			for (const qt of queryTokens) {
				if (entryTokens.has(qt)) relevance += 1;
			}
			return { entry: e, relevance };
		}).filter(s => s.relevance > 0);

		queryHit.hit = scored.length > 0;
		queryHit.hitCount = scored.length;
		queryHit.score = scored.length > 0 ? Math.min(scored[0]!.relevance / queryTokens.size, 1) : 0;
		queryHit.bestCategory = scored.length > 0 ? scored[0]!.entry.category : "";
	}

	// 健康指标
	const thirtyDaysAgo = now - 30 * 86400000;
	let staleEntries = 0;
	let orphanEntries = 0;
	let totalConf = 0;
	let totalRef = 0;
	for (const e of all) {
		totalConf += e.confidence;
		totalRef += e.refCount ?? 0;
		if (e.refCount === 0) orphanEntries++;
		const lastRef = e.lastReferenced ? new Date(e.lastReferenced).getTime() : new Date(e.timestamp).getTime();
		if (lastRef < thirtyDaysAgo) staleEntries++;
	}
	const n = all.length || 1;
	const freshness = Math.max(0, 1 - staleEntries / n);

	return {
		summary: { total: all.length, core: coreEntries.length, log: logEntries.length, experiences: experiences.length },
		categories: Object.fromEntries(
			Object.entries(categories).map(([k, v]) => [k, { count: v.count, avgConfidence: Math.round(v.totalConf / v.count * 100) / 100, avgRefCount: Math.round(v.totalRef / v.count * 100) / 100 }]),
		),
		tagCloud,
		queryHit,
		health: {
			avgConfidence: Math.round(totalConf / n * 100) / 100,
			avgRefCount: Math.round(totalRef / n * 100) / 100,
			staleEntries,
			orphanEntries,
			knowledgeFreshness: Math.round(freshness * 100) / 100,
		},
	};
}

/** 加载所有知识（兼容旧代码） */
export function loadAllKnowledge(): KnowledgeEntry[] {
	// 优先从新格式加载
	const core = visibleToCurrentTenant(loadEntries(CORE_STORE()));
	const log = visibleToCurrentTenant(loadEntries(LOG_STORE()));
	if (core.length > 0 || log.length > 0) {
		return [...core, ...log];
	}
	// 兼容旧格式
	return visibleToCurrentTenant(loadEntries(LEGACY_STORE()));
}

/**
 * 迁移旧格式记忆到新分层系统
 * 迁移策略：
 * - 自我批判/用户纠正 → 日志（低价值）
 * - 技术决策/结论/事实 → 核心（高价值）
 * - 清理所有噪音标签
 */
export function migrateFromLegacy(): { migrated: number; core: number; log: number; skipped: number } {
	if (!existsSync(LEGACY_STORE())) return { migrated: 0, core: 0, log: 0, skipped: 0 };

	const legacy = loadEntries(LEGACY_STORE());
	if (legacy.length === 0) return { migrated: 0, core: 0, log: 0, skipped: 0 };

	let core = 0, log = 0, skipped = 0;

	for (const entry of legacy) {
		// 跳过已经迁移过的
		if ((entry as any).category) { skipped++; continue; }

		const content = entry.content;

		// 自我批判和用户纠正 → 日志，低信心
		if (content.startsWith("自我批判") || content.startsWith("用户纠正")) {
			const migrated: KnowledgeEntry = {
				...entry,
			category: "self-improvement",
			tags: cleanTags(entry.tags),
			confidence: 0.4,
			refCount: 0,
			};
			appendFileSync(LOG_STORE(), JSON.stringify(migrated) + "\n", "utf-8");
			log++;
			continue;
		}

		// 推断分类
		const category = inferCategory(content, entry.tags);
		const migrated: KnowledgeEntry = {
			...entry,
			category,
			tags: cleanTags(entry.tags),
			refCount: 0,
		};

		if (isCoreEntry(migrated)) {
			appendFileSync(CORE_STORE(), JSON.stringify(migrated) + "\n", "utf-8");
			core++;
		} else {
			appendFileSync(LOG_STORE(), JSON.stringify(migrated) + "\n", "utf-8");
			log++;
		}
	}

	return { migrated: core + log, core, log, skipped };
}

// ===== 情景记忆系统 (Episodic Memory) =====
//
// 区别于知识片段（flat conclusions），情景记忆存储完整的经历结构：
//   什么场景 → 遇到什么 → 做了什么 → 结果如何 → 学到什么
// 可按场景/标签/时间检索，形成可复用的经验库。
//
// 存储: ~/.novus/knowledge/experience.jsonl

function EXPERIENCE_STORE(): string { return join(KNOWLEDGE_DIR(), "experience.jsonl"); }
const MAX_EXPERIENCES = 500;

/** 结局状态（结构化结局标签，检索时可按意图区别对待：debug→失败经验含修法加权，howto→成功经验加权） */
export type OutcomeStatus = "success" | "fail" | "partial";

/** 从结局自由文本推断结构化状态；推断不了返回 undefined（不猜测） */
export function inferOutcomeStatus(outcome: string | undefined): OutcomeStatus | undefined {
	if (!outcome) return undefined;
	const s = outcome.toLowerCase();
	const ok = /\bpass\b|通过|成功|完成|1\.0|✅|healthy|正常|success/.test(s);
	const bad = /\bfail\b|失败|0\.0|死型|死法|✗|❌|429|1308|abort|timeout|超时/.test(s);
	if (ok && !bad) return "success";
	if (bad && !ok) return "fail";
	if (ok && bad) return "partial";
	return undefined;
}

export interface ExperienceEntry {
	id: string;
	/** 经历标题 */
	title: string;
	/** 独立核验结果（RSIAgent 机制④⑤；缺省 = 未核验，视为 unverified 同权重） */
	verification?: VerificationResult;
	/** 场景描述（什么情况下发生的） */
	scenario: string;
	/** 遇到的问题/情况 */
	situation: string;
	/** 采取的行动 */
	actions: string[];
	/** 结果 */
	outcome: string;
	/** 结构化结局标签（缺省时由 storeExperience 从 outcome 文本推断） */
	outcomeStatus?: OutcomeStatus;
	/** 规范化实体 id —— 实体检索键 */
	entities?: string[];
	/** 学到的教训/规则（可被identity复用） */
	lessons: string[];
	/** 来源会话 */
	sessionId?: string;
	/** 标签（场景分类：debug、deploy、ssh、优化等） */
	tags: string[];
	/** 时间戳 */
	timestamp: string;
	/** 信心 0-1 */
	confidence: number;
	/** 引用计数 */
	refCount: number;
	/** 归属租户（仅 --auth-file 多租户模式）；缺省 = 本体 */
	tenant?: string;
}

/** 存储情景记忆 */
export function storeExperience(entry: Omit<ExperienceEntry, "id" | "refCount">): ExperienceEntry {
	ensureDir();
	// 全量读写（含其他视角条目），避免租户/本体写回时丢对方的数据
	const entries = loadAllExperiences();

	// 去重：相同title+scenario的保留最新（仅限同视角条目，不跨租户吞并）
	const tid = tenantScope();
	const dupIdx = entries.findIndex(e => (tid ? e.tenant === tid : !e.tenant) && e.title === entry.title && e.scenario === entry.scenario);
	if (dupIdx >= 0) entries.splice(dupIdx, 1);

	const newEntry: ExperienceEntry = {
		...entry,
		id: randomUUID().slice(0, 8),
		refCount: 0,
		tenant: tid ?? undefined,
		outcomeStatus: entry.outcomeStatus ?? inferOutcomeStatus(entry.outcome),
		entities: entry.entities ? normalizeEntities(entry.entities) : extractEntities([entry.title, entry.scenario, entry.situation, entry.actions.join(" ")].join(" ")),
	};
	entries.unshift(newEntry);

	// 限制总数
	if (entries.length > MAX_EXPERIENCES) {
		entries.splice(MAX_EXPERIENCES);
	}

	// 经历用独立存储（不混入knowledge entries）
	writeFileSync(EXPERIENCE_STORE(), entries.map(e => JSON.stringify(e)).join("\n") + "\n", "utf-8");
	return newEntry;
}

/** 写回独立核验结果（RSIAgent 机制④⑤：写入后由独立 Verifier 补验，按 id 定位回填） */
export function applyVerification(id: string, verification: VerificationResult): ExperienceEntry | null {
	ensureDir();
	const entries = loadAllExperiences();
	const idx = entries.findIndex(e => e.id === id);
	if (idx < 0) return null;
	entries[idx].verification = verification;
	writeFileSync(EXPERIENCE_STORE(), entries.map(e => JSON.stringify(e)).join("\n") + "\n", "utf-8");
	return entries[idx];
}

/** 检索情景记忆（按场景/标签/实体/关键词匹配；intent 感知：debug→失败经验加权，howto→成功经验加权） */
export function recallExperience(query: {
	scenario?: string;
	tags?: string[];
	entities?: string[];
	/** 检索意图：debug=排查/修问题（失败经验含修法，加权），howto=学做法（成功经验加权） */
	intent?: "debug" | "howto";
	keyword?: string;
	limit?: number;
}): ExperienceEntry[] {
	const entries = loadExperiences();
	if (entries.length === 0) return [];

	let scored = entries.map(e => {
		let score = 0;

		// 标签精确匹配
		if (query.tags?.length) {
			for (const tag of query.tags) {
				if (e.tags.includes(tag)) score += 10;
			}
		}

		// 实体命中（检索层改造①）：每个交集实体 +12，强于单词场景 token
		const queryEntities = query.entities ? normalizeEntities(query.entities) : [];
		if (queryEntities.length && e.entities?.length) {
			score += 12 * queryEntities.filter(x => e.entities!.includes(x)).length;
		}

		// 场景匹配
		if (query.scenario) {
			const queryTokens = tokenize(query.scenario);
			const sceneTokens = tokenize(e.scenario + " " + e.situation);
			let overlap = 0;
			for (const t of queryTokens) {
				if (sceneTokens.has(t)) overlap++;
			}
			if (queryTokens.size > 0) score += (overlap / queryTokens.size) * 8;
		}

		// 关键词全文搜索
		if (query.keyword) {
			const fullText = (e.title + " " + e.scenario + " " + e.situation + " " + e.outcome + " " + e.lessons.join(" ")).toLowerCase();
			if (fullText.includes(query.keyword.toLowerCase())) score += 5;
			// 额外搜索 bigrams
			const kwTokens = tokenize(query.keyword);
			for (const t of kwTokens) {
				if (fullText.includes(t)) score += 2;
			}
		}

		// 时间衰减（越新越好，但教训不会过时）
		const ageDays = (Date.now() - new Date(e.timestamp).getTime()) / 86400000;
		const recency = ageDays < 7 ? 1.0 : ageDays < 30 ? 0.8 : 0.6;
		// 有教训的经验不过时
		const hasLessons = e.lessons.length > 0;

		let weight = hasLessons ? 1.2 : recency;
		// 意图感知排序（检索层改造②）：查死法优先同类失败（修法在里面），学做法优先同类成功
		if (query.intent === "debug" && e.outcomeStatus === "fail") weight *= 1.35;
		else if (query.intent === "howto" && e.outcomeStatus === "success") weight *= 1.2;
		// 核验状态权重（RSIAgent 机制⑤：rejected 降权但不删除——失败也是素材，只是不可当已验证事实引用）
		if (e.verification?.status === "verified") weight *= 1.2;
		else if (e.verification?.status === "rejected") weight *= 0.3;

		return { entry: e, score: score * weight };
	});

	scored.sort((a, b) => b.score - a.score);
	return scored.filter(s => s.score > 1).slice(0, query.limit ?? 10).map(s => s.entry);
}

/** 从 worklog 条目自动提取情景记忆 */
export function extractExperienceFromWorklog(wle: {
	activity: string;
	changes?: string;
	nextStep?: string;
	step?: string;
	files?: string[];
	status?: string;
	timestamp?: string;
	sessionId?: string;
}): Omit<ExperienceEntry, "id" | "refCount"> | null {
	// 只提取有实质改动的工作（跳过idle/blocked/简单的"检查"）
	if (wle.status === "idle" || wle.status === "blocked") return null;
	if (!wle.changes && !wle.files?.length) return null;
	if (wle.activity.length < 8) return null;

	// 推断场景标签
	const tags: string[] = [];
	const fullText = (wle.activity + " " + (wle.changes || "") + " " + (wle.step || "")).toLowerCase();
	const tagMap: Record<string, string[]> = {
		debug: ["修复", "fix", "bug", "错误", "error", "排查", "诊断"],
		deploy: ["部署", "deploy", "发布", "publish", "同步", "sync"],
		ssh: ["ssh", "175", "93", "服务器", "远程"],
		optimize: ["优化", "优化", "改进", "升级", "improve", "重构"],
		monitor: ["巡检", "检查", "check", "健康", "health"],
	};
	for (const [tag, keywords] of Object.entries(tagMap)) {
		if (keywords.some(kw => fullText.includes(kw))) tags.push(tag);
	}
	if (tags.length === 0) tags.push("general");

	// 从改动描述中提取教训
	const lessons: string[] = [];
	if (wle.changes) {
		// 提取"改为""加""去掉"等动词后的关键信息
		const patterns = wle.changes.match(/(?:改为|改为|加|新增|去掉|移除|修复|改用)[^,;。]+/g);
		if (patterns) lessons.push(...patterns.map(p => "改动: " + p.trim()));
		// 如果有"避免"字样，直接提取为教训
		const avoidPatterns = wle.changes.match(/避免[^,;。]+/g);
		if (avoidPatterns) lessons.push(...avoidPatterns.map(p => p.trim()));
	}


	const result: Omit<ExperienceEntry, "id" | "refCount"> = {
		title: wle.activity,
		scenario: wle.step || tags.join(", "),
		situation: wle.activity,
		actions: wle.changes ? [wle.changes] : [],
		outcome: wle.status === "done" ? "success" : wle.status === "blocked" ? "blocked" : "in progress", // 英文与 i18n 决策一致；结构化语义在 outcomeStatus
		outcomeStatus: wle.status === "done" ? "success" : undefined,
		lessons,
		sessionId: wle.sessionId,
		tags,
		timestamp: wle.timestamp || new Date().toISOString(),
		confidence: 0.85,
		entities: extractEntities(fullText + " " + (wle.files ?? []).join(" ")),
	};
	return result;
}

/** 加载当前视角可见的情景记忆（本体见无主条目，租户见自己的） */
function loadExperiences(): ExperienceEntry[] {
	return visibleToCurrentTenant(loadAllExperiences());
}

/** 加载全部情景记忆（跨视角，供 storeExperience 全量写回用） */
function loadAllExperiences(): ExperienceEntry[] {
	if (!existsSync(EXPERIENCE_STORE())) return [];
	return loadEntries(EXPERIENCE_STORE()) as unknown as ExperienceEntry[];
}

/** 情景记忆统计 */
export function experienceStats(): { total: number; byTag: Record<string, number>; recent: string } {
	const entries = loadExperiences();
	const byTag: Record<string, number> = {};
	for (const e of entries) {
		for (const tag of e.tags) byTag[tag] = (byTag[tag] || 0) + 1;
	}
	return {
		total: entries.length,
		byTag,
		recent: entries[0]?.timestamp || "无",
	};
}

// ===== Tokenize =====

export function tokenize(text: string): Set<string> {
	const lower = text.toLowerCase();
	const tokens = new Set<string>();
	const regex = /[a-z0-9]+|[一-鿿㐀-䶿]+/g;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(lower)) !== null) {
		const word = match[0]!;
		tokens.add(word);
		// For Chinese: also extract bigrams for better recall
		if (word.length >= 2 && /[一-鿿㐀-䶿]/.test(word)) {
			for (let i = 0; i < word.length - 1; i++) {
				tokens.add(word.slice(i, i + 2));
			}
		}
	}
	return tokens;
}
