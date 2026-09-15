# Changelog

## 1.1.1 — Security patch: multi-tenant row-level isolation (2026-09-15)

Fixes the tenant-isolation issue reported in #1.

### Fixed
- **Security**: in `--auth-file` multi-tenant serve mode, knowledge / experience / knowledge-graph entries stored in one tenant context could be recalled from another (#1). Every entry now carries a row-level tenant ownership tag; all read paths (recall, contextual memory, meta-memory, stats, graph traversal) filter by the effective tenant scope. Entries written by the agent itself (CLI / single-user serve) remain unowned and invisible to tenants — strict isolation by default.
- Destructive operations (prune / clear / compress / graph build·link·clear) are scoped or refused in tenant context — a tenant cannot delete or rebuild what it cannot see.
- CLI and single-user serve behavior unchanged.

### Added
- Regression test suite for tenant isolation: `src/tenant-isolation.test.ts` (cross-tenant recall, self-view isolation, cross-tenant delete protection, experience/graph scoping)
- Vitest global setup (`test/setup.ts`) isolating the knowledge store into a temp dir during tests

### Credits
- Thanks [@CaiHB2000](https://github.com/CaiHB2000) for the responsible disclosure.

## 1.1.0 — First public release (2026-09-08)

The essence of a self-evolving AI agent in ~15K lines of TypeScript.

**Before this release:** Novus ran as an internal system for one month of intense daily use (140+ sessions), maintaining a 3-node deployment (phone ↔ cloud VM ↔ overseas VPS), shipping daily news digests, and self-healing its own infrastructure. v1.1.0 is that same core, cleaned and open-sourced.

### Core
- Agent loop on pi-agent-core: tool calling, streaming, multi-turn sessions
- CLI: interactive chat, one-shot mode, session management, `--serve` HTTP API + Web UI
- Dual-track env vars: `NOVUS_*` with automatic `ANTHROPIC_*` (Claude Code) fallback — works with any Anthropic-protocol endpoint (DeepSeek, GLM, Kimi, gateways)

### Memory
- Three-layer persistent memory: knowledge base, episodic experience, project memory
- Knowledge graph linking + MCP server exposing memory to other agents

### Evolution
- Evolution tracker: logs capability changes across sessions
- Behavior guard: monitors the agent's own tool-call patterns (over-calling, repetition) and injects corrective rules

### Tools (16 built-in, dynamic registry)
read/write/edit/bash/grep/find, connect (web senses), codebase-map, github, plan, execution-tracker, auto-manage (autonomous scheduled tasks), session-context, session-worklog, knowledge-graph, evolve-track, runtests, and more — drop a `.ts` file to add your own

### Platform
- Termux/Android native: storage mirroring, wake locks — designed to run on a phone
- 109 tests, zero mandatory heavy dependencies (browser fetching is optional)
