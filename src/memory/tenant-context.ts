// tenant-context.ts — Per-request tenant scope for multi-tenant serve mode.
//
// In --auth-file multi-tenant mode, every persistence layer (knowledge,
// experience, knowledge-graph, worklog, session-context) MUST live under
// the tenant's own data root instead of the global ~/.novus/ directory.
//
// Mechanism: AsyncLocalStorage carries { tenantId, multiTenant } through the
// async request chain. server.ts wraps each authenticated request with
// runWithTenant(); storage modules resolve paths through scopedDir().
//
// Outside multi-tenant mode (CLI, single-user serve without --auth-file),
// scopedDir() returns the default path unchanged — single-user behavior is
// bit-for-bit identical to before.

import { AsyncLocalStorage } from "node:async_hooks";
import { homedir } from "node:os";
import { join } from "node:path";

interface TenantScope {
	tenantId: string;
	multiTenant: boolean;
}

const als = new AsyncLocalStorage<TenantScope>();

/** Run fn within a tenant scope. Called by server.ts per authenticated request. */
export function runWithTenant<T>(ctx: TenantScope, fn: () => T): T {
	return als.run(ctx, fn);
}

/** Current tenant id, or null outside multi-tenant scope. */
export function currentTenantId(): string | null {
	return als.getStore()?.tenantId ?? null;
}

/**
 * Effective tenant boundary for data isolation (row-level ownership).
 * Returns the tenantId ONLY in real multi-tenant mode (--auth-file serve).
 * CLI / single-user serve (multiTenant=false) / daemon → null = "self" view:
 * entries written in these contexts are unowned (tenant-less) and belong
 * to the agent itself.
 */
export function tenantScope(): string | null {
	const ctx = als.getStore();
	if (!ctx || !ctx.multiTenant || !ctx.tenantId) return null;
	return ctx.tenantId;
}

/** Data root for the current tenant, or null when not in multi-tenant scope. */
export function tenantDataRoot(): string | null {
	const ctx = als.getStore();
	if (!ctx || !ctx.multiTenant || !ctx.tenantId) return null;
	return join(homedir(), ".novus", "tenants", ctx.tenantId);
}

/**
 * Redirect a default data path into the current tenant's data root.
 *   ~/.novus/knowledge        → ~/.novus/tenants/{tenantId}/knowledge
 *   ~/.novus/session-x.json   → ~/.novus/tenants/{tenantId}/session-x.json
 * No-op outside multi-tenant scope (CLI / single-user serve).
 */
export function scopedDir(defaultDir: string): string {
	const root = tenantDataRoot();
	if (!root) return defaultDir;
	return join(root, ...defaultDir.split(/[\\/]/).slice(-1));
}
