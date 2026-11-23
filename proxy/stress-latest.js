const path = require("path");
const express = require("express");
const Redis = require("ioredis");
const { ethers } = require("ethers");
const crypto = require("crypto");
const registryArtifact = require("./section-registry.json");
const avatarArtifact = require("./avatar-collection.json");

require("dotenv").config({
    path: path.join(__dirname, ".env")
});

const app = express();

// ---- HTTP and process metrics (GET /metrics, Grafana "Proxy & Redis"): requests per route, method
// and status, latency, requests in flight, memory and event-loop lag
const { monitorEventLoopDelay } = require("perf_hooks");
const LATENCY_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];
const httpStats = { requests: new Map(), durations: new Map(), inFlight: 0, started: Date.now() };
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();

app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    httpStats.inFlight += 1;
    res.once("close", () => {
        httpStats.inFlight -= 1;
        // the route pattern (/transfer/:txHash), never the raw URL: label values stay few
        const route = req.route ? (req.baseUrl || "") + req.route.path : "unmatched";
        const code = res.writableFinished ? String(res.statusCode) : "aborted";
        const key = route + "|" + req.method + "|" + code;
        httpStats.requests.set(key, (httpStats.requests.get(key) || 0) + 1);
        const seconds = Number(process.hrtime.bigint() - start) / 1e9;
        let d = httpStats.durations.get(route);
        if (!d) {
            d = { buckets: LATENCY_BUCKETS.map(() => 0), count: 0, sum: 0 };
            httpStats.durations.set(route, d);
        }
        LATENCY_BUCKETS.forEach((le, i) => { if (seconds <= le) { d.buckets[i] += 1; } });
        d.count += 1;
        d.sum += seconds;
    });
    next();
});

function httpMetricLines() {
    const esc = (v) => String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const lines = [
        "# HELP proxy_http_requests_total HTTP requests answered, per route pattern, method and status code.",
        "# TYPE proxy_http_requests_total counter"
    ];
    for (const [key, value] of httpStats.requests) {
        const [route, method, code] = key.split("|");
        lines.push(`proxy_http_requests_total{route="${esc(route)}",method="${method}",code="${code}"} ${value}`);
    }
    lines.push("# HELP proxy_http_request_duration_seconds Time to answer, per route pattern.",
        "# TYPE proxy_http_request_duration_seconds histogram");
    for (const [route, d] of httpStats.durations) {
        const r = esc(route);
        LATENCY_BUCKETS.forEach((le, i) => lines.push(`proxy_http_request_duration_seconds_bucket{route="${r}",le="${le}"} ${d.buckets[i]}`));
        lines.push(`proxy_http_request_duration_seconds_bucket{route="${r}",le="+Inf"} ${d.count}`,
            `proxy_http_request_duration_seconds_sum{route="${r}"} ${d.sum}`,
            `proxy_http_request_duration_seconds_count{route="${r}"} ${d.count}`);
    }
    const mem = process.memoryUsage();
    const gauge = (name, help, value) => lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${value}`);
    gauge("proxy_http_in_flight", "Requests being answered now.", httpStats.inFlight);
    gauge("proxy_process_resident_memory_bytes", "Resident memory of the proxy process.", mem.rss);
    gauge("proxy_process_heap_used_bytes", "V8 heap in use.", mem.heapUsed);
    gauge("proxy_process_start_time_seconds", "When the proxy started (unix time).", Math.floor(httpStats.started / 1000));
    gauge("proxy_event_loop_lag_p99_seconds", "Event-loop delay, 99th percentile since the last scrape.", loopDelay.percentile(99) / 1e9);
    gauge("proxy_event_loop_lag_max_seconds", "Event-loop delay, maximum since the last scrape.", loopDelay.max / 1e9);
    loopDelay.reset();
    return lines;
}

app.use(express.json({ limit: "1mb" }));

// Memos (docs/features/memos.md): every transaction carries a memo record at the end of its data.
// Each request has a context: the caller's own memo (body.memo, checked here for every write),
// a short request id (links the transactions of one call) and the language of the answer.
const MEMO = require("./memo/memo.js");
const { AsyncLocalStorage } = require("node:async_hooks");
const memoContext = new AsyncLocalStorage();

app.use((req, res, next) => {
    let u = null;

    try {
        u = req.method === "POST" && req.body && typeof req.body === "object" ? MEMO.userMemo(req.body.memo) : null;
    } catch (error) {
        return res.status(400).json({ error: error.message });
    }

    const lang = MEMO.lang(req.query && req.query.lang, req.headers["accept-language"], process.env.MEMO_DEFAULT_LANG);
    memoContext.run({ u, r: crypto.randomBytes(4).toString("hex"), lang }, next);
});

// =======================
// Config
// =======================

const BESU_IP = process.env.BESU_IP || process.env.IP;
const SIGNER_IP = process.env.SIGNER_IP || process.env.IP;

const CONFIG = {
    PORT: Number(process.env.PORT) || 30000,
    BESU_RPC: `http://${BESU_IP}:${process.env.BESU_PORT || 8545}`,
    // the MPC signer's coordinator (Ethereum signer JSON-RPC: eth_accounts, eth_sendTransaction)
    SIGNER_RPC: `http://${SIGNER_IP}:${process.env.SIGNER_PORT || 9100}`,
    SENDER01: process.env.SENDER01 || "0xFE3B557E8Fb62b89F4916B721be55cEb828dBd73",
    // MPC signer admin API: /createaccount creates every account as an MPC key (distributed key
    // generation; no private key exists anywhere). SIGNER_IP/PORT point at the same coordinator.
    MPC_ADMIN_URL: (process.env.MPC_ADMIN_URL || "").trim().replace(/\/$/, ""),
    MPC_ADMIN_TOKEN: (process.env.MPC_ADMIN_TOKEN || "").trim(),
    // presignature pool class of accounts created by /createaccount when the request names none:
    // big (MPC_POOL_TARGET presignatures, like SENDER01), small (MPC_POOL_TARGET_SMALL), none (cold)
    MPC_NEW_ACCOUNT_POOL: (process.env.MPC_NEW_ACCOUNT_POOL || "small").trim().toLowerCase(),
    // Sections (docs/features/sections.md): the on-chain SectionRegistry and the MPC account that writes it
    REGISTRY_CONTRACT: (process.env.REGISTRY_CONTRACT || "").trim(),
    REGISTRY_ADMIN: (process.env.REGISTRY_ADMIN || "").trim(),
    // Admin API (/admin/*): bearer token and the source addresses allowed to use it
    ADMIN_TOKEN: (process.env.ADMIN_TOKEN || "").trim(),
    ADMIN_ALLOWED_IPS: (process.env.ADMIN_ALLOWED_IPS || "").split(/[\s,]+/).filter(Boolean),
    // true: /createaccount and /transfer need a section's X-Section-Key (no SENDER01 fallback)
    SECTION_KEY_REQUIRED: String(process.env.SECTION_KEY_REQUIRED || "").toLowerCase() === "true",
    // the block the registry was deployed in (its events are read from there)
    REGISTRY_FROM_BLOCK: Math.max(0, parseInt(process.env.REGISTRY_FROM_BLOCK || "0", 10) || 0),
    // contract_account_center: the MPC key that deploys every contract (step 4)
    CONTRACT_CENTER: (process.env.CONTRACT_CENTER || "").trim(),
    // monitoring thresholds (0 = off): an upfront account / SENDER01 below them raises an alert
    UPFRONT_LOW_BALANCE_ETH: Number(process.env.UPFRONT_LOW_BALANCE_ETH || 0) || 0,
    SENDER01_LOW_BALANCE_ETH: Number(process.env.SENDER01_LOW_BALANCE_ETH || 0) || 0,
    // memos (docs/features/memos.md): off only for a test; contracts that must not get a memo trailer
    // (their memo is kept in the proxy's memo log instead)
    // a section's +x / -x can be undone (the full amount, once) for this many days
    TRANSFER_UNDO_DAYS: Number(process.env.TRANSFER_UNDO_DAYS || 7),
    MEMO_ENABLED: String(process.env.MEMO_ENABLED || "true").toLowerCase() !== "false",
    MEMO_SKIP_CONTRACTS: (process.env.MEMO_SKIP_CONTRACTS || "").split(/[\s,]+/).filter(Boolean).map((a) => a.toLowerCase()),
    REDIS: {
        host: process.env.REDIS_IP || process.env.IP || BESU_IP,
        port: Number(process.env.REDIS_PORT) || 36379
    }
};

// Redis is an optional cache. The chain is the source of truth for everything the proxy
// keeps (nonces, pending value, avatar token ids), and in-process memory
// holds the live state. If Redis is down, empty, or restored from an old snapshot, requests keep
// working: commands fail fast (no offline queue) and the proxy falls back to memory + chain.
const redis = new Redis({
    ...CONFIG.REDIS,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    connectTimeout: 2000,
    commandTimeout: 1000,
    retryStrategy: (times) => Math.min(times * 500, 5000)
});
let redisDown = false;

redis.on("error", (error) => {
    if (!redisDown) {
        console.warn(`redis unavailable (${error.message}); continuing with memory + chain`);
    }
    redisDown = true;
});

redis.on("ready", () => {
    if (redisDown) {
        console.log("redis available again");
    }
    redisDown = false;
});

// Run a Redis command; on any failure return `fallback` instead of failing the request.
async function cache(fn, fallback = null) {
    if (redis.status !== "ready") {
        return fallback;
    }

    try {
        return await fn();
    } catch (error) {
        console.warn(`redis command failed (${error.message}); using memory + chain`);
        return fallback;
    }
}

// Live state (authoritative while the process runs; one proxy replica, see withSenderLock).
const memNonce = new Map();      // sender -> next nonce to use
const memPending = new Map();    // sender -> Map(nonce -> wei string) not yet mined

// =======================
// JSON RPC Client
// =======================

async function rpc(url, method, params = []) {
    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method,
            params
        })
    });

    const data = await response.json();

    if (data.error) {
        throw new Error(data.error.message);
    }

    return data.result;
}

// =======================
// Redis nonce
// =======================

// Forget the cached nonce so the next nextNonce() re-reads eth_getTransactionCount(pending).
// Called when signing/submitting fails after a nonce was taken: otherwise that nonce is never
// used, every later transaction from the sender waits behind the gap and nothing is mined.
// Safe because every send runs under withSenderLock for its sender.
async function resetNonce(address) {
    const sender = address.toLowerCase();
    memNonce.delete(sender);
    void cache(() => redis.del(`nonce:${sender}`));
}

// Next nonce. The chain is read only when the process has no nonce for the sender yet (start,
// after an error, after a repair): then max(cached counter, chain pending count), so a missing,
// empty or stale Redis is harmless. Afterwards the nonce is counted in memory, which is correct
// because this process is the only one sending for the sender (withSenderLock); the periodic chain
// check (checkSenders) corrects it if the chain ever disagrees. Runs under withSenderLock.
async function nextNonce(address) {
    const sender = address.toLowerCase();
    const key = `nonce:${sender}`;
    let nonce = memNonce.get(sender);

    if (nonce === undefined) {
        const chainPending = parseInt(await rpc(
            CONFIG.BESU_RPC,
            "eth_getTransactionCount",
            [address, "pending"]
        ), 16);
        const stored = await cache(() => redis.get(key));
        nonce = Math.max(stored === null ? 0 : Number(stored), chainPending);
    }

    memNonce.set(sender, nonce + 1);
    void cache(() => redis.set(key, nonce + 1));
    return nonce;
}

// Besu can briefly answer eth_getBalance with null (e.g. while importing a busy block);
// retry a few times instead of failing the request with "Cannot convert null to a BigInt".
async function getBalanceWei(address, block = "latest") {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const result = await rpc(CONFIG.BESU_RPC, "eth_getBalance", [address, block]);

        if (result !== null && result !== undefined) {
            return BigInt(result);
        }

        await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }

    throw new Error(`Besu returned no balance for ${address}`);
}

// =======================
// Address validation
// =======================

function isAddress(address) {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
}

// =======================
// Accounts held by the MPC signer
// =======================

// The signer's key list, cached: it only grows when /createaccount adds a key. A sender that is
// not in the cached list triggers a fresh read, so a new key is found immediately.
const SIGNER_ACCOUNTS_TTL_MS = 10000;
let signerAccounts = { set: new Set(), at: 0 };

async function signerOwns(address) {
    const key = address.toLowerCase();
    const fresh = Date.now() - signerAccounts.at < SIGNER_ACCOUNTS_TTL_MS;

    if (fresh && signerAccounts.set.has(key)) {
        return true;
    }

    const accounts = await rpc(CONFIG.SIGNER_RPC, "eth_accounts");
    signerAccounts = { set: new Set(accounts.map((item) => item.toLowerCase())), at: Date.now() };
    return signerAccounts.set.has(key);
}

// =======================
// ETH conversion
// =======================

function ethToWeiHex(amount) {
    const [whole, fraction = ""] = amount.split(".");

    const wei =
        BigInt(whole) * 1000000000000000000n +
        BigInt((fraction + "000000000000000000").slice(0, 18));

    return "0x" + wei.toString(16);
}

function ethToWei(amount) {
    return BigInt(ethToWeiHex(amount));
}

const senderLocks = new Map();

function withSenderLock(address, task) {
    const key = address.toLowerCase();
    const previous = senderLocks.get(key) || Promise.resolve();
    const run = previous.then(task, task);
    const settled = run.then(() => {}, () => {});
    senderLocks.set(key, settled);
    return run;
}

function pendingValueKey(address) {
    return `pending-value:${address.toLowerCase()}`;
}

async function pendingFor(sender) {
    let pending = memPending.get(sender);

    if (!pending) {
        const stored = await cache(() => redis.hgetall(pendingValueKey(sender)), {});
        pending = new Map(Object.entries(stored || {}));
        memPending.set(sender, pending);
    }

    return pending;
}

// =======================
// Sender state: balance snapshot + periodic chain check
// =======================
//
// The balance check uses a snapshot of the chain (balance and confirmed nonce read AT THE SAME
// BLOCK) minus the value of this sender's transactions that are not confirmed yet (memPending).
// Mined transactions are still in memPending until a newer snapshot shows them confirmed, and are
// then counted once: in the lower balance. So the check is never more generous than the chain.
// checkSenders() refreshes the snapshots in the background and reconciles the in-memory nonce
// with the chain; requests only read the chain when a sender has no recent snapshot.
const SENDER_CHECK_MS = Number(process.env.SENDER_CHECK_MS) || 2000;
const SENDER_STUCK_MS = Number(process.env.SENDER_STUCK_MS) || 30000;
// ...and at least this many new blocks: a gap is only "lost transactions" if the chain keeps
// producing blocks without confirming them. During a halt nothing is repaired.
const SENDER_STUCK_BLOCKS = Number(process.env.SENDER_STUCK_BLOCKS) || 10;
const SENDER_IDLE_MS = Number(process.env.SENDER_IDLE_MS) || 300000;
const SNAPSHOT_MAX_AGE_MS = Math.max(3 * SENDER_CHECK_MS, 5000);

const senders = new Map(); // sender (lowercase) -> state, see senderState()

function senderState(address) {
    const sender = address.toLowerCase();
    let state = senders.get(sender);

    if (!state) {
        state = {
            address,
            snapshot: null,      // { block, balance, confirmed, at }
            chainPending: null,  // last eth_getTransactionCount(pending) seen by the check
            progressAt: Date.now(),
            lastUsed: Date.now(),
            repairs: 0,
            adopted: 0,
            repairNext: false,
            gap: null,           // { at, block, confirmed, from, to } while a nonce gap exists
            stall: null,         // { at, block, confirmed } while ready transactions are not mined
            stalled: false,      // stall lasted SENDER_STUCK_MS and SENDER_STUCK_BLOCKS
            stallLoggedAt: 0,
            stalls: 0,
            fillers: 0,
            futures: [],         // this sender's transactions in Besu's pool above the pending nonce
            poolCheckedAt: 0,
            lastError: null
        };
        senders.set(sender, state);
    }

    return state;
}

// Balance, confirmed nonce and pending nonce of one sender, the first two at the same block.
async function readChainAccount(address) {
    const block = await rpc(CONFIG.BESU_RPC, "eth_blockNumber", []);
    const [balance, confirmed, pending] = await Promise.all([
        getBalanceWei(address, block),
        rpc(CONFIG.BESU_RPC, "eth_getTransactionCount", [address, block]),
        rpc(CONFIG.BESU_RPC, "eth_getTransactionCount", [address, "pending"])
    ]);

    return {
        block: parseInt(block, 16),
        balance,
        confirmed: parseInt(confirmed, 16),
        pending: parseInt(pending, 16)
    };
}

async function applySnapshot(state, chain) {
    const sender = state.address.toLowerCase();
    const previous = state.snapshot;

    if (previous && chain.block < previous.block) {
        return; // an older answer than the one we already have
    }

    if (!previous || chain.confirmed > previous.confirmed) {
        state.progressAt = Date.now();
    }

    state.snapshot = { block: chain.block, balance: chain.balance, confirmed: chain.confirmed, at: Date.now() };
    state.chainPending = chain.pending;

    // drop the value of transactions the snapshot shows as mined (counted in its balance)
    const pending = await pendingFor(sender);
    const mined = [...pending.keys()].filter((nonce) => Number(nonce) < chain.confirmed);

    if (mined.length > 0) {
        mined.forEach((nonce) => pending.delete(nonce));
        void cache(() => redis.hdel(pendingValueKey(sender), ...mined));
    }
}

async function refreshSender(state) {
    await applySnapshot(state, await readChainAccount(state.address));
}

// What the sender can still spend: snapshot balance minus everything sent but not confirmed in
// that snapshot. Reads the chain only when the snapshot is missing or old.
async function availableWei(address) {
    const sender = address.toLowerCase();
    const state = senderState(address);
    state.lastUsed = Date.now();

    if (!state.snapshot || Date.now() - state.snapshot.at > SNAPSHOT_MAX_AGE_MS) {
        await refreshSender(state);
    }

    const pending = await pendingFor(sender);
    let reserved = 0n;

    for (const [nonce, value] of pending) {
        if (Number(nonce) >= state.snapshot.confirmed) {
            reserved += BigInt(value);
        }
    }

    return state.snapshot.balance - reserved;
}

// After a successful send. Following a nonce repair, the next nonce is read from the chain once
// more: the reused nonce may have filled a gap, letting later transactions still in Besu's pool
// become valid, so the chain's pending count is the correct next nonce.
function afterSend(sender) {
    const state = senders.get(sender.toLowerCase());

    if (state && state.repairNext) {
        state.repairNext = false;
        memNonce.delete(sender.toLowerCase());
    }
}

// Background check of every sender used recently (and SENDER01 always, from start-up):
// 1. refresh the balance snapshot (deposits appear within SENDER_CHECK_MS);
// 2. Besu's pending nonce AHEAD of ours: someone else sent from this key -> adopt Besu's value;
// 3. GAP: a nonce is missing, so later transactions cannot be mined. Seen either as our nonce
//    above Besu's pending nonce, or as this sender's transactions waiting in Besu's pool above
//    the pending nonce (works after a proxy restart too, when we have no nonce in memory).
//    Usually the missing transactions are only on other nodes and get mined as soon as blocks are
//    produced, so the repair waits until the chain kept producing blocks (SENDER_STUCK_MS and
//    SENDER_STUCK_BLOCKS) without confirming anything. Then:
//    - transactions wait above the gap -> send a 0-value FILLER transaction (to itself) at each
//      missing nonce, so they are mined right away;
//    - nothing waits above it (sent, then lost by every node) -> continue from Besu's pending
//      nonce, so the next request fills it.
//    Nothing is repaired while the chain is halted.
// 4. STALL: transactions are ready in the RPC node's pool (pending > confirmed) but blocks keep
//    coming without mining them: the validators do not have them (e.g. dropped above their
//    tx-pool-max-future-by-sender). The proxy cannot fix this; it is logged and exposed on
//    /metrics (alert ProxySenderStalled). Restarting one validator makes it fetch the pool again.
// Nonce changes and fillers run under the sender's lock, after reading the chain again.
const POOL_CHECK_MS = 10000;
const MAX_FILLERS = 100;
let checkingSenders = false;
let checkErrorLogged = false;
let txpoolUnavailableLogged = false;

