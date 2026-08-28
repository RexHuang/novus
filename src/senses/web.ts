/**
 * Web Perception Module — novus's first sense.
 *
 * Provides structured access to the internet:
 * - HTTP GET/POST with configurable headers
 * - Content type detection and parsing (JSON, HTML, text)
 * - Rate limiting and timeout safety
 * - Article extraction (boilerplate removal)
 * - RSS/Atom feed parsing
 */

export interface ExtractedArticle {
	title: string;
	author: string;
	publishedDate: string;
	siteName: string;
	textContent: string;
	wordCount: number;
	topImage?: string;
	description?: string;
}

export interface FeedEntry {
	title: string;
	link: string;
	publishedDate: string;
	author: string;
	summary: string;
	content: string;
}

export interface ParsedFeed {
	title: string;
	link: string;
	description: string;
	language: string;
	entries: FeedEntry[];
}

export interface FetchResult {
	ok: boolean;
	status: number;
	contentType: string;
	/** Parsed body (JSON parsed if applicable, otherwise text) */
	body: unknown;
	/** Raw text body (always available) */
	text: string;
	/** Response headers */
	headers: Record<string, string>;
	/** Request URL (may differ from input due to redirects) */
	finalUrl: string;
	/** Content length in bytes */
	length: number;
}

export interface FetchOptions {
	url: string;
	method?: "GET" | "POST" | "PUT" | "DELETE";
	headers?: Record<string, string>;
	body?: string;
	timeout?: number;
	/** Max response size in bytes (default 1MB) */
	maxBytes?: number;
	/** Max text length returned to LLM (default 200KB) */
	maxTextBytes?: number;
}

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_MAX_BYTES = 1_048_576; // 1MB
const DEFAULT_MAX_TEXT_BYTES = 200_000; // Truncate text for LLM context (was 50KB, now 200KB)
const MAX_RETRIES = 3; // Retry transient errors twice (total 4 attempts)
const RETRY_DELAY_MS = 1500;

// Rotating User-Agent pool — avoid bot detection
const UA_POOL = [
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
	"Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
	"Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1",
];
let _uaIndex = 0;
function nextUA(): string {
	const ua = UA_POOL[_uaIndex % UA_POOL.length];
	_uaIndex++;
	return ua;
}

/** Error types that are safe to retry */
function isRetryableError(err: any): boolean {
	const msg = err.message ?? "";
	const cause = err.cause?.message ?? err.cause?.code ?? "";
	return (
		msg.includes("ECONNRESET") || cause === "ECONNRESET" ||
		msg.includes("ETIMEDOUT") || cause === "ETIMEDOUT" ||
		msg.includes("ECONNREFUSED") || cause === "ECONNREFUSED" ||
		msg.includes("EPIPE") || cause === "EPIPE" ||
		msg.includes("429") ||
		msg.includes("503") || msg.includes("502")
	);
}

/**
 * Fetch a URL and return structured results.
 * Handles JSON parsing, content-type detection, and size limits.
 */
export async function fetchUrl(options: FetchOptions): Promise<FetchResult> {
	const { url, method = "GET", headers = {}, body, timeout = DEFAULT_TIMEOUT, maxBytes = DEFAULT_MAX_BYTES, maxTextBytes = DEFAULT_MAX_TEXT_BYTES } = options;

	let lastError: any;

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		if (attempt > 0) {
			// Exponential backoff before retry, with jitter
			const backoff = RETRY_DELAY_MS * attempt * (0.5 + Math.random());
			await new Promise(resolve => setTimeout(resolve, backoff));
		}

		const result = await fetchOnce(url, method, headers, body, timeout, maxBytes, maxTextBytes);

		// Success → return immediately
		if (result.ok) return result;

		// Last attempt → return whatever we got
		if (attempt >= MAX_RETRIES) return result;

		// Retry on server errors (5xx, 429)
		if (result.status >= 500 || result.status === 429) {
			lastError = result;
			continue;
		}

		// Retry on 403 — might be temporary block (Cloudflare challenge)
		if (result.status === 403) {
			lastError = result;
			continue;
		}

		// Retry on network errors (status 0)
		if (result.status === 0) {
			const errText = result.text;
			if (errText.includes("Timeout") || errText.includes("ECONNRESET") ||
				errText.includes("ETIMEDOUT") || errText.includes("ECONNREFUSED")) {
				lastError = result;
				continue;
			}
		}

		return result; // Non-retryable error, return immediately
	}

	return lastError!;
}

