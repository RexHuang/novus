# TB4 Terminal-Bench 4.0 — 题目级 PASS / FAIL 清单

> 快照：**2026-11-05** · 成绩 **55/66 = 83.3%**（best-of-all-runs，hint 辅助多轮迭代口径）
> 分母 = 官方 66 题；65 题已出分（覆盖 98.5%），1 题（GPU-only）无 result。
> 口径与方法论详见 [BENCHMARKS.zh-CN.md](BENCHMARKS.zh-CN.md)（英文版 [BENCHMARKS.md](BENCHMARKS.md)）。

## ✅ PASS（55 题）

| # | 题目 | 状态 |
|---|------|------|
| 1 | atrx-vep-crispr | ✅ |
| 2 | batched-eval-parity | ✅ |
| 3 | biped-contact-dynamics | ✅ |
| 4 | bun-sourcemap-leak | ✅ |
| 5 | cad-model | ✅ |
| 6 | cargo-flight-dispatch | ✅ |
| 7 | coq-block-bound | ✅ |
| 8 | cumulative-layout-shift | ✅ |
| 9 | data-anonymization | ✅ |
| 10 | distributed-dedup | ✅ |
| 11 | embedding-drift-monitor | ✅ |
| 12 | fin-saccr-rwa | ✅ |
| 13 | foodstuff-beta-activity | ✅ |
| 14 | formal-crypto | ✅ |
| 15 | freecad-impeller | ✅ |
| 16 | freecad-platform-drawing | ✅ |
| 17 | freecad-spring-clip | ✅ |
| 18 | glycan-ms2-elucidation | ✅ |
| 19 | gsea-proteomics | ✅ |
| 20 | heat-pump-warranty | ✅ |
| 21 | hof-topology-interpenetration | ✅ |
| 22 | html-js-filter | ✅ |
| 23 | interleaved-vigenere | ✅ |
| 24 | intrastat-meldung | ✅ |
| 25 | lake-temp-glm | ✅ |
| 26 | layout-config-recreation2 | ✅ |
| 27 | legacy-utility-triage | ✅ |
| 28 | live-database-cutover | ✅ |
| 29 | medical-claims-processing | ✅ |
| 30 | mp-checkpoint-consolidation | ✅ |
| 31 | music-harmony | ✅ |
| 32 | mvcc-lsm-compaction | ✅ |
| 33 | nextjs-performance | ✅ |
| 34 | payments-pipeline-fix | ✅ |
| 35 | photonic-waveguide-routing | ✅ |
| 36 | pretrain-shard-corruption | ✅ |
| 37 | production-planning | ✅ |
| 38 | protein-autointerp-disulfide | ✅ |
| 39 | react-lead-form | ✅ |
| 40 | retro-console-soc | ✅ |
| 41 | risk-scorer-replay | ✅ |
| 42 | roy-polymorph-cn | ✅ |
| 43 | satb-audio-transcription | ✅ |
| 44 | session-window-debug | ✅ |
| 45 | sglang-qwen-burst | ✅ |
| 46 | shadow-relay | ✅ |
| 47 | sound-change-cascade | ✅ |
| 48 | telecom-entity-resolution | ✅ |
| 49 | uefi-bootkit | ✅ |
| 50 | vba-userform-port | ✅ |
| 51 | vf2-speedup-networkx | ✅ |
| 52 | vllm-deepseek-streaming | ✅ |
| 53 | vpp-loss-divergence | ✅ |
| 54 | wal-recovery-ordering | ✅ |
| 55 | wdm-design | ✅ |

## ❌ FAIL（10 题）

| # | 题目 | 状态 | 备注 |
|---|------|------|------|
| 1 | ctr-optimization | ❌ | 14 发；反复死于 4h 时间墙，最佳 genuine CTR 2.07%（阈值 2.2%，差 0.13pp） |
| 2 | freight-dispatch-shift | ❌ | 21 发未破 |
| 3 | jax-speedrun-gpu | ❌ | GPU-only，本机硬件（无 NVIDIA GPU）跑不了 |
| 4 | ks-solver-cpp | ❌ | — |
| 5 | kv-live-surgery | ❌ | 6 发 |
| 6 | layout-config-recreation | ❌ | 姊妹题 layout-config-recreation2 已 PASS |
| 7 | math-eval-grader | ❌ | 5 发 |
| 8 | ontology-kg-querying | ❌ | — |
| 9 | rs-archive-clone | ❌ | 11 发（其中 8 次 hang） |
| 10 | takens-embedding-lean | ❌ | 52 发；真数学难度墙（rank-space 置换类损坏，非基建死） |

## ⛔ 无 result（1 题）

| # | 题目 | 状态 | 备注 |
|---|------|------|------|
| 1 | fp8-rmsnorm-gemm | ⛔ | GPU-only，从未跑出 result.json（66 题分母中计为未解） |

---

*数据源：`tb4_score.py`（35 机现算，best-of-all-runs verifier reward==1.0；分母 = `~/tb4/tasks` 全部 66 题目录）。失败题备注中的"发数"= 验尸档案（postmortems/）累计尝试轮次。*
