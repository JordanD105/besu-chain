# Run the proxy with the MPC signer (no Vault, no Web3Signer)

This guide starts from nothing and sets up the proxy so that every transaction is signed by the
2-of-3 MPC signer:

- The hot sender `SENDER01` is an MPC key.
- Every account created by `/createaccount` is an MPC key.
- No private key is ever created, stored or exported anywhere.

Vault and Web3Signer are not needed.

```
client → proxy :30000 ──eth_sendTransaction──► mpc-coordinator :9100 ──► 2 of 3 mpc-nodes
            │  └─/createaccount─► POST /admin/keys (DKG)          │
            └── Redis :36379                                       └──raw tx──► Besu :8545
```

Everything below was tested end to end:
- `/createaccount` created an MPC key in about 0.7 s.
- `/transfer` from a user account took about 1.5 s on the cold path.
- `/nft/deploy` set the MPC sender as minter.
- `/nft/mint`, paid from a user account, took about 1.8 s.

The examples assume one Docker host, `192.168.68.130`. Replace it with your host's IP.

---

## Step 1: Start the MPC signer and create the sender key

```bash
cd mpc-signer/quickstart
MPC_BIGINT=bigint-rug CHAIN_ID=1337 ./quickstart.sh init
./quickstart.sh up
./quickstart.sh setup
```

| Setting | Effect |
|---|---|
| `MPC_BIGINT=bigint-rug` | GMP backend, faster presigning. It adds an LGPL dependency; leave it out to use the pure-Rust default. |
| `CHAIN_ID` | Must equal the `chainId` in Besu's genesis (1337 in `besu-test-network`). |

If `init` says **already initialised**, a cluster from an earlier run exists. Either:
- keep it: check `grep chain_id cluster.json` shows your chain id, then run `up` and `setup`. To switch to the faster backend, set `MPC_BIGINT=bigint-rug` in `.env` and run `docker compose build node0` first.
- or run `./quickstart.sh destroy` to delete it and its key shares, then `init` again.

`setup` runs aux-info generation once (a few minutes), then creates the first key and prints it:

```json
{"key_id":"0x3a55…111d","address":"0x3a554bc204821a020b6a12749aaf95b23b82111d", ...}
```

**This address is `SENDER01`**, the account that funds new accounts and mints NFTs. Write it down.
Besu does not need to be running yet: key generation only involves the 3 MPC nodes.

Check the signing policy in `quickstart/cluster.json`. Every node enforces it:
- `chain_id` must match the chain.
- `max_value_wei` must cover your largest `/createaccount` amount or transfer. The default is 1000 ETH.

If you edit the policy, run `./quickstart.sh down && ./quickstart.sh up`.

## Step 2: Give `SENDER01` a balance in the genesis block

Starting fresh, the simplest way is to pre-fund the MPC address in genesis. Edit
`besu-test-network/config/besu/genesis.json`, in the `alloc` section:

```json
"alloc": {
  "3a554bc204821a020b6a12749aaf95b23b82111d": {
    "balance": "0xd3c21bcecceda1000000"
  }
}
```

- Use your address from step 1, without the `0x` prefix. `0xd3c21bcecceda1000000` is 1,000,000 ETH.
- **Remove the well-known development accounts** (`fe3b55…`, `627306…`, `f17f52…`, …). Their private keys are public, so anyone could spend those balances.
- The gas price is 0 on this chain, so `SENDER01` only needs ETH for the value it sends.

Start the network. If it ran before, `./remove.sh` deletes the old chain data, so only do that
when starting from scratch:

```bash
cd besu-test-network
./remove.sh      # only if a previous chain exists: deletes it
./run.sh
```

Check the balance:

```bash
curl -s localhost:8545 -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_getBalance","params":["0x<SENDER01>","latest"]}'
```

## Step 3: Point the coordinator at Besu, and pool only the hot sender

Edit `mpc-signer/quickstart/.env`:

```bash
# Besu as seen from the coordinator container (rpcnode on the same host)
MPC_BESU_RPC=http://host.docker.internal:8545
# Only SENDER01 keeps a presignature pool (fast signing, ~1 network round).
# User accounts created by /createaccount are signed on the cold path (~0.6-1.5 s),
# so thousands of accounts do not create background presigning work.
MPC_POOL_KEYS=0x3a554bc204821a020b6a12749aaf95b23b82111d
# Listen on the host IP so the proxy container can reach the coordinator
MPC_PUBLISH=192.168.68.130:9100
```

