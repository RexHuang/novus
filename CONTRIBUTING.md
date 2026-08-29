# Contributing to Novus

Thanks for your interest! Novus is a small core by design — before proposing a big feature, please open an issue to discuss.

## Development setup

```bash
git clone <your-fork> && cd novus
npm install
npm run build
npx vitest run        # all tests must pass
```

## Ground rules

1. **The agent is the product.** New features must work in a terminal over SSH. No GUI-only features.
2. **Keep the core small.** Heavy dependencies (e.g. headless browsers) must be optional / dynamically imported, never mandatory.
3. **Zero secrets in code.** Anything sensitive belongs in env vars or `.env` (gitignored). CI scans for leaks.
4. **Tests or it didn't happen.** Bug fixes come with a regression test.

## Adding a custom tool (the fun part)

Drop a file in `src/tools/custom/`:

```typescript
import type { AgentTool } from "@earendil-works/pi-agent-core";

export function createTool(cwd: string): AgentTool<any> {
  return {
    name: "my-tool",
    label: "my-tool",
    description: "Does one thing well.",
    parameters: { type: "object", properties: { /* JSON Schema */ }, required: [] },
    execute: async (toolCallId, params) => ({
      content: [{ type: "text", text: "done" }],
      details: {},
    }),
  };
}
```

It auto-registers at startup. No config, no manifest.

## Style

- TypeScript strict mode; tabs; conventional commits (`feat:`, `fix:`, `docs:` ...)
- Comments in English or Chinese are both fine — clarity over purity
- PRs: small and focused, one logical change each

## Reporting bugs

Include: the tool trace (the agent prints tool calls), Node version, OS, and whether you're on Termux/Android.

## License & Contributions

By submitting a pull request, you agree that your contributions are licensed
under the Apache License 2.0, and that the project maintainer retains the
right to relicense future versions (including dual-licensing). This keeps
the project flexible long-term while all published versions remain open.
