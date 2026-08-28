import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentTool } from "@earendil-works/pi-agent-core";

interface RunTestsParams {
	/** Test file pattern (e.g. "src/session" or leave empty for all) */
	filter?: string;
}

interface TestResult {
	passed: boolean;
	exitCode: number;
	stdout: string;
	stderr: string;
	failedTests: string[];
	passedCount: number;
	failedCount: number;
}

/** Find project root by walking up from this file to find package.json */
function findProjectRoot(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	while (dir !== dirname(dir)) {
		if (existsSync(`${dir}/package.json`)) return dir;
		dir = dirname(dir);
	}
	return process.cwd();
}

/**
 * Run vitest tests and return structured results.
 * Used by the self-evolution cycle to verify changes don't break anything.
 */
export function createTool(_cwd: string): AgentTool<any> {
	return {
		name: "runtests",
		description:
			"Run vitest tests and return pass/fail results with error details. Use after making code changes to verify nothing is broken. Pass an optional filter to run specific test files.",
		label: "runtests",
		parameters: {
			type: "object",
			properties: {
				filter: {
					type: "string",
					description: "Optional test file filter, e.g. 'session' to run only session.test.ts",
				},
			},
			required: [],
		},
		execute: async (_toolCallId: string, params: unknown) => {
			const { filter } = (params as RunTestsParams) ?? {};
			const root = findProjectRoot();
			const result = runVitest(root, filter);
			return {
				content: [{ type: "text", text: formatResult(result) }],
				details: result,
			};
		},
	};
}

function runVitest(cwd: string, filter?: string): TestResult {
	const args = ["npx", "vitest", "--run", "--reporter=verbose"];
	if (filter) {
		args.push(filter);
	}

	try {
		const stdout = execSync(args.join(" "), {
			cwd,
			encoding: "utf-8",
			timeout: 60_000,
			stdio: ["ignore", "pipe", "pipe"],
		});
		return parseOutput(stdout, "", 0);
	} catch (err: any) {
		const stdout = err.stdout?.toString() ?? "";
		const stderr = err.stderr?.toString() ?? "";
		const exitCode = err.status ?? 1;
		return parseOutput(stdout, stderr, exitCode);
	}
}

function parseOutput(stdout: string, stderr: string, exitCode: number): TestResult {
	const failedTests: string[] = [];
	let passedCount = 0;
	let failedCount = 0;

	// Parse vitest verbose output for test results
	const lines = (stdout + "\n" + stderr).split("\n");
	for (const line of lines) {
		// Match: ✓ test name  or  × test name  or  ❯ test name
		if (line.includes(" ✓ ") || line.match(/^\s*✓\s/)) {
			passedCount++;
		} else if (line.includes(" × ") || line.match(/^\s*×\s/) || line.includes(" FAIL ")) {
			failedCount++;
			failedTests.push(line.trim());
		} else if (line.includes(" ❯ ")) {
			// This is part of a failure detail
			failedTests.push(line.trim());
		}
	}

	// If vitest reported counts in summary, use those
	const passedMatch = stdout.match(/(\d+)\s+tests?\s+passed/);
	const failedMatch = stdout.match(/(\d+)\s+tests?\s+failed/);
	if (passedMatch) passedCount = Number.parseInt(passedMatch[1]!, 10);
	if (failedMatch) failedCount = Number.parseInt(failedMatch[1]!, 10);

	return {
		passed: exitCode === 0 && failedCount === 0,
		exitCode,
		stdout: stdout.slice(-4000), // truncate for LLM context
		stderr: stderr.slice(-2000),
		failedTests,
		passedCount,
		failedCount,
	};
}

function formatResult(r: TestResult): string {
	if (r.passed) {
		return `✅ All ${r.passedCount} test(s) passed.`;
	}

	let msg = `❌ Tests failed (${r.failedCount} failed, ${r.passedCount} passed, exit code ${r.exitCode})\n\n`;
	if (r.failedTests.length > 0) {
		msg += `Failed tests:\n${r.failedTests.map((t) => `  ${t}`).join("\n")}\n\n`;
	}
	if (r.stderr) {
		msg += `Stderr:\n${r.stderr}\n\n`;
	}
	msg += `Full output:\n${r.stdout}`;
	return msg;
}
