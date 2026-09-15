/**
 * Multi-tenant row-level isolation tests (Issue #1).
 *
 * 口径（用户确认）：
 *   1. A learn → B recall 不命中
 *   2. A learn → A recall 命中
 *   3. CLI/本体视角照旧（只见无主条目，租户条目不污染本体视野）
 *
 * 隔离机制：单一存储 + 条目 tenant 标签 + 查询过滤（非目录隔离）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithTenant } from "./memory/tenant-context.ts";
import {
	storeKnowledge,
	queryKnowledge,
	knowledgeStats,
	knowledgeCount,
	pruneEntries,
	storeExperience,
	recallExperience,
} from "./memory/knowledge.ts";

const TEST_DIR = mkdtempSync(join(tmpdir(), "novus-tenant-test-"));

// ── 视角 helpers ──────────────────────────────────────────────────
const asTenantA = <T>(fn: () => T): T => runWithTenant({ tenantId: "tenant-a", multiTenant: true }, fn);
const asTenantB = <T>(fn: () => T): T => runWithTenant({ tenantId: "tenant-b", multiTenant: true }, fn);
/** 单用户 serve：multiTenant=false → 本体视角（与 CLI 等价） */
const asSingleUserServe = <T>(fn: () => T): T => runWithTenant({ tenantId: "default", multiTenant: false }, fn);

beforeAll(() => {
	process.env.NOVUS_KNOWLEDGE_DIR = TEST_DIR;
});

afterAll(() => {
	delete process.env.NOVUS_KNOWLEDGE_DIR;
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("Multi-tenant row-level isolation (Issue #1)", () => {
	it("1. tenant A stores → tenant A recalls it", () => {
		const entry = asTenantA(() => storeKnowledge({
			content: "租户A专属机密：项目阿波罗的部署密钥存放在三号保险柜内层抽屉。",
			category: "fact",
			confidence: 0.9,
		}));
		expect(entry).not.toBeNull();
		expect(entry!.tenant).toBe("tenant-a");

		const hits = asTenantA(() => queryKnowledge({ query: "阿波罗部署密钥" }));
		expect(hits.some(e => e.id === entry!.id)).toBe(true);
	});

	it("2. tenant A stores → tenant B must NOT recall it", () => {
		const hits = asTenantB(() => queryKnowledge({ query: "阿波罗部署密钥" }));
		expect(hits).toHaveLength(0);

		// B 的 stats 也看不到 A 的条目
		const stats = asTenantB(() => knowledgeStats());
		expect(stats.total).toBe(0);
	});

	it("3. self (CLI) view excludes tenant entries but keeps its own", () => {
		// 本体视角：看不到租户 A 的条目
		const selfHits = queryKnowledge({ query: "阿波罗部署密钥" });
		expect(selfHits).toHaveLength(0);

		// 本体存自己的知识 → 照旧可召回
		const own = storeKnowledge({
			content: "本体备忘：联邦消息协议的心跳间隔默认是三十秒。",
			category: "fact",
			confidence: 0.9,
		});
		expect(own).not.toBeNull();
		expect(own!.tenant).toBeUndefined();

		const ownHits = queryKnowledge({ query: "联邦心跳间隔" });
		expect(ownHits.some(e => e.id === own!.id)).toBe(true);
		expect(knowledgeCount()).toBeGreaterThanOrEqual(1);
	});

	it("4. single-user serve (multiTenant=false) writes are self-owned", () => {
		const entry = asSingleUserServe(() => storeKnowledge({
			content: "单用户serve写入的知识应当视同本体记忆，不做租户打标。",
			category: "knowledge",
			confidence: 0.85,
		}));
		expect(entry).not.toBeNull();
		expect(entry!.tenant).toBeUndefined();

		// CLI 视角可见（跨模式一致性）
		const hits = queryKnowledge({ query: "单用户serve租户打标" });
		expect(hits.some(e => e.id === entry!.id)).toBe(true);
	});

	it("5. tenant cannot prune entries it cannot see (no cross-tenant delete)", () => {
		const own = storeKnowledge({
			content: "本体保护条目：这条记录不允许任何租户上下文删除它。",
			category: "fact",
			confidence: 0.9,
		});
		expect(own).not.toBeNull();

		// 租户 A 尝试删除本体条目 → removed = 0，条目仍在
		const result = asTenantA(() => pruneEntries([own!.id]));
		expect(result.removed).toBe(0);
		expect(queryKnowledge({ query: "本体保护条目" }).some(e => e.id === own!.id)).toBe(true);

		// 本体自己可以删
		expect(pruneEntries([own!.id]).removed).toBe(1);
	});

	it("6. experience store: tenant A experience invisible to tenant B and self", () => {
		const exp = asTenantA(() => storeExperience({
			title: "租户A独有经验",
			scenario: "部署阿波罗项目",
			situation: "部署时密钥验证失败",
			actions: ["检查三号保险柜", "重新同步密钥"],
			outcome: "成功",
			lessons: ["先验密钥再部署"],
			tags: ["deploy"],
			timestamp: new Date().toISOString(),
			confidence: 0.9,
		}));
		expect(exp.tenant).toBe("tenant-a");

		// B 看不到
		expect(asTenantB(() => recallExperience({ keyword: "阿波罗" }))).toHaveLength(0);
		// 本体看不到
		expect(recallExperience({ keyword: "阿波罗" })).toHaveLength(0);
		// A 自己能看到
		expect(asTenantA(() => recallExperience({ keyword: "阿波罗" }).length).valueOf()).toBeGreaterThan(0);
	});

	it("7. stats reflect the current view only", () => {
		const selfStats = knowledgeStats();
		const aStats = asTenantA(() => knowledgeStats());
		const bStats = asTenantB(() => knowledgeStats());

		expect(aStats.total).toBeGreaterThanOrEqual(1); // A 的知识
		expect(bStats.total).toBe(0);                   // B 仍是空库
		expect(selfStats.byCategory).toBeDefined();
	});
});
