/**
 * session-buffer — interactive UI sync buffer
 *
 * Idea: whatever the interactive UI (chat/terminal) shows, this file records.
 * ~50 lines, rolling window of the latest content.
 * 
 * When the UI gets flooded by output, `session-buffer` can restore what was shown.
 *
 * Usage:
 *   import { buf } from "./session-buffer.ts";
 *   buf(">>> running task: xxx");
 *   buf(rawOutput);
 *   buf("<<< done");
 *   // the file now contains exactly what the UI showed
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

const BUF_FILE = join(homedir(), ".novus", "session-buffer.txt");
const SIGNAL_FILE = join(homedir(), ".novus", "watchdog-signal.txt");
const MAX_LINES = 500;

/**
 * Dedicated channel for watchdog signals (not gated by NOVUS_DAEMON).
 * Background: buf() is silently swallowed in daemon mode, so [CONNECTION_ERROR]
 * markers never reached the buffer, breaking the watchdog chain. Signals go to a dedicated file — always reliable.
 */
export function watchdogSignal(detail: string): void {
  ensureDir();
  writeFileSync(SIGNAL_FILE, `${Date.now()}\n${detail}`, "utf-8");
}

/** Read and delete the watchdog signal (atomic take, prevents double-triggering) */
export function takeWatchdogSignal(): string | null {
  try {
    if (!existsSync(SIGNAL_FILE)) return null;
    const s = readFileSync(SIGNAL_FILE, "utf-8");
    rmSync(SIGNAL_FILE);
    return s.includes("\n") ? s.split("\n").slice(1).join("\n").trim() : s.trim() || null;
  } catch {
    return null;
  }
}

/** Clear the watchdog signal (prevents stale triggers at turn start) */
export function clearWatchdogSignal(): void {
  try { if (existsSync(SIGNAL_FILE)) rmSync(SIGNAL_FILE); } catch { /* ignore */ }
}

function ensureDir(): void {
  const dir = join(homedir(), ".novus");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** 
 * Write one or more lines to the sync buffer.
 * The file always keeps the latest MAX_LINES lines.
 * Old lines are trimmed automatically on each write.
 */
export function buf(...lines: string[]): void {
  if (process.env.NOVUS_DAEMON === '1') return;
  ensureDir();

  const d = new Date();
  const now = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  let content = "";

  // read existing content
  if (existsSync(BUF_FILE)) {
    content = readFileSync(BUF_FILE, "utf-8");
  }
  const existingLines = content.split("\n").filter(l => l.length > 0);

  // append new lines, each with a timestamp prefix
  const newLines: string[] = [];
  for (const line of lines) {
    for (const subLine of line.split("\n")) {
      if (subLine.length > 0) {
        newLines.push(`[${now}] ${subLine}`);
      }
    }
  }

  // merge and trim to MAX_LINES
  const all = [...existingLines, ...newLines];
  const trimmed = all.slice(-MAX_LINES);

  writeFileSync(BUF_FILE, trimmed.join("\n") + "\n", "utf-8");
}

/** Read the entire buffer */
export function readBuffer(): string {
  if (!existsSync(BUF_FILE)) return "";
  const content = readFileSync(BUF_FILE, "utf-8");
  return content.trim().length === 0 ? "" : content;
}

/** Clear the buffer */
export function clearBuffer(): void {
  ensureDir();
  writeFileSync(BUF_FILE, "", "utf-8");
}

/** Clear the in-memory line array (for in-process resets) */
export function bufClear(): void {
  clearBuffer();
}

/** Line count */
export function bufferLines(): number {
  if (!existsSync(BUF_FILE)) return 0;
  return readFileSync(BUF_FILE, "utf-8").split("\n").filter(l => l.length > 0).length;
}

/**
 * Get all visible text from the terminal screen buffer.
 * 
 * How: request the current screen contents from the terminal via ANSI escape sequences.
 * - send \x1b[2J\x1b[H to clear (not used initially, avoids breaking the display)
 * - send \x1b[?1049h to switch to the alternate screen, read back, then \x1b[?1049l to switch back
 * - simpler approach: use \x1b[9999;1H (cursor to last line start), then read
 *   the screen via /dev/tty + proper ioctls
 *
 * Actual implementation: tty-recorder or read /dev/tty scrollback directly.
 * Compatibility: read the whole terminal scrollback buffer (if supported).
 * 
 * fallback: if the terminal doesn't support it, return the full session-buffer.txt content.
 */
export function readScreenBuffer(): string {
  // method 1: get terminal size via tput/stty, then read via special sequences
  // screen readback is supported by most modern terminals (xterm, kitty, alacritty)
  
  if (!process.stdout.isTTY && !process.stderr.isTTY) {
    return readBuffer(); // fall back to session-buffer
  }

  try {
    // get terminal size
    const cols = parseInt(execSync('tput cols 2>/dev/null', { encoding: 'utf-8' }).trim()) || 80;
    const lines = parseInt(execSync('tput lines 2>/dev/null', { encoding: 'utf-8' }).trim()) || 24;
    
    // approach: screen/tmux capture, or read the pty directly
    // most portable: read the current terminal's scrollback
    // most terminal emulators support this via the xterm XTWINOPS extension
    
    // try `screen -X hardcopy` if inside a screen session
    try {
      const screenOutput = execSync('screen -X hardcopy /tmp/novus-screen.txt 2>/dev/null && cat /tmp/novus-screen.txt', {
        encoding: 'utf-8',
        timeout: 2000
      });
      if (screenOutput && screenOutput.trim().length > 0) {
        return screenOutput;
      }
    } catch {
      // not in screen session
    }
    
    // try tmux capture-pane if inside a tmux session
    try {
      const tmuxOutput = execSync('tmux capture-pane -p -S -3000 2>/dev/null', {
        encoding: 'utf-8',
        timeout: 2000
      });
      if (tmuxOutput && tmuxOutput.trim().length > 0) {
        return tmuxOutput;
      }
    } catch {
      // not in tmux session
    }
    
    // fallback: read the full session-buffer.txt content
    return readBuffer();
    
  } catch {
    return readBuffer();
  }
}

/**
 * Read raw terminal content directly from /dev/tty.
 * For lower-level screen buffer access.
 */
export function readTtyRaw(): string {
  try {
    if (!existsSync('/dev/tty')) {
      return '[No /dev/tty accessible]';
    }
    // read the current visible area — via ANSI DSR (Device Status Report)
    // this method needs no screen/tmux — talks to the terminal directly
    const result = execSync(
      'printf "\x1b[6n" > /dev/tty 2>/dev/null; sleep 0.01; timeout 0.1 cat /dev/tty 2>/dev/null || true',
      { encoding: 'utf-8', timeout: 2000 }
    );
    return result || '[No response from terminal]';
  } catch {
    return '[Failed to read /dev/tty]';
  }
}
