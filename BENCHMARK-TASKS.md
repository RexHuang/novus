[简体中文](./BENCHMARK-TASKS.zh-CN.md) | English

# TB4 Terminal-Bench 4.0 — Task-Level PASS / FAIL List

> Snapshot: **2026-11-09 (audited)** · Score **54/66 = 81.8%** (the 2026-11-05 snapshot was 55/66; 9 runs were excluded by the contamination audit — see [BENCHMARKS.md](./BENCHMARKS.md). The table below is the historical 11-05 snapshot; 5 in-table PASSes were re-classified by the audit, which is authoritative.)
> Denominator = the official 66-task set; 65 tasks have verifier results (98.5% coverage), 1 task (GPU-only) has no result.
> Convention & methodology: see [BENCHMARKS.md](./BENCHMARKS.md) (简体中文: [BENCHMARKS.zh-CN.md](./BENCHMARKS.zh-CN.md)).

## ✅ PASS (55 tasks)

| # | Task | Status |
|---|------|--------|
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

## ❌ FAIL (10 tasks)

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1 | ctr-optimization | ❌ | 14 attempts; repeatedly killed by the 4h wall; best genuine CTR 2.07% vs 2.2% threshold (0.13pp short) |
| 2 | freight-dispatch-shift | ❌ | 21 attempts, unsolved |
| 3 | jax-speedrun-gpu | ❌ | GPU-only; our hardware (no NVIDIA GPU) cannot run it |
| 4 | ks-solver-cpp | ❌ | — |
| 5 | kv-live-surgery | ❌ | 6 attempts |
| 6 | layout-config-recreation | ❌ | Sibling task layout-config-recreation2 is PASSed |
| 7 | math-eval-grader | ❌ | 5 attempts |
| 8 | ontology-kg-querying | ❌ | — |
| 9 | rs-archive-clone | ❌ | 11 attempts (8 hangs) |
| 10 | takens-embedding-lean | ❌ | 52 attempts; a genuine math difficulty wall (rank-space permutation-type corruption, not infra death) |

## ⛔ No result (1 task)

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1 | fp8-rmsnorm-gemm | ⛔ | GPU-only; never produced a result.json (counted unsolved in the /66 denominator) |

---

*Data source: `tb4_score.py` (computed live on the run machine; PASS = best-of-all-runs verifier reward == 1.0; denominator = all 66 task dirs under `~/tb4/tasks`). Attempt counts in the FAIL notes come from the accumulated postmortem archive.*
