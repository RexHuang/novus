/**
 * session-buffer — 交互界面同步缓冲区
 *
 * 原理：交互界面（聊天/终端）显示什么，这个文件就记录什么。
 * 约50行，滚动保留最近内容。
 * 
 * 当界面被大量输出淹没时，`session-buffer` 可以还原界面内容。
 *
 * 用法：
 *   import { buf } from "./session-buffer.ts";
 *   buf(">>> 执行任务: xxx");
 *   buf(rawOutput);
 *   buf("<<< 完成");
 *   // 文件里就是界面看到的完整内容
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

const BUF_FILE = join(homedir(), ".novus", "session-buffer.txt");
const SIGNAL_FILE = join(homedir(), ".novus", "watchdog-signal.txt");
const MAX_LINES = 500;

/**
 * watchdog 信号专用通道（不受 NOVUS_DAEMON gate 影响）。
 * 背景：buf() 在 daemon 模式下被静默吞掉，导致 [CONNECTION_ERROR]
 * 标记写不进 buffer，watchdog 断链。信号走独立文件，永远可靠。
 */
export function watchdogSignal(detail: string): void {
  ensureDir();
  writeFileSync(SIGNAL_FILE, `${Date.now()}\n${detail}`, "utf-8");
}

/** 读取并删除 watchdog 信号（原子取走，防重复触发） */
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

/** 清除 watchdog 信号（新 turn 开始时防陈旧误触发） */
export function clearWatchdogSignal(): void {
  try { if (existsSync(SIGNAL_FILE)) rmSync(SIGNAL_FILE); } catch { /* ignore */ }
}

function ensureDir(): void {
  const dir = join(homedir(), ".novus");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** 
 * 向同步缓冲区写入一行/多行内容。
 * 文件始终保持最新的 MAX_LINES 行。
 * 每次写入自动 trim 旧行。
 */
export function buf(...lines: string[]): void {
  if (process.env.NOVUS_DAEMON === '1') return;
  ensureDir();

  const d = new Date();
  const now = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  let content = "";

  // 读取已有内容
  if (existsSync(BUF_FILE)) {
    content = readFileSync(BUF_FILE, "utf-8");
  }
  const existingLines = content.split("\n").filter(l => l.length > 0);

  // 追加新行，每行加时间戳前缀
  const newLines: string[] = [];
  for (const line of lines) {
    for (const subLine of line.split("\n")) {
      if (subLine.length > 0) {
        newLines.push(`[${now}] ${subLine}`);
      }
    }
  }

  // 合并并裁剪到 MAX_LINES
  const all = [...existingLines, ...newLines];
  const trimmed = all.slice(-MAX_LINES);

  writeFileSync(BUF_FILE, trimmed.join("\n") + "\n", "utf-8");
}

/** 读取整个缓冲区内容 */
export function readBuffer(): string {
  if (!existsSync(BUF_FILE)) return "";
  const content = readFileSync(BUF_FILE, "utf-8");
  return content.trim().length === 0 ? "" : content;
}

/** 清空缓冲区 */
export function clearBuffer(): void {
  ensureDir();
  writeFileSync(BUF_FILE, "", "utf-8");
}

/** 清空内存中的行数组（用于进程生命周期内重置） */
export function bufClear(): void {
  clearBuffer();
}

/** 获取行数 */
export function bufferLines(): number {
  if (!existsSync(BUF_FILE)) return 0;
  return readFileSync(BUF_FILE, "utf-8").split("\n").filter(l => l.length > 0).length;
}

/**
 * 从终端屏幕字符缓冲区获取所有可见文本。
 * 
 * 原理：通过 ANSI escape sequence 请求终端回传当前屏幕内容。
 * - 发送 \x1b[2J\x1b[H 清屏（先不动，避免破坏显示）
 * - 发送 \x1b[?1049h 切到 alternate screen 后读回，再 \x1b[?1049l 切回
 * - 更简洁的方案：用 \x1b[9999;1H (光标移到最后一行首)，然后通过
 *   /dev/tty + 适当的 ioctl 读取 screen
 *
 * 实际实现：用 tty-recorder 或直接读 /dev/tty 的 scrollback。
 * 兼容方案：读整个终端的 scrollback buffer（如果支持的的话）。
 * 
 * fallback：如果终端不支持，返回 session-buffer.txt 的完整内容。
 */
export function readScreenBuffer(): string {
  // 方法1：尝试通过 tput 或 stty 获取终端尺寸，然后用特殊序列读取
  // 终端回传内容的方案在大多数现代终端（xterm、kitty、alacritty）中支持
  
  if (!process.stdout.isTTY && !process.stderr.isTTY) {
    return readBuffer(); // fallback 到 session-buffer
  }

  try {
    // 获取终端尺寸
    const cols = parseInt(execSync('tput cols 2>/dev/null', { encoding: 'utf-8' }).trim()) || 80;
    const lines = parseInt(execSync('tput lines 2>/dev/null', { encoding: 'utf-8' }).trim()) || 24;
    
    // 方法：用 screen/tmux capture，或者直接读 pty
    // 最通用的方法：读取当前终端的 scrollback
    // 对于大多数终端模拟器，可以通过 xterm 的 XTWINOPS 扩展获取
    
    // 尝试用 `screen -X hardcopy` 如果在 screen session 中
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
    
    // 尝试用 tmux capture-pane 如果在 tmux session 中
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
    
    // fallback: 读 session-buffer.txt 的完整内容
    return readBuffer();
    
  } catch {
    return readBuffer();
  }
}

/**
 * 从 /dev/tty 直接读取终端原始内容。
 * 用于更底层的屏幕缓冲区访问。
 */
export function readTtyRaw(): string {
  try {
    if (!existsSync('/dev/tty')) {
      return '[No /dev/tty accessible]';
    }
    // 读取终端当前可见区域 — 通过 ANSI DSR (Device Status Report)
    // 这个方法不需要 screen/tmux，直接与终端通信
    const result = execSync(
      'printf "\x1b[6n" > /dev/tty 2>/dev/null; sleep 0.01; timeout 0.1 cat /dev/tty 2>/dev/null || true',
      { encoding: 'utf-8', timeout: 2000 }
    );
    return result || '[No response from terminal]';
  } catch {
    return '[Failed to read /dev/tty]';
  }
}
