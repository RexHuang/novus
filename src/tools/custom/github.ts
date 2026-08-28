/**
 * github — GitHub integration tool for novus.
 *
 * Actions:
 *   search-issues — Search for issues in a repo
 *   read-issue    — Get full issue details + comments
 *   list-repos    — List repos for a user/org
 *   search-repos  — Search GitHub repos by topic/keyword
 *   read-file     — Read a file from a GitHub repo (raw content)
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fetchUrl } from "../../senses/web.ts";

interface GithubParams {
	action: "search-issues" | "read-issue" | "list-repos" | "search-repos" | "read-file";
	/** repo owner/repo (e.g. "earendil-works/pi-agent-core") */
	repo?: string;
	/** issue number */
	issue?: number;
	/** GitHub username or org */
	user?: string;
	/** search query */
	query?: string;
	/** language filter for search-repos */
	language?: string;
	/** file path in repo */
	path?: string;
	/** git ref (branch/tag/commit) */
	ref?: string;
}

function text(t: string) {
	return { type: "text" as const, text: t };
}

const GITHUB_API = "https://api.github.com";

function ghHeaders(): Record<string, string> {
	const headers: Record<string, string> = {
		Accept: "application/vnd.github.v3+json",
		"User-Agent": "novus/0.2 (self-evolving agent)",
	};
	const token = process.env.GITHUB_TOKEN;
	if (token) {
		headers["Authorization"] = "Bearer " + token;
	}
	return headers;
}

function handleJson(result: any): { content: Array<{ type: "text"; text: string }>; details: any } {
	if (!result.ok) {
		return { content: [text("GitHub API error: " + result.text.slice(0, 500))], details: { error: result.text.slice(0, 500) } };
	}

	const body = result.body;
	if (typeof body === "object" && body !== null) {
		// Truncate for LLM context
		const preview = JSON.stringify(body, null, 2).slice(0, 12000);
		return { content: [text(preview)], details: body };
	}
	return { content: [text(String(body).slice(0, 12000))], details: body };
}

export function createTool(_cwd: string): AgentTool<any> {
	return {
		name: "github",
		description:
			"GitHub integration. Actions: search-issues, read-issue, list-repos, search-repos, read-file. Search and read GitHub issues, repos, and files.",
		label: "github",
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					description: "Action: search-issues, read-issue, list-repos, search-repos, read-file",
					enum: ["search-issues", "read-issue", "list-repos", "search-repos", "read-file"],
				},
				repo: { type: "string", description: "owner/repo (e.g. earendil-works/pi-agent-core)" },
				issue: { type: "number", description: "Issue number (for read-issue)" },
				user: { type: "string", description: "GitHub username or org (for list-repos)" },
				query: { type: "string", description: "Search query" },
				language: { type: "string", description: "Language filter (for search-repos)" },
				path: { type: "string", description: "File path in repo (for read-file)" },
				ref: { type: "string", description: "Git ref - branch/tag/commit (for read-file, default: main)" },
			},
			required: ["action"],
		},
		execute: async (_toolCallId: string, params: unknown) => {
			const p = params as GithubParams;
			const headers = ghHeaders();

			switch (p.action) {
				case "search-issues": {
					if (!p.repo || !p.query) {
						return { content: [text("Error: repo and query required for search-issues")], details: {} };
					}
					const url = GITHUB_API + "/search/issues?q=" + encodeURIComponent(p.query + " repo:" + p.repo);
					const result = await fetchUrl({ url, headers });
					return handleJson(result);
				}

				case "read-issue": {
					if (!p.repo || !p.issue) {
						return { content: [text("Error: repo and issue required for read-issue")], details: {} };
					}
					const url = GITHUB_API + "/repos/" + p.repo + "/issues/" + p.issue;
					const result = await fetchUrl({ url, headers });
					return handleJson(result);
				}

				case "list-repos": {
					if (!p.user) {
						return { content: [text("Error: user required for list-repos")], details: {} };
					}
					const url = GITHUB_API + "/users/" + p.user + "/repos?sort=updated&per_page=10";
					const result = await fetchUrl({ url, headers });
					return handleJson(result);
				}

				case "search-repos": {
					if (!p.query) {
						return { content: [text("Error: query required for search-repos")], details: {} };
					}
					let url = GITHUB_API + "/search/repositories?q=" + encodeURIComponent(p.query);
					if (p.language) url += "+language:" + encodeURIComponent(p.language);
					url += "&sort=stars&per_page=10";
					const result = await fetchUrl({ url, headers });
					return handleJson(result);
				}

				case "read-file": {
					if (!p.repo || !p.path) {
						return { content: [text("Error: repo and path required for read-file")], details: {} };
					}
					const ref = p.ref ?? "main";
					const url = "https://raw.githubusercontent.com/" + p.repo + "/" + ref + "/" + p.path;
					const result = await fetchUrl({ url, headers });
					if (!result.ok) {
						return { content: [text("File not found: " + url + " - " + result.text.slice(0, 200))], details: {} };
					}
					return {
						content: [text(String(result.body ?? result.text).slice(0, 12000))],
						details: { url, length: result.length },
					};
				}

				default:
					return { content: [text("Unknown action: " + p.action)], details: {} };
			}
		},
	};
}