// Nonces of this sender's transactions in the RPC node's pool that are above `pending`
// (future: waiting for a missing nonce). Needs the TXPOOL API on BESU_RPC (rpc.toml has it).
async function poolFutures(address, pending) {
    let txs;

    try {
        txs = await rpc(CONFIG.BESU_RPC, "txpool_besuPendingTransactions", [10000, { from: { eq: address.toLowerCase() } }]);
    } catch (error) {
        if (!txpoolUnavailableLogged) {
            console.warn(`sender check: cannot read Besu's transaction pool (${error.message}); enable the TXPOOL API on ${CONFIG.BESU_RPC} so nonce gaps are also found after a proxy restart`);
            txpoolUnavailableLogged = true;
        }
        return null;
    }

    return (txs || [])
        .map((tx) => parseInt(tx.nonce, 16))
        .filter((nonce) => nonce >= pending)
        .sort((a, b) => a - b);
}

// A 0-value transaction from the sender to itself at `nonce`: fills a gap, nothing else.
async function sendFiller(state, nonce) {
    const data = CONFIG.MEMO_ENABLED ? MEMO.append("0x", MEMO.record({ t: "nonce.fill", p: { nonce } })) : "0x";
    const txHash = await sendFromSigner(state.address, state.address, "0", nonce, data, transferGas(ethers.getBytes(data)));
    await rememberPendingWei(state.address, nonce, 0n);
    return txHash;
}

async function repairGap(sender, state) {
    const chain = await readChainAccount(state.address);
    await applySnapshot(state, chain);
    const gap = state.gap;

    if (!gap || chain.confirmed > gap.confirmed || chain.block - gap.block < SENDER_STUCK_BLOCKS) {
        return; // something was confirmed meanwhile: not stuck
    }

    const futures = (await poolFutures(state.address, chain.pending)) || [];
    const ours = memNonce.get(sender);

    if (futures.length > 0) {
        const missing = [];

        for (let nonce = chain.pending; nonce < futures[0] && missing.length < MAX_FILLERS; nonce += 1) {
            missing.push(nonce);
        }

        for (const nonce of missing) {
            await sendFiller(state, nonce);
            state.fillers += 1;
        }

        console.warn(`sender ${state.address}: nonce${missing.length > 1 ? "s" : ""} ${missing[0]}${missing.length > 1 ? ".." + missing[missing.length - 1] : ""} missing for ${chain.block - gap.block} blocks while ${futures.length} transaction(s) waited above; sent ${missing.length} filler transaction(s) (0 ETH to itself) so they can be mined`);

        const after = parseInt(await rpc(CONFIG.BESU_RPC, "eth_getTransactionCount", [state.address, "pending"]), 16);

        if (ours !== undefined && ours < after) {
            memNonce.set(sender, after);
        }

        if (ours === undefined || ours < after) {
            void cache(() => redis.set(`nonce:${sender}`, after));
        }
    } else if (ours !== undefined && chain.pending < ours) {
        memNonce.set(sender, chain.pending);
        void cache(() => redis.set(`nonce:${sender}`, chain.pending));
        state.repairNext = true;
        console.warn(`sender ${state.address}: nonces ${chain.pending}..${ours - 1} were sent but no Besu node mined them in ${chain.block - gap.block} blocks (${Math.round((Date.now() - gap.at) / 1000)}s); they were lost (e.g. RPC node restarted before they spread). Continuing from nonce ${chain.pending}: those transactions will not be mined, the next ones fill the gap.`);
    } else {
        return;
    }

    state.repairs += 1;
    state.gap = null;
}

async function checkSender(sender, state) {
    await refreshSender(state);
    const snap = state.snapshot;
    const pendingNonce = state.chainPending;
    const ours = memNonce.get(sender);

    // this sender's transactions waiting above the pending nonce (pool read every POOL_CHECK_MS)
    if (Date.now() - state.poolCheckedAt >= POOL_CHECK_MS) {
        state.poolCheckedAt = Date.now();
        state.futures = (await poolFutures(state.address, pendingNonce)) || [];
    } else {
        state.futures = state.futures.filter((nonce) => nonce >= pendingNonce);
    }

    // 2. Besu is ahead of us (another client used the key, or a gap we waited on was filled)
    if (ours !== undefined && pendingNonce > ours) {
        await withSenderLock(sender, async () => {
            const chain = await readChainAccount(state.address);
            await applySnapshot(state, chain);
            const current = memNonce.get(sender);

            if (current !== undefined && chain.pending > current) {
                memNonce.set(sender, chain.pending);
                void cache(() => redis.set(`nonce:${sender}`, chain.pending));
                state.adopted += 1;
                console.warn(`sender ${state.address}: chain nonce ${chain.pending} is ahead of ours (${current}): another client sent from this key; continuing from the chain`);
            }
        });
        return;
    }

    // 3. gap: track it, repair when the chain moved on without confirming anything
    const gapNow = (ours !== undefined && pendingNonce < ours) || state.futures.length > 0;

    if (!gapNow) {
        state.gap = null;
    } else if (!state.gap || snap.confirmed > state.gap.confirmed) {
        state.gap = { at: Date.now(), block: snap.block, confirmed: snap.confirmed };
    }

    if (state.gap && Date.now() - state.gap.at >= SENDER_STUCK_MS && snap.block - state.gap.block >= SENDER_STUCK_BLOCKS) {
        await withSenderLock(sender, () => repairGap(sender, state));
        state.poolCheckedAt = 0; // look at the pool again on the next check
    }

    // 4. stall: ready transactions on the RPC node that blocks do not include
    if (pendingNonce <= snap.confirmed) {
        if (state.stalled) {
            console.log(`sender ${state.address}: transactions are being mined again (confirmed nonce ${snap.confirmed})`);
        }
        state.stall = null;
        state.stalled = false;
    } else if (!state.stall || snap.confirmed > state.stall.confirmed) {
        if (state.stalled) {
            console.log(`sender ${state.address}: transactions are being mined again (confirmed nonce ${snap.confirmed})`);
        }
        state.stall = { at: Date.now(), block: snap.block, confirmed: snap.confirmed };
        state.stalled = false;
    } else if (Date.now() - state.stall.at >= SENDER_STUCK_MS && snap.block - state.stall.block >= SENDER_STUCK_BLOCKS) {
        if (!state.stalled) {
            state.stalled = true;
            state.stalls += 1;
        }

        if (Date.now() - state.stallLoggedAt >= 300000) {
            state.stallLoggedAt = Date.now();
            console.warn(`sender ${state.address}: ${pendingNonce - snap.confirmed} transaction(s) are ready in Besu's pool (nonces ${snap.confirmed}..${pendingNonce - 1}) but none was mined in ${snap.block - state.stall.block} blocks (${Math.round((Date.now() - state.stall.at) / 1000)}s): the validators do not have them. Restart one validator (it fetches the pool again) and set tx-pool-max-future-by-sender=2000 on the validators.`);
        }
    }
}

async function checkSenders() {
    if (checkingSenders) {
        return;
    }

    checkingSenders = true;

    try {
        for (const [sender, state] of senders) {
            const pending = memPending.get(sender);
            const busy = (pending && pending.size > 0) || state.gap || state.stall;

            if (!busy && !state.pinned && Date.now() - state.lastUsed > SENDER_IDLE_MS) {
                senders.delete(sender);
                withSenderLock(sender, async () => memNonce.delete(sender)).catch(() => {});
                continue;
            }

            try {
                await checkSender(sender, state);
                state.lastError = null;
            } catch (error) {
                state.lastError = error.message;
            }
        }

        if (checkErrorLogged) {
            console.log("sender check: Besu reachable again");
        }

        checkErrorLogged = false;
    } catch (error) {
        if (!checkErrorLogged) {
            console.warn(`sender check failed (${error.message}); retrying`);
        }

        checkErrorLogged = true;
    } finally {
        checkingSenders = false;
    }
}

// Track SENDER01 from start-up (and every sender with transactions recorded in Redis), so a gap
// left by an earlier run is found even if no request comes for that sender.
function trackSendersAtStart() {
    if (CONFIG.SENDER01 && isAddress(CONFIG.SENDER01)) {
        senderState(CONFIG.SENDER01).pinned = true;
    }

    cache(async () => {
        const keys = await redis.keys("pending-value:0x*");
        keys.map((key) => key.slice("pending-value:".length))
            .filter(isAddress)
            .forEach((address) => senderState(address));
    });
}

setInterval(checkSenders, SENDER_CHECK_MS).unref();
setTimeout(trackSendersAtStart, 1000).unref();



// { t, s, p } + the request's context -> the stored record
function memoRecord(spec) {
    const ctx = memoContext.getStore() || {};
    return MEMO.record(Object.assign({}, spec, { u: spec.u !== undefined ? spec.u : ctx.u, r: ctx.r }));
}

function memoLang() {
    return (memoContext.getStore() || {}).lang || MEMO.lang(process.env.MEMO_DEFAULT_LANG);
}

// The memo fields of an answer
function memoAnswer(rec) {
    return MEMO.answer(rec, memoLang());
}

// Memos that are not on chain (a contract creation, MEMO_SKIP_CONTRACTS): txHash -> record, in Redis
const memoLogKey = "proxy:memo-log";
function logMemo(txHash, rec) {
    if (rec && txHash) {
        void cache(() => redis.hset(memoLogKey, txHash.toLowerCase(), JSON.stringify(rec)));
    }
}

async function loggedMemo(txHash) {
    try {
        const v = await redis.hget(memoLogKey, txHash.toLowerCase());
        return v ? JSON.parse(v) : null;
    } catch (error) {
        return null;
    }
}

// The memo of a contract call: <avatar|nickname>.<function> for the platform collections (when the
// catalogue knows it), else contract.call. Values from the function's arguments and the caller's
// friendly arguments; prices in ETH.
function contractMemo(entry, fragment, args, rawArgs, valueWei, section) {
    const kind = platformKind(entry);
    const known = kind && MEMO.CATALOGUE.types[`${kind}.${fragment.name}`];
    const p = {};

    fragment.inputs.forEach((input, i) => {
        const v = args[i];

        if (!input.name || /uri|attributes|abi|data|metadata/i.test(input.name) || v === undefined || v === null || typeof v === "object") {
            return;
        }

        // the catalogue's names: level, price (e.g. upgradeLevel(toLevel), addLevel(stepPrice))
        const name = { toLevel: "level", stepPrice: "price" }[input.name] || input.name;

        if (input.type === "address") {
            return;  // payee, accounts: shown by the transaction itself
        }

        p[name] = /price|amount/i.test(input.name) && /^uint/.test(input.type) ? ethers.formatEther(v).replace(/\.0$/, "") : v;
    });

    if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
        for (const k of ["nickname", "imageUrl", "image", "name"]) {
            if (typeof rawArgs[k] === "string" && p[k] === undefined) {
                p[k] = rawArgs[k];
            }
        }
    }

    if (valueWei > 0n) {
        p.amount = ethers.formatEther(valueWei).replace(/\.0$/, "");
    }

    if (!known) {
        p.function = fragment.name;
        p.contract = entry.name || entry.address;
    }

    return { t: known ? `${kind}.${fragment.name}` : "contract.call", s: section || undefined, p };
}

function transferGas(bytes) {
    let gas = 21000n;

    for (const byte of bytes) {
        gas += byte === 0 ? 4n : 16n;
    }

    return gas;
}

async function assertCanPay(address, amount) {
    const cost = ethToWei(amount);

    if (await availableWei(address) < cost) {
        const error = new Error("insufficient balance");
        error.statusCode = 400;
        throw error;
    }
}

async function rememberPending(address, nonce, amount) {
    await rememberPendingWei(address, nonce, ethToWei(amount));
}

async function rememberPendingWei(address, nonce, wei) {
    const sender = address.toLowerCase();
    (await pendingFor(sender)).set(String(nonce), wei.toString());
    void cache(() => redis.hset(pendingValueKey(sender), String(nonce), wei.toString()));
    afterSend(sender);
}

// memo: { t, s, p } (the amount is added); the caller's memo and the request id come from the context
async function pay(sender, recipient, amount, memo = { t: "transfer" }) {
    const rec = memoRecord(Object.assign({}, memo, { p: Object.assign({ amount: String(amount) }, memo.p) }));
    const data = CONFIG.MEMO_ENABLED ? MEMO.append("0x", rec) : "0x";
    const gas = transferGas(ethers.getBytes(data));

    await assertCanPay(sender, amount);

    const nonce = await nextNonce(sender);
    let txHash;

    try {
        txHash = await sendFromSigner(sender, recipient, amount, nonce, data, gas);
    } catch (error) {
        await resetNonce(sender);
        throw error;
    }

    await rememberPending(sender, nonce, amount);

    return { txHash, nonce, memo: rec };
}

// =======================
// Create account
// =======================

let accountCreation = Promise.resolve();

function withAccountLock(task) {
    const run = accountCreation.then(task, task);
    accountCreation = run.then(() => {}, () => {});
    return run;
}

// The message for a sender the MPC signer does not hold.
function notManaged(address) {
    return `sender not managed by the MPC signer: ${address} (create it with POST /createaccount)`;
}

async function sendFromSigner(from, to, amount, nonce, data = "0x", gas = 21000n) {
    return rpc(
        CONFIG.SIGNER_RPC,
        "eth_sendTransaction",
        [{
            from,
            to,
            data,
            value: ethToWeiHex(amount),
            gas: "0x" + gas.toString(16),
            gasPrice: "0x0",
            nonce: "0x" + nonce.toString(16)
        }]
    );
}

// Create a new account as an MPC key: the three MPC nodes run distributed key generation and
// each keeps one share. Returns the checksummed address.
const POOL_CLASSES = ["big", "small", "none"];

// The pool class of a request: the given one, or MPC_NEW_ACCOUNT_POOL. 400 for anything else.
function poolClass(pool) {
    const value = pool === undefined || pool === null || pool === ""
        ? CONFIG.MPC_NEW_ACCOUNT_POOL
        : String(pool).trim().toLowerCase();

    if (!POOL_CLASSES.includes(value)) {
        throw httpError(400, `pool must be one of ${POOL_CLASSES.join(", ")}`);
    }

    return value;
}

async function mpcAdmin(path, body) {
    if (!CONFIG.MPC_ADMIN_TOKEN) {
        throw new Error("MPC_ADMIN_TOKEN is not configured");
    }

    return fetch(`${CONFIG.MPC_ADMIN_URL}${path}`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${CONFIG.MPC_ADMIN_TOKEN}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000)
    });
}

async function createMpcAccount(pool) {
    const response = await mpcAdmin("/admin/keys", { pool });

    if (!response.ok) {
        const detail = await response.text();
        throw new Error(`mpc key generation failed (${response.status}): ${detail.slice(0, 300)}`);
    }

    const key = await response.json();
    return ethers.getAddress(key.address);
}

async function createAccount(amount, pool) {
    if (!await signerOwns(CONFIG.SENDER01)) {
        throw new Error("sender01 is not managed by the signer");
    }

    if (!CONFIG.MPC_ADMIN_URL) {
        throw httpError(503, "account creation needs the MPC signer's admin API (MPC_ADMIN_URL)");
    }

    await assertCanPay(CONFIG.SENDER01, amount);
    const address = await createMpcAccount(pool);

    const payment = await withSenderLock(CONFIG.SENDER01, async () => {
        await assertCanPay(CONFIG.SENDER01, amount);
        return pay(CONFIG.SENDER01, address, amount, { t: "account.fund" });
    });

    return {
        success: true,
        address,
        from: CONFIG.SENDER01,
        amount,
        pool,
        txHash: payment.txHash,
        nonce: payment.nonce,
        ...memoAnswer(payment.memo)
    };
}

app.post("/createaccount", async (req, res) => {
    try {
        const { amount } = req.body;

        if (amount === undefined || amount === null || amount === "") {
            return res.status(400).json({
                error: "missing parameters"
            });
        }

        const amountText = String(amount);

        if (!/^\d+(\.\d+)?$/.test(amountText)) {
            return res.status(400).json({
                error: "invalid amount"
            });
        }

        const pool = poolClass(req.body.pool);
        const section = await sectionFromRequest(req);
        const result = section
            ? await createSectionAccount(section, amountText, pool)
            : await withAccountLock(() => createAccount(amountText, pool));
        res.json(result);
    } catch (error) {
        console.error(error);

        res.status(error.statusCode || 500).json({
            error: error.message
        });
    }
});

// =======================
// Presignature pool class of an account (MPC signer only)
// =======================

app.post("/account/pool", async (req, res) => {
    try {
        const { address } = req.body;

        if (!CONFIG.MPC_ADMIN_URL) {
            return res.status(400).json({ error: "pool classes need the MPC signer (MPC_ADMIN_URL)" });
        }

        if (!address || !isAddress(address)) {
            return res.status(400).json({ error: "invalid address" });
        }

        const pool = poolClass(req.body.pool);
        const response = await mpcAdmin(`/admin/keys/${ethers.getAddress(address)}/pool`, { pool });
        const detail = await response.text();

        if (!response.ok) {
            return res.status(response.status === 404 ? 404 : 502).json({
                error: `pool change failed (${response.status}): ${detail.slice(0, 300)}`
            });
        }

        const result = JSON.parse(detail);
        res.json({ success: true, address: ethers.getAddress(address), pool: result.pool, target: result.target });
    } catch (error) {
        console.error(error);

        res.status(error.statusCode || 500).json({
            error: error.message
        });
    }
});

// =======================
// Transfer
// =======================

// The commit this proxy was deployed from (chainlens shows it next to its own)
app.get("/version", (req, res) => {
    res.json({ commit: String(process.env.APP_COMMIT || "").slice(0, 40) });
});

