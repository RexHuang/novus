/**
 * Reflect v2 - high quality reflection module
 *
 * Key changes from v1:
 *   1. No more storing raw self-critique / user correction slices
 *   2. Extract improvement RULES from critiques, store as self-improvement
 *   3. Cleaner fact extraction
 *   4. No used-xx/topic-xx noise tags
 */

import { storeKnowledge, loadAllKnowledge, type KnowledgeCategory } from "./memory/knowledge.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Low-value content patterns that should be filtered before storing */
const LOW_VALUE_PATTERNS = [
  /^技术决策:\s*(好|决定|采用|使用|选择|改为|调整为|已完成|实现完成)\s/i,
  /^改进规则:\s*(.*)/,
  /^讨论要点:\s/i,
];

function isLowValueContent(content: string): boolean {
  return LOW_VALUE_PATTERNS.some(re => re.test(content));
}

function extractText(msg: AgentMessage): string {
	const c = (msg as any).content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) {
		return c.filter((b: any) => b.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("");
	}
	return "";
}

function extractToolArgs(msg: AgentMessage): string[] {
	const c = (msg as any).content;
	if (!Array.isArray(c)) return [];
	return c.filter((b: any) => b.type === "toolCall" && b.input).map((b: any) => JSON.stringify(b.input));
}

function isSystemNoise(text: string): boolean {
	return text.startsWith("[") && (text.includes("stderr") || text.includes("interrupted"));
}

// --- Improvement rule extraction ---

function extractImprovementRule(userTexts: string[], assistantTexts: string[]): { content: string; tags: string[] } | null {
	const hasCorrection = userTexts.some(t => /\u4e0d\u5bf9|\u4e0d\u662f\u8fd9\u6837|\u4e0d\u884c|\u6ca1\u505a\u5230|\u5e94\u8be5|\u4e0d\u8981|\u9519\u4e86|\u95ee\u9898\u5728\u4e8e/.test(t));
	const hasCritique = assistantTexts.some(t => /\u6211\u7684\u95ee\u9898|\u6211\u521a\u624d|\u6211\u592a|\u6211\u5fd8\u4e86|\u6211\u6ca1\u6709/.test(t));
	if (!hasCorrection && !hasCritique) return null;

	const last = assistantTexts[assistantTexts.length - 1] ?? "";
	const rules = [
		/\u4ee5\u540e|\u4e0b\u6b21|\u6211\u5e94\u8be5|\u8981(.{10,100})(?:\u3002|$)/g,
		/\u6539\u4e3a|\u8c03\u6574\u4e3a(.{10,100})(?:\u3002|$)/g,
	];
	for (const re of rules) {
		let m: RegExpExecArray | null;
		while ((m = re.exec(last)) !== null) {
			const rule = "\u6539\u8fdb\u89c4\u5219: " + m[1].trim();
			if (rule.length > 15 && rule.length < 200) return { content: rule, tags: ["improvement-rule"] };
		}
	}

	const correctionText = userTexts.find(t => /\u4e0d\u5bf9|\u4e0d\u8981|\u5e94\u8be5/.test(t));
	if (correctionText) {
		const core = correctionText.replace(/^(?:\u4f60\u8bf4\u5f97\u5bf9|\u5bf9\uff0c?)/, "").trim().slice(0, 150);
		if (core.length > 10) return { content: "\u6539\u8fdb\u89c4\u5219: " + core, tags: ["improvement-rule"] };
	}
	return null;
}

// --- Conclusion extraction ---