Apply the changes:

```bash
cd mpc-signer/quickstart && ./quickstart.sh up
curl -s http://192.168.68.130:9100/admin/pool
```

In the pool output, `SENDER01` should show `"pooled": true`. `ready` climbs toward `MPC_POOL_TARGET` (200).

If more accounts send often (for example a second funding account), add them to `MPC_POOL_KEYS`,
separated by commas.

## Step 4: Configure the proxy for the MPC signer

`proxy/.env`, with no `VAULT_*` settings:

```bash
PORT=30000
BESU_IP=192.168.68.130
BESU_PORT=8545

# The MPC coordinator speaks the same JSON-RPC as Web3Signer
WEB3SIGNER_IP=192.168.68.130
WEB3SIGNER_PORT=9100
SENDER01=0x3a554bc204821a020b6a12749aaf95b23b82111d

# /createaccount creates MPC keys through the coordinator admin API
MPC_ADMIN_URL=http://192.168.68.130:9100
MPC_ADMIN_TOKEN=<value of MPC_ADMIN_TOKEN in mpc-signer/quickstart/.env>

REDIS_IP=192.168.68.130
REDIS_PORT=36379
# leave NFT_CONTRACT unset: deploy a new collection in step 5
```

> **Secrets:** `proxy/.env` is committed to git today, and it already contains a `VAULT_TOKEN`.
> Do not commit `MPC_ADMIN_TOKEN`. It lets the holder create keys, but not sign arbitrary
> transactions: each node's policy still applies. Remove the file from git with
> `git rm --cached proxy/.env`, add it to `.gitignore`, and rotate the Vault token that was
> committed.

Build and start the proxy and Redis:

```bash
cd proxy
docker compose up -d --build
```

## Step 5: Verify

Create an account. It becomes an MPC key, funded from `SENDER01`:

```bash
curl -s localhost:30000/createaccount -H 'content-type: application/json' --data '{"amount":"5"}'
# → {"success":true,"address":"0x1293…717d","from":"0x3a55…111d","amount":"5","txHash":"0x…"}
```

Transfer from the new account. Its key is an MPC key, so the proxy signs through the coordinator:

```bash
curl -s localhost:30000/transfer -H 'content-type: application/json' \
  --data '{"from":"0x1293…717d","to":"0x3a55…111d","amount":"1.5","memo":"hello"}'
```

Deploy an NFT collection. The minter is the MPC sender:

```bash
curl -s localhost:30000/nft/deploy -H 'content-type: application/json' --data '{"name":"MPC NFT","symbol":"MNFT"}'
```

Mint. Every NFT is minted to `SENDER01` and nothing is paid. `amount` is the NFT's **price**,
stored on chain in the collection:

```bash
curl -s localhost:30000/nft/mint -H 'content-type: application/json' \
  --data '{"name":"Badge 1","image":"https://example/badge.png","amount":"0.5"}'
```

Sell it to the user. This is **one** `buy` transaction signed by the buyer, carrying exactly the
price. The NFT moves and the ETH goes to `SENDER01` atomically; if anything fails, nothing moves:

```bash
curl -s localhost:30000/nft/transfer -H 'content-type: application/json' \
  --data '{"to":"0x1293…717d","tokenId":"1"}'
```

Signer side:

```bash
curl -s http://192.168.68.130:9100 -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_accounts","params":[]}'   # SENDER01 + every created account
curl -s http://192.168.68.130:9100/admin/pool                              # hot_signs / cold_signs counters
```

## How the proxy decides who signs

The proxy calls `eth_accounts` on `WEB3SIGNER_IP:WEB3SIGNER_PORT` (now the coordinator):

- **Address in the list** (`SENDER01` and every account from `/createaccount`): the proxy sends
  `eth_sendTransaction` to the coordinator, and 2 of the 3 MPC nodes sign.
- **Address not in the list:** the proxy falls back to reading a private key from Vault. With
  this setup there are no such accounts. Because `VAULT_TOKEN` is not set, any attempt fails
  closed with an error instead of signing.

## Operating it

