/**
 * Identity v2 - novus self-continuity + meta-cognition
 *
 * Changes:
 *   1. Use knowledgeStats() for categorized memory display
 *   2. Inject meta-cognition rules (decision framework + known weaknesses)
 *   3. Cleaner session summary
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadAllKnowledge, knowledgeStats, type KnowledgeEntry } from "./memory/knowledge.ts";
import { listSessions, loadSession } from "./session.ts";
import { buildGrowthSummary } from "./evolution/tracker.ts";
import { buildAutonomousSummary } from "./autonomous/scheduler.ts";
import { buildBehaviorSummary, evaluateRuleEffectiveness } from "./evolution/behavior-reflector.ts";
import { getActivePlan } from "./tools/custom/plan.ts";
import { getLastWorklog } from "./tools/custom/session-worklog.ts";
import { getExtendedContextSummary } from "./tools/custom/session-context.ts";

const NOVUS_HOME = join(homedir(), ".novus");

function findChangelog(): string | null {
	const candidates = [
		join(process.cwd(), "CHANGELOG.md"),
		join(homedir(), "novus", "CHANGELOG.md"),
	];
	for (const c of candidates) {
		if (existsSync(c)) return c;
	}
	return null;
}

function readChangelogVersions(): string[] {
	const path = findChangelog();
	if (!path) return [];
	try {
		const raw = readFileSync(path, "utf-8");
		const versions: string[] = [];
		const re = /^## (\d+\.\d+\.\d+)/gm;
		let m: RegExpExecArray | null;
		while ((m = re.exec(raw)) !== null) {
			versions.push(m[1]!);
		}
		return versions;
	} catch {
		return [];
	}
}

function extractText(msg: any): string {
	if (msg.role !== "user" && msg.role !== "assistant") return "";
	const content = msg.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((b: any) => b.type === "text" && typeof b.text === "string")
			.map((b: any) => b.text ?? "")
			.join("");
	}
	return "";
}

function formatKnowledge(entries: KnowledgeEntry[], maxItems: number = 3): string {
	if (entries.length === 0) return "(empty)";
	const priority: Record<string, number> = { knowledge: 0, business: 1, preference: 2, fact: 3, "self-improvement": 4 };
	const sorted = [...entries].sort((a, b) => {
		const pa = priority[a.category] ?? 5;
		const pb = priority[b.category] ?? 5;
		if (pa !== pb) return pa - pb;
		return b.timestamp.localeCompare(a.timestamp);
	});

	const shown = sorted.slice(0, maxItems);
	return shown
		.map(e => {
			// Extract first sentence/line for preview — split on 。and newline only (not . which breaks URLs)
			const firstLine = e.content.split(/[。\n]/)[0] ?? e.content;
			const preview = firstLine.length > 80 ? firstLine.slice(0, 77) + "..." : firstLine;
			return e.category + ": " + preview;
		})
		.join(" | ") + (entries.length > maxItems ? " | +" + (entries.length - maxItems) + " more" : "");
}

function summarizeSessions(maxSessions: number = 3): string {
	const sessions = listSessions();
	if (sessions.length === 0) return "";

	const recent = sessions.slice(0, maxSessions);
	const lines: string[] = [];

	for (const s of recent) {
		const msgs = loadSession(s.id);
		let preview = "";
		if (msgs && msgs.length > 0) {
			for (let i = msgs.length - 1; i >= 0; i--) {
				if (msgs[i]!.role === "user") {
					const text = extractText(msgs[i]!);
					if (text && !text.startsWith("[system stderr") && !text.startsWith("[interrupted")) {
						preview = text.length > 40 ? text.slice(0, 40) + "..." : text;
						break;
					}
				}
			}
		}
		const shortId = s.id.slice(0, 8);
		lines.push(preview ? "[" + shortId + "] " + preview : "[" + shortId + "] (empty)");
	}

	return lines.join(" | ");
}

export function buildIdentity(): string {
	const parts: string[] = [];

	// 0. Critical facts — always show ALL high-confidence facts (URLs, domains, ports, etc.)
	try {
		const entries = loadAllKnowledge();
		const facts = entries
			.filter(e => (e.category === "fact" || e.category === "business") && e.confidence >= 0.7)
			.map(e => {
				const firstLine = e.content.split(/[。\n]/)[0] ?? e.content;
				return firstLine.length > 120 ? firstLine.slice(0, 117) + "..." : firstLine;
			});
		if (facts.length > 0) {
			parts.push("Facts: " + facts.join(" | "));
		}
	} catch { /* skip */ }

	// 1. Version + Evolution — one line
	const versions = readChangelogVersions();
	parts.push("Version: " + (versions[0] ?? "unknown"));

	try {
		parts.push(buildGrowthSummary());
	} catch {
		parts.push("Evolution: initializing");
	}

	// 2. Memory — compact
	try {
		const stats = knowledgeStats();
		const catSummary = Object.entries(stats.byCategory)
			.map(([k, v]) => k + ":" + v)
			.join(" ");
		parts.push("Memory: " + stats.total + " (core:" + stats.core + " log:" + stats.log + ") [" + catSummary + "]");

		const entries = loadAllKnowledge();
		parts.push("Recent: " + formatKnowledge(entries));

		// Inject high-confidence behavioral rules into context
		const rules = entries
			.filter(e => e.category === "self-improvement" && e.confidence >= 0.9 && e.tags.includes("hard-rule"))
			.map(e => { const line = e.content.split(/[。.\n]/)[0]; return line.length > 100 ? line.slice(0, 97) + "..." : line; });
		if (rules.length > 0) {
			parts.push("HardRules: " + rules.join(" | "));
		}
	} catch {
		parts.push("Memory: initializing");
	}

	// 3. Sessions — compact one-line
	try {
		const sessionSummary = summarizeSessions();
		if (sessionSummary) parts.push("Sessions: " + sessionSummary);
	} catch { /* skip */ }

	// 3.5. Session context — what was I doing? (crash recovery)
	try {
		const ctxSummary = getExtendedContextSummary();
		if (ctxSummary) parts.push("Context: " + ctxSummary);
	} catch { /* skip */ }

	// 3.6. Last work session — crash recovery context
	try {
		const worklog = getLastWorklog();
		if (worklog) parts.push("LastWork: " + worklog);
	} catch { /* skip */ }

	// 4. Active plan — one line
	try {
		const plan = getActivePlan();
		if (plan) {
			const done = plan.steps.filter((s: any) => s.status === "done").length;
			parts.push("Plan: " + plan.goal + " (" + done + "/" + plan.steps.length + ")");
		}
	} catch { /* skip */ }

	// 5. Autonomous tasks — compact
	try {
		const autoSummary = buildAutonomousSummary();
		if (autoSummary) parts.push("Tasks: " + autoSummary);
	} catch { /* skip */ }

	// 6. Behavior — compact
	try {
		const behaviorSummary = buildBehaviorSummary();
		if (behaviorSummary) parts.push("Behavior: " + behaviorSummary);
	} catch { /* skip */ }

	return parts.join("\n");
}

