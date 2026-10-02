# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| latest release (v1.1.x) | ✅ |
| `main` branch | ✅ |
| older releases | ❌ — please upgrade |

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

Preferred channels, in order:

1. **GitHub private vulnerability report** — use the *Report a vulnerability* button in this repository's **Security** tab.
2. If private reporting is unavailable, contact the repository owner directly with `[security]` in the subject line.

When reporting, please include:

- affected version / commit SHA and deployment mode (`cli`, `serve`, multi-tenant `--auth-file`)
- environment (Node.js version, OS, single-user vs multi-tenant)
- reproduction steps or PoC (keep exploit details proportional to the impact)
- your assessment of severity, and whether you want public credit

**You will receive an acknowledgement within 3 business days**, and a status update at least every 7 days until the issue is resolved or declined.

## Scope — especially appreciated

Novus is an agent that **executes tools, writes files, and reads/writes its own source code**, so the following areas matter most:

- **Multi-tenant serve mode (`--serve --auth-file`)** — tenant isolation is the core security boundary. Row-level scoping of knowledge / experience / knowledge-graph stores (hardened in v1.1.1) must never leak entries across tenants, and destructive operations must stay tenant-scoped.
- **Tool execution** — any path where an agent-initiated shell command, file write, or network call can escape the intended workspace or privilege level.
- **Identity & credentials** — how identity files, API keys from environment variables, and session cookies are stored, loaded, and injected.
- **Serve HTTP API + Web UI** — auth bypass, SSRF, injection, session fixation, cross-tenant session pollution.

Out of scope:

- Issues requiring physical access to an already-trusted machine.
- Offensive or unsafe content produced by the underlying LLM (report to your model provider).
- Vulnerabilities in dependencies that do not affect Novus's own attack surface (please report upstream; we track advisories and will bump versions promptly).

## Safe harbor & credit

Good-faith security research is welcome. We ask that you give us a reasonable window to fix before any public disclosure.

Reporters are credited in the CHANGELOG and release notes unless anonymity is requested. For a real example of this process working, see the v1.1.1 security release, credited to [@CaiHB2000](https://github.com/CaiHB2000) for responsible disclosure of the multi-tenant isolation issue (#1).