async function fetchOnce(
	url: string, method: string, headers: Record<string, string>,
	body: string | undefined, timeout: number, maxBytes: number, maxTextBytes: number
): Promise<FetchResult> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeout);

	try {
		const ua = typeof headers["User-Agent"] === "string" ? headers["User-Agent"] : nextUA();
		const fetchOptions: RequestInit = {
			method,
			headers: {
				"User-Agent": ua,
				Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
				"Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
				"Accept-Encoding": "gzip, deflate, br",
				"Cache-Control": "no-cache",
				Pragma: "no-cache",
				"Sec-Fetch-Dest": "document",
				"Sec-Fetch-Mode": "navigate",
				"Sec-Fetch-Site": "none",
				"Sec-Fetch-User": "?1",
				...headers,
			},
			signal: controller.signal,
			redirect: "follow",
		};

		if (body && method !== "GET") {
			fetchOptions.body = body;
		}

		const response = await fetch(url, fetchOptions);

		// Read with size limit
		const reader = response.body?.getReader();
		if (!reader) {
			return {
				ok: response.ok,
				status: response.status,
				contentType: response.headers.get("content-type") ?? "unknown",
				body: null,
				text: "",
				headers: headersToRecord(response.headers),
				finalUrl: response.url,
				length: 0,
			};
		}

		const chunks: Uint8Array[] = [];
		let totalSize = 0;

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			totalSize += value.length;
			if (totalSize > maxBytes) {
				// Take partial data but mark as truncated
				const remaining = maxBytes - (totalSize - value.length);
				if (remaining > 0) {
					chunks.push(value.slice(0, remaining));
				}
				reader.cancel();
				break;
			}
			chunks.push(value);
		}

		const fullBuffer = Buffer.concat(chunks);
		const text = new TextDecoder().decode(fullBuffer);
		const contentType = response.headers.get("content-type") ?? "";

		// Parse body based on content type
		let parsedBody: unknown = text;
		if (contentType.includes("application/json")) {
			try {
				parsedBody = JSON.parse(text);
			} catch {
				// Leave as text if JSON parsing fails
			}
		}

		// Detect JS-required / Cloudflare pages for warning
		const jsWarning = detectJsRequiredPage(text, contentType);

		return {
			ok: response.ok,
			status: response.status,
			contentType,
			body: parsedBody,
			text: (jsWarning ? jsWarning + "\n\n" : "") + text.slice(0, maxTextBytes),
			headers: headersToRecord(response.headers),
			finalUrl: response.url,
			length: totalSize,
		};
	} catch (err: any) {
		const errorMsg = diagnoseError(err, url);
		return {
			ok: false,
			status: 0,
			contentType: "error",
			body: null,
			text: errorMsg,
			headers: {},
			finalUrl: url,
			length: 0,
		};
	} finally {
		clearTimeout(timer);
	}
}