// Undo of a section's +x / -x: { txHash, memo } with X-Section-Key
app.post("/transfer/undo", async (req, res) => {
    try {
        const section = await sectionFromRequest(req);

        if (!section) {
            return res.status(401).json({ error: "X-Section-Key: only a section's transfers can be undone" });
        }

        res.json(await sectionTransferUndo(section, req.body));
    } catch (error) {
        if (!error.statusCode) {
            console.error(error);
        }

        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

app.post("/transfer", async (req, res) => {
    try {
        const section = await sectionFromRequest(req);

        if (section) {
            return res.json(await sectionTransfer(section, req.body));
        }

        const { from, to, amount } = req.body;

        if (!from || !to || !amount) {
            return res.status(400).json({
                error: "missing parameters"
            });
        }

        if (!isAddress(from) || !isAddress(to)) {
            return res.status(400).json({
                error: "invalid address"
            });
        }

        const amountText = String(amount).trim();
        const negative = amountText.startsWith("-");
        const value = negative ? amountText.slice(1) : amountText;

        if (!/^\d+(\.\d+)?$/.test(value)) {
            return res.status(400).json({
                error: "invalid amount"
            });
        }

        const sender = negative ? to : from;
        const recipient = negative ? from : to;

        // accounts of a section only move through that section's key (and never the registry admin)
        await assertNotSectionAccount(sender);
        if (!await signerOwns(sender)) {
            return res.status(400).json({
                error: notManaged(sender)
            });
        }

        const { txHash, nonce, memo: rec } = await withSenderLock(sender, () =>
            pay(sender, recipient, value, { t: "transfer" })
        );

        res.json({
            success: true,
            txHash,
            from: sender,
            to: recipient,
            amount: value,
            nonce,
            ...memoAnswer(rec)
        });
    } catch (error) {
        console.error(error);

        res.status(error.statusCode || 500).json({
            error: error.message
        });
    }
});

// Live state of the senders the proxy is tracking (nonce, confirmed nonce, value in flight,
// corrections made by the periodic chain check). Read-only; for operators and monitoring.
app.get("/status/senders", (req, res) => {
    const rows = [...senders.entries()].map(([sender, state]) => {
        const pending = memPending.get(sender) || new Map();
        const confirmed = state.snapshot ? state.snapshot.confirmed : null;
        let inFlight = 0n;
        let count = 0;

        for (const [nonce, value] of pending) {
            if (confirmed === null || Number(nonce) >= confirmed) {
                inFlight += BigInt(value);
                count += 1;
            }
        }

        return {
            address: state.address,
            nextNonce: memNonce.has(sender) ? memNonce.get(sender) : null,
            chainPendingNonce: state.chainPending,
            confirmedNonce: confirmed,
            snapshotBlock: state.snapshot ? state.snapshot.block : null,
            snapshotAgeMs: state.snapshot ? Date.now() - state.snapshot.at : null,
            balanceWei: state.snapshot ? state.snapshot.balance.toString() : null,
            inFlightWei: inFlight.toString(),
            inFlightTransactions: count,
            secondsSinceLastConfirmed: Math.round((Date.now() - state.progressAt) / 1000),
            gapSeconds: state.gap ? Math.round((Date.now() - state.gap.at) / 1000) : null,
            waitingAboveGap: state.futures.length,
            stalled: state.stalled,
            stallSeconds: state.stall ? Math.round((Date.now() - state.stall.at) / 1000) : null,
            stalls: state.stalls,
            fillerTransactions: state.fillers,
            nonceRepairs: state.repairs,
            nonceAdoptedFromChain: state.adopted,
            lastCheckError: state.lastError
        };
    });

    res.json({ checkIntervalMs: SENDER_CHECK_MS, stuckAfterMs: SENDER_STUCK_MS, stuckAfterBlocks: SENDER_STUCK_BLOCKS, senders: rows });
});

// Prometheus metrics of the sender check (monitoring/: job "proxy", alerts in rules/proxy.yml).
// Optional bearer token: METRICS_TOKEN.
app.get("/metrics", (req, res) => {
    const token = (process.env.METRICS_TOKEN || "").trim();

    if (token && req.get("authorization") !== `Bearer ${token}`) {
        return res.status(401).send("metrics token required\n");
    }

    const lines = [];
    const metric = (name, type, help, rows) => {
        lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
        rows.forEach(([labels, value]) => lines.push(labels ? `${name}{${labels}} ${value}` : `${name} ${value}`));
    };
    const all = [...senders.entries()].filter(([, state]) => state.snapshot);
    const per = (fn) => all.map(([sender, state]) => [`sender="${sender}"`, fn(sender, state)]);
    const inFlight = (sender, state) => {
        const pending = memPending.get(sender) || new Map();
        return [...pending.keys()].filter((nonce) => Number(nonce) >= state.snapshot.confirmed).length;
    };

    metric("proxy_up", "gauge", "Proxy is running.", [["", 1]]);
    metric("proxy_redis_up", "gauge", "1 while the proxy's Redis connection is ready (it works without Redis: memory + chain).",
        [["", redis.status === "ready" ? 1 : 0]]);
    lines.push(...httpMetricLines());
    metric("proxy_senders_tracked", "gauge", "Senders watched by the background chain check.", [["", senders.size]]);
    metric("proxy_account_info", "gauge", "The platform and section accounts by name (always 1): account, kind (platform, upfront, consumption, payment), section.",
        [...accountInfo.entries()].map(([address, info]) =>
            [`address="${address}",account="${labelValue(info.account)}",kind="${info.kind}",section="${labelValue(info.section)}",section_id="${info.sectionId}"`, 1]));
    metric("proxy_sender_info", "gauge", "What a sender is (always 1): account (a readable name), kind (platform, upfront, consumption, payment, user, retired, other) and section.",
        all.filter(([sender]) => senderInfo.has(sender)).map(([sender]) => {
            const info = senderInfo.get(sender);
            return [`sender="${sender}",account="${labelValue(info.name)}",kind="${info.kind}",section="${labelValue(info.section)}",section_id="${info.sectionId}"`, 1];
        }));
    metric("proxy_sender_next_nonce", "gauge", "Next nonce the proxy will use (absent until first use).",
        all.filter(([sender]) => memNonce.has(sender)).map(([sender]) => [`sender="${sender}"`, memNonce.get(sender)]));
    metric("proxy_sender_pending_nonce", "gauge", "Besu's pending nonce (eth_getTransactionCount pending).", per((_, st) => st.chainPending));
    metric("proxy_sender_confirmed_nonce", "gauge", "Besu's confirmed nonce.", per((_, st) => st.snapshot.confirmed));
    metric("proxy_sender_inflight_transactions", "gauge", "Transactions sent by the proxy and not confirmed yet.", per(inFlight));
    metric("proxy_sender_waiting_above_gap", "gauge", "This sender's transactions in Besu's pool waiting for a missing nonce.", per((_, st) => st.futures.length));
    metric("proxy_sender_gap_seconds", "gauge", "Seconds a nonce gap has existed with nothing confirmed (0 = no gap).",
        per((_, st) => (st.gap ? Math.round((Date.now() - st.gap.at) / 1000) : 0)));
    metric("proxy_sender_stalled", "gauge", "1 = transactions ready in Besu's pool are not mined while blocks are produced.",
        per((_, st) => (st.stalled ? 1 : 0)));
    metric("proxy_sender_stall_seconds", "gauge", "Seconds ready transactions have waited with nothing confirmed (0 = none waiting).",
        per((_, st) => (st.stall ? Math.round((Date.now() - st.stall.at) / 1000) : 0)));
    metric("proxy_sender_check_error", "gauge", "1 = the last chain check of this sender failed.", per((_, st) => (st.lastError ? 1 : 0)));
    metric("proxy_sender_nonce_repairs_total", "counter", "Nonce gaps repaired.", per((_, st) => st.repairs));
    metric("proxy_sender_filler_transactions_total", "counter", "0-value filler transactions sent to close a gap.", per((_, st) => st.fillers));
    metric("proxy_sender_nonce_adopted_total", "counter", "Times Besu's nonce was ahead (another client used the key).", per((_, st) => st.adopted));
    metric("proxy_sender_stalls_total", "counter", "Stalls detected (ready transactions not mined).", per((_, st) => st.stalls));

    lines.push(...sectionMetricLines());
    res.type("text/plain; version=0.0.4").send(lines.join("\n") + "\n");
});

app.get("/transfer/:txHash", async (req, res) => {
    try {
        const txHash = req.params.txHash;

        if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
            return res.status(400).json({
                error: "invalid transaction hash"
            });
        }

        const tx = await rpc(
            CONFIG.BESU_RPC,
            "eth_getTransactionByHash",
            [txHash]
        );

        if (!tx) {
            return res.status(404).json({
                error: "transaction not found"
            });
        }

        const rec = MEMO.fromTransaction(tx) || await loggedMemo(txHash);
        const undoable = rec && (rec.t === "transfer.in" || rec.t === "transfer.out");

        res.json({
            success: true,
            txHash: tx.hash || txHash,
            from: tx.from,
            to: tx.to || null,
            ...memoAnswer(rec),
            ...(undoable ? { undoneBy: await transferUndoneBy(txHash.toLowerCase()).catch(() => null) } : {})
        });
    } catch (error) {
        console.error(error);

        res.status(error.statusCode || 500).json({
            error: error.message
        });
    }
});

// =======================
// Avatar helpers (mint metadata and token ids)
// =======================

const ON_CHAIN_META_LIMIT = 48 * 1024;

function httpError(statusCode, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

function parseTokenId(value) {
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
        return String(value);
    }

    if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) {
        return value;
    }

    return null;
}

function onChainTokenUri(metadata) {
    const json = JSON.stringify(metadata);

    if (Buffer.byteLength(json) > ON_CHAIN_META_LIMIT) {
        throw httpError(400, "metadata is too large for the chain");
    }

    return "data:application/json;base64," + Buffer.from(json, "utf8").toString("base64");
}

async function ethCall(to, data) {
    return rpc(CONFIG.BESU_RPC, "eth_call", [{ to, data }, "latest"]);
}

async function estimateGas(tx) {
    return BigInt(await rpc(CONFIG.BESU_RPC, "eth_estimateGas", [tx]));
}

function withGasBuffer(gas) {
    return (gas * 12n) / 10n + 10000n;
}

async function assertMintFits(from, to, data) {
    let gas;

    try {
        gas = withGasBuffer(await estimateGas({
            from,
            to,
            data,
            value: "0x0"
        }));
    } catch (error) {
        const message = String(error.message || "");

        if (/gas|too large|exceed/i.test(message)) {
            throw httpError(400, "metadata is too large for the chain");
        }

        throw error;
    }

    const block = await rpc(CONFIG.BESU_RPC, "eth_getBlockByNumber", ["latest", false]);

    if (gas > BigInt(block.gasLimit)) {
        throw httpError(400, "metadata is too large for the chain");
    }
}

async function assertCanPayGas(address, gas, valueWei = 0n) {
    const cost = valueWei + gas * 0n;

    if (await availableWei(address) < cost) {
        throw httpError(400, "insufficient balance");
    }

    return cost;
}

async function sendDataFromSigner(from, to, data, nonce, gas, valueHex) {
    const tx = {
        from,
        data,
        value: valueHex,
        nonce: "0x" + nonce.toString(16),
        gas: "0x" + gas.toString(16),
        gasPrice: "0x0"
    };

    if (to) {
        tx.to = to;
    }

    return rpc(CONFIG.SIGNER_RPC, "eth_sendTransaction", [tx]);
}

// memo: { t, s, p }. A contract creation (no `to`) gets no trailer (the constructor reads its
// arguments from the end of the code), nor a contract in MEMO_SKIP_CONTRACTS: their memo goes to
// the memo log.
async function sendData(from, to, callData, valueWei = 0n, memo = { t: "other" }) {
    const rec = memoRecord(memo);
    const onChain = CONFIG.MEMO_ENABLED && to && !CONFIG.MEMO_SKIP_CONTRACTS.includes(String(to).toLowerCase());
    const data = onChain ? MEMO.append(callData, rec) : callData;
    const valueHex = "0x" + valueWei.toString(16);
    const estimateTx = {
        from,
        data,
        value: valueHex
    };

    if (to) {
        estimateTx.to = to;
    }

    const gas = withGasBuffer(await estimateGas(estimateTx));
    const cost = await assertCanPayGas(from, gas, valueWei);
    const nonce = await nextNonce(from);
    let txHash;

    try {
        txHash = await sendDataFromSigner(from, to, data, nonce, gas, valueHex);
    } catch (error) {
        await resetNonce(from);
        throw error;
    }

    await rememberPendingWei(from, nonce, cost);

    if (!onChain && CONFIG.MEMO_ENABLED) {
        logMemo(txHash, rec);
    }

    return {
        txHash,
        nonce,
        gas: gas.toString(),
        memo: rec
    };
}

async function waitForReceipt(txHash) {
    const started = Date.now();

    while (Date.now() - started < 120000) {
        const receipt = await rpc(
            CONFIG.BESU_RPC,
            "eth_getTransactionReceipt",
            [txHash]
        );

        if (receipt) {
            if (BigInt(receipt.status) !== 1n) {
                throw new Error("transaction reverted");
            }

            return receipt;
        }

        await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error("transaction was not mined");
}

function collectionField(value, label, max) {
    if (typeof value !== "string" || value.trim() === "") {
        throw httpError(400, `missing ${label}`);
    }

    const text = value.trim();

    if (text.length > max) {
        throw httpError(400, `${label} is too long`);
    }

    return text;
}

function normalizeAttributes(attributes) {
    if (attributes === undefined) {
        return [];
    }

    if (!Array.isArray(attributes)) {
        throw httpError(400, "invalid attributes");
    }

    return attributes.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
            throw httpError(400, "invalid attributes");
        }

        if (typeof item.trait_type !== "string" || item.trait_type === "") {
            throw httpError(400, "invalid attributes");
        }

        const kind = typeof item.value;

        if (kind !== "string" && kind !== "number" && kind !== "boolean") {
            throw httpError(400, "invalid attributes");
        }

        const attribute = {
            trait_type: item.trait_type,
            value: item.value
        };

        if (typeof item.display_type === "string" && item.display_type.trim() !== "") {
            attribute.display_type = item.display_type.trim();
        }

        if (typeof item.max_value === "string" || typeof item.max_value === "number") {
            attribute.max_value = item.max_value;
        }

        return attribute;
    });
}

// =======================
// Sections (docs/features/sections.md)
// =======================
// The SectionRegistry contract (v2) on chain holds the sections: name, three MPC accounts (upfront
// pays out, consumption receives, payment collects), the API-key hash, active / archived, and
// free-form info fields. Only REGISTRY_ADMIN writes it, through this proxy's send queue (one
// sender, ordered nonces). A section call is identified by its X-Section-Key alone; who may reach
// the proxy at all is the firewall's proxy_client_ips.
// The admin API (/admin/*) needs ADMIN_TOKEN and a source address in ADMIN_ALLOWED_IPS.

const registryIface = new ethers.Interface(registryArtifact.abi);
const SECTION_ROLES = {
    upfront: { kind: 2, pool: "big" },
    consumption: { kind: 3, pool: "none" },
    payment: { kind: 4, pool: "none" }
};
const ACCOUNT_USER = 1;
const SECTION_CACHE_MS = 10000;
const sectionCache = { at: 0, list: null };
const accountSectionCache = new Map(); // address (lower) -> { id, kind }
let sectionWriteChain = Promise.resolve();

function sectionsConfigured() {
    return isAddress(CONFIG.REGISTRY_CONTRACT) && isAddress(CONFIG.REGISTRY_ADMIN);
}

function requireSections() {
    if (!sectionsConfigured()) {
        throw httpError(503, "sections are not configured (REGISTRY_CONTRACT, REGISTRY_ADMIN)");
    }
}

async function registryCall(fn, args = [], iface = registryIface, address = CONFIG.REGISTRY_CONTRACT) {
    const data = iface.encodeFunctionData(fn, args);
    const result = await ethCall(address, data);
    return iface.decodeFunctionResult(fn, result);
}

// One registry write at a time, signed by REGISTRY_ADMIN; waits until it is mined.
function registryWrite(fn, args, memo = { t: "other" }) {
    const run = sectionWriteChain.then(async () => {
        const data = registryIface.encodeFunctionData(fn, args);
        let sent;

        try {
            sent = await withSenderLock(CONFIG.REGISTRY_ADMIN, () =>
                sendData(CONFIG.REGISTRY_ADMIN, CONFIG.REGISTRY_CONTRACT, data, 0n, memo)
            );
        } catch (error) {
            const reason = String(error.message || "").match(/revert(?:ed)?:?\s*(.*)$/i);
            throw reason ? httpError(409, `registry refused: ${reason[1] || error.message}`) : error;
        }

        const receipt = await waitForReceipt(sent.txHash);
        sectionCache.at = 0;
        return { txHash: sent.txHash, receipt, memo: sent.memo };
    });
    sectionWriteChain = run.then(() => {}, () => {});
    return run;
}

function sectionFromTuple(id, s, info) {
    return {
        id,
        name: s.name,
        active: s.active,
        archived: s.archived,
        createdAt: Number(s.createdAt),
        accounts: {
            upfront: ethers.getAddress(s.upfront),
            consumption: ethers.getAddress(s.consumption),
            payment: ethers.getAddress(s.payment)
        },
        info,
        keyHash: s.keyHash
    };
}

async function readSection(id) {
    const [s] = await registryCall("getSection", [id]);
    const [keys, values] = await registryCall("getInfo", [id]);
    const info = {};
    keys.forEach((key, i) => { info[key] = values[i]; });
    return sectionFromTuple(id, s, info);
}

// All sections, archived ones included (callers filter)
async function listSections(fresh = false) {
    requireSections();

    if (!fresh && sectionCache.list && Date.now() - sectionCache.at < SECTION_CACHE_MS) {
        return sectionCache.list;
    }

    const count = Number((await registryCall("sectionCount"))[0]);
    const list = [];

    for (let id = 1; id <= count; id += 1) {
        list.push(await readSection(id));
    }

    sectionCache.list = list;
    sectionCache.at = Date.now();
    return list;
}

async function getSection(id, fresh = false, allowArchived = false) {
    const n = Number(id);
    const section = Number.isInteger(n) ? (await listSections(fresh)).find((s) => s.id === n) : null;

    if (!section) {
        throw httpError(404, `no section ${id}`);
    }

    if (section.archived && !allowArchived) {
        throw httpError(409, `section ${id} is archived`);
    }

    return section;
}

async function withBalances(section) {
    const balances = {};

    for (const [role, address] of Object.entries(section.accounts)) {
        balances[role] = ethers.formatEther(await getBalanceWei(address));
    }

    const { keyHash, ...rest } = section;
    return { ...rest, balances };
}

function newSectionKey() {
    const key = "sk_" + crypto.randomBytes(32).toString("hex");
    return { key, hash: ethers.keccak256(ethers.toUtf8Bytes(key)) };
}

function sectionName(value) {
    const name = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";

    if (!name || Buffer.byteLength(name) > 64) {
        throw httpError(400, "name: 1 to 64 characters");
    }

    return name;
}

async function assertNameFree(name, exceptId = 0) {
    const taken = (await listSections(true)).find((s) => !s.archived && s.id !== exceptId && s.name.toLowerCase() === name.toLowerCase());

    if (taken) {
        throw httpError(409, `a section named "${taken.name}" exists already`);
    }
}

function infoField(key, value) {
    const k = typeof key === "string" ? key.trim() : "";

    if (!/^[A-Za-z0-9_.-]{1,32}$/.test(k)) {
        throw httpError(400, "info key: 1 to 32 characters, letters, digits, _ . -");
    }

    const v = value === undefined || value === null ? "" : String(value);

    if (Buffer.byteLength(v) > 512) {
        throw httpError(400, "info value: up to 512 bytes");
    }

    return [k, v];
}

// ---- IPv4 addresses and networks (the admin API's allowed addresses)

function ipv4ToInt(ip) {
    const parts = String(ip).split(".");

    if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) {
        return null;
    }

    return parts.reduce((acc, p) => ((acc << 8) | Number(p)) >>> 0, 0);
}

function ipMatches(ip, entries) {
    const addr = ipv4ToInt(String(ip || "").replace(/^::ffff:/, ""));

    if (addr === null) {
        return false;
    }

    return entries.some((entry) => {
        const [net, bits = "32"] = String(entry).split("/");
        const base = ipv4ToInt(net);
        const n = Number(bits);

        if (base === null || !(n >= 0 && n <= 32)) {
            return false;
        }

        const mask = n === 0 ? 0 : (0xffffffff << (32 - n)) >>> 0;
        return ((addr & mask) >>> 0) === ((base & mask) >>> 0);
    });
}

