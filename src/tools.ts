/**
 * Tool system entry point.
 *
 * Built-in tools: read, write, edit, bash, grep, find
 * Custom tools: dynamically loaded from src/tools/custom/
 *
 * To add a custom tool, create a .ts file in src/tools/custom/ that
 * exports `createTool(cwd: string): AgentTool<any>`.
 * Then run `npm run build` to compile and register it.
 */
export { createAllTools, listCustomToolFiles, TOOL_TEMPLATE } from "./tools/registry.ts";
