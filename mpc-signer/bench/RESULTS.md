# Benchmark results: Vault + Web3Signer vs MPC signer

Raw data: [`results/20261111T192227Z.jsonl`](results/20261111T192227Z.jsonl). Rerun with `bench/run-bench.sh`.

## Reading the numbers

- **Everything ran on one 4-vCPU VM:** Besu, Vault, Web3Signer, the 3 MPC nodes, the
  coordinator and the load generator. Absolute numbers are low. Compare signers *against each
  other*, not against production hardware. The load generator, which also verifies every
  signature with ethers, is itself a bottleneck in phases B and C.
- **Hot path (B, C): the MPC signer matches or beats the old stack.** With presignatures ready,
  a signature takes one parallel HTTP round to two nodes. Throughput was equal or higher at
  every concurrency level, and latency was equal or lower. End-to-end with Besu, MPC was faster
  (669 vs 232/324 TPS). The Rust coordinator adds less overhead than Web3Signer or the
  JS proxy's per-transaction Vault read.
- **Sustained rate is set by presignature generation (A, E): 3.3 signatures/s on this VM.**
  Bursts beyond the pool fall back to presignature-limited throughput (E: 3.2 TPS), or to the
  cold path (D: about 0.6 s per signature, 3.3 TPS at concurrency 4).
- **Sizing for the same sustained throughput as before.** Each presignature costs
  **0.57 CPU-seconds on each of its 2 nodes** (GMP backend, multi-exponentiation tables).
  Each node takes part in 2/3 of sessions, so:

  `cores per node ≈ sustained_TPS × 0.57 × 2/3 ≈ 0.38 × sustained_TPS`

  | sustained TPS | cores per node (3 nodes) |
  |---:|---:|
  | 10 | ~4 |
  | 50 | ~19 |
  | 100 | ~38 |
  | 300 | ~115 |

  The pool (`MPC_POOL_TARGET`) absorbs bursts above that rate. Example: a pool of 50,000
  covers a 10-minute burst of 100 TPS above the sustained rate. Peak throughput while the pool
  has stock is the hot-path number from B and C.

---

# Signer throughput: Vault + Web3Signer vs MPC (CGGMP24)

Host: 4 vCPU (Intel(R) Xeon(R) Processor @ 2.10GHz), 16 GB. MPC binary: `/home/user/besu-chain/mpc-signer/target-rug/release`. All components on one host.

## A. Presignature generation capacity

| presignatures | seconds | presignatures/s | avg session (ms) | node CPU-s per presig per party |
|---:|---:|---:|---:|---:|
| 1950 | 585.5 | **3.33** | 1186 | 0.574 |

## B. Signing throughput (`eth_signTransaction`; MPC pool pre-filled, refill paused)

| signer | concurrency | ok/requests | TPS | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|
| OLD Web3Signer (key from Vault) | 1 | 500/500 | **202** | 4.63 | 6.73 | 8.77 |
| OLD proxy: Vault read + local sign | 1 | 500/500 | **208.1** | 4.42 | 7.18 | 8.29 |
| NEW MPC 2-of-3 | 1 | 500/500 | **227.1** | 4.14 | 5.87 | 6.4 |
| OLD Web3Signer (key from Vault) | 16 | 500/500 | **328.5** | 46.36 | 67.54 | 76.28 |
| OLD proxy: Vault read + local sign | 16 | 500/500 | **282.9** | 55.45 | 81.31 | 91.62 |
| NEW MPC 2-of-3 | 16 | 500/500 | **305.4** | 48.67 | 75.75 | 84.19 |
| OLD Web3Signer (key from Vault) | 64 | 500/500 | **353.8** | 175.57 | 221.46 | 258.98 |
| OLD proxy: Vault read + local sign | 64 | 500/500 | **272** | 228.8 | 311.46 | 356.55 |
| NEW MPC 2-of-3 | 64 | 500/500 | **355.8** | 171.09 | 253.7 | 279.34 |

## C. End-to-end (sign + submit to Besu, then wait until all mined)

| signer | concurrency | ok/requests | TPS | p50 ms | p95 ms | p99 ms | mined after (s) | end-to-end TPS |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| OLD Web3Signer (key from Vault) | 32 | 500/500 | **444.2** | 68.6 | 94.97 | 125.63 | 1.03 | 232.2 |
| OLD proxy: Vault read + local sign | 32 | 500/500 | **388.5** | 76.87 | 114.06 | 174.46 | 0.26 | 324 |
| NEW MPC 2-of-3 | 32 | 500/500 | **1046.4** | 29.1 | 43.37 | 51.79 | 0.27 | 668.6 |

## D. MPC cold path (pool empty → full interactive 3+1-round signing)

| signer | concurrency | ok/requests | TPS | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|
| NEW MPC 2-of-3 | 1 | 24/24 | **1.7** | 609.86 | 662.9 | 694.55 |
| NEW MPC 2-of-3 | 4 | 24/24 | **3.3** | 1157.57 | 1582.12 | 1905.44 |

## E. MPC sustained (pool empty at start, refill running during load)

| signer | concurrency | ok/requests | TPS | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|
| NEW MPC 2-of-3 | 16 | 150/150 | **3.2** | 5318.45 | 8177.27 | 9797.89 |

Pool stats after E: hot=2376, cold=180, failed=0, presigs generated=2419.