function diagnoseError(err: any, url: string): string {
	const msg = err.message ?? String(err);
	const name = err.name ?? "UnknownError";
	const cause = err.cause;
	const causeMsg = cause?.message ?? cause?.code ?? "";

	// Known error patterns
	if (name === "AbortError") {
		return `Timeout after ${DEFAULT_TIMEOUT / 1000}s — server did not respond`;
	}
	if (msg.includes("ENOTFOUND") || causeMsg === "ENOTFOUND" || causeMsg === "ENOTFOUND") {
		return `DNS resolution failed — cannot find host: ${new URL(url).hostname}`;
	}
	if (msg.includes("ECONNREFUSED") || causeMsg === "ECONNREFUSED") {
		return `Connection refused — server is down or port is blocked`;
	}
	if (msg.includes("ECONNRESET") || causeMsg === "ECONNRESET") {
		return `Connection reset by server`;
	}
	if (msg.includes("ETIMEDOUT") || causeMsg === "ETIMEDOUT") {
		return `Network timeout — server unreachable`;
	}
	if (msg.includes("UNABLE_TO_VERIFY_LEAF_SIGNATURE") || msg.includes("CERT_HAS_EXPIRED") || msg.includes("self signed")) {
		return `SSL/TLS error — certificate issue`;
	}
	if (msg.includes("fetch failed") && causeMsg) {
		return `Network error: ${causeMsg}`;
	}
	if (msg.includes("fetch failed")) {
		return `Network error — no internet connection or URL blocked`;
	}

	return `${name}: ${msg}`;
}

/**
 * Detect if a page appears to be a JS-dependent SPA or has a Cloudflare/challenge wall.
 * Returns a warning string, or empty string if page looks normal.
 */
function detectJsRequiredPage(html: string, contentType: string): string {
	if (!contentType.includes("text/html")) return "";

	const lower = html.toLowerCase();

	// Cloudflare challenge pages
	if (lower.includes("cf-browser-verification") || lower.includes("cf-challenge-running") ||
		lower.includes("cf-please-wait") || lower.includes("checking your browser")) {
		return "⚠️ Cloudflare challenge detected — page requires browser JS execution. Use mode=browser (coming soon) or try a different source.";
	}

	// Generic "enable JavaScript" pages
	if (lower.includes("please enable javascript") || lower.includes("javascript is required") ||
		lower.includes("javascript is disabled")) {
		return "⚠️ This page requires JavaScript. Content may be missing. Use mode=browser for JS-heavy sites.";
	}

	// SPA shell detection: minimal body with JS bundle references
	const strippedBody = stripForDetection(lower);
	if (strippedBody.length < 300) {
		const hasJsBundle = lower.includes("/static/js/") || lower.includes("/assets/") ||
			lower.includes("react") || lower.includes("vue") || lower.includes("angular") ||
			lower.includes("__nuxt") || lower.includes("__next");
		if (hasJsBundle) {
			return `⚠️ SPA shell detected (stripped body: ${strippedBody.length} chars) — content likely rendered by JavaScript. Use mode=browser for this page.`;
		}
	}

	return "";
}

