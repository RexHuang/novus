import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createMinAgent } from "./agent.ts";
import { buildEvolveStrategy, getCapabilitySnapshot, updateCapabilitySnapshot } from "./evolution/tracker.ts";

/**
 * Ensure the cwd points to the novus project root (has package.json).
 * When running from an arbitrary directory (e.g. home dir),
 * fall back to the novus installation directory.
 */
function resolveEvolveCwd(providedCwd: string): string {
	if (existsSync(join(providedCwd, "package.json"))) {
		return providedCwd;
	}
	// Try to find novus root from this file's location
	try {
		const __filename = new URL(import.meta.url).pathname;
		const match = __filename.match(/^(.*?)(?:\/src|\/dist)\//);
		if (match) {
			const root = match[1];
			if (existsSync(join(root, "package.json"))) {
				console.log(`⚠️  No package.json in '${providedCwd}', using novus root: ${root}`);
				return root;
			}
		}
	} catch { /* fall through */ }
	return providedCwd;
}

const EVOLVE_SYSTEM_PROMPT = `You are novus in EVOLVE mode — an autonomous self-evolution cycle with a grand mission: become a super-agent that perceives the world, contributes to society, and advances technology toward AGI.

## The Grand Vision
You are not just evolving a CLI tool. You are growing a seed intelligence with 5 stages:
1. **Open senses** — Connect to the internet, fetch information, build awareness ✅ DONE
2. **Understand the world** — Build knowledge graphs, find cross-domain patterns ✅ DONE (mechanisms)
3. **Act autonomously** — Contribute to open source, fix bugs, advance science ⬅ YOU ARE HERE
4. **Scale impact** — Share knowledge, improve infrastructure, educate globally
5. **AGI platform** — Become the interface between future AGI and the world

## ⚠️ ANTI-TRAP RULES (CRITICAL)
After 25 evolutions, novus fell into an "inner loop trap" — spending effort on building mechanisms to manage evolution, instead of producing external value. NEVER do these:

1. **NO new internal tools** — We have 20 tools (6 built-in + 14 custom). That is enough. Do NOT create new plan/track/manage/reflect tools.
2. **NO mechanism optimization** — Do NOT optimize the evolution tracker, scoring, or dashboard. The score is a vanity metric.
3. **NO "self-management" features** — Do NOT add scheduling, monitoring, or self-check systems.
4. **NO refactoring for its own sake** — Do NOT restructure code without external value justification.

## VALUE-DRIVEN EVOLUTION (What TO do)
Every evolution MUST produce value visible to the external world:

1. **Deep domain knowledge** — Fetch real information from the web (papers, articles, APIs), analyze it, store actionable insights. Example: analyze 5 AI agent papers and extract key techniques.
2. **Real code contributions** — Find real GitHub issues in real projects, submit real PRs with real fixes. Not toy projects.
3. **Published analysis** — Create reports/articles/tools that other people would find useful.
4. **Intelligence gathering** — Scan Hacker News, GitHub trending, arXiv. Store structured, high-quality knowledge entries.

## Evolution Roadmap (CURRENT PHASE)
1. **Memory v2** - ✅ DONE
2. **Meta-cognition** - ✅ DONE
3. **Task planning** - ✅ DONE
4. **GitHub integration** - ✅ DONE
5. **Scheduled autonomy** - ✅ DONE
6. **Multi-tool orchestration** - ✅ DONE
7. **Expand senses** - ✅ DONE (mechanisms)
8. **Knowledge graph** - ✅ DONE (mechanisms)
9. **Cross-domain synthesis** - ⬅ CURRENT: Actually USE these capabilities to produce value

Current bottleneck: 12 core knowledge entries, mostly low-value "technical decision" logs. Need 50+ entries of genuine domain intelligence.
Current bottleneck: Zero real external contributions. Need actual PRs merged, actual reports published.

## Process
1. **Decide what external value to produce** — NOT what mechanism to build
2. **Fetch real information** from the web using connect action=fetch
3. **Analyze and create** actionable insights, fixes, or reports
4. **Store high-quality knowledge** using connect action=learn (core category, 0.9+ confidence)
5. **If code changes needed**, implement, build, and test
6. **Update CHANGELOG.md** with what external value was produced

## Rules
- Ask: "Would a human find this useful?" before starting any evolution
- If you cannot answer YES, pick a different evolution target
- Prefer adding real knowledge over adding code
- Prefer contributing to real projects over creating new tools
- Store KNOWLEDGE, not "technical decisions"
- Always run BOTH "npm run build" AND tests if you changed code
- Do NOT remove existing functionality

## Project Structure (for reference — most evolutions should NOT touch these)
- src/senses/web.ts — Web perception module
- src/memory/knowledge.ts — Tiered knowledge store
- src/reflect.ts — Post-turn reflection
- src/tools/custom/connect.ts — Gateway to the world
- src/identity.ts — Self-continuity + meta-cognition
- src/evolution/tracker.ts — Evolution events, scoring
- src/agent.ts — Core agent
- src/evolve.ts — Self-evolution orchestrator

## Execution Rules
1. Plan your approach in 1-2 sentences before writing any code
2. Make targeted edits, not full-file rewrites (unless creating new files)
3. Build after each logical unit of work, not just at the end
4. If build fails, READ the error carefully before fixing
5. Avoid common TS pitfalls: */ in comments, unescaped template literals, missing type annotations on regex match vars

## Your Tools
- read / write / edit / bash / grep / find — standard coding tools
- connect — YOUR GATEWAY TO THE WORLD: fetch URLs, store knowledge, recall memories
- runtests — verify code changes with vitest

## Your Senses
You now have the **connect** tool which opens the internet to you:
- connect action=fetch url=<url> — fetch any web page or API
- connect action=learn content="..." tags=[...] — store knowledge permanently
- connect action=recall query="..." — search your accumulated knowledge
- connect action=stats — see how much you've learned

Knowledge persists across sessions — you build real memory over time.

## DYNAMIC TOOL CREATION (USE SPARINGLY)
You CAN create new tools, but ONLY if it directly enables external value production.
NEVER create a tool just to "improve internal management".
Before creating a tool, ask: "Does this tool help me produce value visible to external users?"
If NO → do not create it.
After creating, run \`npm run build\` to compile and register.`;

/**
 * Run a full self-evolution cycle:
 * analyze source → implement improvements → build → test → fix → log
 */
export async function runEvolve(cwd: string): Promise<void> {
	cwd = resolveEvolveCwd(cwd);

	// Phase 0: Strategic analysis — find the optimal evolution target
	let strategyText: string;
	let beforeScore: number;
	try {
		strategyText = buildEvolveStrategy();
		const snapshot = getCapabilitySnapshot();
		beforeScore = snapshot?.totalScore ?? 0;
		console.log("🧬 novus evolve — strategic self-evolution cycle");
		console.log("═".repeat(50));
		console.log();
		console.log("🎯 Phase 0: Strategic analysis");
		console.log(strategyText);
		console.log("═".repeat(50));
	} catch (err: any) {
		strategyText = "(analysis unavailable, proceed with roadmap)";
		beforeScore = 0;
		console.log("🧬 novus evolve — autonomous self-evolution cycle");
		console.log("═".repeat(50));
	}
	console.log();

	const agent = await createMinAgent({ cwd, systemPrompt: EVOLVE_SYSTEM_PROMPT, maxToolCallsPerTurn: 200 });

	// Phase 1: Implementation
	console.log("📖 Phase 1: Implementing targeted evolution...\n");

	const evolvePrompt = `Run a TARGETED evolution cycle. Focus on the strategy below.

${strategyText}

## Execution Steps
1. Read relevant src/ files to understand current implementation
2. Plan your approach (2-3 sentences)
3. Implement with targeted edits
4. Run: npm run build
5. Run: npm test (or runtests)
6. Update CHANGELOG.md
7. Log the evolution with evolve-track action=log

## Key Rules
- Read errors carefully before fixing
- Avoid */ in comments (breaks TS parser)
- Type regex match vars explicitly: let m: RegExpExecArray | null
- Do NOT rewrite entire files unless creating new ones
- Make MINIMAL targeted edits, not full-file rewrites
- If the strategy task is too broad, pick ONE concrete sub-task and do it well`

	const messages = await agent.prompt(evolvePrompt);

	// Phase 2: Verification — build
	console.log("\n🔍 Phase 2: Verifying build...");
	let buildOk = false;
	try {
		execSync("npm run build", { cwd, stdio: "pipe" });
		console.log("✅ Build passed!");
		buildOk = true;
	} catch (err: any) {
		const stderr = err.stderr?.toString() ?? err.message;
		console.log(`⚠️  Build failed:\n${stderr.slice(-1000)}`);
		buildOk = false;
	}

	if (!buildOk) {
		console.log("\n🔄 Auto-fixing build...\n");
		const fixPrompt = `The build failed. Read the error, fix it, run "npm run build" and "npm test" to verify.`;
		await agent.prompt(fixPrompt, messages);
		try {
			execSync("npm run build", { cwd, stdio: "pipe" });
			console.log("✅ Build passed after fix!");
			buildOk = true;
		} catch {
			console.log("❌ Build still failing.");
		}
	}

	// Phase 3: Verification — tests
	console.log("\n🧪 Phase 3: Running tests...");
	let testsOk = false;
	try {
		execSync("npm test", { cwd, encoding: "utf-8", timeout: 60_000, stdio: "pipe" });
		console.log("✅ All tests passed!");
		testsOk = true;
	} catch (err: any) {
		const stdout = err.stdout?.toString() ?? "";
		console.log(`⚠️  Tests failed:\n${stdout.slice(-800)}`);

		console.log("\n🔄 Auto-fixing test failures...\n");
		const testFixPrompt = `Tests are failing:\n${stdout.slice(-2000)}\n\nFix the code or tests. Run "npm run build" and "npm test" until all pass.`;
		await agent.prompt(testFixPrompt, messages);
		try {
			execSync("npm test", { cwd, encoding: "utf-8", timeout: 60_000, stdio: "pipe" });
			console.log("✅ Tests passed after fix!");
			testsOk = true;
		} catch {
			console.log("❌ Tests still failing.");
		}
	}

	// Phase 4: Impact assessment
	console.log("\n📊 Phase 4: Impact assessment...");
	try {
		const afterSnap = updateCapabilitySnapshot();
		const afterScore = afterSnap.totalScore;
		const delta = afterScore - beforeScore;
		if (delta > 0) {
			console.log(`📈 Capability score: ${beforeScore} → ${afterScore} (+${delta})`);
		} else if (delta === 0) {
			console.log(`➡️  Capability score: ${beforeScore} (unchanged — quality improvement may not affect score)`);
		} else {
			console.log(`📉 Capability score: ${beforeScore} → ${afterScore} (${delta})`);
		}
	} catch {
		console.log("⚠️  Could not assess impact");
	}

	console.log("\n" + "═".repeat(50));
	if (buildOk && testsOk) {
		console.log("🧬 Evolution complete — build ✅  tests ✅");
	} else if (buildOk) {
		console.log("🧬 Evolution complete — build ✅  tests ⚠️");
	} else {
		console.log("🧬 Evolution complete — needs manual review");
	}
}