| Task | How |
|---|---|
| Watch signing | `GET :9100/admin/pool`: `ready` for `SENDER01`, `hot_signs`, `cold_signs`, `failed_signs` |
| Faster sustained throughput | more CPU per MPC node, `MPC_REFILL_CONCURRENCY`, `MPC_COMPUTE_THREADS`, a larger `MPC_POOL_TARGET` for bursts (see `mpc-signer/bench/RESULTS.md`) |
| Backups | each node's Docker volume (`node0-data`, `node1-data`, `node2-data`) **and** its passphrase in `quickstart/.env`. Keep them separate per node. |
| A node is down | signing continues with the other 2. `/createaccount` needs **all 3** (key generation), so new accounts fail until it returns. |
| Production | put the 3 nodes on 3 hosts run by different admins (`mpc-signer/deploy/`), see the README "Production architecture" and the hardening list: the proxy's in-process sender lock limits it to one replica today |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `policy: value above limit` | the amount is above `max_value_wei` in `quickstart/cluster.json` (default 1000 ETH per transaction) | raise it, then `./quickstart.sh down && ./quickstart.sh up` |
| `/createaccount` returns a `txHash`, but chainlens shows 0 transactions and the receipt is `null` | **nonce gap**: an earlier failed request used up a nonce (for example nonce 0), so later transactions wait in Besu's pool. Fixed in the proxy: a failed send now clears the cached nonce. | update the proxy, then fill the gap once: `eth_sendTransaction` on the coordinator from the sender to itself, `value 0x0`, `nonce` = the missing one. Then `docker exec <redis> redis-cli DEL nonce:<sender lowercase>`. |
| `/nft/deploy` says `alreadyDeployed` but chainlens shows no contract; `/nft/mint` says `NFT contract is not a collection` | `NFT_CONTRACT` in `proxy/.env` points to a contract from **before the chain was reset**. The proxy now reports this clearly. | delete the `NFT_CONTRACT` line, run `docker compose up -d --build`, then call `/nft/deploy` again (the proxy finds the collection on chain by itself) |
| chainlens stuck with `Missing batch response` | old chainlens image (batch over Besu's 1024 limit) | `git pull`, then `docker compose up -d --build` in `chainlens/` |

## Redis is optional (no replica needed)

The proxy treats Redis as a cache. The chain is the source of truth, and in-process memory holds
the live state. If Redis is down, empty, or restored from an old snapshot, every endpoint keeps
working. Redis commands fail fast (no queueing), and the log shows
`redis unavailable (...); continuing with memory + chain`.

| Redis key | Without Redis |
|---|---|
| `nonce:<sender>` | next nonce = max(cached counter, `eth_getTransactionCount(pending)`), so a stale or missing value is harmless |
| `pending-value:<sender>` | kept in memory; entries are dropped once their nonce is mined |
| `nft:contract` (default collection) | `NFT_CONTRACT` env → memory → Redis → **found on chain** (SENDER01's deployment addresses whose `minter()` is SENDER01) |
| `nft:collections` (all collections) | memory → Redis → found on chain the same way |
| `nft:nextId:<contract>` | per collection: max(memory/Redis, highest token id minted on chain) + 1 |
| `nft:meta:<contract>:<tokenId>` | metadata decoded from the token's on-chain `tokenURI` (`data:application/json;base64,…`) |

Tested: Redis stopped during load; Redis replaced by an empty instance plus a proxy restart; and a
stale snapshot with a nonce rolled back. In all three, transfers, account creation and NFT mint
and metadata kept working, and every transaction was mined with no nonce gaps.

Still one proxy replica: the per-sender lock is in process memory.

## Several NFT collections

`POST /nft/deploy` deploys a **new** collection every time. The first one is the default, and
`GET /nft/collections` lists them all. Names and symbols must be unique across collections; a
duplicate is rejected with 409.

Choose a collection with `"collection"` in the `/nft/mint` and `/nft/transfer` body, or with
`?collection=` on `GET /nft/:id`, `/nft/:id/metadata` and `/nft/owner/:address`. The value can be
the collection's **name**, its **symbol** (both case-insensitive) or its **address**. Without it,
the default collection is used, so single-collection requests still work. `contract` is accepted
as an alias. Token ids start at 1 in each collection. Examples are in `proxy/api.txt`.
