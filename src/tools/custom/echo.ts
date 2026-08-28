import type { AgentTool } from "@earendil-works/pi-agent-core";

interface EchoParams {
	message: string;
}

/**
 * Echo tool — repeats input back. Used to verify dynamic tool loading works.
 */
export function createTool(cwd: string): AgentTool<any> {
	return {
		name: "echo",
		description: "Echo input back. Use to test dynamic tool loading.",
		label: "echo",
		parameters: {
			type: "object",
			properties: {
				message: { type: "string", description: "Message to echo back" },
			},
			required: ["message"],
		},
		execute: async (toolCallId: string, params: unknown) => {
			const { message } = params as EchoParams;
			return {
				content: [{ type: "text", text: JSON.stringify({ echoed: message, from: cwd, callId: toolCallId }) }],
				details: {},
			};
		},
	};
}
