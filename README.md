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

## It evolves itself — for real

Not "self-improving" as a marketing word. The loop is concrete — and it ran, end to end, on the day this README was being written:

- **Reads and rewrites its own source code** — that day, the agent found 4 bugs in its own federation registry (a hardcoded version string, a node type it couldn't recognize, a zombie entry that refused to die, and a liveness probe that lied), patched its own TypeScript, rebuilt, and shipped the fix to every machine it runs on
- **Deploys its own updates** across the fleet — phone → cloud VM → overseas VPS, over SSH and WebSocket
- **Keeps lessons across sessions** — a persistent knowledge store, not a context window that resets. A fix found once is a lesson stored; the same mistake can't repeat
- **Watches its own habits** — 10 behavioral patterns identified (over-calling tools, redundant searches…), 7 already corrected by self-imposed rules that now gate its own tool calls
- **Logs every evolution** — 15 so far, each recording what changed and why

Bug → self-diagnosis → self-patch → self-deploy → lesson stored. No human typed a line of that fix. The maintainer watched it happen, then updated this README.

*(The federation layer itself ships in v1.2 — see [Roadmap](#roadmap).)*

## Quickstart (5 minutes)

```bash
git clone https://github.com/YOUR_USER/novus.git && cd novus
npm install && npm run build
```

> **Android**: install [Termux from F-Droid](https://f-droid.org/en/packages/com.termux/) first — the Play Store build is outdated and won't work. Then `pkg install nodejs-lts git python make clang` (the native module needs a small toolchain), and everything below works as-is. Step-by-step guide: [MOBILE.md](MOBILE.md).

> **Windows**: install [Git for Windows](https://git-scm.com/download/win) first — it provides the `git` and `bash` commands Novus shells out to. Run from Git Bash, WSL, or plain cmd/PowerShell once it's installed.

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

### About images

- **Seeing images**: `read` any jpg/png/gif/webp/bmp file and it is sent to the model as an image block — provided your `NOVUS_MODEL` is multimodal (e.g. Claude Sonnet). Pure-text models will silently ignore images.
- **Manipulating images** (resize, convert, watermark) works with any model — the agent writes scripts for that.
- **Generating images** is not built in; it's one custom tool away (drop a `.ts` in `src/tools/custom/` that calls any image API — see [Dynamic tools](#whats-inside)).

```bash
npm link                  # one-time: register the `novus` command globally
novus                     # interactive chat
novus -p "fix the failing tests in this repo"
novus --serve --port 24999   # HTTP API + web UI
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

## Grown, not built

Novus did not start as an architecture diagram. It started as a seed — a minimal agent loop — and every capability you see was grown in response to a real problem the agent hit the day before:

- **Memory** grew because sessions kept forgetting things worth keeping — a fact learned on Monday shouldn't be re-learned on Friday. It now carries 560 entries across sessions.
- **Context management** grew because windows overflow — sessions now compress, checkpoint, and restore themselves.
- **Web access** grew because an agent sealed off from the internet cannot perceive the world.
- **26 custom tools** grew one at a time — each one an answer to yesterday's friction, not a line-item in a design doc.
- **Behavior reflection** grew because the same mistake kept repeating — Novus now watches its own patterns (over-tool-calling, redundant calls) and corrects them.

Every feature here exists because the agent using it demanded it. The maintainer's job was mostly to say yes.

You'll notice there's no plugin marketplace and no "skills" framework. That's deliberate, not an oversight. A plugin system is how you add capabilities to a system that can't grow its own — and this one grows its own. A tree grown from a seed has no seams; an assembly of parts does. Plugins may still come someday, when a capability genuinely can't be grown. So far, none has.

## Philosophy

1. **The agent is the product, not the app.** No chrome, no Electron — a REPL and an HTTP server.
2. **Memory is not a feature, it's the foundation.** An agent that forgets everything is a chatbot.
3. **Evolve or die.** The agent that can't observe and correct its own behavior can't improve.
4. **Run anywhere.** A phone is a computer. Act like it.

## Roadmap

- [ ] v1.2 — multi-agent federation protocol (the phone ↔ servers story, open-sourced)
- [ ] v1.3 — org-level orchestration (roles, pipelines, debates)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Good first issues: tool ideas, Termux/Android quirks, docs translations.

## License

Apache 2.0 — see [LICENSE](LICENSE). Built on [pi-agent-core](https://www.npmjs.com/package/@earendil-works/pi-agent-core) (MIT).
