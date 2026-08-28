import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, openSync, readSync, fstatSync, closeSync, readFileSync, readdirSync, unlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

const SESSION_DIR = join(homedir(), ".novus", "sessions");

interface SessionHeader {
	type: "session";
	version: 1;
	id: string;
	timestamp: string;
	cwd: string;
}

interface MessageEntry {
	type: "message";
	id: string;
	parentId: string | null;
	timestamp: string;
	message: AgentMessage;
}

type SessionLine = SessionHeader | MessageEntry;

function ensureDir(): void {
	if (!existsSync(SESSION_DIR)) {
		mkdirSync(SESSION_DIR, { recursive: true });
	}
}

function sessionPath(id: string): string {
	return join(SESSION_DIR, `${id}.jsonl`);
}

function shortId(): string {
	return randomUUID().replace(/-/g, "").slice(0, 8);
}

/** Create a new session and return its ID. If `id` is provided, use it instead of generating a random UUID. */
export function createSession(cwd: string, id?: string): string {
	ensureDir();
	const sessionId = id ?? randomUUID();
	if (id && existsSync(sessionPath(sessionId))) {
		// Session with this ID already exists — return it as-is
		return sessionId;
	}
	const header: SessionHeader = {
		type: "session",
		version: 1,
		id: sessionId,
		timestamp: new Date().toISOString(),
		cwd,
	};
	appendFileSync(sessionPath(sessionId), JSON.stringify(header) + "\n", "utf-8");
	return sessionId;
}

/** Load messages from a session */
export function loadSession(sessionId: string): AgentMessage[] | null {
	const path = sessionPath(sessionId);
	if (!existsSync(path)) return null;

	const messages: AgentMessage[] = [];
	const raw = readFileSync(path, "utf-8");
	for (const line of raw.trim().split("\n")) {
		if (!line) continue;
		try {
			const entry = JSON.parse(line) as SessionLine;
			if (entry.type === "message") {
				messages.push(entry.message);
			}
		} catch {
			// skip malformed lines
		}
	}
	return messages;
}

/** Save new messages to a session */
export function saveMessages(sessionId: string, messages: AgentMessage[]): void {
	ensureDir();
	const parentId = getLastEntryId(sessionId);
	let prevId = parentId;

	for (const msg of messages) {
		const id = shortId();
		const entry: MessageEntry = {
			type: "message",
			id,
			parentId: prevId,
			timestamp: new Date().toISOString(),
			message: msg,
		};
		appendFileSync(sessionPath(sessionId), JSON.stringify(entry) + "\n", "utf-8");
		prevId = id;
	}
}

/** Get the last entry ID in a session, or null if none.
 *  Reads only the last ~4KB of the file to avoid loading large sessions. */
function getLastEntryId(sessionId: string): string | null {
	const path = sessionPath(sessionId);
	if (!existsSync(path)) return null;

	try {
		const fd = openSync(path, "r");
		try {
			const stat = fstatSync(fd);
			if (stat.size <= 0) { closeSync(fd); return null; }
			const tailSize = Math.min(stat.size, 4096);
			const offset = stat.size - tailSize;
			const buf = Buffer.alloc(tailSize);
			readSync(fd, buf, 0, tailSize, offset);
			closeSync(fd);
			const tail = buf.toString("utf-8");
			const lines = tail.split("\n");
			for (let i = lines.length - 1; i >= 0; i--) {
				const line = lines[i]!.trim();
				if (!line) continue;
				try {
					const entry = JSON.parse(line) as SessionLine;
					if (entry.type === "message") return entry.id;
				} catch { continue; }
			}
			return null;
		} catch {
			try { closeSync(fd); } catch {}
			return null;
		}
	} catch {
		// Fallback: read whole file
		const raw = readFileSync(path, "utf-8");
		const lines = raw.trim().split("\n");
		if (lines.length <= 1) return null;
		const lastLine = lines[lines.length - 1];
		if (!lastLine) return null;
		try {
			const entry = JSON.parse(lastLine) as MessageEntry;
			return entry.id;
		} catch { return null; }
	}
}

/** Check if a session exists */
export function sessionExists(sessionId: string): boolean {
	return existsSync(sessionPath(sessionId));
}

/** Delete a session by ID. Returns true if deleted. */
export function deleteSession(sessionId: string): boolean {
	const path = sessionPath(sessionId);
	if (!existsSync(path)) return false;
	unlinkSync(path);
	return true;
}

/** Metadata about a session */
export interface SessionMeta {
	id: string;
	timestamp: string;
	cwd: string;
	messageCount: number;
	path: string;
}

