# Benchmark results: Vault + Web3Signer vs MPC signer

Two runs on the same 4-vCPU VM, with identical phases:

| Run | MPC cluster | Report | Raw data |
|---|---|---|---|
| **Latest (Docker)** | `quickstart/` containers, GMP backend | [report](results/20261111T214737Z.md) | [jsonl](results/20261111T214737Z.jsonl) |
| Earlier (host processes) | `scripts/local-cluster.sh`, GMP backend | [report](results/20261111T192227Z.md) | [jsonl](results/20261111T192227Z.jsonl) |

Rerun with `bench/run-bench.sh`. It needs only Docker; see the README.

## Reading the numbers

- **Everything runs on one 4-vCPU VM:** Besu, Vault, Web3Signer, the 3 MPC nodes, the
  coordinator and the load generator. Compare signers *against each other*. The load
  generator, which verifies every signature with ethers, is itself a bottleneck in B and C.
- **Docker adds no measurable overhead.** Presignature rate was 3.39/s in containers vs 3.33/s
  as host processes.
- **Hot path (B): the MPC signer is on par with the old stack.** With presignatures ready, a
  signature costs one parallel HTTP round to two nodes. Across concurrency 1/16/64, all three
  signers stay within roughly ±15% of each other, about 200–350 TPS on this host.
- **Submission (C): MPC accepts transactions fastest** (Docker run: 905 TPS vs 426 for
  Web3Signer and 366 for Vault + local sign). End-to-end TPS, counted until everything is
  mined, is about 300–350 for all three. That figure is dominated by Besu's 1-second block
  period, not by the signer.
- **Sustained rate is set by presignature generation (A, E): about 3.4 signatures/s on this VM.**
  Bursts beyond the pool fall back to presignature-limited throughput (E: 3.1 TPS), or to the
  cold path (D: about 0.7 s per signature, 3.2 TPS at concurrency 4).
- **Sizing for the same sustained throughput as before.** Each presignature costs about
  **0.56 CPU-seconds on each of its 2 nodes** (GMP backend, multi-exponentiation tables).
  Each node takes part in 2/3 of sessions, so:

  `cores per node ≈ sustained_TPS × 0.56 × 2/3 ≈ 0.38 × sustained_TPS`

  | sustained TPS | cores per node (3 nodes) |
  |---:|---:|
  | 10 | ~4 |
  | 50 | ~19 |
  | 100 | ~38 |
  | 300 | ~115 |

  The pool (`MPC_POOL_TARGET`) absorbs bursts above that rate. Peak throughput while the pool
  has stock is the hot-path number above.

---

# Signer throughput: Vault + Web3Signer vs MPC (CGGMP24)

Host: 4 vCPU (Intel(R) Xeon(R) Processor @ 2.10GHz), 16 GB. MPC cluster: docker (bigint-rug). All components on one host.

## A. Presignature generation capacity

| presignatures | seconds | presignatures/s | avg session (ms) | node CPU-s per presig per party |
|---:|---:|---:|---:|---:|
| 1800 | 531.5 | **3.39** | 1173 | 0.563 |

## B. Signing throughput (`eth_signTransaction`; MPC pool pre-filled, refill paused)

| signer | concurrency | ok/requests | TPS | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|
| OLD Web3Signer (key from Vault) | 1 | 500/500 | **196.4** | 4.77 | 6.88 | 10.07 |
| OLD proxy: Vault read + local sign | 1 | 500/500 | **208** | 4.61 | 6.34 | 8.05 |
| NEW MPC 2-of-3 | 1 | 500/500 | **201** | 4.74 | 6.91 | 8.48 |
| OLD Web3Signer (key from Vault) | 16 | 500/500 | **342.1** | 44.69 | 63.89 | 73.28 |
| OLD proxy: Vault read + local sign | 16 | 500/500 | **235.9** | 64.15 | 105.72 | 128.68 |
| NEW MPC 2-of-3 | 16 | 500/500 | **319.1** | 49.79 | 66.04 | 73.78 |
| OLD Web3Signer (key from Vault) | 64 | 500/500 | **316.5** | 188.92 | 259.99 | 297.18 |
| OLD proxy: Vault read + local sign | 64 | 500/500 | **267** | 228.39 | 304.17 | 331.49 |
| NEW MPC 2-of-3 | 64 | 500/500 | **306.9** | 198.71 | 268.73 | 294.84 |

## C. End-to-end (sign + submit to Besu, then wait until all mined)

| signer | concurrency | ok/requests | TPS | p50 ms | p95 ms | p99 ms | mined after (s) | end-to-end TPS |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| OLD Web3Signer (key from Vault) | 32 | 500/500 | **426.2** | 68.93 | 125.99 | 138.78 | 0.27 | 346.5 |
| OLD proxy: Vault read + local sign | 32 | 500/500 | **365.6** | 86.65 | 119.51 | 136.42 | 0.26 | 307.1 |
| NEW MPC 2-of-3 | 32 | 500/500 | **905.4** | 31.09 | 57.7 | 67.66 | 1.03 | 315.8 |

## D. MPC cold path (pool empty → full interactive 3+1-round signing)

| signer | concurrency | ok/requests | TPS | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|
| NEW MPC 2-of-3 | 1 | 24/24 | **1.5** | 682.01 | 810.48 | 973.57 |
| NEW MPC 2-of-3 | 4 | 24/24 | **3.2** | 1199.86 | 1654.37 | 1784.9 |

## E. MPC sustained (pool empty at start, refill running during load)

| signer | concurrency | ok/requests | TPS | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|
| NEW MPC 2-of-3 | 16 | 150/150 | **3.1** | 5778.18 | 7976.15 | 9393.89 |

Pool stats after E: hot=2519, cold=175, failed=0, presigs generated=2806.

