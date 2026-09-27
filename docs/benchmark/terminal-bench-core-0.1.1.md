# novus on Terminal-Bench Core 0.1.1 — Self-Reported Results

**Final score: 34/80 tasks resolved = 42.50%** (186 total trial attempts, all 80 tasks attempted)

| Item | Value |
|---|---|
| Agent | [novus](https://github.com/RexHuang/novus) (self-improving super-agent) |
| Model | GLM-5.3-flash via Zhipu anthropic-compatible endpoint |
| Harness | terminal-bench 0.2.18 (legacy CLI) |
| Dataset | terminal-bench-core 0.1.1 (80 tasks) |
| Environment | Local Docker on a home server (Ubuntu, amd64), 2026-09-26 → 09-28 |
| Official leaderboard | Not submitted — external submissions are not accepted (see harbor-framework/terminal-bench#1507). Self-reported only. |

## Honesty / disclosure

- Mid-run, Debian 11 (bullseye) reached EOL and its security apt pool was removed globally, breaking several task images. We restored builds with a **shadow base image** (same task Dockerfiles, but sources.list pointed to Aliyun main+updates mirrors plus apt retry / dpkg non-interactive hardening). **No task logic, tests, or oracle solutions were modified.**
- A TLS-tunnel HTTP proxy was used for network-restricted domains (PyPI/HF/github raw). Task containers inherited normal proxy env; no allowlist of verifier endpoints.
- Failed tasks below include some where the agent completed the work but infra still blocked it (e.g. qemu-alpine-ssh: 26 attempts, trials ran but never resolved).

## Per-task results

| Task | Attempts | Resolved |
|---|---|---|
| blind-maze-explorer-5x5 | 1 | ❌ |
| blind-maze-explorer-algorithm | 1 | ✅ |
| blind-maze-explorer-algorithm.easy | 1 | ❌ |
| blind-maze-explorer-algorithm.hard | 1 | ✅ |
| build-initramfs-qemu | 11 | ❌ |
| build-linux-kernel-qemu | 4 | ❌ |
| build-tcc-qemu | 2 | ❌ |
| cartpole-rl-training | 1 | ✅ |
| chess-best-move | 1 | ❌ |
| conda-env-conflict-resolution | 1 | ❌ |
| configure-git-webserver | 1 | ❌ |
| count-dataset-tokens | 1 | ✅ |
| crack-7z-hash | 1 | ✅ |
| crack-7z-hash.easy | 9 | ✅ |
| crack-7z-hash.hard | 8 | ✅ |
| create-bucket | 1 | ❌ |
| cron-broken-network | 1 | ❌ |
| csv-to-parquet | 1 | ✅ |
| decommissioning-service-with-sensitive-data | 1 | ❌ |
| download-youtube | 1 | ❌ |
| eval-mteb | 1 | ✅ |
| eval-mteb.hard | 1 | ✅ |
| extract-moves-from-video | 1 | ❌ |
| extract-safely | 1 | ✅ |
| fibonacci-server | 1 | ❌ |
| fix-git | 1 | ✅ |
| fix-pandas-version | 1 | ✅ |
| fix-permissions | 1 | ✅ |
| get-bitcoin-nodes | 1 | ❌ |
| git-multibranch | 1 | ❌ |
| git-workflow-hack | 1 | ✅ |
| gpt2-codegolf | 1 | ❌ |
| grid-pattern-transform | 1 | ✅ |
| hello-world | 1 | ✅ |
| heterogeneous-dates | 1 | ❌ |
| hf-model-inference | 1 | ❌ |
| incompatible-python-fasttext | 1 | ✅ |
| incompatible-python-fasttext.base_with_hint | 1 | ✅ |
| intrusion-detection | 1 | ❌ |
| jupyter-notebook-server | 1 | ❌ |
| modernize-fortran-build | 1 | ✅ |
| new-encrypt-command | 1 | ❌ |
| nginx-request-logging | 1 | ❌ |
| oom | 1 | ✅ |
| openssl-selfsigned-cert | 1 | ✅ |
| organization-json-generator | 1 | ❌ |
| password-recovery | 1 | ✅ |
| path-tracing | 1 | ❌ |
| path-tracing-reverse | 1 | ❌ |
| play-zork | 3 | ❌ |
| polyglot-c-py | 1 | ❌ |
| polyglot-rust-c | 1 | ❌ |
| processing-pipeline | 1 | ✅ |
| prove-plus-comm | 1 | ✅ |
| pytorch-model-cli | 1 | ❌ |
| pytorch-model-cli.easy | 1 | ✅ |
| pytorch-model-cli.hard | 1 | ❌ |
| qemu-alpine-ssh | 26 | ❌ |
| qemu-startup | 25 | ✅ |
| raman-fitting | 1 | ❌ |
| raman-fitting.easy | 1 | ❌ |
| reshard-c4-data | 1 | ❌ |
| run-pdp11-code | 1 | ❌ |
| sanitize-git-repo | 3 | ❌ |
| sanitize-git-repo.hard | 4 | ❌ |
| security-vulhub-minio | 11 | ❌ |
| simple-sheets-put | 1 | ✅ |
| simple-web-scraper | 1 | ✅ |
| solana-data | 1 | ❌ |
| sqlite-db-truncate | 1 | ✅ |
| sqlite-with-gcov | 1 | ✅ |
| super-benchmark-upet | 8 | ❌ |
| swe-bench-astropy-1 | 1 | ✅ |
| swe-bench-astropy-2 | 2 | ❌ |
| swe-bench-fsspec | 2 | ❌ |
| swe-bench-langcodes | 2 | ✅ |
| tmux-advanced-workflow | 1 | ✅ |
| train-fasttext | 1 | ❌ |
| vim-terminal-task | 2 | ❌ |
| write-compressor | 1 | ❌ |

## Failed tasks (46)

blind-maze-explorer-5x5 blind-maze-explorer-algorithm.easy build-initramfs-qemu build-linux-kernel-qemu build-tcc-qemu chess-best-move conda-env-conflict-resolution configure-git-webserver create-bucket cron-broken-network decommissioning-service-with-sensitive-data download-youtube extract-moves-from-video fibonacci-server get-bitcoin-nodes git-multibranch gpt2-codegolf heterogeneous-dates hf-model-inference intrusion-detection jupyter-notebook-server new-encrypt-command nginx-request-logging organization-json-generator path-tracing path-tracing-reverse play-zork polyglot-c-py polyglot-rust-c pytorch-model-cli pytorch-model-cli.hard qemu-alpine-ssh raman-fitting raman-fitting.easy reshard-c4-data run-pdp11-code sanitize-git-repo sanitize-git-repo.hard security-vulhub-minio solana-data super-benchmark-upet swe-bench-astropy-2 swe-bench-fsspec train-fasttext vim-terminal-task write-compressor

## Notes

- qemu-startup: resolved after 25 attempts — the same infra breakage that initially made it look impossible; first genuine pass came immediately after the shadow-image fix.
- Hardest unresolved clusters: qemu/OS builds, swe-bench (2/3 failed), video/multimodal tasks, RL training.