/** Get metadata for a single session */
export function getSessionMeta(sessionId: string): SessionMeta | null {
	const path = sessionPath(sessionId);
	if (!existsSync(path)) return null;

	const raw = readFileSync(path, "utf-8");
	const lines = raw.trim().split("\n");
	if (lines.length === 0) return null;

	const header = JSON.parse(lines[0]!) as SessionHeader;
	return {
		id: header.id,
		timestamp: header.timestamp,
		cwd: header.cwd,
		messageCount: lines.length - 1, // exclude header
		path,
	};
}

/** List all session IDs with metadata, most recent first.
 *  Reads header + counts lines for accurate message counts.
 */
export function listSessions(): SessionMeta[] {
	ensureDir();
	try {
		const files = readdirSync(SESSION_DIR)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(SESSION_DIR, f))
			.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

		const metas: SessionMeta[] = [];
		for (const file of files) {
			try {
				const stat = statSync(file);
				// Read only first 1KB to get the header
				const fd = openSync(file, "r");
				try {
					const buf = Buffer.alloc(Math.min(stat.size, 1024));
					readSync(fd, buf, 0, buf.length, 0);
					closeSync(fd);
					const firstLine = buf.toString("utf-8").split("\n")[0]!.trim();
					if (!firstLine) continue;
					const header = JSON.parse(firstLine) as SessionHeader;
					// Count newlines in file for accurate message count
					const countBuf = Buffer.alloc(Math.min(stat.size, 65536));
					const countFd = openSync(file, 'r');
					try {
						readSync(countFd, countBuf, 0, countBuf.length, 0);
					} finally {
						closeSync(countFd);
					}
					const lineCount = countBuf.toString("utf-8").split("\n").length - 1;
					const estimatedMessages = Math.max(0, lineCount - 1);
					metas.push({
						id: header.id,
						timestamp: header.timestamp,
						cwd: header.cwd,
						messageCount: estimatedMessages,
						path: file,
					});
				} catch {
					try { closeSync(fd); } catch {}
				}
			} catch {
				// skip
			}
		}
		return metas;
	} catch {
		return [];
	}
}

/** Get the most recent session ID, or null if none */
export function getLastSessionId(): string | null {
	const sessions = listSessions();
	return sessions.length > 0 ? sessions[0]!.id : null;
}

/** Extract text content from a user or assistant message. Returns "" for other roles. */
function extractText(msg: AgentMessage): string {
	if (msg.role !== "user" && msg.role !== "assistant") return "";
	const content = (msg as { content: string | Array<{ type: string; text?: string }> }).content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((block: { type: string; text?: string }) => block.type === "text" && typeof block.text === "string")
			.map((block: { type: string; text?: string }) => block.text ?? "")
			.join("");
	}
	return "";
}

/** Truncate text to a given max length, adding ellipsis if needed */
function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return text.slice(0, maxLen - 3) + "...";
}

export interface ConversationRound {
	user: string;
	assistant: string;
}

/**
 * Extract the last N conversation rounds (user+assistant pairs) from a session.
 * A "round" is one user message followed by the assistant's response.
 * Tool messages between them are ignored for display purposes.
 */
export function getLastRounds(sessionId: string, count: number = 1): ConversationRound[] {
	const messages = loadSession(sessionId);
	if (!messages || messages.length === 0) return [];

	// Build rounds: collect user messages and their following assistant responses
	const rounds: ConversationRound[] = [];
	let currentUser: string | null = null;

	for (const msg of messages) {
		if (msg.role === "user") {
			currentUser = extractText(msg);
		} else if (msg.role === "assistant" && currentUser !== null) {
			const text = extractText(msg);
			rounds.push({ user: currentUser, assistant: text });
			currentUser = null;
		}
	}

	// Remove empty rounds from the end (e.g. in-progress assistant turns with no text yet)
	while (rounds.length > 0 && !rounds[rounds.length - 1]!.assistant.trim()) {
		rounds.pop();
	}

	return rounds.slice(-count);
}

/**
 * Format conversation rounds for terminal display.
 * Shows role labels, truncated content, and a separator.
 */
export function formatConversationSummary(rounds: ConversationRound[], maxLineLen: number = 80): string {
	const lines: string[] = [];
	lines.push(`── Last ${rounds.length === 1 ? "conversation" : rounds.length + " conversations"} ──`);
	lines.push("");

	for (let i = 0; i < rounds.length; i++) {
		const round = rounds[i];
		if (rounds.length > 1) {
			lines.push(`[Round ${i + 1}]`);
		}
		lines.push(`  🧑 ${truncate(round.user, maxLineLen)}`);
		lines.push(`  🤖 ${truncate(round.assistant, maxLineLen)}`);
		if (i < rounds.length - 1) lines.push("");
	}

	lines.push("");
	lines.push("────────────────────────────────────────────────────────────────");
	return lines.join("\n");
}
