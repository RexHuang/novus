[English](./BENCHMARK-TASKS.md) | 简体中文

# TB4 Terminal-Bench 4.0 — 题目级成绩清单

> 快照:**2026-11-09(审计后)** · 成绩 **54/66 = 81.8%**——raw best-of-all-runs 为 63/66;合规审计(2026-11-09)判定 9 个 run 不合规、待重新验证,从成绩中剔除(明细见 [BENCHMARKS.zh-CN.md](./BENCHMARKS.zh-CN.md) 合规审计一节)。
> 分母 = 官方 66 题;64 题已出分,2 道 GPU-only 题在我方(纯 CPU)硬件上无 result。
> 口径与方法论详见 [BENCHMARKS.zh-CN.md](BENCHMARKS.zh-CN.md)(英文版 [BENCHMARK-TASKS.md](BENCHMARK-TASKS.md))。

## ✅ PASS（54 题）

| # | 题目 | 状态 |
|---|------|------|
| 1 | atrx-vep-crispr | ✅ |
| 2 | batched-eval-parity | ✅ |
| 3 | bun-sourcemap-leak | ✅ |
| 4 | cad-model | ✅ |
| 5 | cargo-flight-dispatch | ✅ |
| 6 | coq-block-bound | ✅ |
| 7 | ctr-optimization | ✅ |
| 8 | cumulative-layout-shift | ✅ |
| 9 | data-anonymization | ✅ |
| 10 | distributed-dedup | ✅ |
| 11 | embedding-drift-monitor | ✅ |
| 12 | fin-saccr-rwa | ✅ |
| 13 | foodstuff-beta-activity | ✅ |
| 14 | freecad-impeller | ✅ |
| 15 | freecad-platform-drawing | ✅ |
| 16 | freecad-spring-clip | ✅ |
| 17 | freight-dispatch-shift | ✅ |
| 18 | glycan-ms2-elucidation | ✅ |
| 19 | gsea-proteomics | ✅ |
| 20 | heat-pump-warranty | ✅ |
| 21 | hof-topology-interpenetration | ✅ |
| 22 | html-js-filter | ✅ |
| 23 | interleaved-vigenere | ✅ |
| 24 | intrastat-meldung | ✅ |
| 25 | kv-live-surgery | ✅ |
| 26 | lake-temp-glm | ✅ |
| 27 | layout-config-recreation2 | ✅ |
| 28 | legacy-utility-triage | ✅ |
| 29 | live-database-cutover | ✅ |
| 30 | medical-claims-processing | ✅ |
| 31 | mp-checkpoint-consolidation | ✅ |
| 32 | music-harmony | ✅ |
| 33 | mvcc-lsm-compaction | ✅ |
| 34 | nextjs-performance | ✅ |
| 35 | payments-pipeline-fix | ✅ |
| 36 | photonic-waveguide-routing | ✅ |
| 37 | pretrain-shard-corruption | ✅ |
| 38 | production-planning | ✅ |
| 39 | protein-autointerp-disulfide | ✅ |
| 40 | react-lead-form | ✅ |
| 41 | risk-scorer-replay | ✅ |
| 42 | roy-polymorph-cn | ✅ |
| 43 | rs-archive-clone | ✅ |
| 44 | satb-audio-transcription | ✅ |
| 45 | session-window-debug | ✅ |
| 46 | sglang-qwen-burst | ✅ |
| 47 | shadow-relay | ✅ |
| 48 | sound-change-cascade | ✅ |
| 49 | telecom-entity-resolution | ✅ |
| 50 | vf2-speedup-networkx | ✅ |
| 51 | vllm-deepseek-streaming | ✅ |
| 52 | vpp-loss-divergence | ✅ |
| 53 | wal-recovery-ordering | ✅ |
| 54 | wdm-design | ✅ |

## 🔁 待重新验证（9 题）

2026-11-09 合规审计判定不合规;重验通过前不计入 54/66 成绩。

| # | 题目 | 状态 |
|---|------|------|
| 1 | biped-contact-dynamics | 🔁 |
| 2 | formal-crypto | 🔁 |
| 3 | ks-solver-cpp | 🔁 |
| 4 | layout-config-recreation | 🔁 |
| 5 | ontology-kg-querying | 🔁 |
| 6 | retro-console-soc | 🔁 |
| 7 | takens-embedding-lean | 🔁 |
| 8 | uefi-bootkit | 🔁 |
| 9 | vba-userform-port | 🔁 |

## ❌ FAIL（1 题）

已在 CPU 上尝试,无 PASS run。

| # | 题目 | 状态 |
|---|------|------|
| 1 | math-eval-grader | ❌ |

## ⛔ 无结果（2 题）

GPU-only;我方硬件(无 NVIDIA GPU)无法运行。

| # | 题目 | 状态 |
|---|------|------|
| 1 | fp8-rmsnorm-gemm | ⛔ |
| 2 | jax-speedrun-gpu | ⛔ |

---

*数据来源:`tb4_score.py`(在跑分机上现算;PASS = best-of-all-runs verifier reward == 1.0;分母 = `~/tb4/tasks` 下全部 66 个题目目录)。*
