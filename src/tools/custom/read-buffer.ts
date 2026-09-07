/**
 * read-buffer — 查看会话缓冲区
 *
 * 交互界面（聊天/终端）显示的内容会同步写入 ~/.novus/session-buffer.txt。
 * 本工具让你能随时查看缓冲区内容，还原界面当时的状态。
 *
 * 用法：
 *   read-buffer         — 查看全文
 *   read-buffer clear   — 清空缓冲区
 *   read-buffer lines   — 只看行数
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { readBuffer, clearBuffer, bufferLines, readScreenBuffer } from "../../utils/session-buffer.ts";

export function createTool(cwd: string): AgentTool<any> {
  return {
    name: "session-buffer",
    description: "Use only when interactive output was truncated — restores the terminal buffer. Note: in daemon mode the buffer is always empty; use the read tool for files instead. Actions: read/clear/lines/screen/full.", 
    label: "session-buffer",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "action: read (default) / clear / lines / screen / full",
          enum: ["read", "clear", "lines", "screen", "full"],
        },
      },
      required: [],
    },
    execute: async (_toolCallId: string, params: unknown) => {
      const p = params as Record<string, string | undefined>;
      const action = p.action ?? "read";

      try {
        const EMPTY_HINT = "📭 Session buffer is empty — nothing to read. Use the read tool for files.";
        switch (action) {
          case "read": {
            const content = readBuffer();
            if (!content || content.trim().length === 0) {
              return { content: [{ type: "text", text: EMPTY_HINT }], details: {} };
            }
            const lines = content.split("\n").filter(l => l.length > 0);
            const numbered = lines.map((l, i) => `${String(i + 1).padStart(3, ' ')}| ${l}`).join("\n");
            return { content: [{ type: "text", text: numbered }], details: {} };
          }
          case "clear": {
            clearBuffer();
            return { content: [{ type: "text", text: "✅ Buffer cleared" }], details: {} };
          }
          case "lines": {
            const n = bufferLines();
            return { content: [{ type: "text", text: `Buffer has ${n} lines (50 shown max)` }], details: {} };
          }
          case "screen": {
            const content = readScreenBuffer();
            if (!content || content.trim().length === 0) {
              return { content: [{ type: "text", text: EMPTY_HINT }], details: {} };
            }
            return { content: [{ type: "text", text: content }], details: {} };
          }
          case "full": {
            const bufContent = readBuffer();
            const screenContent = readScreenBuffer();
            if ((!bufContent || bufContent.trim().length === 0) && (!screenContent || screenContent.trim().length === 0)) {
              return { content: [{ type: "text", text: EMPTY_HINT }], details: {} };
            }
            const combined = `=== Session Buffer (rolling log) ===\n${bufContent}\n\n=== Screen Buffer (terminal screen) ===\n${screenContent}`;
            return { content: [{ type: "text", text: combined }], details: {} };
          }
          default:
            return { content: [{ type: "text", text: `Unknown action: ${action}` }], details: {} };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${msg}` }], details: {} };
      }
    },
  };
}
