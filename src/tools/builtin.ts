import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createCodingTools, createFindTool, createGrepTool } from "@earendil-works/pi-coding-agent";

/**
 * The 6 essential built-in tools for self-evolution:
 * read, write, edit, bash, grep, find
 */
export function createBuiltinTools(cwd: string): AgentTool<any>[] {
	return [...createCodingTools(cwd), createGrepTool(cwd), createFindTool(cwd)];
}
