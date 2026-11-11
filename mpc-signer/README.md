# mpc-signer: non-exportable signer for Besu (replaces Vault + Web3Signer)

A 2-of-3 threshold ECDSA (secp256k1) signer built on **CGGMP24 / LFDT Lockness**. This is the
patched successor of the `cggmp21` crate, published as `cggmp24`.

**The private key never exists anywhere.** It is created by distributed key generation across
three nodes. Each node holds one share. Any two nodes produce a normal Ethereum signature
together. One stolen node, disk or admin account cannot sign and cannot recover the key.

It speaks the same JSON-RPC as Web3Signer (`eth_accounts`, `eth_signTransaction`,
`eth_sendTransaction`; everything else is proxied to Besu). Existing clients such as `../proxy`
switch to it by changing the signer URL.

```
 client / proxy ──JSON-RPC──► mpc-coordinator  (stateless, no key material)
                               │  • presignature pool  • policy pre-check  • Besu forwarding
                               │  • WebSocket relay (routes only; cannot read or forge)
            ┌──────────────────┼──────────────────┐   node API (bearer token)
            ▼                  ▼                  ▼
        mpc-node 0         mpc-node 1         mpc-node 2      one share each, sealed on disk
        policy ✓           policy ✓           policy ✓        each node checks every tx itself
            └──── MPC messages: Ed25519-signed, p2p ChaCha20-Poly1305 (X25519) ────┘
```

## How signing works

| Path | When | Request-time cost |
|---|---|---|
| **Hot** | a presignature is ready in the pool | 1 parallel HTTP call to 2 nodes; each node computes `k·m + r·χ` (no network rounds) |
| **Cold** | pool empty | full CGGMP24 interactive signing (3+1 rounds, Paillier ZK proofs) |

The coordinator keeps a pool of presignatures per key and refills it in the background,
spreading sessions across the node pairs {0,1}, {1,2} and {0,2}. Each hot signature uses up one
presignature. **Sustained throughput therefore equals the presignature generation rate.** The
pool only absorbs bursts.

Rules taken from the library's security notes:

- A presignature is **single-use**. Nodes keep presignatures **only in memory** and delete one
  *before* issuing its partial signature, so a restart or backup can never resurrect one.
- Nodes rebuild and keccak-hash the **full transaction** themselves. They never sign a bare hash.
  The library forbids raw-hash signing with presignatures.
- **No HD derivation** (`hd-wallet` feature off). HD combined with presignatures is the
  vulnerability fixed in 0.7. Each hot key gets its own DKG; aux info is shared across keys.
- **No key import/export** (`spof` feature off). The old Vault keys cannot be imported, by design.

## Layout

```
src/eth.rs          legacy EIP-155 RLP, keccak, address, recovery id (tested against EIP-155 vector)
src/transport.rs    signed + encrypted MPC message envelopes over the coordinator relay
src/store.rs        Argon2id + XChaCha20-Poly1305 sealed files (identity, aux info, key shares)
src/policy.rs       per-node policy: chain id, max value, max gas, destination allowlist
src/bin/mpc-node.rs         node API: aux, keygen, presign, partial, sign, discard
src/bin/mpc-coordinator.rs  JSON-RPC, relay, presignature pool, admin API
scripts/local-cluster.sh    run all 3 nodes + coordinator on one host (dev / bench)
deploy/                     Dockerfile-based deployment, one node per host
bench/                      throughput benchmark vs Vault + Web3Signer
```

## Quick start (single host, for development)

```bash
cargo build --release                                       # or: --no-default-features --features bigint-rug
scripts/local-cluster.sh init                               # node identities, cluster.json, tokens
BESU_RPC=http://127.0.0.1:8545 scripts/local-cluster.sh start
scripts/local-cluster.sh setup                              # aux info (~2-3 min, once) + first key
```

Create more keys with `scripts/local-cluster.sh admin POST /admin/keys`, and check the pool with
`curl localhost:9100/admin/pool`.

Use it like Web3Signer:

```bash
curl -s localhost:9100 -H 'content-type: application/json' --data \
 '{"jsonrpc":"2.0","id":1,"method":"eth_sendTransaction","params":[{"from":"0x<mpc address>","to":"0x…","gas":"0x5208","gasPrice":"0x0","value":"0x1"}]}'
```

For `../proxy`: set `WEB3SIGNER_IP` / `WEB3SIGNER_PORT` to the coordinator (port 9100) and use
the MPC address as `SENDER01`. The proxy's `sendFromVault` path (per-user keys read from Vault)
is what this project replaces. Each user account should become an MPC key (`POST /admin/keys`)
rather than a Vault secret.

## Production deployment

- Build the image (`docker build -t mpc-signer .`) and run `deploy/docker-compose.node.yml` on
  **three different hosts with different administrators**, ideally in different sites. If one
  person or one machine can reach two nodes, the threshold protects nothing.
- Run `mpc-node init` on each host, then assemble `cluster.json` from the three printed public
  keys (see `deploy/cluster.example.json`) and copy it to every host and to the coordinator.
- Run 1..N coordinators (`deploy/docker-compose.coordinator.yml`). They hold no secrets.
- Back up each node's `/data` (sealed shares) separately, under that node's own team.
- Size node CPU from benchmark phase A: `cores per node ≈ target_TPS × (CPU-s per presig per party) × 2/3`.

Still to do before production:

- mTLS on the node API. Today it uses a bearer token; message *contents* are already
  end-to-end protected.
- Authentication on the relay. Today anyone who can reach it can disrupt a session (denial of
  service), but cannot forge messages.
- Proactive key refresh. The library does not support it yet; rotate by creating a new key
  and moving funds.
- EIP-1559 (type-2) transactions. Only legacy EIP-155 is implemented, which is what the proxy
  uses (`gasPrice` 0).
- `cggmp24 0.7.0-alpha.3` is an alpha. The Kudelski audit covers an earlier version. Pin it and
  review the changes since the audit.

## Benchmark

```bash
cd bench && npm install && cd ..
REQUESTS=500 SEND_REQUESTS=500 bench/run-bench.sh   # starts Besu + Vault + Web3Signer + MPC cluster
```

See [`bench/RESULTS.md`](bench/RESULTS.md) for the latest results and how to read them.