// ---- Admin API guard

function adminTokenOk(req) {
    const given = Buffer.from(String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
    const want = Buffer.from(CONFIG.ADMIN_TOKEN);
    return given.length === want.length && crypto.timingSafeEqual(given, want);
}

// A request with the admin token from an admin address (the same rules as adminGuard)
function isAdminCaller(req) {
    return CONFIG.ADMIN_TOKEN.length >= 16 && CONFIG.ADMIN_ALLOWED_IPS.length > 0
        && ipMatches(req.socket.remoteAddress, CONFIG.ADMIN_ALLOWED_IPS) && adminTokenOk(req);
}

function adminGuard(req, res, next) {
    if (CONFIG.ADMIN_TOKEN.length < 16 || !CONFIG.ADMIN_ALLOWED_IPS.length) {
        return res.status(404).json({ error: "the admin API is off (ADMIN_TOKEN, ADMIN_ALLOWED_IPS)" });
    }

    if (!ipMatches(req.socket.remoteAddress, CONFIG.ADMIN_ALLOWED_IPS)) {
        return res.status(403).json({ error: "the admin API is not allowed from this address" });
    }

    if (!adminTokenOk(req)) {
        console.warn(`admin: wrong token from ${req.socket.remoteAddress}`);
        return setTimeout(() => res.status(401).json({ error: "wrong admin token" }), 1000);
    }

    next();
}

function adminRoute(handler) {
    return async (req, res) => {
        try {
            res.json(await handler(req));
        } catch (error) {
            if (!error.statusCode) {
                console.error(error);
            }

            res.status(error.statusCode || 500).json({ error: error.message });
        }
    };
}

// ---- Admin routes: sections

app.get("/admin/sections", adminGuard, adminRoute(async (req) => {
    const all = await listSections(req.query.fresh === "1");
    const sections = [];

    for (const section of all.filter((s) => req.query.archived === "1" || !s.archived)) {
        sections.push(await withBalances(section));
    }

    return { success: true, registry: ethers.getAddress(CONFIG.REGISTRY_CONTRACT), sections };
}));

app.get("/admin/sections/:id", adminGuard, adminRoute(async (req) => ({
    success: true,
    section: await withBalances(await getSection(req.params.id, true, true))
})));

// Create: three MPC keys (needs all MPC nodes online), the API key (shown only in this answer),
// the registry entry, optional info fields. No funding: top up the upfront account separately.
app.post("/admin/sections", adminGuard, adminRoute(async (req) => {
    requireSections();
    const name = sectionName(req.body.name);
    const info = Object.entries(req.body.info || {}).map(([k, v]) => infoField(k, v)).filter(([, v]) => v !== "");
    await assertNameFree(name);

    if (!CONFIG.MPC_ADMIN_URL) {
        throw httpError(503, "sections need the MPC signer (MPC_ADMIN_URL)");
    }

    const accounts = {};

    for (const [role, { pool }] of Object.entries(SECTION_ROLES)) {
        accounts[role] = await createMpcAccount(pool);
    }

    const { key, hash } = newSectionKey();
    const written = await registryWrite("createSection", [name, accounts.upfront, accounts.consumption, accounts.payment, hash],
        { t: "section.create", p: { name } });
    const created = written.receipt.logs
        .map((log) => { try { return registryIface.parseLog(log); } catch { return null; } })
        .find((log) => log && log.name === "SectionCreated");
    const id = Number(created.args.id);

    for (const [k, v] of info) {
        await registryWrite("setInfo", [id, k, v], { t: "section.info", s: [id, name], p: { key: k } });
    }

    console.log(`section ${id} "${name}" created: upfront ${accounts.upfront}, consumption ${accounts.consumption}, payment ${accounts.payment}`);

    return {
        success: true,
        section: await withBalances(await getSection(id, true)),
        apiKey: key,
        note: "the API key is shown only now: store it for the section's applications",
        txHash: written.txHash,
        ...memoAnswer(written.memo)
    };
}));

app.post("/admin/sections/:id/name", adminGuard, adminRoute(async (req) => {
    const section = await getSection(req.params.id, true);
    const name = sectionName(req.body.name);

    if (name === section.name) {
        return { success: true, id: section.id, name };
    }

    await assertNameFree(name, section.id);
    const written = await registryWrite("setName", [section.id, name], { t: "section.rename", s: [section.id, name], p: { from: section.name, to: name } });
    console.log(`section ${section.id}: renamed "${section.name}" -> "${name}"`);
    return { success: true, id: section.id, name, txHash: written.txHash, ...memoAnswer(written.memo) };
}));

// Info field: { key, value }; an empty value removes the field
app.post("/admin/sections/:id/info", adminGuard, adminRoute(async (req) => {
    const section = await getSection(req.params.id, true);
    const [key, value] = infoField(req.body.key, req.body.value);
    const written = await registryWrite("setInfo", [section.id, key, value], { t: "section.info", s: section, p: { key } });
    return { success: true, id: section.id, key, value, removed: value === "", txHash: written.txHash, ...memoAnswer(written.memo) };
}));

// New API key; the old one stops working at once
app.post("/admin/sections/:id/key", adminGuard, adminRoute(async (req) => {
    const section = await getSection(req.params.id, true);
    const { key, hash } = newSectionKey();
    const written = await registryWrite("setKey", [section.id, hash], { t: "section.key", s: section });
    console.log(`section ${section.id}: API key rotated`);
    return { success: true, id: section.id, apiKey: key, note: "the API key is shown only now", txHash: written.txHash, ...memoAnswer(written.memo) };
}));

app.post("/admin/sections/:id/active", adminGuard, adminRoute(async (req) => {
    const section = await getSection(req.params.id, true);

    if (typeof req.body.active !== "boolean") {
        throw httpError(400, "active: true or false");
    }

    const written = await registryWrite("setActive", [section.id, req.body.active], { t: req.body.active ? "section.enable" : "section.disable", s: section });
    return { success: true, id: section.id, active: req.body.active, txHash: written.txHash, ...memoAnswer(written.memo) };
}));

// ---- Admin routes: section money. Each transfer carries a memo naming the operation, so the chain
// itself shows what it was. "all" moves the whole spendable balance (gas is free).

function adminAmount(value, allowAll) {
    const text = String(value === undefined || value === null ? "" : value).trim().toLowerCase();

    if (allowAll && text === "all") {
        return "all";
    }

    if (!/^\d+(\.\d+)?$/.test(text) || ethToWei(text) === 0n) {
        throw httpError(400, allowAll ? "amount: a positive number of ETH, or \"all\"" : "amount: a positive number of ETH");
    }

    return text;
}

// Moves `amountInput` ("all" or ETH) from -> to. With quietIfEmpty, "all" of a zero balance is a no-op.
// op: topup | sweep | payback | account_replaced | archive_return (with role). The memo names it.
const MOVE_MEMO = { topup: "section.topup", sweep: "section.sweep", payback: "section.payback", account_replaced: "account.move", archive_return: "section.return" };

async function sectionMove(section, from, to, amountInput, op, quietIfEmpty = false, role = undefined) {
    let amount = amountInput;
    const memo = { t: MOVE_MEMO[op] || "transfer", s: section, p: role ? { role } : {} };

    const result = await withSenderLock(from, async () => {
        if (amount === "all") {
            const available = await availableWei(from);

            if (available === 0n) {
                if (quietIfEmpty) {
                    return null;
                }

                throw httpError(400, "nothing to move: the balance is 0");
            }

            amount = ethers.formatEther(available);
        }

        await assertCanPay(from, amount);
        return pay(from, to, amount, memo);
    });

    if (!result) {
        return { success: true, id: section.id, operation: op, from, to, amount: "0", txHash: null };
    }

    console.log(`section ${section.id}: ${op}${role ? " " + role : ""}: ${amount} ETH ${from} -> ${to} (${result.txHash})`);
    countSectionOp(section, op, amount);
    return { success: true, id: section.id, operation: op, from, to, amount, txHash: result.txHash, nonce: result.nonce, ...memoAnswer(result.memo) };
}

// SENDER01 -> upfront_i
app.post("/admin/sections/:id/topup", adminGuard, adminRoute(async (req) => {
    const section = await getSection(req.params.id, true);
    return sectionMove(section, CONFIG.SENDER01, section.accounts.upfront, adminAmount(req.body.amount, false), "topup");
}));

// consumption_i -> payment_i
app.post("/admin/sections/:id/sweep", adminGuard, adminRoute(async (req) => {
    const section = await getSection(req.params.id, true);
    return sectionMove(section, section.accounts.consumption, section.accounts.payment, adminAmount(req.body.amount, true), "sweep");
}));

// payment_i -> SENDER01
app.post("/admin/sections/:id/payback", adminGuard, adminRoute(async (req) => {
    const section = await getSection(req.params.id, true);
    return sectionMove(section, section.accounts.payment, CONFIG.SENDER01, adminAmount(req.body.amount, true), "payback");
}));

// Replace an account: { role: upfront | consumption | payment }. A new MPC key takes the role; the
// whole balance of the previous account moves to it (the previous one stays the section's, retired).
app.post("/admin/sections/:id/account", adminGuard, adminRoute(async (req) => {
    const section = await getSection(req.params.id, true);
    const role = String(req.body.role || "");

    if (!SECTION_ROLES[role]) {
        throw httpError(400, "role: upfront, consumption or payment");
    }

    if (!CONFIG.MPC_ADMIN_URL) {
        throw httpError(503, "sections need the MPC signer (MPC_ADMIN_URL)");
    }

    const previous = section.accounts[role];
    const account = await createMpcAccount(SECTION_ROLES[role].pool);
    const written = await registryWrite("replaceAccount", [section.id, SECTION_ROLES[role].kind, account], { t: "account.replace", s: section, p: { role } });
    accountSectionCache.clear();
    console.log(`section ${section.id}: ${role} account ${previous} -> ${account}`);
    let moved;

    try {
        moved = await sectionMove(section, previous, account, "all", "account_replaced", true, role);
    } catch (error) {
        moved = { error: `the previous account's balance was not moved (${error.message}); move it with this request again` };
    }

    return { success: true, id: section.id, role, previous, account, txHash: written.txHash, balanceMoved: moved, ...memoAnswer(written.memo) };
}));

// Archive: all money back to SENDER01 (upfront, consumption, payment), then the section is closed
// for good (name and key freed, history kept). Body { confirm: "<section name>" }.
app.post("/admin/sections/:id/archive", adminGuard, adminRoute(async (req) => {
    const section = await getSection(req.params.id, true);

    if (req.body.confirm !== section.name) {
        throw httpError(400, `to archive, send { "confirm": "${section.name}" }`);
    }

    const returned = {};

    for (const role of Object.keys(SECTION_ROLES)) {
        returned[role] = await sectionMove(section, section.accounts[role], CONFIG.SENDER01, "all", "archive_return", true, role);
    }

    const written = await registryWrite("archive", [section.id], { t: "section.archive", s: section });
    console.log(`section ${section.id} "${section.name}" archived`);
    return { success: true, id: section.id, archived: true, returned, txHash: written.txHash, ...memoAnswer(written.memo) };
}));

// eth_getLogs over [fromBlock, head] in chunks of 1000 blocks (Besu limits the range per call)
async function registryLogs(address, fromBlock, topics) {
    const head = parseInt(await rpc(CONFIG.BESU_RPC, "eth_blockNumber", []), 16);
    const logs = [];

    for (let start = fromBlock; start <= head; start += 1000) {
        const end = Math.min(start + 999, head);
        logs.push(...await rpc(CONFIG.BESU_RPC, "eth_getLogs", [{
            address, fromBlock: ethers.toQuantity(start), toBlock: ethers.toQuantity(end), topics
        }]));
    }

    return logs;
}

// ---- Admin routes: a section's user accounts (chainlens Sections page)

// The user accounts of a section (AccountAdded events), with their balances
app.get("/admin/sections/:id/accounts", adminGuard, adminRoute(async (req) => {
    const section = await getSection(req.params.id, true, true);
    const logs = await registryLogs(CONFIG.REGISTRY_CONTRACT, CONFIG.REGISTRY_FROM_BLOCK, [
        registryIface.getEvent("AccountAdded").topicHash, ethers.zeroPadValue(ethers.toBeHex(section.id), 32)
    ]);
    const accounts = [];

    for (const log of logs) {
        const address = ethers.getAddress("0x" + log.topics[2].slice(26));

        if (!accounts.some((a) => a.address === address)) {
            accounts.push({ address, balance: ethers.formatEther(await getBalanceWei(address)), addedIn: parseInt(log.blockNumber, 16) });
        }
    }

    return { success: true, id: section.id, accounts };
}));

// A new user account of the section, funded from its upfront account (like /createaccount with its key)
app.post("/admin/sections/:id/accounts", adminGuard, adminRoute(async (req) => {
    const section = await getSection(req.params.id, true);
    const amount = String(req.body.amount === undefined || req.body.amount === null || req.body.amount === "" ? "0" : req.body.amount).trim();

    if (!/^\d+(\.\d+)?$/.test(amount)) {
        throw httpError(400, "amount: ETH, e.g. \"5\" (0 for none)");
    }

    return createSectionAccount(section, amount, poolClass(req.body.pool));
}));

// +x account -> consumption, -x upfront -> account (like /transfer with its key)
app.post("/admin/sections/:id/transfer", adminGuard, adminRoute(async (req) => {
    const section = await getSection(req.params.id, true);
    return sectionTransfer(section, { account: req.body.account, amount: req.body.amount, memo: req.body.memo });
}));

// The undo of a +x / -x (docs/features/transfer-undo.md), as the section's key would: { txHash, memo }
app.post("/admin/sections/:id/undo", adminGuard, adminRoute(async (req) => {
    const section = await getSection(req.params.id, true);
    return sectionTransferUndo(section, req.body);
}));

// ---- Transfer undo: the money of a +x / -x goes back, the full amount, once, within TRANSFER_UNDO_DAYS.
// It is sent through the TransferUndo contract, which refuses a second undo of the same transfer.

async function transferUndoContract(optional = false) {
    requireSections();
    const pick = (book) => [...book.values()]
        .filter((e) => hasFunction(e, "undoneAt") && hasFunction(e, "undo") && !platformKind(e))
        .sort((a, b) => b.registeredIn - a.registeredIn)[0];
    const entry = pick(await loadContracts()) || pick(await loadContracts(true));

    if (!entry && !optional) {
        throw httpError(503, "no transfer-undo contract yet: POST /admin/contract/deploy { \"template\": \"transfer-undo\" } (ansible 06-proxy.yml does it)");
    }

    return entry || null;
}

// The undo of a transfer, if any: { block, txHash }
async function transferUndoneBy(txHash) {
    const entry = await transferUndoContract(true);

    if (!entry) {
        return null;
    }

    const [block] = await entryCall(entry, "undoneAt", [txHash]);

    if (!block) {
        return null;
    }

    const topic = entry.iface.getEvent("TransferUndone").topicHash;
    const logs = await rpc(CONFIG.BESU_RPC, "eth_getLogs", [{ address: entry.address, topics: [topic, txHash],
        fromBlock: ethers.toQuantity(block), toBlock: ethers.toQuantity(block) }]);
    return { block: Number(block), txHash: logs[0] ? logs[0].transactionHash : null };
}

async function sectionTransferUndo(section, body) {
    const original = String((body || {}).txHash || "").toLowerCase();

    if (!/^0x[0-9a-f]{64}$/.test(original)) {
        throw httpError(400, "txHash: the +x / -x transaction to undo");
    }

    const entry = await transferUndoContract();
    const tx = await rpc(CONFIG.BESU_RPC, "eth_getTransactionByHash", [original]);
    const receipt = tx ? await rpc(CONFIG.BESU_RPC, "eth_getTransactionReceipt", [original]) : null;

    if (!tx || !receipt) {
        throw httpError(404, "transaction not found (or not mined yet)");
    }

    if (BigInt(receipt.status) !== 1n) {
        throw httpError(409, "that transaction failed: nothing to undo");
    }

    const rec = MEMO.fromTransaction(tx);
    const kind = rec && { "transfer.in": "in", "transfer.out": "out" }[rec.t];

    if (!kind || !rec.s || Number(rec.s[0]) !== section.id) {
        throw httpError(409, `only a +x / -x of section "${section.name}" can be undone (this is ${rec ? rec.t : "not a section transfer"})`);
    }

    const block = await rpc(CONFIG.BESU_RPC, "eth_getBlockByNumber", [tx.blockNumber, false]);
    const ageDays = (Date.now() / 1000 - Number(BigInt(block.timestamp))) / 86400;

    if (ageDays > CONFIG.TRANSFER_UNDO_DAYS) {
        throw httpError(409, `too late: a transfer can be undone for ${CONFIG.TRANSFER_UNDO_DAYS} days (this one is ${ageDays.toFixed(1)} days old)`);
    }

    const done = await transferUndoneBy(original);

    if (done) {
        throw httpError(409, `already undone in block ${done.block}${done.txHash ? ` (transaction ${done.txHash})` : ""}`);
    }

    // +x: the consumption account pays the user back; -x: the user pays the upfront account back
    const user = ethers.getAddress(kind === "in" ? tx.from : tx.to);
    const payer = kind === "in" ? section.accounts.consumption : user;
    const recipient = kind === "in" ? user : section.accounts.upfront;
    const amountWei = BigInt(tx.value);
    const amount = ethers.formatEther(amountWei).replace(/\.0$/, "");
    const balance = await getBalanceWei(payer);

    if (balance < amountWei) {
        throw httpError(409, `the undo needs ${amount} ETH but ${payer} (${kind === "in" ? "the consumption account" : "the user account"}) has ${ethText(balance)} ETH`);
    }

    const data = entry.iface.encodeFunctionData("undo", [original, recipient]);
    let sent;

    try {
        sent = await withSenderLock(payer, () => sendData(payer, entry.address, data, amountWei,
            { t: kind === "in" ? "transfer.undoIn" : "transfer.undoOut", s: section, p: { amount, undoOf: original } }));
    } catch (error) {
        if (error.statusCode) {
            throw error;
        }

        throw httpError(409, `the undo would revert: ${revertReason(error)}`);
    }

    const mined = await receiptOf(sent.txHash);

    if (BigInt(mined.status) !== 1n) {
        throw httpError(409, `the undo reverted (transaction ${sent.txHash}): maybe undone meanwhile`);
    }

    countSectionOp(section, kind === "in" ? "transfer_in_undo" : "transfer_out_undo", amount);
    console.log(`section ${section.id}: undo of ${original} (${kind === "in" ? "+x" : "-x"} ${amount} ETH): ${payer} -> ${recipient} (${sent.txHash})`);

    return {
        success: true,
        section: { id: section.id, name: section.name },
        undoOf: original,
        direction: kind === "in" ? "consumption -> account" : "account -> upfront",
        from: payer,
        to: recipient,
        amount,
        txHash: sent.txHash,
        nonce: sent.nonce,
        ...memoAnswer(sent.memo)
    };
}

// ---- Migration from an earlier registry (v1): sections (name, accounts, key hash, active) and their
// user accounts are written into this registry. Run once by Ansible after deploying v2.
// Body { from: <old registry>, fromBlock: <block it was deployed in> }.
const registryV1Iface = new ethers.Interface(require("./section-registry-v1.json").abi);

app.post("/admin/registry/migrate", adminGuard, adminRoute(async (req) => {
    requireSections();
    const from = String(req.body.from || "");

    if (!isAddress(from)) {
        throw httpError(400, "from: the previous registry's address");
    }

    const startBlock = Number.isInteger(Number(req.body.fromBlock)) && Number(req.body.fromBlock) >= 0 ? Number(req.body.fromBlock) : 0;
    const [count] = await registryCall("sectionCount", [], registryV1Iface, from);
    const existing = await listSections(true);
    const done = [];

    for (let id = 1; id <= Number(count); id += 1) {
        const [s] = await registryCall("getSection", [id], registryV1Iface, from);

        // a section created by an earlier, interrupted run: keep it, still copy its user accounts
        const earlier = existing.find((e) => e.accounts.upfront.toLowerCase() === s.upfront.toLowerCase());
        let newId;

        if (earlier) {
            newId = earlier.id;
        } else {
            const written = await registryWrite("createSection", [s.name, s.upfront, s.consumption, s.payment, s.keyHash],
                { t: "section.migrate", s: [id, s.name] });
            const created = written.receipt.logs
                .map((log) => { try { return registryIface.parseLog(log); } catch { return null; } })
                .find((log) => log && log.name === "SectionCreated");
            newId = Number(created.args.id);

            if (!s.active) {
                await registryWrite("setActive", [newId, false], { t: "section.migrate", s: [newId, s.name] });
            }
        }

        // the section's user accounts, from the old registry's AccountAdded events (in chunks: Besu
        // limits the block range of one eth_getLogs)
        const users = [...new Set((await registryLogs(from, startBlock, [
            registryV1Iface.getEvent("AccountAdded").topicHash, ethers.zeroPadValue(ethers.toBeHex(id), 32)
        ])).map((log) => ethers.getAddress("0x" + log.topics[2].slice(26))))];

        // only the ones not registered yet (addAccounts skips the others anyway)
        const missing = [];

        for (const user of users) {
            const [kind] = await registryCall("accountKind", [user]);

            if (Number(kind) === 0) {
                missing.push(user);
            }
        }

        for (let i = 0; i < missing.length; i += 100) {
            await registryWrite("addAccounts", [newId, missing.slice(i, i + 100)], { t: "section.migrate", s: [newId, s.name] });
        }

        done.push({ id, newId, name: s.name, active: s.active, users: users.length, added: missing.length, resumed: Boolean(earlier) });
        console.log(`registry migration: section ${id} "${s.name}" -> ${newId}, ${users.length} user account(s)`);
    }

    accountSectionCache.clear();
    return { success: true, from: ethers.getAddress(from), to: ethers.getAddress(CONFIG.REGISTRY_CONTRACT), sections: done };
}));

// =======================
// Contracts (docs/features/sections.md, step 4)
// =======================
// Contracts are deployed by CONTRACT_CENTER (an MPC key, through this proxy's send queue) and
// registered in the SectionRegistry with their ABI (ContractRegistered event). Applications read
// them with /contract/call and change them with /contract/send, signed by a user account of their
// section. Only registered contracts and only functions of their ABI.

const CONTRACT_KINDS = { common: 1, avatar: 2 };
const KIND_ALIASES = { nft: "avatar" };          // the old name, still accepted
const contractBook = { byAddress: new Map(), scannedTo: -1, at: 0, loading: null };

function requireCenter() {
    if (!isAddress(CONFIG.CONTRACT_CENTER)) {
        throw httpError(503, "the contract account center is not configured (CONTRACT_CENTER)");
    }
}

// Registered contracts, from the registry's ContractRegistered events (new ones read every 10 s)
async function loadContracts(fresh = false) {
    requireSections();

    if (!fresh && contractBook.scannedTo >= 0 && Date.now() - contractBook.at < 10000) {
        return contractBook.byAddress;
    }

    if (!contractBook.loading) {
        contractBook.loading = (async () => {
            const from = contractBook.scannedTo >= 0 ? contractBook.scannedTo + 1 : CONFIG.REGISTRY_FROM_BLOCK;
            const head = parseInt(await rpc(CONFIG.BESU_RPC, "eth_blockNumber", []), 16);

            if (from <= head) {
                const logs = await registryLogs(CONFIG.REGISTRY_CONTRACT, from, [registryIface.getEvent("ContractRegistered").topicHash]);

                for (const log of logs) {
                    const parsed = registryIface.parseLog(log);
                    const address = ethers.getAddress(parsed.args.contractAddress);

                    try {
                        const abi = JSON.parse(parsed.args.abiJson);
                        contractBook.byAddress.set(address.toLowerCase(), {
                            address,
                            kind: Number(parsed.args.kind) === 2 ? "avatar" : "common",
                            name: parsed.args.name,
                            abi,
                            iface: new ethers.Interface(abi),
                            registeredIn: parseInt(log.blockNumber, 16)
                        });
                    } catch (error) {
                        console.error(`contract ${address}: unreadable ABI in the registry (${error.message})`);
                    }
                }
            }

            contractBook.scannedTo = head;
            contractBook.at = Date.now();
        })().finally(() => { contractBook.loading = null; });
    }

    await contractBook.loading;
    return contractBook.byAddress;
}

async function registeredContract(address) {
    if (!isAddress(String(address || ""))) {
        throw httpError(400, "contract: a contract address");
    }

    let entry = (await loadContracts()).get(address.toLowerCase());

    if (!entry) {
        entry = (await loadContracts(true)).get(address.toLowerCase());
    }

    if (!entry) {
        throw httpError(404, `${ethers.getAddress(address)} is not a registered contract`);
    }

    return entry;
}

function contractFunction(entry, fn) {
    let fragment;

    try {
        fragment = entry.iface.getFunction(String(fn || ""));
    } catch (error) {
        throw httpError(400, `function "${fn}": ${/ambiguous/i.test(error.message) ? "several functions have this name, give the signature, e.g. transfer(address,uint256)" : "not in the contract's ABI"}`);
    }

    if (!fragment) {
        throw httpError(400, `function "${fn}" is not in the contract's ABI`);
    }

    return fragment;
}

// Arguments typed as text: arrays and tuples as JSON, booleans as true/false; other values as given
function coerceParams(params, raw) {
    const list = Array.isArray(raw) ? raw : [];

    if (list.length !== params.length) {
        throw httpError(400, `expects ${params.length} argument(s): (${params.map((p) => p.format("sighash") + (p.name ? " " + p.name : "")).join(", ")})`);
    }

    return params.map((p, i) => {
        const v = list[i];

        if (typeof v !== "string") {
            return v;
        }

        if (p.baseType === "array" || p.baseType === "tuple") {
            try {
                return JSON.parse(v);
            } catch (error) {
                throw httpError(400, `argument ${p.name || i}: arrays and tuples are written as JSON`);
            }
        }

        if (p.baseType === "bool") {
            return v.trim().toLowerCase() === "true";
        }

        return v.trim();
    });
}

function jsonValue(value) {
    if (typeof value === "bigint") {
        return value.toString();
    }

    if (value instanceof Uint8Array) {
        return ethers.hexlify(value);
    }

    if (value && typeof value === "object" && typeof value.toArray === "function") {
        return value.toArray().map(jsonValue);
    }

    if (Array.isArray(value)) {
        return value.map(jsonValue);
    }

    return value;
}

function revertReason(error) {
    const text = String(error && error.message || error);
    const m = text.match(/revert(?:ed)?:?\s*(.*)$/i);
    const reason = m && m[1] ? m[1].trim() : text;
    return reason.replace(/^\((.*)\)$/, "$1");
}

// A receipt, whatever its status (waitForReceipt throws on a revert)
async function receiptOf(txHash) {
    const started = Date.now();

    while (Date.now() - started < 120000) {
        const receipt = await rpc(CONFIG.BESU_RPC, "eth_getTransactionReceipt", [txHash]);

        if (receipt) {
            return receipt;
        }

        await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw httpError(504, `transaction ${txHash} was not mined within 120 s`);
}

function decodeEvents(entry, receipt) {
    return (receipt.logs || []).filter((log) => log.address.toLowerCase() === entry.address.toLowerCase()).map((log) => {
        try {
            const parsed = entry.iface.parseLog(log);
            const args = {};
            parsed.fragment.inputs.forEach((input, i) => { args[input.name || String(i)] = jsonValue(parsed.args[i]); });
            return { name: parsed.name, args };
        } catch (error) {
            return { name: log.topics[0] ? log.topics[0].slice(0, 10) : "log", args: {} };
        }
    });
}

// ---- Admin: the deployment of a contract by the center (check = dry run)

function deployInputOf(body) {
    const b = body || {};
    const kind = KIND_ALIASES[String(b.kind || "common")] || String(b.kind || "common");

    if (!CONTRACT_KINDS[kind]) {
        throw httpError(400, "kind: common or avatar");
    }

    if (!Array.isArray(b.abi) || typeof b.bytecode !== "string" || !/^(0x)?[0-9a-fA-F]+$/.test(b.bytecode)) {
        throw httpError(400, "abi (array) and bytecode (hex) are required: the compiled contract");
    }

    if (b.bytecode.includes("__$")) {
        throw httpError(400, "the bytecode has unlinked library placeholders (__$...$__)");
    }

    const name = typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 80) : "Contract";
    const iface = new ethers.Interface(b.abi);
    const args = coerceParams(iface.deploy.inputs, b.args || []);
    let encoded;

    try {
        encoded = iface.encodeDeploy(args);
    } catch (error) {
        throw httpError(400, `constructor arguments: ${error.shortMessage || error.message}`);
    }

    const bytecode = b.bytecode.startsWith("0x") ? b.bytecode : "0x" + b.bytecode;
    return {
        kind, name, iface, abi: b.abi, args, data: ethers.concat([bytecode, encoded]),
        deployedBytecode: typeof b.deployedBytecode === "string" && b.deployedBytecode.length > 2
            ? (b.deployedBytecode.startsWith("0x") ? b.deployedBytecode : "0x" + b.deployedBytecode) : null,
        immutables: b.immutableReferences || null
    };
}

async function deployCheck(input) {
    let estimate;

    try {
        estimate = await estimateGas({ from: CONFIG.CONTRACT_CENTER, data: input.data, value: "0x0" });
    } catch (error) {
        throw httpError(400, `the deployment reverts or is invalid (${revertReason(error)}). Check the constructor arguments and the EVM version (cancun at the latest)`);
    }

    const block = await rpc(CONFIG.BESU_RPC, "eth_getBlockByNumber", ["latest", false]);

    if (withGasBuffer(estimate) > BigInt(block.gasLimit)) {
        throw httpError(400, `needs ${estimate} gas, more than a block holds (${BigInt(block.gasLimit)})`);
    }

    return estimate;
}

function codeCheck(input, code) {
    const expected = input.deployedBytecode;

    if (!expected) {
        return "not checked (no deployedBytecode)";
    }

    if (code.toLowerCase() === expected.toLowerCase()) {
        return "matches the artifact";
    }

    if (ethers.dataLength(code) !== ethers.dataLength(expected)) {
        return "DIFFERS from the artifact";
    }

    if (input.immutables && Object.keys(input.immutables).length) {
        const a = ethers.getBytes(code).slice();
        const b = ethers.getBytes(expected).slice();

        for (const refs of Object.values(input.immutables)) {
            for (const { start, length } of refs) {
                a.fill(0, start, start + length);
                b.fill(0, start, start + length);
            }
        }

        return ethers.hexlify(a) === ethers.hexlify(b) ? "matches the artifact (immutable values excluded)" : "DIFFERS from the artifact";
    }

    return "same length as the artifact, not identical";
}

// Dry run: every check, nothing signed
app.post("/admin/contract/check", adminGuard, adminRoute(async (req) => {
    requireSections();
    requireCenter();
    const input = await templateInput(req.body);
    const estimate = await deployCheck(input);
    const nonce = parseInt(await rpc(CONFIG.BESU_RPC, "eth_getTransactionCount", [CONFIG.CONTRACT_CENTER, "pending"]), 16);

    return {
        success: true,
        name: input.name,
        kind: input.kind,
        from: ethers.getAddress(CONFIG.CONTRACT_CENTER),
        constructor: input.iface.deploy.inputs.map((p) => p.format("sighash") + (p.name ? " " + p.name : "")).join(", "),
        args: jsonValue(input.args),
        estimate: estimate.toString(),
        gas: withGasBuffer(estimate).toString(),
        address: ethers.getCreateAddress({ from: CONFIG.CONTRACT_CENTER, nonce }),
        creationSize: ethers.dataLength(input.data)
    };
}));

// Deploy (signed by the center), check the code, register it (registry admin)
app.post("/admin/contract/deploy", adminGuard, adminRoute(async (req) => {
    requireSections();
    requireCenter();
    return deployAndRegister(await templateInput(req.body));
}));

async function deployAndRegister(input) {
    await deployCheck(input);
    const deployMemo = { t: "contract.deploy", p: { name: input.name, kind: input.kind } };
    const sent = await withSenderLock(CONFIG.CONTRACT_CENTER, () => sendData(CONFIG.CONTRACT_CENTER, null, input.data, 0n, deployMemo));
    const receipt = await receiptOf(sent.txHash);

    if (BigInt(receipt.status) !== 1n || !receipt.contractAddress) {
        throw httpError(400, `the deployment reverted in block ${BigInt(receipt.blockNumber)} (transaction ${sent.txHash})`);
    }

    const address = ethers.getAddress(receipt.contractAddress);
    const code = await rpc(CONFIG.BESU_RPC, "eth_getCode", [address, "latest"]);
    const check = codeCheck(input, code);
    const registered = await registryWrite("registerContract", [address, CONTRACT_KINDS[input.kind], input.name, JSON.stringify(input.abi)], deployMemo);
    contractBook.byAddress.set(address.toLowerCase(), {
        address, kind: input.kind, name: input.name, abi: input.abi, iface: input.iface, registeredIn: parseInt(registered.receipt.blockNumber, 16)
    });
    console.log(`contract ${input.kind} "${input.name}" deployed at ${address} by the center (${sent.txHash}), ${check}`);

    return {
        success: true,
        name: input.name,
        kind: input.kind,
        address,
        deployer: ethers.getAddress(CONFIG.CONTRACT_CENTER),
        txHash: sent.txHash,
        blockNumber: Number(BigInt(receipt.blockNumber)),
        gasUsed: Number(BigInt(receipt.gasUsed)),
        codeCheck: check,
        registryTxHash: registered.txHash,
        ...memoAnswer(registered.memo)
    };
}


// ---- Nickname tokens (contracts/NicknameCollection.sol, docs/features/nicknames.md) ----------------
// One nickname per section user account, bound to it (never transferable), with an edge level that only
// goes up. Bought and upgraded by the user account (its MPC key signs), paid to its section's
// consumption account. The edge levels are set by the contract account center (the minter).
// The collection: the latest registered nickname collection, version 5 (POST /admin/contract/deploy, template nickname-collection).

const nicknameArtifact = require("./nickname-collection.json");
const transferUndoArtifact = require("./transfer-undo.json");
const NICKNAME_FORBIDDEN = /[<>&"'\\\u0000-\u001f\u007f]/;

function ethText(wei) {
    return ethers.formatEther(wei).replace(/\.0$/, "");
}

async function nicknameCollection(optional = false) {
    requireSections();
    const pick = (book) => [...book.values()]
        .filter((e) => platformKind(e) === "nickname")
        .sort((a, b) => b.registeredIn - a.registeredIn)[0];
    const entry = pick(await loadContracts()) || pick(await loadContracts(true));

    if (!entry && !optional) {
        throw httpError(503, "no nickname collection yet: deploy one (POST /admin/contract/deploy with template nickname-collection, or the chainlens Nicknames page)");
    }

    return entry || null;
}

// What the user typed, trimmed and NFC-normalized: 1-256 characters, none forbidden
function nicknameInput(value) {
    if (typeof value !== "string") {
        throw httpError(400, "nickname: text, 1 to 256 characters");
    }

    const text = value.normalize("NFC").trim();
    const chars = Array.from(text).length;

    if (chars < 1 || chars > 256) {
        throw httpError(400, `nickname: 1 to 256 characters (this one has ${chars})`);
    }

    if (NICKNAME_FORBIDDEN.test(text)) {
        throw httpError(400, "nickname: no control characters and none of < > & \" ' \\");
    }

    return text;
}

// A user level: its number, step price (ETH) and whether it is for sale. Nothing else is stored.
function levelOut(level, l) {
    return { level, price: ethText(l.stepPrice), forSale: l.forSale };
}

async function readLevels(entry) {
    const [count] = await entryCall(entry, "levelCount");
    const levels = [];

    for (let level = 0; level < Number(count); level++) {
        const [l] = await entryCall(entry, "levelInfo", [level]);
        levels.push(levelOut(level, l));
    }

    return levels;
}

function decodeDataUri(uri) {
    const m = String(uri).match(/^data:application\/json;base64,(.*)$/);
    return m ? JSON.parse(Buffer.from(m[1], "base64").toString("utf8")) : null;
}

// A user level's price and sale state from friendly input; omitted fields keep the current values
function levelInput(body, current) {
    const b = body || {};
    return {
        stepPrice: b.price === undefined && current ? ethToWei(current.price) : adminPrice(b.price),
        forSale: b.forSale === undefined ? (current ? current.forSale : true) : Boolean(b.forSale)
    };
}

function adminPrice(value) {
    if (value === undefined || value === null || !/^\d+(\.\d+)?$/.test(String(value))) {
        throw httpError(400, "price: ETH, e.g. \"0.5\" (0 allowed)");
    }

    return ethToWei(String(value));
}

// Avatar metadata (no name: the image is the avatar), as an on-chain data URI
function avatarMetadataUri(o) {
    const image = collectionField(o.image, "image", 2000);
    const description = o.description === undefined ? "" : o.description;

    if (typeof description !== "string" || description.length > 5000) {
        throw httpError(400, "description: text, at most 5000 characters");
    }

    const metadata = { image };

    if (description) {
        metadata.description = description;
    }

    const attributes = normalizeAttributes(o.attributes);

    if (attributes.length) {
        metadata.attributes = attributes;
    }

    return { image, uri: onChainTokenUri(metadata) };
}

// The token id of an image (avatar) or nickname, 404 when not minted
async function tokenIdOf(entry, key) {
    const [tokenId] = await entryCall(entry, "tokenOf", [key]);

    if (tokenId === 0n) {
        throw httpError(404, `${platformKind(entry) === "nickname" ? `nickname "${key}"` : `image ${key}`} is not minted`);
    }

    return tokenId;
}

// Every payment for a token, with times and whether each can be undone now (see BoundItems)
async function paymentsInfo(entry, tokenId) {
    const [[list], [hold], block] = await Promise.all([
        entryCall(entry, "paymentsOf", [tokenId]),
        entryCall(entry, "holdSeconds"),
        rpc(CONFIG.BESU_RPC, "eth_getBlockByNumber", ["latest", false])
    ]);
    const now = BigInt(parseInt(block.timestamp, 16));
    const iso = (s) => new Date(Number(s) * 1000).toISOString();
    let sale = -1;
    list.forEach((p, i) => { if (Number(p.kind) === 0) { sale = i; } });
    const saleLive = sale >= 0 && !list[sale].undone;
    let newestLevel = -1;

    if (saleLive) {
        for (let i = list.length - 1; i > sale; i--) {
            if (!list[i].undone) {
                newestLevel = i;
                break;
            }
        }
    }

    return list.map((p, i) => {
        const until = BigInt(p.paidAt) + hold;
        const level = Number(p.kind) === 1;
        const open = !p.undone && now <= until && (level ? i === newestLevel : i === sale && saleLive);
        const out = { kind: level ? "level" : "sale" };

        if (level) {
            Object.assign(out, { fromLevel: Number(p.fromLevel), toLevel: Number(p.toLevel) });
        }

        return Object.assign(out, { amount: ethText(p.amount), payer: ethers.getAddress(p.payer), paidTo: ethers.getAddress(p.paidTo),
            paidAt: iso(p.paidAt), undoUntil: iso(until), undone: p.undone, undoable: open, current: i >= sale && saleLive });
    });
}

// The token's undo target: the sale (undo) or the newest level upgrade (undoLevel), its refund and payee
async function undoTarget(entry, fragmentName, tokenId) {
    const payments = await paymentsInfo(entry, tokenId);
    const current = payments.filter((p) => p.current && !p.undone);

    if (!current.length) {
        throw httpError(409, `token ${tokenId} is not sold`);
    }

    if (fragmentName === "undo") {
        const sale = current[0];

        if (!sale.undoable) {
            throw httpError(409, `the undo period of token ${tokenId} ended at ${sale.undoUntil}`);
        }

        const refund = current.reduce((sum, p) => sum + ethToWei(p.amount), 0n);
        return { paidTo: sale.paidTo, buyer: sale.payer, refundWei: refund, until: sale.undoUntil };
    }

    const levels = current.filter((p) => p.kind === "level");

    if (!levels.length) {
        throw httpError(409, `token ${tokenId} has no level upgrade to undo`);
    }

    const last = levels[levels.length - 1];

    if (!last.undoable) {
        throw httpError(409, `the undo period of the level ${last.fromLevel} -> ${last.toLevel} upgrade ended at ${last.undoUntil}`);
    }

    return { paidTo: last.paidTo, buyer: last.payer, refundWei: ethToWei(last.amount), until: last.undoUntil };
}

// ---- Applications: read and write registered contracts (docs/reference/proxy-api.md)
// One API shape for every registered contract:
//   POST /contract/call    read (one call, or { "calls": [...] } for up to 50 at once)
//   POST /contract/send    write, signed by a user account of the caller's section
//   POST /contract/events  the contract's events (filters, newest first)
//   GET  /contract/list    the registered contracts
//   POST /admin/contract/send  write, signed by the contract account center (admin token)
// "args" is a list (the ABI's raw values: wei, bytes, ...) or an object. With an object, the
// platform's own contracts (the avatar collection and the nickname collection) take friendly
// values: ETH prices, nickname edge levels, metadata for a mint. Their answers carry a
// "result" with friendly values too (ETH, decoded metadata, nickname details and levels).

// "nickname" (NicknameCollection version 6) or "avatar" (AvatarCollection version 4): the platform's items
// (BoundItems: minted by the center, bought once, undo within the hold period), or null. Older
// collections (avatar 3, nickname 4 and 5) are ordinary contracts to the proxy: no friendly values.
function platformKind(entry) {
    if (!entry.platformKind) {
        const item = hasFunction(entry, "undo") && hasFunction(entry, "paymentsOf") && hasFunction(entry, "tokensOf") && hasFunction(entry, "setPrice");
        entry.platformKind = item && hasFunction(entry, "upgradeLevel") ? "nickname" : item && hasFunction(entry, "imageOf") ? "avatar" : "none";
    }

    return entry.platformKind === "none" ? null : entry.platformKind;
}

function hasFunction(entry, name) {
    try {
        return Boolean(entry.iface.getFunction(name)); // ethers 6: null when missing
    } catch (error) {
        return true; // ambiguous: several overloads exist
    }
}

async function entryCall(entry, fn, args) {
    const out = await rpc(CONFIG.BESU_RPC, "eth_call", [{ to: entry.address, data: entry.iface.encodeFunctionData(fn, args || []) }, "latest"]);
    return entry.iface.decodeFunctionResult(fn, out);
}

function objectArg(o, ...names) {
    for (const name of names) {
        if (o[name] !== undefined) {
            return o[name];
        }
    }

    return undefined;
}

// An object's values in the ABI's order, by input name (a leading/trailing "_" is ignored)
function argsByName(fragment, o) {
    const known = new Set(fragment.inputs.map((p) => p.name.replace(/^_+|_+$/g, "")));
    const unknown = Object.keys(o).filter((k) => !known.has(k));

    if (unknown.length) {
        throw httpError(400, `args: unknown name(s) ${unknown.join(", ")}; ${fragment.format("sighash")} takes ${fragment.inputs.map((p) => p.name || "?").join(", ")}`);
    }

    return fragment.inputs.map((p) => o[p.name.replace(/^_+|_+$/g, "")]);
}

function ethInput(value, what) {
    if (value === undefined || value === null || !/^\d+(\.\d+)?$/.test(String(value))) {
        throw httpError(400, `${what}: ETH, e.g. "0.5"`);
    }

    return ethToWei(String(value)).toString();
}

// Friendly object arguments of the platform's contracts -> the ABI's raw values.
// ctx: { center: true } for /admin/contract/send
// The names a friendly object may use, per function of the platform's contracts
const ITEM_KEYS = {
    setPrice: ["tokenId", "price"], undo: ["tokenId"], tokensOf: ["account", "owner"], balanceOf: ["account", "owner"],
    ownerOf: ["tokenId"], priceOf: ["tokenId"], tokenURI: ["tokenId"], paymentsOf: ["tokenId"]
};
const FRIENDLY_KEYS = {
    avatar: { ...ITEM_KEYS, mint: ["image", "price", "description", "attributes"], buy: ["tokenId", "imageUrl", "payee"],
        tokenOf: ["imageUrl"], imageOf: ["tokenId"] },
    nickname: { ...ITEM_KEYS, mint: ["nickname", "price"], buy: ["tokenId", "nickname", "payee"], tokenOf: ["nickname"],
        nicknameOf: ["tokenId"], levelOf: ["tokenId"], addLevel: ["price"], setLevel: ["level", "price", "forSale"],
        levelInfo: ["level"], quote: ["tokenId", "level"], upgradeLevel: ["tokenId", "level", "payee"], undoLevel: ["tokenId"] }
};

async function friendlyArgs(entry, fragment, raw, ctx) {
    const keys = (FRIENDLY_KEYS[platformKind(entry)] || {})[fragment.name];

    if (keys && raw && typeof raw === "object" && !Array.isArray(raw)) {
        const unknown = Object.keys(raw).filter((k) => !keys.includes(k));

        if (unknown.length) {
            throw httpError(400, `args: unknown name(s) ${unknown.join(", ")}; ${fragment.name} takes ${keys.join(", ")}`);
        }
    }

    const args = await friendlyArgsOf(entry, fragment, raw, ctx);

    // an object that left out a value (or misnamed it): say which one, except payee (filled in later)
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const missing = fragment.inputs.findIndex((p, i) => args[i] === undefined && !(p.name === "payee" && p.type === "address"));

        if (missing >= 0) {
            throw httpError(400, `args: no value for "${(keys ? keys[missing] : null) || fragment.inputs[missing].name.replace(/^_+|_+$/g, "")}" (${fragment.format("sighash")}); given: ${Object.keys(raw).join(", ") || "nothing"}`);
        }
    }

    return args;
}

async function friendlyArgsOf(entry, fragment, raw, ctx) {
    const kind = platformKind(entry);
    const name = fragment.name;

    if (raw === undefined || raw === null) {
        raw = [];
    }

    if (Array.isArray(raw)) {
        const args = [...raw];

        // nicknames are always trimmed and NFC-normalized, also as raw values
        if (kind === "nickname" && ["mint", "tokenOf"].includes(name) && typeof args[0] === "string") {
            args[0] = nicknameInput(args[0]);
        }

        return args;
    }

    if (typeof raw !== "object") {
        throw httpError(400, "args: a list (raw ABI values) or an object (by name)");
    }

    const o = raw;
    const id = () => o.tokenId;

    if (kind) {
        switch (name) {
        case "setPrice": return [id(), ethInput(o.price, "price")];
        case "undo": case "ownerOf": case "priceOf": case "tokenURI": case "paymentsOf":
        case "imageOf": case "nicknameOf": case "levelOf": case "undoLevel": return [id()];
        case "tokensOf": case "balanceOf": return [objectArg(o, "account", "owner")];
        default: break;
        }
    }

    if (kind === "avatar") {
        switch (name) {
        case "mint": {
            if (!ctx || !ctx.center) {
                break;
            }

            const { image, uri } = avatarMetadataUri(o);
            return [image, uri, ethInput(o.price === undefined ? "0" : o.price, "price")];
        }
        case "buy": return [o.tokenId !== undefined ? o.tokenId : (o.imageUrl !== undefined ? await tokenIdOf(entry, String(o.imageUrl)) : undefined), o.payee];
        case "tokenOf": return [o.imageUrl];
        default: break;
        }
    }

    if (kind === "nickname") {
        switch (name) {
        case "mint": return [nicknameInput(o.nickname), ethInput(o.price === undefined ? "0" : o.price, "price")];
        case "buy": return [o.tokenId !== undefined ? o.tokenId : (o.nickname !== undefined ? await tokenIdOf(entry, nicknameInput(o.nickname)) : undefined), o.payee];
        case "tokenOf": return [nicknameInput(o.nickname)];
        case "addLevel": return [levelInput(o, null).stepPrice];
        case "setLevel": {
            const level = Number(o.level);
            const levels = await readLevels(entry);

            if (!Number.isInteger(level) || !levels[level]) {
                throw httpError(404, `level: no level ${o.level} (levels 0-${levels.length - 1})`);
            }

            const l = levelInput(o, levels[level]);
            return [level, l.stepPrice, l.forSale];
        }
        case "levelInfo": return [o.level];
        case "quote": return [o.tokenId, o.level];
        case "upgradeLevel": return [o.tokenId, o.level, o.payee];
        default: break;
        }
    }

    return argsByName(fragment, o);
}

// The friendly "result" of a read
async function friendlyCall(entry, fragment, args, decoded) {
    const kind = platformKind(entry);
    const name = fragment.name;
    const v = decoded;

    if (kind) {
        const minter = async () => ethers.getAddress((await entryCall(entry, "minter"))[0]);

        switch (name) {
        case "priceOf": return { tokenId: String(args[0]), price: ethText(v[0]) };
        case "ownerOf": {
            const owner = ethers.getAddress(v[0]);
            return { tokenId: String(args[0]), owner, sold: owner !== await minter() };
        }
        case "balanceOf": return { owner: ethers.getAddress(args[0]), tokens: Number(v[0]) };
        case "paymentsOf": return paymentsInfo(entry, args[0]);
        case "tokenOf": {
            if (v[0] === 0n) {
                return { tokenId: null, minted: false };
            }

            const [[owner], [price]] = await Promise.all([entryCall(entry, "ownerOf", [v[0]]), entryCall(entry, "priceOf", [v[0]])]);
            return { tokenId: v[0].toString(), minted: true, sold: ethers.getAddress(owner) !== await minter(), owner: ethers.getAddress(owner), price: ethText(price) };
        }
        case "tokensOf": return Promise.all(v[0].map((t) => itemSummary(entry, t)));
        default: break;
        }
    }

    if (kind === "avatar") {
        switch (name) {
        case "tokenURI": {
            const meta = decodeDataUri(v[0]);
            return { tokenId: String(args[0]), metadata: meta, image: meta ? meta.image || null : null };
        }
        case "imageOf": return { tokenId: String(args[0]), image: v[0] };
        default: break;
        }
    }

    if (kind === "nickname") {
        switch (name) {
        case "tokenURI": return { tokenId: String(args[0]), metadata: decodeDataUri(v[0]) || {} };
        case "nicknameOf": return { tokenId: String(args[0]), nickname: v[0] };
        case "levelOf": return { tokenId: String(args[0]), level: Number(v[0]) };
        case "levelCount": return { count: Number(v[0]), levels: await readLevels(entry) };
        case "levelInfo": return levelOut(Number(args[0]), v[0]);
        case "quote": return { tokenId: String(args[0]), level: Number(args[1]), price: ethText(v[0]) };
        default: break;
        }
    }

    // any contract: one value, or the named values; JSON data URIs decoded
    const plain = (x) => {
        const value = jsonValue(x);
        return typeof value === "string" && value.startsWith("data:application/json;base64,") ? decodeDataUri(value) : value;
    };

    if (fragment.outputs.length === 1) {
        return plain(v[0]);
    }

    const out = {};
    fragment.outputs.forEach((p, i) => { out[p.name || String(i)] = plain(v[i]); });
    return out;
}

// One item: avatar { tokenId, image, price } or nickname { tokenId, nickname, level, price }
async function itemSummary(entry, tokenId) {
    const [[price], [text]] = await Promise.all([
        entryCall(entry, "priceOf", [tokenId]),
        entryCall(entry, platformKind(entry) === "nickname" ? "nicknameOf" : "imageOf", [tokenId])
    ]);

    if (platformKind(entry) === "nickname") {
        const [level] = await entryCall(entry, "levelOf", [tokenId]);
        return { tokenId: tokenId.toString(), nickname: text, level: Number(level), price: ethText(price) };
    }

    return { tokenId: tokenId.toString(), image: text, price: ethText(price) };
}

// The friendly "result" of a write, from its events
async function friendlySend(entry, fragment, args, events) {
    const kind = platformKind(entry);
    const find = (n) => events.find((e) => e.name === n);

    if (!kind) {
        return null;
    }

    const minted = find("Minted");

    if (minted) {
        return { minted: true, ...await itemSummary(entry, BigInt(minted.args.tokenId)) };
    }

    const priceSet = find("PriceSet");

    if (priceSet) {
        return { tokenId: String(priceSet.args.tokenId), price: ethText(BigInt(priceSet.args.price)) };
    }

    const hold = async () => (await entryCall(entry, "holdSeconds"))[0];
    const sold = find("Sold");

    if (sold) {
        const until = new Date(Date.now() + Number(await hold()) * 1000).toISOString();
        return { ...await itemSummary(entry, BigInt(sold.args.tokenId)), buyer: sold.args.buyer, paid: ethText(BigInt(sold.args.price)),
            paidTo: sold.args.paidTo, undoUntil: until };
    }

    const undone = find("Undone");

    if (undone) {
        return { tokenId: String(undone.args.tokenId), undone: "sale", buyer: undone.args.buyer, refunded: ethText(BigInt(undone.args.refunded)),
            by: undone.args.by };
    }

    const upgraded = find("LevelUpgraded");

    if (upgraded) {
        const until = new Date(Date.now() + Number(await hold()) * 1000).toISOString();
        return { ...await itemSummary(entry, BigInt(upgraded.args.tokenId)), fromLevel: Number(upgraded.args.fromLevel),
            paid: ethText(BigInt(upgraded.args.price)), paidTo: upgraded.args.paidTo, undoUntil: until };
    }

    const levelUndone = find("LevelUndone");

    if (levelUndone) {
        return { tokenId: String(levelUndone.args.tokenId), undone: "level", level: Number(levelUndone.args.toLevel),
            undoneLevel: Number(levelUndone.args.fromLevel), refunded: ethText(BigInt(levelUndone.args.refunded)) };
    }

    const levelSet = find("LevelSet");

    if (levelSet) {
        const [info] = await entryCall(entry, "levelInfo", [Number(levelSet.args.level)]);
        return { level: levelOut(Number(levelSet.args.level), info) };
    }

    return null;
}

// One read: { contract, function, args } -> answer
async function contractRead(body) {
    const b = body || {};
    const entry = await registeredContract(b.contract);
    const fragment = contractFunction(entry, b.function);

    if (fragment.stateMutability !== "view" && fragment.stateMutability !== "pure") {
        throw httpError(400, `${fragment.format("sighash")} changes state: use POST /contract/send`);
    }

    const args = await friendlyArgs(entry, fragment, b.args, null);
    const data = entry.iface.encodeFunctionData(fragment, coerceParams(fragment.inputs, args));
    let out;

    try {
        out = await ethCall(entry.address, data);
    } catch (error) {
        throw httpError(400, `call reverted: ${revertReason(error)}`);
    }

    const decoded = entry.iface.decodeFunctionResult(fragment, out);
    return {
        success: true,
        contract: entry.address,
        function: fragment.format("sighash"),
        result: await friendlyCall(entry, fragment, args, decoded),
        outputs: fragment.outputs.map((p, i) => ({ name: p.name || String(i), type: p.format("sighash"), value: jsonValue(decoded[i]) }))
    };
}

function contractRoute(handler) {
    return async (req, res) => {
        try {
            res.json(await handler(req));
        } catch (error) {
            if (!error.statusCode) {
                console.error(error);
            }

            res.status(error.statusCode || 500).json({ error: error.message });
        }
    };
}

// The read routes: a section key (required with sections_required), or the admin caller (chainlens)
async function contractReader(req) {
    if (String(req.headers["x-section-key"] || "").trim() === "" && isAdminCaller(req)) {
        return null;
    }

    return sectionFromRequest(req);
}

// Read: a view/pure function (eth_call on the latest block). With sections_required, a section key.
// { "calls": [ {contract, function, args}, ... ] }: up to 50 reads, each answered (or failed) on its own.
app.post("/contract/call", contractRoute(async (req) => {
    await contractReader(req);
    const calls = (req.body || {}).calls;

    if (calls === undefined) {
        return contractRead(req.body);
    }

    if (!Array.isArray(calls) || calls.length < 1 || calls.length > 50) {
        throw httpError(400, "calls: a list of 1 to 50 reads { contract, function, args }");
    }

    const results = await Promise.all(calls.map((c) => contractRead(c).catch((error) => {
        if (!error.statusCode) {
            console.error(error);
        }

        return { success: false, status: error.statusCode || 500, error: error.message };
    })));
    return { success: results.every((r) => r.success), results };
}));

// The registered contracts. ?type=avatar|nickname|contract, ?kind=common|avatar (the old name nft is
// accepted for both), ?has=<function>, ?q=<name>,
// ?functions=1 (the functions and events of each)
const symbolCache = new Map();

app.get("/contract/list", contractRoute(async (req) => {
    await contractReader(req);
    const q = req.query || {};
    const latestNickname = await nicknameCollection(true);
    const rows = [];

    for (const entry of [...(await loadContracts()).values()].sort((a, b) => a.registeredIn - b.registeredIn)) {
        const type = platformKind(entry) || "contract";

        const wantType = q.type && (KIND_ALIASES[q.type] || q.type);
        const wantKind = q.kind && (KIND_ALIASES[q.kind] || q.kind);

        if ((wantType && wantType !== type) || (wantKind && wantKind !== entry.kind) || (q.has && !hasFunction(entry, String(q.has)))
            || (q.q && !entry.name.toLowerCase().includes(String(q.q).toLowerCase()))) {
            continue;
        }

        const row = { address: entry.address, name: entry.name, type, kind: entry.kind, registeredIn: entry.registeredIn };

        if (type === "avatar" || type === "nickname") {
            if (!symbolCache.has(entry.address)) {
                const [[symbol], [minter]] = await Promise.all([entryCall(entry, "symbol"), entryCall(entry, "minter")]);
                symbolCache.set(entry.address, { symbol, minter: ethers.getAddress(minter) });
            }

            Object.assign(row, symbolCache.get(entry.address));
        }

        if (type === "nickname") {
            row.current = Boolean(latestNickname && latestNickname.address === entry.address);
        }

        if (q.functions === "1") {
            row.functions = entry.iface.fragments.filter((f) => f.type === "function")
                .map((f) => ({ signature: f.format("sighash"), mutability: f.stateMutability }));
            row.events = entry.iface.fragments.filter((f) => f.type === "event").map((f) => f.format("sighash"));
        }

        rows.push(row);
    }

    return { success: true, center: isAddress(CONFIG.CONTRACT_CENTER) ? ethers.getAddress(CONFIG.CONTRACT_CENTER) : null, contracts: rows };
}));

// The events of a registered contract, newest first.
// { contract, event, where: { arg: value }, fromBlock, toBlock, limit (100, max 1000), current }
// "where" on an indexed argument filters on the chain; on another argument, after decoding.
// current: true with event "Transfer" and where.to: only tokens that address still owns.
const blockTimes = new Map();

async function blockTime(number) {
    if (!blockTimes.has(number)) {
        const block = await rpc(CONFIG.BESU_RPC, "eth_getBlockByNumber", [ethers.toQuantity(number), false]);
        blockTimes.set(number, block ? new Date(parseInt(block.timestamp, 16) * 1000).toISOString() : null);

        if (blockTimes.size > 20000) {
            blockTimes.clear();
        }
    }

    return blockTimes.get(number);
}

function sameValue(a, b) {
    const x = String(a);
    const y = String(b);
    return isAddress(x) && isAddress(y) ? x.toLowerCase() === y.toLowerCase() : x === y;
}

app.post("/contract/events", contractRoute(async (req) => {
    await contractReader(req);
    const b = req.body || {};
    const entry = await registeredContract(b.contract);
    let fragment;

    try {
        fragment = entry.iface.getEvent(String(b.event || ""));
    } catch (error) {
        fragment = null;
    }

    if (!fragment) {
        throw httpError(400, `event: one of ${entry.iface.fragments.filter((f) => f.type === "event").map((f) => f.name).join(", ")}`);
    }

    const where = b.where && typeof b.where === "object" ? b.where : {};
    const unknown = Object.keys(where).filter((k) => !fragment.inputs.some((p) => p.name === k));

    if (unknown.length) {
        throw httpError(400, `where: ${fragment.name} has no argument ${unknown.join(", ")} (${fragment.inputs.map((p) => p.name).join(", ")})`);
    }

    const limit = Math.min(Math.max(Number(b.limit) || 100, 1), 1000);
    const head = parseInt(await rpc(CONFIG.BESU_RPC, "eth_blockNumber", []), 16);
    const fromBlock = b.fromBlock === undefined ? entry.registeredIn - 5 : Number(b.fromBlock);
    const toBlock = b.toBlock === undefined ? head : Math.min(Number(b.toBlock), head);

    if (!Number.isInteger(fromBlock) || !Number.isInteger(toBlock) || fromBlock < 0 || toBlock < fromBlock) {
        throw httpError(400, "fromBlock / toBlock: block numbers, fromBlock <= toBlock");
    }

    let topics;

    try {
        topics = entry.iface.encodeFilterTopics(fragment, fragment.inputs.map((p) => (p.indexed && where[p.name] !== undefined ? where[p.name] : null)));
    } catch (error) {
        throw httpError(400, `where: ${error.shortMessage || error.message}`);
    }

    const rest = fragment.inputs.filter((p) => !p.indexed && where[p.name] !== undefined);
    const friendly = Boolean(platformKind(entry));
    const found = [];

    // newest first, 2000 blocks at a time, until the limit
    for (let end = toBlock; end >= fromBlock && found.length < limit; end -= 2000) {
        const start = Math.max(fromBlock, end - 1999);
        const logs = await rpc(CONFIG.BESU_RPC, "eth_getLogs", [{ address: entry.address, fromBlock: ethers.toQuantity(start), toBlock: ethers.toQuantity(end), topics }]);

        for (const log of logs.reverse()) {
            const parsed = entry.iface.parseLog(log);
            const args = {};
            parsed.fragment.inputs.forEach((p, i) => {
                const value = jsonValue(parsed.args[i]);
                args[p.name || String(i)] = friendly && ["price", "stepPrice"].includes(p.name) ? ethText(BigInt(value)) : value;
            });

            if (rest.every((p) => sameValue(jsonValue(parsed.args[p.name]), where[p.name]))) {
                found.push({ name: parsed.name, args, blockNumber: parseInt(log.blockNumber, 16), txHash: log.transactionHash, logIndex: parseInt(log.logIndex, 16) });
            }
        }
    }

    let events = found.slice(0, limit);

    if (b.current) {
        if (fragment.name !== "Transfer" || !where.to || !hasFunction(entry, "ownerOf")) {
            throw httpError(400, "current: only with event Transfer and where.to (the tokens that address owns now)");
        }

        const seen = new Set();
        const kept = [];

        for (const e of events) {
            const id = String(e.args.tokenId);

            if (seen.has(id)) {
                continue;
            }

            seen.add(id);
            const [owner] = await entryCall(entry, "ownerOf", [BigInt(id)]).catch(() => [null]);

            if (owner && sameValue(owner, where.to)) {
                kept.push(e);
            }
        }

        events = kept;
    }

    for (const e of events) {
        e.time = await blockTime(e.blockNumber);
    }

    return { success: true, contract: entry.address, event: fragment.format("sighash"), fromBlock, toBlock,
        count: events.length, complete: found.length < limit, events };
}));

// Write: a state-changing function, signed by a user account of the caller's section. Waits for the
// block; answers with the status and the contract's decoded events.
// The platform's items (avatar and nickname collections) through /contract/send:
//   buy(tokenId, payee), nickname upgradeLevel(tokenId, level, payee): signed by "from" (a user account
//     of the section). The payee (an address input named "payee") is the sender's section's consumption
//     account: filled in when left out, refused when it is another account; the price (value) is
//     filled in when left out;
//   undo(tokenId), nickname undoLevel(tokenId): signed by the account that was paid (the section's
//     consumption account), which sends the refund; "from" is not needed.
async function knownSend(entry, fragment, args, from, section) {
    const payeeAt = fragment.inputs.findIndex((input) => input.name === "payee" && input.type === "address");

    if (payeeAt >= 0) {
        const consumption = ethers.getAddress(section.accounts.consumption);
        const given = args[payeeAt];

        if (given === undefined || given === null || String(given) === "") {
            args[payeeAt] = consumption;
        } else if (!isAddress(String(given)) || ethers.getAddress(String(given)) !== consumption) {
            throw httpError(400, `payee: the consumption account of section "${section.name}" (${consumption}); leave it out to fill it in`);
        }
    }

    const kind = platformKind(entry);
    const name = fragment.name;

    if (!kind || !["buy", "upgradeLevel"].includes(name)) {
        return { priceWei: null };
    }

    const tokenId = parseTokenId(String(args[0]));

    if (!tokenId) {
        throw httpError(400, "tokenId: a token id (1, 2, …)");
    }

    let owner;

    try {
        [owner] = await entryCall(entry, "ownerOf", [tokenId]);
    } catch (error) {
        throw httpError(404, `token ${tokenId} is not minted`);
    }

    const [minter] = await entryCall(entry, "minter");

    if (name === "buy") {
        if (ethers.getAddress(owner) !== ethers.getAddress(minter)) {
            throw httpError(409, `token ${tokenId} is already sold`);
        }

        return { priceWei: (await entryCall(entry, "priceOf", [tokenId]))[0] };
    }

    if (ethers.getAddress(owner) !== from) {
        throw httpError(403, `token ${tokenId} is not owned by ${from}`);
    }

    try {
        return { priceWei: (await entryCall(entry, "quote", [tokenId, args[1]]))[0] };
    } catch (error) {
        throw httpError(400, `level ${args[1]}: ${revertReason(error)}`);
    }
}

// Section operation counters from the events of a sent transaction
function countKnownSend(section, entry, events) {
    const kind = platformKind(entry);
    const eth = (v) => ethers.formatEther(BigInt(v));

    for (const event of events) {
        if (event.name === "Sold") {
            countSectionOp(section, `${kind}_sale`, eth(event.args.price));
        } else if (event.name === "Undone") {
            countSectionOp(section, `${kind}_undo`, eth(event.args.refunded));
        } else if (event.name === "LevelUpgraded") {
            countSectionOp(section, "level_upgrade", eth(event.args.price));
        } else if (event.name === "LevelUndone") {
            countSectionOp(section, "level_undo", eth(event.args.refunded));
        }
    }
}

app.post("/contract/send", async (req, res) => {
    try {
        // X-Section-Key, or the admin caller (chainlens): then the section is the one of "from"
        const hasKey = String(req.headers["x-section-key"] || "").trim() !== "";
        const admin = !hasKey && isAdminCaller(req);
        let section = admin ? null : await sectionFromRequest(req);

        if (!section && !admin) {
            throw httpError(401, "X-Section-Key is required: transactions are sent by a user account of a section");
        }

        const entry = await registeredContract(req.body.contract);
        const fragment = contractFunction(entry, req.body.function);

        if (fragment.stateMutability === "view" || fragment.stateMutability === "pure") {
            throw httpError(400, `${fragment.format("sighash")} only reads: use POST /contract/call`);
        }

        const kind = platformKind(entry);
        const undoCall = Boolean(kind) && (fragment.name === "undo" || (kind === "nickname" && fragment.name === "undoLevel"));
        let from;
        let args;
        let known;

        if (undoCall) {
            // signed by the account that was paid (the section's consumption account), which sends the refund
            args = await friendlyArgs(entry, fragment, req.body.args, null);
            const tokenId = parseTokenId(String(args[0]));

            if (!tokenId) {
                throw httpError(400, "tokenId: a token id (1, 2, …)");
            }

            const target = await undoTarget(entry, fragment.name, tokenId);
            const paid = await accountSection(target.paidTo);
            const paidSection = paid.id ? await getSection(paid.id, false) : null;

            if (!paidSection) {
                throw httpError(409, `token ${tokenId} was paid to ${target.paidTo}, not a section's account`);
            }

            if (section && section.id !== paidSection.id) {
                throw httpError(403, `token ${tokenId} was paid to section "${paidSection.name}": only its key can undo`);
            }

            section = paidSection;
            from = target.paidTo;

            if (req.body.from && (!isAddress(String(req.body.from)) || ethers.getAddress(String(req.body.from)) !== from)) {
                throw httpError(400, `from: leave it out (an undo is signed by ${from}, the account that was paid)`);
            }

            const balance = await getBalanceWei(from);

            if (balance < target.refundWei) {
                throw httpError(409, `the refund needs ${ethText(target.refundWei)} ETH but ${from} (section "${section.name}" consumption) has ${ethText(balance)} ETH`);
            }

            known = { priceWei: target.refundWei };
        } else {
            if (!isAddress(String(req.body.from || ""))) {
                throw httpError(400, "from: the user account (of this section) that signs");
            }

            from = ethers.getAddress(req.body.from);

            if (!section) {
                const owner = await accountSection(from);

                if (owner.kind !== ACCOUNT_USER) {
                    throw httpError(403, `${from} is not a user account of a section`);
                }

                section = await getSection(owner.id, false);
            }

            await assertSectionUser(section, from);
            args = await friendlyArgs(entry, fragment, req.body.args, null);
            known = await knownSend(entry, fragment, args, from, section);
        }

        if (!section.active) {
            throw httpError(403, `section "${section.name}" is disabled`);
        }

        let valueWei = 0n;

        if (req.body.value !== undefined && req.body.value !== null && String(req.body.value) !== "" && String(req.body.value) !== "0") {
            if (fragment.stateMutability !== "payable") {
                throw httpError(400, `${fragment.format("sighash")} is not payable: send no value`);
            }

            if (!/^\d+(\.\d+)?$/.test(String(req.body.value))) {
                throw httpError(400, "value: ETH, e.g. \"1.5\"");
            }

            valueWei = ethToWei(String(req.body.value));
        }

        if (known.priceWei !== null) {
            const given = req.body.value === undefined || req.body.value === null || String(req.body.value) === "";

            if (!given && valueWei !== known.priceWei) {
                throw httpError(400, `value: the price is ${ethText(known.priceWei)} ETH (leave "value" out to pay it)`);
            }

            valueWei = known.priceWei;
        }

        const data = entry.iface.encodeFunctionData(fragment, coerceParams(fragment.inputs, args));
        let sent;

        try {
            sent = await withSenderLock(from, () => sendData(from, entry.address, data, valueWei,
                contractMemo(entry, fragment, args, req.body.args, valueWei, section)));
        } catch (error) {
            if (error.statusCode) {
                throw error;
            }

            if (/insufficient/i.test(error.message)) {
                throw httpError(400, `insufficient balance: ${ethText(valueWei)} ETH is needed`);
            }

            throw httpError(400, `the transaction would revert: ${revertReason(error)}`);
        }

        const receipt = await receiptOf(sent.txHash);
        const ok = BigInt(receipt.status) === 1n;
        const events = ok ? decodeEvents(entry, receipt) : [];

        if (ok) {
            countKnownSend(section, entry, events);
        }

        console.log(`section ${section.id}: ${from} -> ${entry.address} ${fragment.format("sighash")} ${ok ? "ok" : "REVERTED"} (${sent.txHash})`);

        res.status(ok ? 200 : 400).json({
            success: ok,
            ...(ok ? {} : { error: "the transaction reverted on chain" }),
            section: { id: section.id, name: section.name },
            contract: entry.address,
            function: fragment.format("sighash"),
            from,
            value: ethers.formatEther(valueWei),
            txHash: sent.txHash,
            blockNumber: Number(BigInt(receipt.blockNumber)),
            gasUsed: Number(BigInt(receipt.gasUsed)),
            result: ok ? await friendlySend(entry, fragment, args, events) : null,
            events,
            ...memoAnswer(sent.memo)
        });
    } catch (error) {
        if (!error.statusCode) {
            console.error(error);
        }

        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

// ---- Admin: write as the contract account center (the minter and owner of the platform's contracts)
// { contract, function, args, value }. Friendly object args for the platform's contracts, e.g.
//   avatar mint    { "image", "price": "0.5", "description", "attributes" }   (the metadata uri is built here)
//   nickname mint  { "nickname", "price": "1" }
//   setPrice       { "tokenId", "price" }                (until the token is sold)
//   addLevel       { "price": "1" }                      (nickname: the next user level, for sale)
//   setLevel       { "level": 2, "price", "forSale" }    (omitted fields keep their value)
app.post("/admin/contract/send", adminGuard, adminRoute(async (req) => {
    requireSections();
    requireCenter();
    const b = req.body || {};
    const entry = await registeredContract(b.contract);
    const fragment = contractFunction(entry, b.function);

    if (fragment.stateMutability === "view" || fragment.stateMutability === "pure") {
        throw httpError(400, `${fragment.format("sighash")} only reads: use POST /contract/call`);
    }

    const center = ethers.getAddress(CONFIG.CONTRACT_CENTER);
    const args = await friendlyArgs(entry, fragment, b.args, { center: true });
    let valueWei = 0n;

    if (b.value !== undefined && b.value !== null && String(b.value) !== "" && String(b.value) !== "0") {
        if (fragment.stateMutability !== "payable") {
            throw httpError(400, `${fragment.format("sighash")} is not payable: send no value`);
        }

        valueWei = BigInt(ethInput(b.value, "value"));
    }

    const data = entry.iface.encodeFunctionData(fragment, coerceParams(fragment.inputs, args));

    if (platformKind(entry) === "avatar" && fragment.name === "mint") {
        await assertMintFits(center, entry.address, data);
    }

    let sent;

    try {
        sent = await withSenderLock(center, () => sendData(center, entry.address, data, valueWei,
            contractMemo(entry, fragment, args, b.args, valueWei, null)));
    } catch (error) {
        if (error.statusCode) {
            throw error;
        }

        throw httpError(400, `the transaction would revert: ${revertReason(error)}`);
    }

    const receipt = await receiptOf(sent.txHash);
    const ok = BigInt(receipt.status) === 1n;
    const events = ok ? decodeEvents(entry, receipt) : [];
    console.log(`center -> ${entry.address} ${fragment.format("sighash")} ${ok ? "ok" : "REVERTED"} (${sent.txHash})`);

    if (!ok) {
        throw httpError(400, `reverted in block ${BigInt(receipt.blockNumber)} (transaction ${sent.txHash})`);
    }

    return {
        success: true,
        contract: entry.address,
        function: fragment.format("sighash"),
        from: center,
        value: ethers.formatEther(valueWei),
        txHash: sent.txHash,
        blockNumber: Number(BigInt(receipt.blockNumber)),
        gasUsed: Number(BigInt(receipt.gasUsed)),
        result: await friendlySend(entry, fragment, args, events),
        events,
        ...memoAnswer(sent.memo)
    };
}));

// ---- Deploy templates: the platform's own contracts, compiled into the proxy image
// POST /admin/contract/check and /admin/contract/deploy with
//   { "template": "avatar-collection", "name": "Dragons", "symbol": "DRG" }   (old name: nft-collection)
//   { "template": "nickname-collection", "name": "Nicknames", "symbol": "NICK", "another": false }
// both with "holdDays" (default 7): how long a sale (or nickname level upgrade) can be undone
async function templateInput(body) {
    const b = body || {};

    if (b.template === undefined) {
        return deployInputOf(b);
    }

    requireSections();
    // how long a sale (or level upgrade) can be undone: holdDays, default 7 (decimals allowed, e.g. for tests)
    const holdDays = b.holdDays === undefined ? 7 : Number(b.holdDays);

    if (!Number.isFinite(holdDays) || holdDays < 0 || holdDays > 365) {
        throw httpError(400, "holdDays: 0 to 365 (default 7)");
    }

    const holdSeconds = String(Math.round(holdDays * 86400));

    if (b.template === "avatar-collection" || b.template === "nft-collection") {
        const name = collectionField(b.name, "name", 64);
        const symbol = collectionField(b.symbol, "symbol", 16);

        for (const entry of (await loadContracts(true)).values()) {
            if (platformKind(entry) !== "avatar") {
                continue;
            }

            const [other] = await entryCall(entry, "symbol").catch(() => [""]);

            if (entry.name.toLowerCase() === name.toLowerCase() || other.toLowerCase() === symbol.toLowerCase()) {
                throw httpError(409, `a collection named "${entry.name}" (${other}) exists at ${entry.address}: names and symbols are unique`);
            }
        }

        return deployInputOf({ kind: "avatar", name, abi: avatarArtifact.abi, bytecode: avatarArtifact.bytecode,
            deployedBytecode: avatarArtifact.deployedBytecode, immutableReferences: avatarArtifact.immutableReferences,
            args: [name, symbol, CONFIG.REGISTRY_CONTRACT, holdSeconds] });
    }

    if (b.template === "nickname-collection") {
        const existing = await nicknameCollection(true);

        if (existing && !b.another) {
            throw httpError(409, `a nickname collection exists at ${existing.address} (send "another": true to deploy a new one: the new one is used from then on)`);
        }

        const name = String(b.name || "Nicknames").trim().slice(0, 64);
        const symbol = String(b.symbol || "NICK").trim().slice(0, 16);
        return deployInputOf({ kind: "common", name, abi: nicknameArtifact.abi, bytecode: nicknameArtifact.bytecode,
            deployedBytecode: nicknameArtifact.deployedBytecode, immutableReferences: nicknameArtifact.immutableReferences,
            args: [name, symbol, CONFIG.REGISTRY_CONTRACT, holdSeconds] });
    }

    if (b.template === "transfer-undo") {
        const existing = await transferUndoContract(true);

        if (existing && !b.another) {
            throw httpError(409, `the transfer-undo contract exists at ${existing.address} (send "another": true to replace it)`);
        }

        return deployInputOf({ kind: "common", name: String(b.name || "TransferUndo").trim().slice(0, 64), abi: transferUndoArtifact.abi,
            bytecode: transferUndoArtifact.bytecode, deployedBytecode: transferUndoArtifact.deployedBytecode,
            immutableReferences: transferUndoArtifact.immutableReferences, args: [CONFIG.REGISTRY_CONTRACT] });
    }

    throw httpError(400, "template: avatar-collection, nickname-collection or transfer-undo (or no template: abi and bytecode)");
}

// ---- Removed routes: 410 with the call that replaces each
const MOVED = [
    ["post", "/nft/deploy", "POST /admin/contract/deploy { \"template\": \"avatar-collection\", \"name\", \"symbol\" }"],
    ["post", "/nft/mint", "POST /admin/contract/send { \"contract\", \"function\": \"mint\", \"args\": { \"image\", \"price\" } }"],
    ["post", "/nft/transfer", "POST /contract/send { \"contract\", \"function\": \"buy\", \"args\": { \"tokenId\" }, \"from\": buyer } (avatars are bought once, never resold)"],
    ["get", "/nft/contract", "GET /contract/list?type=avatar"],
    ["get", "/nft/collections", "GET /contract/list?type=avatar"],
    ["get", "/nft/owner/:address", "POST /contract/call { \"contract\", \"function\": \"tokensOf\", \"args\": { \"account\" } }"],
    ["get", "/nft/:tokenId/metadata", "POST /contract/call { \"contract\", \"function\": \"tokenURI\", \"args\": { \"tokenId\" } } (result.metadata)"],
    ["get", "/nft/:tokenId", "POST /contract/call { \"calls\": [ ownerOf, priceOf, tokenURI, paymentsOf ] }"],
    ["get", "/nickname/edges", "POST /contract/call { \"contract\", \"function\": \"levelCount\" } (result.levels); the collection: GET /contract/list?type=nickname"],
    ["get", "/nickname/check", "POST /contract/call { \"contract\", \"function\": \"tokenOf\", \"args\": { \"nickname\" } }"],
    ["get", "/nickname/of/:account", "POST /contract/call { \"contract\", \"function\": \"tokensOf\", \"args\": { \"account\" } }"],
    ["get", "/nickname/quote", "POST /contract/call { \"contract\", \"function\": \"quote\", \"args\": { \"tokenId\", \"level\" } }"],
    ["post", "/nickname/buy", "POST /contract/send { \"contract\", \"function\": \"buy\", \"args\": { \"nickname\" }, \"from\" }"],
    ["post", "/nickname/edge", "POST /contract/send { \"contract\", \"function\": \"upgradeLevel\", \"args\": { \"tokenId\", \"level\" }, \"from\" }"],
    ["post", "/admin/nickname/deploy", "POST /admin/contract/deploy { \"template\": \"nickname-collection\", \"name\", \"symbol\" }"],
    ["put", "/admin/nickname/price", "POST /admin/contract/send { \"contract\", \"function\": \"setPrice\", \"args\": { \"tokenId\", \"price\" } } (each nickname has its own price)"],
    ["post", "/admin/nickname/edges", "POST /admin/contract/send { \"contract\", \"function\": \"addLevel\", \"args\": { \"price\" } }"],
    ["put", "/admin/nickname/edges/:level", "POST /admin/contract/send { \"contract\", \"function\": \"setLevel\", \"args\": { \"level\", \"price\", \"forSale\" } }"],
    ["get", "/admin/contracts", "GET /contract/list (\"center\": the contract account center)"],
    ["post", "/admin/contracts/check", "POST /admin/contract/check (same body)"],
    ["post", "/admin/contracts/deploy", "POST /admin/contract/deploy (same body)"],
    ["get", "/admin/nickname", "GET /contract/list?type=nickname (the collection), POST /contract/call (levelCount, totalSupply, tokensOf) and POST /contract/events (Sold, Undone, LevelUpgraded, LevelUndone)"],
    ["post", "/admin/nickname/reserve", "nothing: reserved names are gone (only names the center mints can be bought)"]
];

for (const [method, path, use] of MOVED) {
    app[method](path, (req, res) => res.status(410).json({ error: `${method.toUpperCase()} ${path} was removed: use ${use}` }));
}

// ---- Section metrics (step 6): balances refreshed every 15 s (the scrape stays fast), operation
// counters in memory (they restart at 0 with the proxy; dashboards use increase()).
const sectionOps = new Map(); // "id|op" -> { id, name, op, count, wei }
const SECTION_OPS = ["create_account", "transfer_in", "transfer_out", "transfer_in_undo", "transfer_out_undo", "avatar_sale", "avatar_undo", "nickname_sale", "nickname_undo", "level_upgrade", "level_undo", "topup", "sweep", "payback", "account_replaced", "archive_return"];
const sectionMetrics = { rows: [], sender01: null, error: 0, at: 0 };
// Names of the platform and section accounts, whether they send now or not (proxy_account_info): the
// MPC signer dashboard names each key's presignature pool with it. address (lowercase) -> info
const accountInfo = new Map();

function countSectionOp(section, op, amountEth) {
    const key = `${section.id}|${op}`;
    const entry = sectionOps.get(key) || { id: section.id, name: section.name, op, count: 0, wei: 0n };
    entry.name = section.name;
    entry.count += 1;

    try {
        entry.wei += ethToWei(String(amountEth || "0"));
    } catch (error) {
        // amount not countable: count only
    }

    sectionOps.set(key, entry);
}

async function refreshSectionMetrics() {
    try {
        const rows = [];

        if (sectionsConfigured()) {
            for (const section of (await listSections()).filter((s) => !s.archived)) {
                // every counter exists from the start at 0, so the first operation counts in increase()
                for (const op of SECTION_OPS) {
                    const key = `${section.id}|${op}`;

                    if (!sectionOps.has(key)) {
                        sectionOps.set(key, { id: section.id, name: section.name, op, count: 0, wei: 0n });
                    }
                }

                for (const [role, address] of Object.entries(section.accounts)) {
                    rows.push({ id: section.id, name: section.name, active: section.active, role, address,
                        eth: Number(ethers.formatEther(await getBalanceWei(address))) });
                }
            }
        }

        sectionMetrics.rows = rows;
        const names = new Map([[CONFIG.SENDER01, "SENDER01"], [CONFIG.REGISTRY_ADMIN, "registry admin"], [CONFIG.CONTRACT_CENTER, "contract center"]]
            .filter(([address]) => isAddress(address))
            .map(([address, name]) => [address.toLowerCase(), { account: name, kind: "platform", section: "", sectionId: "" }]));
        rows.forEach((r) => names.set(r.address.toLowerCase(), { account: `${r.name} · ${r.role}`, kind: r.role, section: r.name, sectionId: String(r.id) }));
        accountInfo.clear();
        names.forEach((info, address) => accountInfo.set(address, info));
        sectionMetrics.sender01 = isAddress(CONFIG.SENDER01) ? Number(ethers.formatEther(await getBalanceWei(CONFIG.SENDER01))) : null;
        sectionMetrics.error = 0;
        sectionMetrics.at = Date.now();
    } catch (error) {
        sectionMetrics.error = 1;
    }
}

setInterval(refreshSectionMetrics, 15000).unref();
setTimeout(refreshSectionMetrics, 5000).unref();

// What each tracked sender is, for the dashboards (proxy_sender_info): the platform accounts by name,
// section accounts by section and role, user accounts by section. Resolved in the background (the
// registry is read once per address; a section's name is current at every refresh).
const SENDER_KINDS = { 1: "user", 2: "upfront", 3: "consumption", 4: "payment", 5: "retired" };
const senderInfo = new Map(); // sender (lowercase) -> { name, kind, section, sectionId }

function shortAddress(address) {
    return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

async function refreshSenderInfo() {
    const platform = new Map([[CONFIG.SENDER01, "SENDER01"], [CONFIG.REGISTRY_ADMIN, "registry admin"], [CONFIG.CONTRACT_CENTER, "contract center"]]
        .filter(([address]) => isAddress(address)).map(([address, name]) => [address.toLowerCase(), name]));
    let names = new Map();

    try {
        names = sectionsConfigured() ? new Map((await listSections()).map((s) => [s.id, s.name])) : names;
    } catch (error) {
        // registry not readable now: keep the previous names
    }

    for (const sender of senders.keys()) {
        try {
            if (platform.has(sender)) {
                senderInfo.set(sender, { name: platform.get(sender), kind: "platform", section: "", sectionId: "" });
                continue;
            }

            const owner = sectionsConfigured() ? await accountSection(sender) : { id: 0, kind: 0 };
            const kind = SENDER_KINDS[owner.kind] || "other";
            const section = owner.kind ? names.get(owner.id) || `section ${owner.id}` : "";
            const name = !section ? shortAddress(sender) : kind === "user" ? `${section} · user ${shortAddress(sender)}` : `${section} · ${kind}`;

            senderInfo.set(sender, { name, kind, section, sectionId: owner.kind ? String(owner.id) : "" });
        } catch (error) {
            // try again at the next refresh
        }
    }

    for (const sender of senderInfo.keys()) {
        if (!senders.has(sender)) {
            senderInfo.delete(sender);
        }
    }
}

setInterval(refreshSenderInfo, 15000).unref();
setTimeout(refreshSenderInfo, 3000).unref();

function labelValue(text) {
    return String(text).replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, " ");
}

function sectionMetricLines() {
    const lines = [];
    const metric = (name, type, help, rows) => {
        lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
        rows.forEach(([labels, value]) => lines.push(labels ? `${name}{${labels}} ${value}` : `${name} ${value}`));
    };
    const sec = (id, name) => `section_id="${id}",section="${labelValue(name)}"`;

    metric("proxy_section_balance_eth", "gauge", "Balance of a section account (role upfront, consumption, payment).",
        sectionMetrics.rows.map((r) => [`${sec(r.id, r.name)},role="${r.role}",active="${r.active ? 1 : 0}"`, r.eth]));
    metric("proxy_section_active", "gauge", "1 = the section is enabled (archived sections are not listed).",
        [...new Map(sectionMetrics.rows.map((r) => [r.id, r])).values()].map((r) => [sec(r.id, r.name), r.active ? 1 : 0]));
    metric("proxy_section_operations_total", "counter", "Section operations since the proxy started (op: create_account, transfer_in, transfer_out, transfer_in_undo, transfer_out_undo, avatar_sale, avatar_undo, nickname_sale, nickname_undo, level_upgrade, level_undo, topup, sweep, payback, account_replaced, archive_return).",
        [...sectionOps.values()].map((e) => [`${sec(e.id, e.name)},op="${e.op}"`, e.count]));
    metric("proxy_section_amount_eth_total", "counter", "ETH moved by section operations since the proxy started.",
        [...sectionOps.values()].map((e) => [`${sec(e.id, e.name)},op="${e.op}"`, Number(ethers.formatEther(e.wei))]));
    metric("proxy_section_low_balance_eth", "gauge", "Alert threshold for upfront accounts (0 = off).", [["", CONFIG.UPFRONT_LOW_BALANCE_ETH]]);

    if (sectionMetrics.sender01 !== null) {
        metric("proxy_sender01_balance_eth", "gauge", "SENDER01's balance (it funds the upfront accounts).", [["", sectionMetrics.sender01]]);
    }

    metric("proxy_sender01_low_balance_eth", "gauge", "Alert threshold for SENDER01 (0 = off).", [["", CONFIG.SENDER01_LOW_BALANCE_ETH]]);
    metric("proxy_sections_metrics_error", "gauge", "1 = the last refresh of the section balances failed.", [["", sectionMetrics.error]]);
    metric("proxy_sections_metrics_age_seconds", "gauge", "Seconds since the section balances were refreshed.",
        [["", sectionMetrics.at ? Math.round((Date.now() - sectionMetrics.at) / 1000) : -1]]);
    return lines;
}

// ---- Section calls: X-Section-Key -> section_i

// The section of a request, or null for a call without X-Section-Key (SENDER01 behaviour, unless
// SECTION_KEY_REQUIRED). The key must belong to an active section.
async function sectionFromRequest(req) {
    const key = String(req.headers["x-section-key"] || "").trim();

    if (!key) {
        if (CONFIG.SECTION_KEY_REQUIRED) {
            throw httpError(401, "X-Section-Key is required");
        }

        return null;
    }

    requireSections();
    const hash = ethers.keccak256(ethers.toUtf8Bytes(key));
    const live = (list) => list.find((s) => !s.archived && s.keyHash === hash);
    let section = live(await listSections());

    if (!section) {
        // a key created or rotated a moment ago (by the other proxy, or before the cache refresh)
        section = live(await listSections(true));
    }

    if (!section) {
        console.warn(`section call with an unknown key from ${req.socket.remoteAddress}`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        throw httpError(401, "unknown section key");
    }

    if (!section.active) {
        throw httpError(403, `section "${section.name}" is disabled`);
    }

    return section;
}

async function accountSection(address) {
    const key = address.toLowerCase();

    if (accountSectionCache.has(key)) {
        return accountSectionCache.get(key);
    }

    const [id] = await registryCall("sectionOfAccount", [address]);
    const [kind] = await registryCall("accountKind", [address]);
    const result = { id: Number(id), kind: Number(kind) };

    if (result.kind !== 0) {
        accountSectionCache.set(key, result);
    }

    return result;
}

// Calls without a section key must not move a section's money (or send from the registry admin)
async function assertNotSectionAccount(address) {
    if (!sectionsConfigured() || !isAddress(address)) {
        return;
    }

    if (ethers.getAddress(address) === ethers.getAddress(CONFIG.REGISTRY_ADMIN)
        || (isAddress(CONFIG.CONTRACT_CENTER) && ethers.getAddress(address) === ethers.getAddress(CONFIG.CONTRACT_CENTER))) {
        throw httpError(403, "the registry admin and contract center accounts can't be used here");
    }

    const owner = await accountSection(address);

    if (owner.kind !== 0) {
        throw httpError(403, `${ethers.getAddress(address)} belongs to section ${owner.id}: call with that section's X-Section-Key`);
    }
}

async function assertSectionUser(section, address) {
    const owner = await accountSection(address);

    if (owner.kind !== ACCOUNT_USER || owner.id !== section.id) {
        throw httpError(403, `${ethers.getAddress(address)} is not an account of section "${section.name}"`);
    }
}

// /createaccount for a section: the account is registered under the section, then funded from the
// section's upfront account (instead of SENDER01).
async function createSectionAccount(section, amount, pool) {
    if (!CONFIG.MPC_ADMIN_URL) {
        throw httpError(503, "sections need the MPC signer (MPC_ADMIN_URL)");
    }

    const funder = section.accounts.upfront;
    await assertCanPay(funder, amount);
    const address = await createMpcAccount(pool);
    const registered = await registryWrite("addAccount", [section.id, address], { t: "account.create", s: section, p: { account: address } });
    accountSectionCache.set(address.toLowerCase(), { id: section.id, kind: ACCOUNT_USER });
    const payment = await withSenderLock(funder, async () => {
        await assertCanPay(funder, amount);
        return pay(funder, address, amount, { t: "account.fund", s: section, p: { account: address } });
    });
    countSectionOp(section, "create_account", amount);

    return {
        success: true,
        section: { id: section.id, name: section.name },
        address,
        from: funder,
        amount,
        pool,
        txHash: payment.txHash,
        nonce: payment.nonce,
        registryTxHash: registered.txHash,
        ...memoAnswer(payment.memo)
    };
}

// /transfer for a section: { account, amount, memo }
//   +x  account -> the section's consumption account
//   -x  the section's upfront account -> account
async function sectionTransfer(section, body) {
    const { account, amount, memo } = body || {};

    if (body && (body.from !== undefined || body.to !== undefined)) {
        throw httpError(400, "with X-Section-Key, send { \"account\": \"0x...\", \"amount\": \"5\" | \"-5\" }: +amount account -> consumption, -amount upfront -> account");
    }

    if (!account || !isAddress(account) || amount === undefined || amount === null || amount === "") {
        throw httpError(400, "missing parameters: account, amount");
    }

    MEMO.userMemo(memo);  // checked (the request's context holds it)

    const amountText = String(amount).trim();
    const negative = amountText.startsWith("-");
    const value = negative ? amountText.slice(1) : amountText;

    if (!/^\d+(\.\d+)?$/.test(value) || ethToWei(value) === 0n) {
        throw httpError(400, "invalid amount");
    }

    const user = ethers.getAddress(account);
    await assertSectionUser(section, user);
    const sender = negative ? section.accounts.upfront : user;
    const recipient = negative ? user : section.accounts.consumption;
    const { txHash, nonce, memo: rec } = await withSenderLock(sender, () =>
        pay(sender, recipient, value, { t: negative ? "transfer.out" : "transfer.in", s: section }));
    countSectionOp(section, negative ? "transfer_out" : "transfer_in", value);

    return {
        success: true,
        section: { id: section.id, name: section.name },
        direction: negative ? "upfront -> account" : "account -> consumption",
        txHash,
        from: sender,
        to: recipient,
        amount: value,
        nonce,
        ...memoAnswer(rec)
    };
}

// Startup check: the configured registry answers and its admin is REGISTRY_ADMIN
async function checkRegistryAtStart() {
    if (!CONFIG.REGISTRY_CONTRACT && !CONFIG.REGISTRY_ADMIN) {
        console.log("sections: off (no REGISTRY_CONTRACT)");
        return;
    }

    try {
        requireSections();
        const [admin] = await registryCall("admin");
        const [version] = await registryCall("VERSION");
        const [count] = await registryCall("sectionCount");

        if (ethers.getAddress(admin) !== ethers.getAddress(CONFIG.REGISTRY_ADMIN)) {
            console.error(`sections: the registry's admin is ${admin}, not REGISTRY_ADMIN ${CONFIG.REGISTRY_ADMIN}: writes will fail`);
        }

        if (Number(version) !== 2) {
            console.error(`sections: the registry is version ${version}; this proxy needs version 2 (rerun ansible 06-proxy.yml)`);
        }

        senderState(CONFIG.REGISTRY_ADMIN).pinned = true;

        if (isAddress(CONFIG.CONTRACT_CENTER)) {
            senderState(CONFIG.CONTRACT_CENTER).pinned = true;
        }

        loadContracts(true).then((book) => console.log(`contracts: ${book.size} registered, center ${CONFIG.CONTRACT_CENTER || "(not configured)"}`))
            .catch((error) => console.error(`contracts: not loaded yet (${error.message})`));
        console.log(`sections: registry ${CONFIG.REGISTRY_CONTRACT} v${version}, ${count} section(s), admin API ${CONFIG.ADMIN_TOKEN ? "on" : "off"}`);
    } catch (error) {
        // e.g. Besu behind HAProxy not answering yet right after a restart: try again
        console.error(`sections: registry ${CONFIG.REGISTRY_CONTRACT} not usable yet (${error.message}); retrying in 15 s`);
        setTimeout(checkRegistryAtStart, 15000).unref();
    }
}

setTimeout(checkRegistryAtStart, 1500).unref();

// =======================
// Start
// =======================

const LISTEN_HOST = process.env.LISTEN_HOST || BESU_IP;

app.listen(CONFIG.PORT, LISTEN_HOST, () => {
    console.log(`Server running ${LISTEN_HOST}:${CONFIG.PORT}`);
});
