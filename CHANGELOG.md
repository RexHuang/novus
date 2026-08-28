# Changelog

## 1.1.0 — First public release (2026-09-12)

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