function extractConclusions(userTexts: string[], assistantTexts: string[]): Array<{ content: string; tags: string[]; category: KnowledgeCategory }> {
	const results: Array<{ content: string; tags: string[]; category: KnowledgeCategory }> = [];

	for (const text of assistantTexts) {
		if (text.length < 100) continue;

		// Structured sections with conclusion headings
		const sections = text.split(/^(?:##|\*\*)([^\n#*]+)(?:##|\*\*)?\s*$/m);
		for (let i = 1; i < sections.length; i += 2) {
			const heading = sections[i]!.trim();
			const body = (sections[i + 1] || "").trim();
			const isConclusion = /^(?:\u95ee\u9898|\u6839\u56e0|\u539f\u56e0|\u65b9\u6848|\u8ba1\u5212|\u7ed3\u8bba|\u603b\u7ed3|\u51b3\u5b9a|\u89e3\u51b3|\u4fee\u590d|\u6539\u8fdb|\u65b9\u5411|\u7b56\u7565|\u5206\u6790|\u8bca\u65ad|\u4f18\u5148\u7ea7)/.test(heading);
			if (!isConclusion || body.length < 30) continue;
			results.push({
				content: heading + ": " + body.slice(0, 400),
				tags: ["conclusion"],
				category: "knowledge",
			});
		}

		// Numbered lists with 3+ items — only extract if they contain decisions or rules
		const blocks = text.split(/\n\n/);
		for (const block of blocks) {
			const lines = block.trim().split("\n").filter(l => l.trim());
			if (lines.length < 3) continue;
			const listCount = lines.filter(l => /^\s*(?:\d+[.\u3001)\uff09]|[-*\u2022])\s/.test(l)).length;
			if (listCount < 3) continue;
			const c = block.trim().slice(0, 500);
			if (/^\u81ea\u6211\u6279\u5224|^\u6211\u521a\u624d|^\u6211\u7684\u95ee\u9898/.test(c)) continue;
			// Only store if the list contains decision/rule/action language (not just discussion)
			if (!/\u51b3\u5b9a|\u89c4\u5219|\u65b9\u6848|\u4efb\u52a1|\u5b9e\u73b0|\u4fee\u590d|\u7b56\u7565|\u539f\u5219/.test(c)) continue;
			results.push({ content: "\u7ed3\u8bba: " + c, tags: ["conclusion"], category: "knowledge" });
		}
	}
	return results;
}

// --- Fact extraction ---

function extractFacts(
	userTexts: string[],
	assistantTexts: string[],
	toolArgs: string[],
): Array<{ content: string; tags: string[]; category: KnowledgeCategory }> {
	const facts: Array<{ content: string; tags: string[]; category: KnowledgeCategory }> = [];
	const allText = [...userTexts, ...assistantTexts, ...toolArgs].join("\n");

	// IP addresses
	const ipRe = /(\d+\.\d+\.\d+\.\d+)/g;
	let m: RegExpExecArray | null;
	while ((m = ipRe.exec(allText)) !== null) {
		const ip = m[1]!;
		const label = "\u670d\u52a1\u5668IP: " + ip;
		if (!facts.some(f => f.content === label)) {
			facts.push({ content: label, tags: ["server"], category: "fact" });
		}
	}

	// SSH connections
	const sshRe = /sshpass.*ssh.*\s+(\w+)@(\d+\.\d+\.\d+\.\d+)/g;
	while ((m = sshRe.exec(allText)) !== null) {
		const label = "SSH\u8fde\u63a5: " + m[1] + "@" + m[2];
		if (!facts.some(f => f.content === label)) {
			facts.push({ content: label, tags: ["ssh"], category: "fact" });
		}
	}

	// Remote paths
	const pathRe = /(?:scp\s+.*\s+)?(\w+)@(\d+\.\d+\.\d+\.\d+):(\S+)/g;
	while ((m = pathRe.exec(allText)) !== null) {
		const label = "\u8fdc\u7a0b\u8def\u5f84: " + m[1] + "@" + m[2] + ":" + m[3];
		if (!facts.some(f => f.content === label)) {
			facts.push({ content: label, tags: ["deployment"], category: "fact" });
		}
	}

	// URLs
	const urlRe = /(https?:\/\/[\w.-]+[\w.\/-]*)/g;
	while ((m = urlRe.exec(allText)) !== null) {
		const url = m[1]!;
		if (/google\.com\/search|api\.anthropic\.com|localhost/.test(url)) continue;
		const label = "URL: " + url;
		if (!facts.some(f => f.content === label)) {
			facts.push({ content: label, tags: ["url"], category: "fact" });
		}
	}

	// Tech decisions — only high-value strategic decisions, not trivial implementation notes
	for (const text of assistantTexts) {
		const dm = text.match(/^(?:好，|决定|采用|使用|选择|改为|调整为|已完成|实现完成)(.+)/m);
		if (dm?.[1]) {
			const decision = dm[1].slice(0, 200);
			// Only store if it contains strategic keywords
			if (decision.length > 30 && /全局|架构|核心|策略|重大|关键|价值|方向|目标/.test(decision)) {
				const label = "技术决策: " + decision;
				if (!facts.some(f => f.content === label)) {
					facts.push({ content: label, tags: ["decision"], category: "knowledge" });
				}
			}
		}
	}
	// User preferences
	for (const text of userTexts) {
		if (/(?:\u4ee5\u540e|\u6bcf\u6b21|\u4e0b\u6b21|\u8bb0\u4f4f)(?:\u8981|\u5e94\u8be5|\u90fd)/.test(text)) {
			const pref = text.trim().slice(0, 200);
			const label = "\u7528\u6237\u4e60\u60ef: " + pref;
			if (!facts.some(f => f.tags.includes("preference") && f.content.slice(0, 50) === label.slice(0, 50))) {
				facts.push({ content: label, tags: ["preference"], category: "preference" });
			}
		}
	}

	return facts;
}

// --- Dedup ---

function tokenize(text: string): Set<string> {
	const lower = text.toLowerCase();
	const tokens = new Set<string>();
	const re = /[a-z0-9]+|[\u4e00-\u9fff]/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(lower)) !== null) {
		tokens.add(m[0]!);
	}
	return tokens;
}

