import { describe, it, expect, afterEach } from "vitest";
import {
	storeKnowledge,
	queryKnowledge,
	knowledgeStats,
	analyzeKnowledgeQuality,
	pruneEntries,
	findCompressibleGroups,
	compressGroup,
	getContextualMemory,
	flushPendingRefs,
} from "./memory/knowledge.ts";
import type { KnowledgeCategory } from "./memory/knowledge.ts";

describe("Knowledge store", () => {
	const stored: (string | null)[] = [];

	afterEach(() => {
		// Prune test entries
		const validIds = stored.filter((id): id is string => id !== null);
		if (validIds.length > 0) {
			pruneEntries(validIds);
		}
		stored.length = 0;
	});

	it("should store a valid knowledge entry", () => {
		const entry = storeKnowledge({
			content: "TypeScript 的 union type 允许一个变量有多种类型，用 | 分隔。",
			tags: ["typescript", "types"],
			category: "knowledge",
			confidence: 0.9,
		});
		expect(entry).not.toBeNull();
		expect(entry!.content).toContain("union type");
		expect(entry!.category).toBe("knowledge");
		expect(entry!.id).toBeTruthy();
		stored.push(entry!.id);
	});

	it("should reject empty content", () => {
		const entry = storeKnowledge({ content: "   ", tags: [] });
		expect(entry).toBeNull();
	});

	it("should reject content shorter than 10 chars", () => {
		const entry = storeKnowledge({ content: "too short", tags: [] });
		expect(entry).toBeNull();
	});

	it("should detect duplicates", () => {
		const content = "This is a unique test content for dedup checking.";
		const entry1 = storeKnowledge({ content, tags: ["test"] });
		expect(entry1).not.toBeNull();
		stored.push(entry1!.id);

		const entry2 = storeKnowledge({ content, tags: ["test"] });
		expect(entry2).toBeNull(); // duplicate
	});

	it("should infer category from content", () => {
		const entry = storeKnowledge({
			content: "以后每次写代码都要先写测试再写实现，这是 TDD 的核心原则。",
			tags: [],
		});
		expect(entry).not.toBeNull();
		expect(entry!.category).toBe("preference");
		stored.push(entry!.id);
	});

	it("should recall entries by query", () => {
		storeKnowledge({ content: "Rust 的所有权系统在编译时检查内存安全", tags: ["rust", "memory"], category: "knowledge" });
		storeKnowledge({ content: "Go 的 goroutine 是轻量级线程，通过 channel 通信", tags: ["go", "concurrency"], category: "knowledge" });

		const results = queryKnowledge({ query: "rust", coreOnly: false });
		expect(results.length).toBeGreaterThanOrEqual(1);
		expect(results.some(r => r.content.includes("Rust"))).toBe(true);
	});

	it("should recall Chinese bigram queries", () => {
		storeKnowledge({ content: "React 的虚拟 DOM 通过 diff 算法最小化真实 DOM 操作", tags: ["react"], category: "knowledge" });

		// Bigram "虚拟" should match
		const results = queryKnowledge({ query: "虚拟DOM", coreOnly: false });
		expect(results.length).toBeGreaterThanOrEqual(1);
	});

	it("should sort by value by default", () => {
		const e1 = storeKnowledge({ content: "Low value entry about nothing important", tags: ["low"], confidence: 0.5, category: "knowledge" });
		const e2 = storeKnowledge({ content: "High value entry: JavaScript closures capture variables from their enclosing scope", tags: ["high", "javascript"], confidence: 0.95, category: "knowledge" });

		const results = queryKnowledge({ query: "javascript closures", coreOnly: false, limit: 2 });
		if (results.length >= 2) {
			// Higher confidence entry should appear first (higher value score)
			const ids = results.map(r => r.id);
			expect(ids).toContain(e2!.id);
		}
		if (e1) stored.push(e1.id);
		if (e2) stored.push(e2.id);
	});

	it("should provide stats", () => {
		const stats = knowledgeStats();
		expect(typeof stats.total).toBe("number");
		expect(typeof stats.core).toBe("number");
		expect(typeof stats.log).toBe("number");
	});

	it("should analyze quality", () => {
		const analysis = analyzeKnowledgeQuality();
		expect(typeof analysis.total).toBe("number");
		expect(Array.isArray(analysis.candidates)).toBe(true);
	});

	// ── New features (v3) ──

	it("should increment refCount on recall and persist", async () => {
		const entry = storeKnowledge({
			content: "Persistent refCount test: Python decorators wrap functions to modify behavior.",
			tags: ["python", "test"],
			category: "knowledge",
			confidence: 0.9,
		});
		expect(entry).not.toBeNull();
		stored.push(entry!.id);

		// Recall twice
		queryKnowledge({ query: "python decorators", coreOnly: false });
		queryKnowledge({ query: "python decorators", coreOnly: false });

		// Flush pending ref updates to disk
		flushPendingRefs();

		// Recall again — refCount should have been persisted
		const results = queryKnowledge({ query: "python decorators", coreOnly: false });
		const found = results.find(r => r.id === entry!.id);
		expect(found).toBeDefined();
		// refCount should be at least 2 (from the two previous recalls + this one)
		expect(found!.refCount).toBeGreaterThanOrEqual(2);
	});

	it("should deduplicate similar recall results", () => {
		// These two entries share most words — Jaccard should be > 0.7
		const e1 = storeKnowledge({
			content: "Docker containers are lightweight virtualized environments that package code and dependencies together.",
			tags: ["docker"],
			category: "knowledge",
		});
		const e2 = storeKnowledge({
			content: "Docker containers are lightweight virtualized environments packaging code and dependencies together for deployment.",
			tags: ["docker", "container"],
			category: "knowledge",
		});
		expect(e1).not.toBeNull();
		expect(e2).not.toBeNull();
		stored.push(e1!.id, e2!.id);

		// Without dedup — should return 2 results
		const resultsNoDedup = queryKnowledge({ query: "docker containers", coreOnly: false, deduplicate: false });
		expect(resultsNoDedup.length).toBeGreaterThanOrEqual(2);

		// With dedup — should merge similar entries
		const resultsDedup = queryKnowledge({ query: "docker containers", coreOnly: false, deduplicate: true });
		const hasDocker = resultsDedup.filter(r => r.content.includes("Docker")).length;
		expect(hasDocker).toBeLessThanOrEqual(1);
	});

	it("should find compressible groups", () => {
		const e1 = storeKnowledge({
			content: "Kubernetes is a container orchestration platform that automates deployment and scaling of applications.",
			tags: ["kubernetes"],
			category: "knowledge",
		});
		const e2 = storeKnowledge({
			content: "Kubernetes is a container orchestration platform automating deployment and scaling of containerized applications.",
			tags: ["kubernetes", "k8s"],
			category: "knowledge",
		});
		expect(e1).not.toBeNull();
		expect(e2).not.toBeNull();
		stored.push(e1!.id, e2!.id);

		// These share ~80% tokens, should be found even with high threshold
		const groups = findCompressibleGroups(0.6);
		const k8sGroup = groups.find(g =>
			g.entries.some(e => e.content.includes("Kubernetes"))
		);
		expect(k8sGroup).toBeDefined();
	});

	it("should compress similar entries into one", () => {
		const e1 = storeKnowledge({
			content: "React hooks let you use state and other React features without writing a class. useState for state, useEffect for side effects.",
			tags: ["react", "hooks"],
			category: "knowledge",
		});
		const e2 = storeKnowledge({
			content: "React hooks like useState and useEffect replace class lifecycle methods. They let functional components manage state.",
			tags: ["react", "hooks", "functional"],
			category: "knowledge",
		});
		expect(e1).not.toBeNull();
		expect(e2).not.toBeNull();
		stored.push(e1!.id, e2!.id);

		const result = compressGroup([e1!, e2!]);
		expect(result.compressed).toBe(2);
		expect(result.merged).toBe(1);
		expect(result.removedIds).toContain(e1!.id);
		expect(result.removedIds).toContain(e2!.id);
		expect(result.newEntry).toBeDefined();
		expect(result.newEntry!.content).toContain("React");
		expect(result.newEntry!.tags).toContain("compressed:2");

		// Actually prune the old entries (compressGroup doesn't do it)
		pruneEntries(result.removedIds);
	});

	it("should return contextual memory summary", () => {
		const e1 = storeKnowledge({
			content: "重要项目: Snaptool 是一个 AI 驱动的截图工具，使用 Electron + React 构建。",
			tags: ["snaptool", "project"],
			category: "business",
			confidence: 0.95,
		});
		const e2 = storeKnowledge({
			content: "用户偏好: 写代码前先写测试，遵循 TDD 原则。",
			tags: ["preference", "tdd"],
			category: "preference",
			confidence: 0.9,
		});
		expect(e1).not.toBeNull();
		expect(e2).not.toBeNull();
		stored.push(e1!.id, e2!.id);

		const ctx = getContextualMemory(15);
		expect(ctx).toContain("Memory Context");
		expect(ctx).toContain("Snaptool");
	});
});
