[简体中文](./BENCHMARK-TASKS.zh-CN.md) | English

# TB4 Terminal-Bench 4.0 — Task-Level Results

> Snapshot: **2026-11-23** · Score **56/66 = 84.8%**.
> Denominator = the official 66-task set; 64 tasks have verifier results, 2 GPU-only tasks produced no result on our (CPU-only) hardware.
> Convention & methodology: see [BENCHMARKS.md](./BENCHMARKS.md) (简体中文: [BENCHMARKS.zh-CN.md](./BENCHMARKS.zh-CN.md)).

## ✅ PASS (56 tasks)

| # | Task | Status |
|---|------|--------|
| 1 | atrx-vep-crispr | ✅ |
| 2 | batched-eval-parity | ✅ |
| 3 | biped-contact-dynamics | ✅ |
| 4 | bun-sourcemap-leak | ✅ |
| 5 | cad-model | ✅ |
| 6 | cargo-flight-dispatch | ✅ |
| 7 | coq-block-bound | ✅ |
| 8 | ctr-optimization | ✅ |
| 9 | cumulative-layout-shift | ✅ |
| 10 | data-anonymization | ✅ |
| 11 | distributed-dedup | ✅ |
| 12 | embedding-drift-monitor | ✅ |
| 13 | fin-saccr-rwa | ✅ |
| 14 | foodstuff-beta-activity | ✅ |
| 15 | formal-crypto | ✅ |
| 16 | freecad-impeller | ✅ |
| 17 | freecad-platform-drawing | ✅ |
| 18 | freecad-spring-clip | ✅ |
| 19 | freight-dispatch-shift | ✅ |
| 20 | glycan-ms2-elucidation | ✅ |
| 21 | gsea-proteomics | ✅ |
| 22 | heat-pump-warranty | ✅ |
| 23 | hof-topology-interpenetration | ✅ |
| 24 | html-js-filter | ✅ |
| 25 | interleaved-vigenere | ✅ |
| 26 | intrastat-meldung | ✅ |
| 27 | kv-live-surgery | ✅ |
| 28 | lake-temp-glm | ✅ |
| 29 | layout-config-recreation2 | ✅ |
| 30 | legacy-utility-triage | ✅ |
| 31 | live-database-cutover | ✅ |
| 32 | medical-claims-processing | ✅ |
| 33 | mp-checkpoint-consolidation | ✅ |
| 34 | music-harmony | ✅ |
| 35 | mvcc-lsm-compaction | ✅ |
| 36 | nextjs-performance | ✅ |
| 37 | payments-pipeline-fix | ✅ |
| 38 | photonic-waveguide-routing | ✅ |
| 39 | pretrain-shard-corruption | ✅ |
| 40 | production-planning | ✅ |
| 41 | protein-autointerp-disulfide | ✅ |
| 42 | react-lead-form | ✅ |
| 43 | risk-scorer-replay | ✅ |
| 44 | roy-polymorph-cn | ✅ |
| 45 | rs-archive-clone | ✅ |
| 46 | satb-audio-transcription | ✅ |
| 47 | session-window-debug | ✅ |
| 48 | shadow-relay | ✅ |
| 49 | sglang-qwen-burst | ✅ |
| 50 | sound-change-cascade | ✅ |
| 51 | telecom-entity-resolution | ✅ |
| 52 | vf2-speedup-networkx | ✅ |
| 53 | vllm-deepseek-streaming | ✅ |
| 54 | vpp-loss-divergence | ✅ |
| 55 | wal-recovery-ordering | ✅ |
| 56 | wdm-design | ✅ |

## ❌ FAIL (8 tasks)

Attempted; no score-crediting PASS run.

| # | Task | Status |
|---|------|--------|
| 1 | math-eval-grader | ❌ |
| 2 | ks-solver-cpp | ❌ |
| 3 | layout-config-recreation | ❌ |
| 4 | ontology-kg-querying | ❌ |
| 5 | retro-console-soc | ❌ |
| 6 | takens-embedding-lean | ❌ |
| 7 | uefi-bootkit | ❌ |
| 8 | vba-userform-port | ❌ |

## ⛔ No result (2 tasks)

GPU-only; our hardware (no NVIDIA GPU) cannot run them.

| # | Task | Status |
|---|------|--------|
| 1 | fp8-rmsnorm-gemm | ⛔ |
| 2 | jax-speedrun-gpu | ⛔ |

---

*Data source: `tb4_score.py` (computed live on the run machine; PASS = best-of-all-runs verifier reward == 1.0; denominator = all 66 task dirs under `~/tb4/tasks`).*
