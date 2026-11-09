[简体中文](./BENCHMARK-TASKS.zh-CN.md) | English

# TB4 Terminal-Bench 4.0 — Task-Level Results

> Snapshot: **2026-11-09 (audited)** · Score **54/66 = 81.8%** — raw best-of-all-runs is 63/66; the contamination audit (2026-11-09) flagged 9 runs as non-compliant, excluded pending re-verification (see the audit section in [BENCHMARKS.md](./BENCHMARKS.md)).
> Denominator = the official 66-task set; 64 tasks have verifier results, 2 GPU-only tasks produced no result on our (CPU-only) hardware.
> Convention & methodology: see [BENCHMARKS.md](./BENCHMARKS.md) (简体中文: [BENCHMARKS.zh-CN.md](./BENCHMARKS.zh-CN.md)).

## ✅ PASS (54 tasks)

| # | Task | Status |
|---|------|--------|
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

## 🔁 Pending re-verification (9 tasks)

Flagged by the 2026-11-09 compliance audit; excluded from the 54/66 score until re-verified.

| # | Task | Status |
|---|------|--------|
| 1 | biped-contact-dynamics | 🔁 |
| 2 | formal-crypto | 🔁 |
| 3 | ks-solver-cpp | 🔁 |
| 4 | layout-config-recreation | 🔁 |
| 5 | ontology-kg-querying | 🔁 |
| 6 | retro-console-soc | 🔁 |
| 7 | takens-embedding-lean | 🔁 |
| 8 | uefi-bootkit | 🔁 |
| 9 | vba-userform-port | 🔁 |

## ❌ FAIL (1 task)

Attempted on CPU; no PASS run.

| # | Task | Status |
|---|------|--------|
| 1 | math-eval-grader | ❌ |

## ⛔ No result (2 tasks)

GPU-only; our hardware (no NVIDIA GPU) cannot run them.

| # | Task | Status |
|---|------|--------|
| 1 | fp8-rmsnorm-gemm | ⛔ |
| 2 | jax-speedrun-gpu | ⛔ |

---

*Data source: `tb4_score.py` (computed live on the run machine; PASS = best-of-all-runs verifier reward == 1.0; denominator = all 66 task dirs under `~/tb4/tasks`).*
