# MPC signer benchmarks

> **What:** Throughput and latency of the MPC signer, and how to size the MPC nodes.
> **For:** developers, capacity planning.
> **Related:** [MPC signer](../components/mpc-signer.md) · [development environment](../getting-started/development.md)

**Contents**
- [How to run](#how-to-run)
- [Measured results](#measured-results)
- [Reading the numbers](#reading-the-numbers)
- [Sizing the MPC nodes](#sizing-the-mpc-nodes)

---

## How to run

From `mpc-signer/`. It needs only Docker, bash and curl:

```bash
bench/run-bench.sh
```

It starts the quick-start cluster (3 MPC nodes + coordinator, `quickstart/`) and runs five phases.
Each run writes its report to `mpc-signer/bench/results/<time>.md` and the raw measurements to
`mpc-signer/bench/results/<time>.jsonl`. Options (request counts, concurrency, GMP backend, host
processes instead of Docker): "Benchmark" in [MPC signer](../components/mpc-signer.md#benchmark).

| Phase | Measures |
|---|---|
| A | presignature generation capacity: the sustained signing ceiling |
| B | signing throughput (`eth_signTransaction`), pool pre-filled, refill paused: the hot path |
| C | end-to-end: sign + submit to Besu + wait until mined |
| D | cold path: no presignature, full interactive 3+1-round signing |
| E | sustained: pool empty at start, refill running during the load |

## Measured results

One 4-vCPU VM (Intel Xeon @ 2.10 GHz, 16 GB), MPC cluster in Docker, GMP backend
(`bigint-rug`). Besu, the 3 MPC nodes, the coordinator and the load generator all run on that
host.

**A. Presignature generation**

| presignatures | seconds | presignatures/s | avg session (ms) | node CPU-s per presignature per party |
|---:|---:|---:|---:|---:|
| 1800 | 531.5 | **3.39** | 1173 | 0.563 |

**B. Hot-path signing** (500 requests per run)

| concurrency | TPS | p50 ms | p95 ms | p99 ms |
|---:|---:|---:|---:|---:|
| 1 | **201** | 4.74 | 6.91 | 8.48 |
| 16 | **319.1** | 49.79 | 66.04 | 73.78 |
| 64 | **306.9** | 198.71 | 268.73 | 294.84 |

**C. End-to-end** (500 transactions, concurrency 32)

| submission TPS | p50 ms | p95 ms | p99 ms | all mined after (s) | end-to-end TPS |
|---:|---:|---:|---:|---:|---:|
| **905.4** | 31.09 | 57.7 | 67.66 | 1.03 | 315.8 |

**D. Cold path** (24 requests per run)

| concurrency | TPS | p50 ms | p95 ms | p99 ms |
|---:|---:|---:|---:|---:|
| 1 | **1.5** | 682.01 | 810.48 | 973.57 |
| 4 | **3.2** | 1199.86 | 1654.37 | 1784.9 |

**E. Sustained** (150 requests, concurrency 16, pool empty at start)

| TPS | p50 ms | p95 ms | p99 ms |
|---:|---:|---:|---:|
| **3.1** | 5778.18 | 7976.15 | 9393.89 |

Pool counters after E: hot = 2519, cold = 175, failed = 0, presignatures generated = 2806.

## Reading the numbers

- **Everything runs on one VM.** The load generator, which verifies every signature, is itself
  a bottleneck in B and C. Absolute numbers are lower bounds for separate hosts.
- **Docker adds no measurable overhead.** The same run with host processes
  (`MPC_RUNTIME=native`) made 3.33 presignatures/s, against 3.39/s in containers.
- **Hot path (B): 200–320 TPS.** With presignatures ready, a signature costs one parallel HTTP
  round to two nodes, about 5 ms at concurrency 1.
- **End-to-end (C):** the coordinator accepts about 900 transactions/s. Counted until everything
  is mined, it is about 315 TPS, set by Besu's 1-second block period rather than by the signer.
- **Sustained rate is set by presignature generation (A, E): about 3.4 signatures/s on this VM.**
  Once the pool is empty, throughput drops to the presigning rate (E: 3.1 TPS), or to the cold
  path (D: about 0.7 s per signature, 1.5 TPS at concurrency 1, 3.2 TPS at concurrency 4).

## Sizing the MPC nodes

Each presignature costs about **0.56 CPU-seconds on each of its 2 nodes** (GMP backend,
multi-exponentiation tables). Each node takes part in 2/3 of sessions, so:

`cores per node ≈ sustained_TPS × 0.56 × 2/3 ≈ 0.38 × sustained_TPS`

| sustained TPS | cores per node (3 nodes) |
|---:|---:|
| 10 | ~4 |
| 50 | ~19 |
| 100 | ~38 |
| 300 | ~115 |

- The pools absorb bursts above that rate: `MPC_POOL_TARGET` per `big` key and
  `MPC_POOL_TARGET_SMALL` per `small` key, on each coordinator. Peak throughput while a pool has
  stock is the hot-path number above.
- Every coordinator fills its own pools, so two coordinators with the same targets double the
  presigning work. Setting `MPC_POOL_TARGET_SMALL=0` on the standby coordinator avoids that for
  small keys ([MPC signer in production](../deployment/mpc-signer-production.md#presignature-pools-big-small-and-none)).
- The pure-Rust backend (`bigint-num`) presigns several times slower than GMP: size for that if
  you build without `BIGINT=bigint-rug`.
- To raise the rate, give the nodes more cores and raise `MPC_COMPUTE_THREADS` (nodes) and
  `MPC_REFILL_CONCURRENCY` (coordinators).
