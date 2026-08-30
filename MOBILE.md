# Novus on Android — Termux Quick Start

A full agent runtime in your pocket. No root required.

> Verified on Termux (F-Droid) · nodejs-lts 24 · aarch64 — the same setup one of the authors uses daily.

## 1. Install Termux (F-Droid only)

Get Termux from [F-Droid](https://f-droid.org/en/packages/com.termux/).
**The Play Store build is outdated and will not work.**

## 2. Install the toolchain

```bash
pkg update
pkg install nodejs-lts git python make clang
```

Why `python make clang`? Novus depends on `better-sqlite3`, a native module that compiles on-device during `npm install`. These three packages provide the compiler toolchain — without them the install fails deep inside node-gyp errors. On a modern phone this costs one extra minute, once.

## 3. Standard install

Same flow as any platform — that's the point:

```bash
git clone https://github.com/RexHuang/novus.git
cd novus
npm install && npm run build
npm link        # one-time: registers the `novus` command
```

## 4. Point it at your LLM

Any Anthropic-protocol compatible API works:

```bash
export NOVUS_BASE_URL="https://api.anthropic.com"
export NOVUS_AUTH_TOKEN="sk-ant-..."
export NOVUS_MODEL="claude-sonnet-4-20250514"
```

Or just reuse your existing Claude Code env (`ANTHROPIC_*`) — Novus picks it up automatically. Works with DeepSeek, Zhipu GLM, Moonshot Kimi, OpenRouter, and local servers too.

## 5. Verify

```bash
novus -p "hello from my phone"
```

You should get a reply. Welcome to agents-in-your-pocket.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `pkg` missing, or permission errors right at launch | You're on the Play Store build — install the F-Droid build instead. |
| `npm install` fails inside `better-sqlite3` (node-gyp spam) | Build tools missing: `pkg install python make clang` |
| Engine warning, or syntax errors at startup | Node too old. `pkg install nodejs-lts` — Novus needs Node ≥ 22.19 |
| `novus: command not found` | Re-run `npm link` from the repo root |

## Next steps

- `novus` — interactive chat right in Termux
- `novus --serve --port 24999` — HTTP API + web UI served from your phone
- See the [README](README.md) for the full feature tour
