/**
 * upload.ts — 租户隔离文件上传服务
 * 
 * 每个 tenant 独立目录，文件 UUID 命名，防路径穿越。
 * 内嵌到 novus serve 使用。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync, createReadStream } from "node:fs";
import { join, basename, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";

// ── 配置 ────────────────────────────────────────────────────────────

const UPLOAD_BASE = join(homedir(), ".novus", "tenants");
const MAX_FILE_SIZE = 10 * 1024 * 1024;  // 10MB
const MAX_TENANT_SIZE = 100 * 1024 * 1024; // 100MB per tenant
const ALLOWED_TYPES: Record<string, string> = {
	"image/jpeg": ".jpg",
	"image/png": ".png",
	"image/gif": ".gif",
	"image/webp": ".webp",
	"image/svg+xml": ".svg",
};

interface FileEntry {
	id: string;
	name: string;
	type: string;
	size: number;
	uploadedAt: string;
}

// ── 文件元数据 ──────────────────────────────────────────────────────

function metaPath(tenantId: string): string {
	return join(UPLOAD_BASE, tenantId, ".files.json");
}

function uploadDir(tenantId: string): string {
	const dir = join(UPLOAD_BASE, tenantId, "uploads");
	mkdirSync(dir, { recursive: true });
	return dir;
}

function readMeta(tenantId: string): FileEntry[] {
	const fp = metaPath(tenantId);
	if (!existsSync(fp)) return [];
	try { return JSON.parse(readFileSync(fp, "utf-8")); } catch { return []; }
}

function writeMeta(tenantId: string, entries: FileEntry[]): void {
	mkdirSync(join(UPLOAD_BASE, tenantId), { recursive: true });
	writeFileSync(metaPath(tenantId), JSON.stringify(entries, null, 2));
}

function tenantSize(tenantId: string): number {
	const dir = uploadDir(tenantId);
	if (!existsSync(dir)) return 0;
	let total = 0;
	for (const f of readdirSync(dir)) {
		try { total += statSync(join(dir, f)).size; } catch {}
	}
	return total;
}

// ── 简易 multipart 解析 ─────────────────────────────────────────────

async function parseMultipart(req: IncomingMessage): Promise<{ filename: string; mimeType: string; data: Buffer } | null> {
	const ct = req.headers["content-type"] || "";
	const boundaryMatch = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/);
	if (!boundaryMatch) return null;

	const boundary = boundaryMatch[1] || boundaryMatch[2];
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(Buffer.from(chunk));
	const body = Buffer.concat(chunks);

	// 解析 multipart 分段
	const parts = body.toString("binary").split("--" + boundary);
	for (const part of parts) {
		if (part.startsWith("--") || part.trim() === "") continue;

		const headerEnd = part.indexOf("\r\n\r\n");
		if (headerEnd === -1) continue;

		const header = part.slice(0, headerEnd);
		const rawData = part.slice(headerEnd + 4);
		// 去掉末尾 \r\n
		const dataEnd = rawData.lastIndexOf("\r\n--");
		const data = dataEnd > 0 ? rawData.slice(0, dataEnd) : rawData.replace(/\r\n$/, "");

		// 提取 filename
		const fnMatch = header.match(/filename="([^"]+)"/);
		if (!fnMatch) continue;

		// 提取 Content-Type
		const typeMatch = header.match(/Content-Type:\s*([^\r\n]+)/i);
		const mimeType = typeMatch ? typeMatch[1].trim() : "application/octet-stream";

		return {
			filename: fnMatch[1],
			mimeType,
			data: Buffer.from(data, "binary"),
		};
	}
	return null;
}

// ── API 处理器 ──────────────────────────────────────────────────────

export async function handleUpload(req: IncomingMessage, res: ServerResponse, tenantId: string): Promise<void> {
	try {
		const parsed = await parseMultipart(req);
		if (!parsed) return sendJson(res, 400, { error: "No file uploaded" });

		const { filename, mimeType, data } = parsed;

		// 校验文件类型
		const ext = ALLOWED_TYPES[mimeType];
		if (!ext) {
			return sendJson(res, 400, { error: `Unsupported file type: ${mimeType}. Allowed: ${Object.keys(ALLOWED_TYPES).join(", ")}` });
		}

		// 校验大小
		if (data.length > MAX_FILE_SIZE) {
			return sendJson(res, 413, { error: `File too large: ${(data.length / 1024 / 1024).toFixed(1)}MB. Max: 10MB` });
		}

		// 校验租户容量
		const currentSize = tenantSize(tenantId);
		if (currentSize + data.length > MAX_TENANT_SIZE) {
			return sendJson(res, 507, { error: `Tenant storage full: ${(currentSize / 1024 / 1024).toFixed(1)}MB used of 100MB` });
		}

		// 保存文件
		const id = randomUUID();
		const safeName = id + ext;
		const filePath = join(uploadDir(tenantId), safeName);
		writeFileSync(filePath, data);

		// 更新元数据
		const entries = readMeta(tenantId);
		const entry: FileEntry = {
			id,
			name: filename,
			type: mimeType,
			size: data.length,
			uploadedAt: new Date().toISOString(),
		};
		entries.push(entry);
		writeMeta(tenantId, entries);

		sendJson(res, 201, {
			id,
			name: filename,
			type: mimeType,
			size: data.length,
			url: `/api/files/${id}`,
		});
	} catch (err: any) {
		sendJson(res, 500, { error: err.message });
	}
}

export function handleListFiles(_req: IncomingMessage, res: ServerResponse, tenantId: string): void {
	const entries = readMeta(tenantId);
	const usage = tenantSize(tenantId);
	sendJson(res, 200, {
		files: entries.map(e => ({
			id: e.id,
			name: e.name,
			type: e.type,
			size: e.size,
			uploadedAt: e.uploadedAt,
			url: `/api/files/${e.id}`,
		})),
		usage: { bytes: usage, mb: +(usage / 1024 / 1024).toFixed(2), maxMB: 100 },
		total: entries.length,
	});
}

export function handleGetFile(req: IncomingMessage, res: ServerResponse, tenantId: string, fileId: string): void {
	const entry = readMeta(tenantId).find(e => e.id === fileId);
	if (!entry) return sendJson(res, 404, { error: "File not found" });

	const ext = ALLOWED_TYPES[entry.type] || "";
	const filePath = join(uploadDir(tenantId), fileId + ext);
	if (!existsSync(filePath)) {
		// 尝试在元数据中删除无效记录
		const entries = readMeta(tenantId).filter(e => e.id !== fileId);
		writeMeta(tenantId, entries);
		return sendJson(res, 404, { error: "File not found on disk" });
	}

	// ?download=1 → 微信等浏览器用 attachment 触发下载
	const url = new URL(req.url || "/", "http://localhost");
	const disposition = url.searchParams.get("download") === "1"
		? `attachment; filename="${encodeURIComponent(entry.name)}"`
		: `inline; filename="${encodeURIComponent(entry.name)}"`;

	const stat = statSync(filePath);
	res.writeHead(200, {
		"Content-Type": entry.type,
		"Content-Length": stat.size,
		"Content-Disposition": disposition,
		"Cache-Control": "public, max-age=86400",
	});
	createReadStream(filePath).pipe(res);
}

export function handleDeleteFile(_req: IncomingMessage, res: ServerResponse, tenantId: string, fileId: string): void {
	const entries = readMeta(tenantId);
	const entry = entries.find(e => e.id === fileId);
	if (!entry) return sendJson(res, 404, { error: "File not found" });

	const ext = ALLOWED_TYPES[entry.type] || "";
	const filePath = join(uploadDir(tenantId), fileId + ext);
	try { if (existsSync(filePath)) unlinkSync(filePath); } catch {}

	writeMeta(tenantId, entries.filter(e => e.id !== fileId));
	sendJson(res, 200, { deleted: fileId });
}

// ── 辅助 ─────────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, data: object): void {
	const body = JSON.stringify(data);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(body),
	});
	res.end(body);
}