function isDuplicate(content: string): boolean {
	const existing = loadAllKnowledge();
	if (existing.length === 0) return false;
	const newT = tokenize(content);
	if (newT.size === 0) return false;
	for (const e of existing) {
		const eT = tokenize(e.content);
		if (eT.size === 0) continue;
		let inter = 0;
		for (const t of newT) { if (eT.has(t)) inter++; }
		const union = newT.size + eT.size - inter;
		if (union > 0 && inter / union > 0.7) return true;
	}
	return false;
}

// --- Main ---

interface ReflectionItem {
	content: string;
	tags: string[];
	category: KnowledgeCategory;
	confidence: number;
}

export async function reflectAfterTurn(
	_sessionId: string,
	newMessages: AgentMessage[],
	_allMessages: AgentMessage[],
): Promise<void> {
	try {
		const userTexts: string[] = [];
		const assistantTexts: string[] = [];
		const toolArgs: string[] = [];

		for (const msg of newMessages) {
			if (msg.role === "user") {
				const t = extractText(msg);
				if (t && !isSystemNoise(t)) userTexts.push(t);
			} else if (msg.role === "assistant") {
				assistantTexts.push(extractText(msg));
				toolArgs.push(...extractToolArgs(msg));
			}
		}

		if (userTexts.length === 0) return;

		const items: ReflectionItem[] = [];

		// 1. Improvement rules (highest priority)
		const rule = extractImprovementRule(userTexts, assistantTexts);
		if (rule) {
			items.push({ ...rule, category: "self-improvement", confidence: 0.9 });
		}

		// 2. Conclusions
		const conclusions = extractConclusions(userTexts, assistantTexts);
		for (const c of conclusions) {
			items.push({ ...c, confidence: 0.85 });
		}

		// 3. Facts
		const facts = extractFacts(userTexts, assistantTexts, toolArgs);
		for (const f of facts) {
			items.push({ ...f, confidence: 0.85 });
		}

		// Store
		let stored = 0;
		for (const item of items) {
			if (isDuplicate(item.content)) continue;
			storeKnowledge({
				content: item.content,
				source: "reflect",
				category: item.category,
				tags: item.tags,
				confidence: item.confidence,
			});
			stored++;
		}

		if (stored > 0) {
			const cats = [...new Set(items.map(i => i.category))].join(", ");
			process.stderr.write("\x1b[90m🤔 +" + stored + " (" + cats + ")\x1b[0m\n");
		}
	} catch {
		// silent
	}
}