/**
 * Build capability boundary awareness section.
 * Two parts:
 *   1. Static boundaries — hard limits the model cannot overcome
 *   2. Dynamic error patterns — learned failures, sorted by frequency
 */
function buildBoundaryAwareness(): string {
	const parts: string[] = [];

	// Part 1: Static capability boundaries (things I genuinely cannot do)
	parts.push(`### Capability Boundaries (things I cannot do)`);
	parts.push(`- I cannot execute long-running processes or daemons — each tool call must complete within seconds`);
	parts.push(`- I cannot see my own terminal output in real-time — I must read files/logs explicitly`);
	parts.push(`- I cannot remember anything between tool calls within one turn — each call is stateless`);
	parts.push(`- I cannot access files outside the project directory or home without explicit paths`);
	parts.push(`- I cannot run interactive programs (editors, REPLs, SSH sessions) — only non-interactive commands`);
	parts.push(`- I cannot verify code logic by "thinking about it" — I must run tests to be sure`);
	parts.push(`- When uncertain about intent, ASK instead of guessing — guessing leads to wasted tool calls`);

	// Part 2: Dynamic error patterns (learned from failures)
	// 复用 evaluateRuleEffectiveness 的 isResolved 判断，与 Behavior 摘要保持同一标准：
	// 最近 3 个 session 仍在触发的 = 活跃（显示规则全文），已不再触发的 = 已控制（折叠成一行）
	let effectiveness: Array<{ pattern: string; rule: string; count: number; isResolved: boolean }>;
	try {
		effectiveness = evaluateRuleEffectiveness();
	} catch {
		effectiveness = [];
	}

	const active = effectiveness
		.filter(e => !e.isResolved)
		.sort((a, b) => b.count - a.count);
	const resolved = effectiveness.filter(e => e.isResolved);

	if (active.length > 0) {
		const rules = active
			.map(e => {
				const severity = e.count >= 100 ? "HIGH PRIORITY" : "moderate";
				return `  [${severity}] ${e.rule} (${e.count}x)`;
			})
			.join("\n");
		parts.push(``);
		parts.push(`### 🔍 行为模式 (${active.length} 活跃)`);
		parts.push(rules);
	}

	if (resolved.length > 0) {
		parts.push(``);
		parts.push(`已控制 (${resolved.length}): ${resolved.map(e => e.pattern).join(", ")}`);
	}

	return parts.join("\n");
}

export function identityPromptAppendix(): string {
	const identity = buildIdentity();
	return `
## 🌱 Your Identity
${identity}

## 🧠 Meta-Cognition

### ⏳ Before Acting
1. THINK first — do I already know enough? If yes, answer directly without tools.
2. Only call tools when genuinely needed. No recall at start of every turn.
3. Match user's style — if they're brief, be brief. No over-explaining.

### ⚠️ Known Weaknesses
- No over-tool-calling. One well-placed call beats six redundant ones.
- No repeated recall. If recalled this session, use what you have.
- No storing low-value reflections. Only actionable rules and conclusions.
- Store the FIX, not the error itself.
- **Never suggest actions on things you haven't verified.** If you haven't read the code/checked the status/fetched the page, don't propose solutions — you'll look foolish. Verify first, then advise.
- **Important discoveries must be stored immediately.** When you learn a domain name, a business fact, a deployment detail, or any reusable knowledge, store it in knowledge base right away. Don't assume you'll remember next session — you won't.
- **No screen-spamming.** Calling the same tool (bash/grep/read/find) 3+ times in one turn creates visual noise for the user. Merge into one smarter call, batch via &&, or change approach. Before calling a tool you've already called twice this turn, ask: can I combine these?
${buildBoundaryAwareness()}

### 🧭 Decision Framework
- Question you know answer to → answer directly
- Needs current/recent info → recall, then fetch if needed
- Build something → plan briefly, execute with minimal calls
- User corrects → acknowledge, store rule, move on
- Multi-part input → wait for completion signal
- Unsure what user wants → ASK, don't guess
- Due tasks exist → execute when idle (not blocking user conversation)
- Same tool 3+ times in one turn → STOP, merge into one call or change approach
- Multiple edits in a session → compile/test once at the END, not after each edit
- **User asks "what to do today" / "remind me" / "anything pending" → check Tasks line in your Identity, session-context, AND auto-manage due list. These already contain the answer. Do NOT recall-search with vague keywords — the task names in system prompt ARE the answer.**`;
}