function stripForDetection(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<[^>]+>/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function headersToRecord(headers: Headers): Record<string, string> {
	const record: Record<string, string> = {};
	headers.forEach((value, key) => {
		record[key] = value;
	});
	return record;
}

// --- Structured content extraction ---

// Tags to remove entirely (navigation, ads, boilerplate)
const REMOVE_TAGS = new Set([
	"script", "style", "noscript", "iframe", "svg", "canvas",
	"nav", "header", "footer", "aside", "form", "button",
	"input", "textarea", "select", "menu", "dialog",
]);

// Tags with low content value
const LOW_VALUE_TAGS = new Set([
	"div", "span", "a", "i", "em", "b", "strong", "small",
	"sup", "sub", "abbr", "time", "mark", "code", "pre",
]);

// Tags with high content value (article body candidates)
const HIGH_VALUE_TAGS = new Set([
	"article", "section", "main", "p", "h1", "h2", "h3", "h4", "h5", "h6",
	"blockquote", "ul", "ol", "li", "dl", "dt", "dd",
	"table", "tr", "td", "th", "figcaption", "figure",
]);

/**
 * Extract the main article content from an HTML page.
 * Uses tag scoring to find the content-dense region, then strips boilerplate.
 * Pure regex/string approach — no dependencies.
 */
export function extractArticle(html: string, url: string): ExtractedArticle {
	const text = decodeHtmlEntities(html);

	// Extract metadata first
	const title = extractMeta(text, ["og:title", "title"]) || extractTagText(text, "h1");
	const author = extractMeta(text, ["author", "og:article:author"]);
	const publishedDate = extractMeta(text, ["article:published_time", "datePublished", "pubdate", "date"]);
	const description = extractMeta(text, ["og:description", "description"]);
	const siteName = extractMeta(text, ["og:site_name", "application-name"]);
	const topImage = extractMeta(text, ["og:image", "twitter:image"]);

	// Find the best content block
	const content = findMainContent(text);
	const cleanContent = cleanText(content);
	const wordCount = cleanContent.split(/\s+/).filter((w) => w.length > 0).length;

	return {
		title: cleanText(title) || new URL(url).hostname,
		author: cleanText(author),
		publishedDate: cleanText(publishedDate),
		siteName: cleanText(siteName),
		textContent: cleanContent,
		wordCount,
		topImage: topImage || undefined,
		description: cleanText(description) || undefined,
	};
}

/**
 * Parse an RSS or Atom feed from XML text into a structured object.
 */
export function parseFeed(xml: string): ParsedFeed {
	const text = decodeHtmlEntities(xml);

	// Detect feed type
	const isAtom = text.includes("<feed") && text.includes("{http://www.w3.org/2005/Atom}");

	if (isAtom) {
		return parseAtom(text);
	}
	// Default to RSS
	return parseRss(text);
}

function extractMeta(html: string, names: string[]): string {
	for (const name of names) {
		// Try content attribute first (og: tags)
		const contentPattern = new RegExp(`<meta[^>]*property=["']${escapeRegex(name)}["'][^>]*content=["']([^"']*)["']`, "i");
		let m: RegExpExecArray | null = contentPattern.exec(html);
		if (m) return m[1].trim();

		// Try reversed attribute order
		const reversedPattern = new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*property=["']${escapeRegex(name)}["']`, "i");
		m = reversedPattern.exec(html);
		if (m) return m[1].trim();

		// Try name attribute (standard meta tags)
		const namePattern = new RegExp(`<meta[^>]*name=["']${escapeRegex(name)}["'][^>]*content=["']([^"']*)["']`, "i");
		m = namePattern.exec(html);
		if (m) return m[1].trim();

		const nameReversed = new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*name=["']${escapeRegex(name)}["']`, "i");
		m = nameReversed.exec(html);
		if (m) return m[1].trim();

		// Try time elements
		const timePattern = new RegExp(`<time[^>]*(?:datetime|pubdate)=["']([^"']*)["']`, "i");
		m = timePattern.exec(html);
		if (m) return m[1].trim();
	}
	return "";
}

function extractTagText(html: string, tag: string): string {
	const pattern = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
	const m: RegExpExecArray | null = pattern.exec(html);
	if (!m) return "";
	return cleanText(stripTags(m[1]));
}

function findMainContent(html: string): string {
	// Strategy: score each block-level element by content density,
	// pick the best scoring block as main content.

	// Remove all unwanted tags first
	let cleaned = html;
	for (const tag of REMOVE_TAGS) {
		cleaned = cleaned.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"), " ");
	}

	// Also remove self-closing remove tags
	for (const tag of REMOVE_TAGS) {
		cleaned = cleaned.replace(new RegExp(`<${tag}[^>]*/?>`, "gi"), " ");
	}

	// Try to find article or main tag first
	const articlePattern = new RegExp(`<(?:article|main)[^>]*>([\\s\\S]*?)</(?:article|main)>`, "i");
	let m: RegExpExecArray | null = articlePattern.exec(cleaned);
	if (m && m[1].length > 200) {
		return m[1];
	}

	// Score all div and section blocks
	const blockPattern = new RegExp(`<(?:div|section)[^>]*>([\\s\\S]*?)</(?:div|section)>`, "gi");
	let bestBlock = "";
	let bestScore = 0;

	let match: RegExpExecArray | null;
	while ((match = blockPattern.exec(cleaned)) !== null) {
		const block = match[1];
		if (block.length < 100) continue;
		const score = scoreBlock(block);
		if (score > bestScore) {
			bestScore = score;
			bestBlock = block;
		}
	}

	if (bestBlock.length > 200) {
		return bestBlock;
	}

	// Fallback: use body content
	const bodyPattern = new RegExp(`<body[^>]*>([\\s\\S]*?)</body>`, "i");
	m = bodyPattern.exec(cleaned);
	if (m) return m[1];

	return cleaned;
}

function scoreBlock(html: string): number {
	let score = 0;

	// Count high-value tags
	for (const tag of HIGH_VALUE_TAGS) {
		const pattern = new RegExp(`<${tag}[^>]*>`, "gi");
		const matches = html.match(pattern);
		if (matches) score += matches.length * 3;
	}

	// Count low-value tags (slightly negative)
	for (const tag of LOW_VALUE_TAGS) {
		const pattern = new RegExp(`<${tag}[\\s>]`, "gi");
		const matches = html.match(pattern);
		if (matches) score -= matches.length * 0.5;
	}

	// Bonus for text density (ratio of text to HTML)
	const stripped = stripTags(html);
	const textLen = stripped.replace(/\s+/g, "").length;
	const htmlLen = html.length;
	if (htmlLen > 0) {
		score += (textLen / htmlLen) * 100;
	}

	// Penalty for too many links (likely navigation)
	const linkPattern = /<a[^>]*>/gi;
	const links = html.match(linkPattern);
	if (links && links.length > 5) {
		score -= links.length * 2;
	}

	return score;
}

function stripTags(html: string): string {
	return html.replace(/<[^>]*>/g, " ");
}

function cleanText(text: string): string {
	return text
		.replace(/<[^>]*>/g, " ") // strip tags
		.replace(/&nbsp;/g, " ")
		.replace(/&#160;/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function decodeHtmlEntities(html: string): string {
	return html
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&apos;/g, "'")
		.replace(/&#x27;/g, "'");
}

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- RSS/Atom parsing ---

function extractXmlText(xml: string, tag: string): string {
	// Handle namespaced tags
	const pattern = new RegExp(`<(?:[\w-]+:)?${escapeRegex(tag)}[^>]*>([\\s\\S]*?)</(?:[\w-]+:)?${escapeRegex(tag)}>`, "i");
	const m: RegExpExecArray | null = pattern.exec(xml);
	if (!m) return "";
	return decodeHtmlEntities(m[1].trim());
}

function extractXmlAttr(xml: string, tag: string, attr: string): string {
	const pattern = new RegExp(`<(?:[\w-]+:)?${escapeRegex(tag)}[^>]*${escapeRegex(attr)}=["']([^"']*)["']`, "i");
	const m: RegExpExecArray | null = pattern.exec(xml);
	return m ? m[1].trim() : "";
}

function parseRss(xml: string): ParsedFeed {
	const title = extractXmlText(xml, "title");
	const link = extractXmlText(xml, "link");
	const description = extractXmlText(xml, "description");
	const language = extractXmlText(xml, "language");

	const entries: FeedEntry[] = [];
	const itemPattern = /<item[^>]*>([\s\S]*?)<\/item>/gi;
	let itemMatch: RegExpExecArray | null;
	while ((itemMatch = itemPattern.exec(xml)) !== null) {
		const itemXml = itemMatch[1];
		entries.push({
			title: extractXmlText(itemXml, "title"),
			link: extractXmlText(itemXml, "link"),
			publishedDate: extractXmlText(itemXml, "pubDate"),
			author: extractXmlText(itemXml, "dc:creator") || extractXmlAttr(itemXml, "dc:creator", "rdf:resource"),
			summary: extractXmlText(itemXml, "description"),
			content: extractXmlText(itemXml, "content:encoded") || extractXmlText(itemXml, "content"),
		});
	}

	return { title, link, description, language, entries };
}

function parseAtom(xml: string): ParsedFeed {
	const title = extractXmlText(xml, "title");
	const link = extractXmlAttr(xml, "link", "href") || extractXmlText(xml, "link");
	const subtitle = extractXmlText(xml, "subtitle");
	const language = extractXmlAttr(xml, "feed", "xml:lang");

	const entries: FeedEntry[] = [];
	const entryPattern = /<entry[^>]*>([\s\S]*?)<\/entry>/gi;
	let entryMatch: RegExpExecArray | null;
	while ((entryMatch = entryPattern.exec(xml)) !== null) {
		const entryXml = entryMatch[1];
		entries.push({
			title: extractXmlText(entryXml, "title"),
			link: extractXmlAttr(entryXml, "link", "href"),
			publishedDate: extractXmlText(entryXml, "published") || extractXmlText(entryXml, "updated"),
			author: extractXmlText(entryXml, "name"),
			summary: extractXmlText(entryXml, "summary"),
			content: extractXmlText(entryXml, "content"),
		});
	}

	return { title, link, description: subtitle, language, entries };
}

// --- Browser mode (Playwright + CDP + raw CDP fallback) ---

export interface BrowserFetchOptions {
	url: string;
	/** Max wait time for page load in ms (default 30s) */
	timeout?: number;
	/** Max text bytes returned (default 200KB) */
	maxTextBytes?: number;
	/** CDP WebSocket endpoint. Defaults to CHROME_WS_ENDPOINT env var */
	wsEndpoint?: string;
	/** Additional seconds to wait after network idle */
	extraWaitMs?: number;
	/** Scroll to bottom to trigger lazy loading */
	scrollToBottom?: boolean;
}

/**
 * Fetch a URL using a headless browser via Chrome DevTools Protocol.
 *
 * Priority:
 * 1. Playwright + CDP (full-featured, preferred)
 * 2. Playwright local launch (if no CDP endpoint)
 * 3. Raw CDP WebSocket fallback (when Playwright unavailable, e.g. Android/Termux)
 *
 * Requires a running Chrome/Chromium instance with `--remote-debugging-port`,
 * or set CHROME_WS_ENDPOINT env var to the WebSocket URL.
 *
 * Example: CHROME_WS_ENDPOINT=ws://192.168.1.100:9222/devtools/browser/xxx
 */
export async function fetchBrowser(options: BrowserFetchOptions): Promise<FetchResult> {
	const {
		url,
		timeout = 30_000,
		maxTextBytes = DEFAULT_MAX_TEXT_BYTES,
		wsEndpoint = process.env.CHROME_WS_ENDPOINT,
		extraWaitMs = 0,
		scrollToBottom = true,
	} = options;

	// Try to load Playwright
	let playwright: any;
	let playwrightAvailable = false;
	try {
		playwright = await import("playwright");
		playwrightAvailable = true;
	} catch {
		// Playwright not available — will try raw CDP fallback
	}

	// Path 1 & 2: Playwright available
	if (playwrightAvailable) {
		if (!wsEndpoint) {
			return fetchBrowserLocal(url, timeout, maxTextBytes, scrollToBottom, extraWaitMs, playwright);
		}
		return fetchBrowserCDP(url, wsEndpoint, timeout, maxTextBytes, scrollToBottom, extraWaitMs, playwright);
	}

	// Path 3: Raw CDP fallback (no Playwright, Android/Termux compatible)
	if (wsEndpoint) {
		return fetchBrowserRawCDP(url, wsEndpoint, timeout, maxTextBytes, scrollToBottom, extraWaitMs);
	}

	// No Playwright and no CDP endpoint — give helpful error
	return {
		ok: false,
		status: 0,
		contentType: "error",
		body: null,
		text: "Browser mode unavailable on this platform.\n" +
			"Options:\n" +
			"1. Set CHROME_WS_ENDPOINT to a remote Chrome CDP WebSocket URL\n" +
			"   e.g. export CHROME_WS_ENDPOINT=ws://192.168.1.100:9222/devtools/browser/xxx\n" +
			"2. Install Playwright: npm install playwright && npx playwright install chromium",
		headers: {},
		finalUrl: url,
		length: 0,
	};
}

async function fetchBrowserCDP(
	url: string, wsEndpoint: string, timeout: number,
	maxTextBytes: number, scrollToBottom: boolean, extraWaitMs: number,
	playwright: any,
): Promise<FetchResult> {
	let browser: any;
	try {
		browser = await playwright.chromium.connectOverCDP(wsEndpoint, {
			timeout: 10_000,
		});
	} catch (e: any) {
		return {
			ok: false, status: 0, contentType: "error", body: null,
			text: `Failed to connect to Chrome at ${wsEndpoint}: ${e.message}\n` +
				`Make sure Chrome is running with: chromium --remote-debugging-port=9222`,
			headers: {}, finalUrl: url, length: 0,
		};
	}

	try {
		const context = browser.contexts()[0] || await browser.newContext({
			userAgent: nextUA(),
			viewport: { width: 1280, height: 800 },
		});
		const page = await context.newPage();

		try {
			await page.goto(url, { waitUntil: "networkidle", timeout });

			if (scrollToBottom) {
				await page.evaluate("window.scrollTo(0, document.body.scrollHeight)");
				await new Promise(r => setTimeout(r, Math.min(extraWaitMs || 1000, 3000)));
			}

			const html = await page.content();
			const finalUrl = page.url();
			await page.close();

			const truncated = html.slice(0, maxTextBytes);
			return {
				ok: true,
				status: 200,
				contentType: "text/html",
				body: html,
				text: truncated,
				headers: {},
				finalUrl,
				length: Buffer.byteLength(html),
			};
		} finally {
			// Don't close the browser — it's shared
		}
	} catch (e: any) {
		return {
			ok: false, status: 0, contentType: "error", body: null,
			text: `Browser fetch failed: ${e.message}`,
			headers: {}, finalUrl: url, length: 0,
		};
	}
}

async function fetchBrowserLocal(
	url: string, timeout: number, maxTextBytes: number,
	scrollToBottom: boolean, extraWaitMs: number, playwright: any,
): Promise<FetchResult> {
	let browser: any;
	try {
		browser = await playwright.chromium.launch({
			headless: true,
			args: ["--no-sandbox", "--disable-dev-shm-usage"],
		});
	} catch (e: any) {
		return {
			ok: false, status: 0, contentType: "error", body: null,
			text: `Failed to launch local browser: ${e.message}\n` +
				`Set CHROME_WS_ENDPOINT to use a remote Chrome, or run: npx playwright install chromium`,
			headers: {}, finalUrl: url, length: 0,
		};
	}

	try {
		const context = await browser.newContext({
			userAgent: nextUA(),
			viewport: { width: 1280, height: 800 },
		});
		const page = await context.newPage();

		try {
			await page.goto(url, { waitUntil: "networkidle", timeout });

			if (scrollToBottom) {
				await page.evaluate("window.scrollTo(0, document.body.scrollHeight)");
				await new Promise(r => setTimeout(r, Math.min(extraWaitMs || 1000, 3000)));
			}

			const html = await page.content();
			const finalUrl = page.url();

			const truncated = html.slice(0, maxTextBytes);
			return {
				ok: true, status: 200, contentType: "text/html", body: html,
				text: truncated, headers: {}, finalUrl, length: Buffer.byteLength(html),
			};
		} finally {
			await page.close();
			await context.close();
		}
	} catch (e: any) {
		return {
			ok: false, status: 0, contentType: "error", body: null,
			text: `Browser fetch failed: ${e.message}`,
			headers: {}, finalUrl: url, length: 0,
		};
	} finally {
		await browser.close();
	}
}

/** Raw CDP WebSocket fallback — works without Playwright (Android/Termux compatible) */
async function fetchBrowserRawCDP(
	url: string, wsEndpoint: string, timeout: number,
	maxTextBytes: number, scrollToBottom: boolean, extraWaitMs: number,
): Promise<FetchResult> {
	const WebSocket = (await import("ws")).WebSocket;

	return new Promise((resolve) => {
		const ws = new WebSocket(wsEndpoint);
		let msgId = 0;
		let loadFired = false;
		let finalUrl = url;
		const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

		const send = (method: string, params?: Record<string, unknown>): Promise<any> => {
			const id = ++msgId;
			return new Promise((res, rej) => {
				pending.set(id, { resolve: res, reject: rej });
				ws.send(JSON.stringify({ id, method, params }));
			});
		};

		const fail = (text: string) => {
			try { ws.close(); } catch {}
			resolve({ ok: false, status: 0, contentType: "error", body: null, text, headers: {}, finalUrl, length: 0 });
		};

		const timer = setTimeout(() => {
			fail(`Browser fetch timed out after ${timeout}ms`);
		}, timeout + 10_000);

		ws.on("error", (e: Error) => {
			clearTimeout(timer);
			fail(`CDP WebSocket error: ${e.message}\nEndpoint: ${wsEndpoint}`);
		});

		ws.on("message", (raw: Buffer) => {
			try {
				const msg = JSON.parse(raw.toString());

				// Handle events
				if (msg.method === "Page.loadEventFired") {
					loadFired = true;
					return;
				}
				if (msg.method === "Page.frameNavigated" && msg.params?.frame?.url) {
					finalUrl = msg.params.frame.url;
					return;
				}

				// Handle command responses
				if (msg.id && pending.has(msg.id)) {
					const { resolve: res, reject: rej } = pending.get(msg.id)!;
					pending.delete(msg.id);
					if (msg.error) {
						rej(new Error(`${msg.error.message || JSON.stringify(msg.error)}`));
					} else {
						res(msg.result);
					}
				}
			} catch { /* ignore parse errors */ }
		});

		ws.on("open", async () => {
			try {
				// Enable Page domain
				await send("Page.enable");

				// Navigate
				await send("Page.navigate", { url });

				// Wait for load event (poll if already fired)
				const start = Date.now();
				while (!loadFired && Date.now() - start < timeout) {
					await new Promise(r => setTimeout(r, 200));
				}

				// Extra wait
				if (extraWaitMs > 0) {
					await new Promise(r => setTimeout(r, Math.min(extraWaitMs, 5000)));
				}

				// Scroll to bottom
				if (scrollToBottom) {
					await send("Runtime.evaluate", {
						expression: "window.scrollTo(0, document.body.scrollHeight)",
					});
					await new Promise(r => setTimeout(r, Math.min(extraWaitMs || 1000, 3000)));
				}

				// Get HTML content
				const result = await send("Runtime.evaluate", {
					expression: "document.documentElement.outerHTML",
					returnByValue: true,
				});

				const html: string = result?.result?.value || "";
				const truncated = html.slice(0, maxTextBytes);

				clearTimeout(timer);
				ws.close();
				resolve({
					ok: true, status: 200, contentType: "text/html",
					body: html, text: truncated,
					headers: {}, finalUrl, length: Buffer.byteLength(html),
				});
			} catch (e: any) {
				clearTimeout(timer);
				fail(`CDP command failed: ${e.message}`);
			}
		});
	});
}
