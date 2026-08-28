# Novus

> **Your phone is the agent. Your servers are its hands.**

A self-evolving AI agent framework that runs anywhere — including the Android phone in your pocket. I stopped carrying a laptop: the agent lives on my phone (Termux) and reaches out to my servers, an overseas VPS, even the Mac under my desk, over a single WebSocket.

---

## What's the essence of an AI agent?

Claude Code taught the world what agent loops look like. Novus asks the other question: **how small can the core be?**

- **~15K lines of TypeScript** (under 1 MB of source)
- **16 built-in tools**, zero-config dynamic registry
- **109 tests**, builds clean in seconds
- Runs on a phone, a Pi, a VPS, or your laptop — if Node.js runs, Novus runs

No bundling of heavyweight SDKs, no vendor lock-in. Just the loop: *perceive → think → act → remember → evolve*.

## Quickstart (5 minutes)

```bash
git clone https://github.com/YOUR_USER/novus.git && cd novus
npm install && npm run build
```

Set your LLM endpoint — **any Anthropic-protocol compatible API works**:

```bash
# Native (recommended)
export NOVUS_BASE_URL="https://api.anthropic.com"
export NOVUS_AUTH_TOKEN="sk-ant-..."
export NOVUS_MODEL="claude-sonnet-4-20250514"

# Or use your existing Claude Code env vars — picked up automatically
# ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL
```

Works out of the box with **Anthropic, DeepSeek, Zhipu GLM, Moonshot Kimi**, OpenRouter, LiteLLM gateways, and local servers.

```bash
node dist/cli.js          # interactive chat
node dist/cli.js -p "fix the failing tests in this repo"
node dist/cli.js --serve --port 24999   # HTTP API + web UI
```

> Already a Claude Code user? You're done — Novus reads your existing `ANTHROPIC_*` environment.

## What's inside

| Capability | What it means |
|---|---|
| 🧠 **Three-layer memory** | Knowledge base (semantics), episodic experience (war stories), project memory (state) — all persistent across sessions |
| 🧬 **Self-evolution** | An evolution tracker + behavior guard that watches the agent's own tool-call patterns and injects corrective rules into future prompts |
| 🔌 **Dynamic tools** | Drop a `.ts` file in `src/tools/custom/`, it auto-registers. No config, no boilerplate |
| 🌐 **Senses** | Web fetching (raw/article/feed, optional headless-browser mode), GitHub integration, codebase mapping |
| 📋 **Planning** | Plans with dependency tracking, execution tracing, auto-execute script generation |
| 🤖 **Autonomous tasks** | Schedule recurring agent tasks (`on-start`, `periodic`, `event-triggered`) |
| 📱 **Termux-native** | Android storage mirroring, wake locks — designed to actually live on a phone |
| 🔓 **MCP server** | Expose Novus memory as MCP tools for other agents |

## Not a demo — it runs my infrastructure

Novus has been my daily driver for **one month of intense use**: 140+ sessions, 560 knowledge entries accumulated. It maintains a 3-node deployment (phone ↔ cloud VM ↔ overseas VPS) that self-heals, ships daily news digests, and publishes articles. The agent wrote parts of its own release tooling. This README's narrative was drafted by Novus itself.

*The multi-node federation layer is not open-sourced (yet) — see [Roadmap](#roadmap).*

## Philosophy

1. **The agent is the product, not the app.** No chrome, no Electron — a REPL and an HTTP server.
2. **Memory is not a feature, it's the foundation.** An agent that forgets everything is a chatbot.
3. **Evolve or die.** The agent that can't observe and correct its own behavior can't improve.
4. **Run anywhere.** A phone is a computer. Act like it.

## Roadmap

- [ ] v1.2 — plugin marketplace & tool sandboxing
- [ ] v1.3 — multi-agent federation protocol (the phone ↔ servers story, open-sourced)
- [ ] v1.4 — org-level orchestration (roles, pipelines, debates)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Good first issues: tool ideas, Termux/Android quirks, docs translations.

## License

Apache 2.0 — see [LICENSE](LICENSE). Built on [pi-agent-core](https://www.npmjs.com/package/@earendil-works/pi-agent-core) (MIT).
