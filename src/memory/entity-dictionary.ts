/**
 * Entity Dictionary — 实体词典与抽取器（2026-10-10 检索层改造第①步）
 *
 * 目的：把自由文本中的运维实体（节点/项目/任务/人物）抽取为规范化实体 id，
 * 作为「意图转译产物 = 经验检索键」的实体维度。
 *
 * 设计约束：
 * - 纯词典 + 正则，零外部依赖，单次抽取 <1ms（全内存 JSONL 规模下够用）
 * - boost 而非硬过滤：老条目无 entities 字段照常工作，实体命中只是加权
 * - 最长匹配优先 + span 重叠保护：novus-93 命中后不再命中 proj:novus
 * - IP 先行：149.28.169.93 先归一为 node:novus-93，裸 "93" 不会重复命中
 * - 数字别名守卫：裸 "93"/"175" 不匹配 "93%"/"175.5" 等数字上下文
 */

export interface EntityDef {
	/** 规范化实体 id，如 node:pc_box / proj:tb4 / task:freecad-impeller / person:master */
	id: string;
	/** 别名（匹配时不区分大小写；ASCII 走词边界，CJK 走包含） */
	aliases: string[];
}

// 种子词典来源：2026-10-10 对本机知识库 1495 条 core + 157 条 experience 的频次挖掘
// （TOP IP: 192.168.3.35×51 / 149.28.169.93×41 / 175.178.237.9×39 / 192.168.3.37×13；
//   TOP 项目词: novus×419 / tb4×204 / freecad×98 / harbor×95 / coq×81 / ws-comm×77）
export const ENTITY_DEFS: EntityDef[] = [
	// ── 节点（fleet 四节点 + 手机）──
	{ id: "node:pc_box", aliases: ["pc_box", "pc-box", "192.168.3.35", "35机", "35号机", "35机器", "sudoroot@192.168.3.35"] },
	{ id: "node:novus-93", aliases: ["novus-93", "novus93", "149.28.169.93", "93机", "93号机", "93服务器", "93号", "93"] },
	{ id: "node:novus-175", aliases: ["novus-175", "175.178.237.9", "175机", "175服务器", "175号", "175"] },
	{ id: "node:mac_novus01", aliases: ["mac_novus01", "mac-novus01", "192.168.3.37", "mac mini", "macmini"] },
	{ id: "node:phone4", aliases: ["192.168.3.19", "glasses-phone4", "第四台手机", "u0_a325"] },
	{ id: "node:phone-novus", aliases: ["phone-novus"] },
	{ id: "node:lan-28", aliases: ["192.168.3.28"] },
	// ── 项目 ──
	{ id: "proj:novus-glasses", aliases: ["novus-glasses", "novus glasses", "眼镜项目", "眼镜"] },
	{ id: "proj:novus", aliases: ["novus"] },
	{ id: "proj:tb4", aliases: ["tb4", "terminal-bench-4.0", "terminal-bench-4", "terminal-bench 4", "tbench4"] },
	{ id: "proj:tb-core", aliases: ["tb-core", "tbcore", "terminal-bench"] },
	{ id: "proj:freecad", aliases: ["freecad"] },
	{ id: "proj:harbor", aliases: ["harbor"] },
	{ id: "proj:coq", aliases: ["coq"] },
	{ id: "proj:ws-comm", aliases: ["ws-comm", "wscomm", "ws_daemon"] },
	{ id: "proj:astribot", aliases: ["astribot"] },
	{ id: "proj:archcad", aliases: ["archcad"] },
	{ id: "proj:kylin-membench", aliases: ["kylin-membench", "kylin", "membench"] },
	{ id: "proj:snaptools", aliases: ["snaptools.uk", "snaptools", "snaptool"] },
	{ id: "proj:qingshuichi", aliases: ["qingshuichi", "清水池"] },
	{ id: "proj:face26", aliases: ["face26"] },
	{ id: "proj:laya", aliases: ["laya-cascade", "laya-serve", "laya"] },
	{ id: "proj:rsiagent", aliases: ["rsiagent", "rsi-agent"] },
	{ id: "proj:fde-web", aliases: ["fde-web", "fde web", "fdeweb"] },
	{ id: "proj:terminus2", aliases: ["terminus-2", "terminus2"] },
	{ id: "proj:scrapeai", aliases: ["scrapeai"] },
	// ── 高频任务（TB4 跑批任务名）──
	{ id: "task:freecad-impeller", aliases: ["freecad-impeller", "impeller"] },
	{ id: "task:coq-block-bound", aliases: ["coq-block-bound"] },
	{ id: "task:cargo-flight-dispatch", aliases: ["cargo-flight-dispatch"] },
	{ id: "task:bun-sourcemap-leak", aliases: ["bun-sourcemap-leak"] },
	{ id: "task:glycan-ms2-elucidation", aliases: ["glycan-ms2-elucidation", "glycan-ms2"] },
	{ id: "task:music-harmony", aliases: ["music-harmony"] },
	// ── 人物/角色 ──
	{ id: "person:master", aliases: ["主人"] },
	// ── 舰队整体（主人高频说法）──
	{ id: "fleet:all", aliases: ["三机", "三台机器", "全部节点", "所有节点", "四节点", "舰队", "fleet"] },
];

const IPV4_RE = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g;
const IPV4_EXACT = /^(?:\d{1,3}\.){3}\d{1,3}$/; // 无 /g 标志：test() 无状态，避免 lastIndex 陷阱
/** 非实体 IP（回环/通配）——占位 span 但不产出实体 */
const SKIP_IPS = new Set(["127.0.0.1", "0.0.0.0"]);
/** 数字别名的数字上下文守卫：前后紧邻这些字符时不视为实体引用 */
const NUMERIC_GUARD = /[0-9.%]/;

// ── 编译期索引 ──

const IP_MAP = new Map<string, string>();
for (const def of ENTITY_DEFS) {
	for (const alias of def.aliases) {
		if (IPV4_EXACT.test(alias)) IP_MAP.set(alias, def.id);
	}
}

interface CompiledAlias { alias: string; id: string; cjk: boolean; numeric: boolean }
const ALIAS_SORTED: CompiledAlias[] = ENTITY_DEFS.flatMap(def =>
	def.aliases
		.filter(a => !IP_MAP.has(a)) // IP 别名走 IP 通道，避免重复
		.map(alias => ({
			alias: alias.toLowerCase(),
			id: def.id,
			cjk: /[\u4e00-\u9fff]/.test(alias),
			numeric: /^\d+$/.test(alias),
		}))
).sort((a, b) => b.alias.length - a.alias.length); // 最长优先

function wordBoundary(lower: string, start: number, end: number): boolean {
	const before = start > 0 ? lower[start - 1] : "";
	const after = end < lower.length ? lower[end] : "";
	// ASCII 别名要求两侧不是字母数字（'-'/'_'/'/'/'.' 等算边界，故 tb4 命中 tb4-serial）
	if (before && /[a-z0-9]/.test(before)) return false;
	if (after && /[a-z0-9]/.test(after)) return false;
	return true;
}

/**
 * 从文本抽取规范化实体 id（去重、上限 12 个）
 * 未知 IP 归一为 ip:<addr>，保持可检索性
 */
export function extractEntities(text: string): string[] {
	if (!text) return [];
	const lower = text.toLowerCase();
	const claimed: Array<[number, number]> = [];
	const found: string[] = [];
	const overlaps = (s: number, e: number) => claimed.some(([cs, ce]) => s < ce && e > cs);
	const claim = (s: number, e: number) => { claimed.push([s, e]); };
	const add = (id: string) => { if (!found.includes(id) && found.length < 12) found.push(id); };

	// 1) IP 先行（精确、最长形态）
	for (const m of lower.matchAll(IPV4_RE)) {
		const ip = m[0];
		const s = m.index!, e = s + ip.length;
		claim(s, e);
		if (SKIP_IPS.has(ip)) continue;
		add(IP_MAP.get(ip) ?? `ip:${ip}`);
	}

	// 2) 词典别名（最长优先 + span 重叠保护 + 词边界 + 数字守卫）
	for (const { alias, id, cjk, numeric } of ALIAS_SORTED) {
		let from = 0;
		for (;;) {
			const idx = lower.indexOf(alias, from);
			if (idx < 0) break;
			from = idx + 1;
			const end = idx + alias.length;
			if (overlaps(idx, end)) continue;
			if (!cjk && !wordBoundary(lower, idx, end)) continue;
			if (numeric) {
				const before = idx > 0 ? lower[idx - 1] : "";
				const after = end < lower.length ? lower[end] : "";
				if (NUMERIC_GUARD.test(before) || NUMERIC_GUARD.test(after)) continue;
			}
			add(id);
			claim(idx, end);
		}
	}

	return found;
}

/** 规范化查询传入的实体 id：接受完整 id 或别名，统一映射到规范 id */
export function normalizeEntities(input: string[]): string[] {
	const out: string[] = [];
	for (const raw of input) {
		const s = raw.trim().toLowerCase();
		if (!s) continue;
		const byId = ENTITY_DEFS.find(d => d.id === s);
		if (byId) { if (!out.includes(byId.id)) out.push(byId.id); continue; }
		const byAlias = ALIAS_SORTED.find(a => a.alias === s);
		if (byAlias) { if (!out.includes(byAlias.id)) out.push(byAlias.id); continue; }
		if (!out.includes(s)) out.push(s); // 未知 id（如 ip:x）原样保留
	}
	return out.slice(0, 12);
}
