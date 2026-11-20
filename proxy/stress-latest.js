const path = require("path");
const express = require("express");
const Redis = require("ioredis");
const { ethers } = require("ethers");
const crypto = require("crypto");
const nftArtifact = require("./nft-collection.json");
const registryArtifact = require("./section-registry.json");

require("dotenv").config({
    path: path.join(__dirname, ".env")
});

const app = express();
app.use(express.json({ limit: "1mb" }));

// =======================
// Config
// =======================

const BESU_IP = process.env.BESU_IP || process.env.IP;
const VAULT_IP = process.env.VAULT_IP || process.env.IP;
const WEB3SIGNER_IP = process.env.WEB3SIGNER_IP || process.env.IP;

const CONFIG = {
    PORT: Number(process.env.PORT) || 30000,
    BESU_RPC: `http://${BESU_IP}:${process.env.BESU_PORT || 8545}`,
    WEB3SIGNER_RPC: `http://${WEB3SIGNER_IP}:${process.env.WEB3SIGNER_PORT || 9000}`,
    VAULT_ADDR: `http://${VAULT_IP}:${process.env.VAULT_PORT || 8200}`,
    VAULT_MOUNT: process.env.VAULT_MOUNT || "web3signer",
    VAULT_ACCOUNT_PREFIX: process.env.VAULT_ACCOUNT_PREFIX || "accounts",
    VAULT_TOKEN: (process.env.VAULT_TOKEN || "").trim(),
    SENDER01: process.env.SENDER01 || "0xFE3B557E8Fb62b89F4916B721be55cEb828dBd73",
    // MPC signer: when MPC_ADMIN_URL is set, /createaccount creates the account as an MPC key
    // (distributed key generation; no private key exists anywhere) instead of storing a
    // private key in Vault. Point WEB3SIGNER_IP/PORT at the same coordinator for signing.
    MPC_ADMIN_URL: (process.env.MPC_ADMIN_URL || "").trim().replace(/\/$/, ""),
    MPC_ADMIN_TOKEN: (process.env.MPC_ADMIN_TOKEN || "").trim(),
    // presignature pool class of accounts created by /createaccount when the request names none:
    // big (MPC_POOL_TARGET presignatures, like SENDER01), small (MPC_POOL_TARGET_SMALL), none (cold)
    MPC_NEW_ACCOUNT_POOL: (process.env.MPC_NEW_ACCOUNT_POOL || "small").trim().toLowerCase(),
    NFT_BASE_URL: (process.env.NFT_BASE_URL || "").trim().replace(/\/$/, ""),
    // Sections (docs/sections.md): the on-chain SectionRegistry and the MPC account that writes it
    REGISTRY_CONTRACT: (process.env.REGISTRY_CONTRACT || "").trim(),
    REGISTRY_ADMIN: (process.env.REGISTRY_ADMIN || "").trim(),
    // Admin API (/admin/*): bearer token and the source addresses allowed to use it
    ADMIN_TOKEN: (process.env.ADMIN_TOKEN || "").trim(),
    ADMIN_ALLOWED_IPS: (process.env.ADMIN_ALLOWED_IPS || "").split(/[\s,]+/).filter(Boolean),
    // true: /createaccount and /transfer need a section's X-Section-Key (no SENDER01 fallback)
    SECTION_KEY_REQUIRED: String(process.env.SECTION_KEY_REQUIRED || "").toLowerCase() === "true",
    REDIS: {
        host: process.env.REDIS_IP || process.env.IP || BESU_IP,
        port: Number(process.env.REDIS_PORT) || 36379
    }
};

// Redis is an optional cache. The chain is the source of truth for everything the proxy
// keeps (nonces, pending value, NFT contract, token ids, NFT metadata), and in-process memory
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
// NFT collections: the default collection (NFT_CONTRACT / nft:contract / first deployed),
// every collection deployed by SENDER01, and the next token id per collection.
const memNft = { contract: null, nextId: new Map(), collections: null };

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
// Check Web3Signer account
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

    const accounts = await rpc(CONFIG.WEB3SIGNER_RPC, "eth_accounts");
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
    const ownedBySigner = await signerOwns(state.address);
    const txHash = ownedBySigner
        ? await sendFromSigner(state.address, state.address, "0", nonce, "0x", 21000n)
        : await sendFromVault(state.address, state.address, "0", nonce, "0x", 21000n);
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

const MEMO_LIMIT = 256;
const MINT_MEMO_LIMIT = 4096;

function memoBytes(memo) {
    return ethers.toUtf8Bytes(memo || "");
}

function clipUtf8(text, limit) {
    const bytes = memoBytes(text);

    if (bytes.length <= limit) {
        return text;
    }

    let size = limit;

    while (size > 0 && (bytes[size] & 0xc0) === 0x80) {
        size -= 1;
    }

    return ethers.toUtf8String(bytes.slice(0, size));
}

function decodeMemo(input) {
    if (!input || input === "0x") {
        return "";
    }

    let bytes;

    try {
        bytes = ethers.getBytes(input);
    } catch (error) {
        return "";
    }

    if (bytes.length > MINT_MEMO_LIMIT || bytes.includes(0)) {
        return "";
    }

    try {
        return ethers.toUtf8String(bytes);
    } catch (error) {
        return "";
    }
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

async function pay(sender, recipient, amount, ownedBySigner, memo = "") {
    const bytes = memoBytes(memo);
    const gas = transferGas(bytes);
    const data = bytes.length === 0 ? "0x" : ethers.hexlify(bytes);

    await assertCanPay(sender, amount);

    const nonce = await nextNonce(sender);
    let txHash;

    try {
        txHash = ownedBySigner
            ? await sendFromSigner(sender, recipient, amount, nonce, data, gas)
            : await sendFromVault(sender, recipient, amount, nonce, data, gas);
    } catch (error) {
        await resetNonce(sender);
        throw error;
    }

    await rememberPending(sender, nonce, amount);

    return { txHash, nonce };
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

function vaultToken() {
    if (!CONFIG.VAULT_TOKEN) {
        throw new Error("VAULT_TOKEN is not configured");
    }

    return CONFIG.VAULT_TOKEN;
}

function accountName(address) {
    return "acct-" + address.slice(2).toLowerCase();
}

function vaultDataUrl(name) {
    return `${CONFIG.VAULT_ADDR}/v1/${CONFIG.VAULT_MOUNT}/data/${CONFIG.VAULT_ACCOUNT_PREFIX}/${name}`;
}

async function storePrivateKey(name, privateKey) {
    const response = await fetch(vaultDataUrl(name), {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Vault-Token": await vaultToken()
        },
        body: JSON.stringify({
            data: {
                privateKey
            }
        })
    });

    if (!response.ok) {
        const detail = await response.text();
        throw new Error(`vault write failed (${response.status}): ${detail.slice(0, 300)}`);
    }
}

// The message for a sender that no configured signer holds. Without Vault (MPC deployments) the
// only signer is the MPC cluster, so say so instead of reporting a missing VAULT_TOKEN.
function notManaged(address) {
    const signer = CONFIG.MPC_ADMIN_URL ? "the MPC signer" : "Web3Signer";
    return CONFIG.VAULT_TOKEN
        ? `sender not managed by ${signer} or Vault: ${address}`
        : `sender not managed by ${signer}: ${address} (create it with POST /createaccount)`;
}

async function readPrivateKey(name) {
    // no Vault configured: no locally stored keys, so the account is simply not managed here
    if (!CONFIG.VAULT_TOKEN) {
        return null;
    }

    const response = await fetch(vaultDataUrl(name), {
        headers: {
            "X-Vault-Token": await vaultToken()
        }
    });

    if (response.status === 404) {
        return null;
    }

    if (!response.ok) {
        const detail = await response.text();
        throw new Error(`vault read failed (${response.status}): ${detail.slice(0, 300)}`);
    }

    const body = await response.json();
    const privateKey = body.data && body.data.data && body.data.data.privateKey;

    if (!privateKey) {
        return null;
    }

    return privateKey.startsWith("0x") ? privateKey : "0x" + privateKey;
}

async function vaultWallet(from) {
    const privateKey = await readPrivateKey(accountName(from));

    if (!privateKey) {
        throw httpError(400, notManaged(from));
    }

    const wallet = new ethers.Wallet(privateKey);

    if (wallet.address.toLowerCase() !== from.toLowerCase()) {
        throw new Error("vault key does not match sender");
    }

    return wallet;
}

async function sendRawTransaction(wallet, tx) {
    const chainId = await rpc(CONFIG.BESU_RPC, "eth_chainId");
    const signed = await wallet.signTransaction({
        ...tx,
        chainId: parseInt(chainId, 16),
        gasPrice: "0x0"
    });

    return rpc(CONFIG.BESU_RPC, "eth_sendRawTransaction", [signed]);
}

async function sendFromVault(from, to, amount, nonce, data = "0x", gas = 21000n) {
    const wallet = await vaultWallet(from);

    return sendRawTransaction(wallet, {
        to,
        value: ethToWeiHex(amount),
        nonce,
        data,
        gasLimit: gas
    });
}

async function sendFromSigner(from, to, amount, nonce, data = "0x", gas = 21000n) {
    return rpc(
        CONFIG.WEB3SIGNER_RPC,
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

    const useMpc = Boolean(CONFIG.MPC_ADMIN_URL);
    const wallet = useMpc ? null : ethers.Wallet.createRandom();

    if (useMpc) {
        await assertCanPay(CONFIG.SENDER01, amount);
    }

    const address = useMpc ? await createMpcAccount(pool) : wallet.address;

    const payment = await withSenderLock(CONFIG.SENDER01, async () => {
        await assertCanPay(CONFIG.SENDER01, amount);
        if (!useMpc) {
            await storePrivateKey(accountName(address), wallet.privateKey.slice(2));
        }
        return pay(CONFIG.SENDER01, address, amount, true);
    });

    return {
        success: true,
        address,
        from: CONFIG.SENDER01,
        amount,
        ...(useMpc ? { pool } : {}),
        txHash: payment.txHash,
        nonce: payment.nonce
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

app.post("/transfer", async (req, res) => {
    try {
        const section = await sectionFromRequest(req);

        if (section) {
            return res.json(await sectionTransfer(section, req.body));
        }

        const { from, to, amount, memo } = req.body;

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

        if (memo !== undefined && typeof memo !== "string") {
            return res.status(400).json({
                error: "invalid memo"
            });
        }

        const memoText = memo === undefined ? "" : memo;

        if (memoBytes(memoText).length > MEMO_LIMIT) {
            return res.status(400).json({
                error: "memo is too long"
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
        const ownedBySigner = await signerOwns(sender);

        if (!ownedBySigner && !await readPrivateKey(accountName(sender))) {
            return res.status(400).json({
                error: notManaged(sender)
            });
        }

        const { txHash, nonce } = await withSenderLock(sender, () =>
            pay(sender, recipient, value, ownedBySigner, memoText)
        );

        res.json({
            success: true,
            txHash,
            from: sender,
            to: recipient,
            amount: value,
            memo: memoText,
            nonce
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
    metric("proxy_senders_tracked", "gauge", "Senders watched by the background chain check.", [["", senders.size]]);
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

        res.json({
            success: true,
            txHash: tx.hash || txHash,
            from: tx.from,
            to: tx.to || null,
            memo: decodeMemo(tx.input || tx.data)
        });
    } catch (error) {
        console.error(error);

        res.status(error.statusCode || 500).json({
            error: error.message
        });
    }
});

// =======================
// NFT
// =======================

const nftInterface = new ethers.Interface(nftArtifact.abi);
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
const NFT_META_LIMIT = 512 * 1024;
const ON_CHAIN_META_LIMIT = 48 * 1024;

let nftDeployChain = Promise.resolve();

function withDeployLock(task) {
    const run = nftDeployChain.then(task, task);
    nftDeployChain = run.then(() => {}, () => {});
    return run;
}

function httpError(statusCode, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

function isRevert(error) {
    return /revert|invalid opcode|out of gas|could not decode/i.test(error.message || "");
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

function nftMetaKey(contract, tokenId) {
    return `nft:meta:${contract.toLowerCase()}:${tokenId}`;
}

function metadataUrl(req, tokenId) {
    const root = CONFIG.NFT_BASE_URL || `${req.protocol}://${req.get("host")}`;
    return `${root}/nft/${tokenId}/metadata`;
}

function onChainTokenUri(metadata) {
    const json = JSON.stringify(metadata);

    if (Buffer.byteLength(json) > ON_CHAIN_META_LIMIT) {
        throw httpError(400, "metadata is too large for the chain");
    }

    return "data:application/json;base64," + Buffer.from(json, "utf8").toString("base64");
}

function nftBytecode() {
    return nftArtifact.bytecode.startsWith("0x")
        ? nftArtifact.bytecode
        : "0x" + nftArtifact.bytecode;
}

function nftDeployData(name, symbol) {
    return ethers.hexlify(ethers.concat([
        nftBytecode(),
        nftInterface.encodeDeploy([name, symbol])
    ]));
}

async function hasCode(address) {
    const code = await rpc(CONFIG.BESU_RPC, "eth_getCode", [address, "latest"]);
    return Boolean(code) && code !== "0x";
}

// Only NftCollection version 2 (price at mint + atomic buy) is supported. Older collections on
// the chain are ignored by listing/discovery and rejected when selected.
const COLLECTION_VERSION = 2n;
const versionCache = new Map();

async function isSupportedCollection(address) {
    const key = address.toLowerCase();

    if (!versionCache.has(key)) {
        let ok = false;

        try {
            ok = (await callNft(address, "version", []))[0] === COLLECTION_VERSION;
        } catch (error) {
            ok = false;
        }

        versionCache.set(key, ok);
    }

    return versionCache.get(key);
}

function oldCollectionError(address) {
    return httpError(400, `collection ${address} is an old version without buy(); `
        + "old collections are no longer supported, deploy a new collection with /nft/deploy");
}

async function nftContractAddress() {
    const configured = (process.env.NFT_CONTRACT || "").trim();

    if (configured) {
        if (!isAddress(configured)) {
            throw httpError(500, "NFT_CONTRACT is not a valid address");
        }

        const address = ethers.getAddress(configured);

        // e.g. the chain was reset: the configured address belongs to the old chain
        if (memNft.contract !== address && !await hasCode(address)) {
            throw httpError(500, `NFT_CONTRACT ${address} has no contract on this chain `
                + "(was the chain reset?). Remove NFT_CONTRACT from .env to let the proxy "
                + "find or deploy the collection, or set it to the current address.");
        }

        if (!await isSupportedCollection(address)) {
            throw oldCollectionError(address);
        }

        memNft.contract = address;
        return address;
    }

    if (memNft.contract) {
        return memNft.contract;
    }

    const stored = await cache(() => redis.get("nft:contract"));

    if (stored && isAddress(stored)) {
        if (await hasCode(stored) && await isSupportedCollection(stored)) {
            memNft.contract = ethers.getAddress(stored);
            return memNft.contract;
        }

        // stale cache from an old chain: forget it and look on the current chain
        console.warn(`cached nft:contract ${stored} is missing or an old version; ignoring it`);
        await cache(() => redis.del("nft:contract"));
    }

    const found = await discoverNftContract();

    if (found) {
        await rememberNftContract(found);
    }

    return found;
}

async function rememberNftContract(contract) {
    memNft.contract = ethers.getAddress(contract);
    await cache(() => redis.set("nft:contract", memNft.contract));
}

// Every collection SENDER01 deployed lives at one of its CREATE addresses
// (keccak(rlp(sender, nonce))). Scan them (oldest first) and keep those with code whose
// minter() is SENDER01. Used when neither memory nor Redis knows the collections.
let discovery = null;

// Scan once per process (it is only needed on a cold start without Redis); collections
// deployed later are added to memory directly.
function discoverCollections() {
    if (!discovery) {
        discovery = scanCollections().catch((error) => {
            discovery = null;
            throw error;
        });
    }

    return discovery;
}

async function scanCollections() {
    const sender = ethers.getAddress(CONFIG.SENDER01);
    const latest = parseInt(await rpc(CONFIG.BESU_RPC, "eth_getTransactionCount", [sender, "latest"]), 16);
    const found = [];

    for (let nonce = 0; nonce < latest; nonce += 1) {
        const candidate = ethers.getCreateAddress({ from: sender, nonce });

        if (!await hasCode(candidate)) {
            continue;
        }

        try {
            const minter = (await callNft(candidate, "minter", []))[0];

            if (minter.toLowerCase() === sender.toLowerCase() && await isSupportedCollection(candidate)) {
                found.push(candidate);
            }
        } catch (error) {
            // not an NftCollection; keep looking
        }
    }

    if (found.length > 0) {
        console.log(`NFT collections recovered from chain: ${found.join(", ")}`);
    }

    return found;
}

async function discoverNftContract() {
    const found = await discoverCollections();
    return found.length > 0 ? found[0] : null;
}

async function collectionInfo(contract) {
    const info = { name: null, symbol: null };

    try {
        info.name = (await callNft(contract, "name", []))[0];
        info.symbol = (await callNft(contract, "symbol", []))[0];
    } catch (error) {
        // name/symbol are optional for display
    }

    return info;
}

// All known collections: memory -> Redis hash nft:collections -> chain discovery.
async function knownCollections() {
    if (!memNft.collections) {
        const stored = await cache(() => redis.hgetall("nft:collections"), null);
        const collections = new Map();

        if (stored && Object.keys(stored).length > 0) {
            for (const [address, json] of Object.entries(stored)) {
                if (isAddress(address) && await hasCode(address) && await isSupportedCollection(address)) {
                    collections.set(ethers.getAddress(address), JSON.parse(json));
                }
            }
        } else {
            for (const address of await discoverCollections()) {
                collections.set(address, await collectionInfo(address));
            }
        }

        memNft.collections = collections;
    }

    const def = await nftContractAddress();

    if (def && !memNft.collections.has(def)) {
        memNft.collections.set(def, await collectionInfo(def));
    }

    // best effort: persist anything Redis is missing (e.g. deployed while Redis was down)
    for (const [address, info] of memNft.collections) {
        await cache(() => redis.hsetnx("nft:collections", address, JSON.stringify(info)));
    }

    return memNft.collections;
}

async function rememberCollection(contract, info) {
    const address = ethers.getAddress(contract);
    (await knownCollections()).set(address, info);
    await cache(() => redis.hset("nft:collections", address, JSON.stringify(info)));
}

function sameLabel(a, b) {
    return typeof a === "string" && typeof b === "string" && a.trim().toLowerCase() === b.trim().toLowerCase();
}

// Collections whose name or symbol equals `label` (case-insensitive).
async function collectionsByLabel(label) {
    const matches = [];

    for (const [contract, info] of await knownCollections()) {
        if (sameLabel(info.name, label) || sameLabel(info.symbol, label)) {
            matches.push(contract);
        }
    }

    return matches;
}

// Collection for a request: an address, a collection name or symbol, or (empty) the default.
async function resolveCollection(input) {
    if (input === undefined || input === null || input === "") {
        return requireNftContract();
    }

    if (typeof input !== "string") {
        throw httpError(400, "collection must be a name, symbol or address");
    }

    if (isAddress(input)) {
        const address = ethers.getAddress(input);

        if (!await hasCode(address)) {
            throw httpError(404, `no contract at ${address} on this chain`);
        }

        if (!await isSupportedCollection(address)) {
            throw oldCollectionError(address);
        }

        return address;
    }

    const matches = await collectionsByLabel(input);

    if (matches.length === 0) {
        throw httpError(404, `no NFT collection named "${input.trim()}": list the collections with GET /nft/collections, or create one with POST /nft/deploy {"name": "...", "symbol": "..."}`);
    }

    if (matches.length > 1) {
        throw httpError(409, `"${input.trim()}" matches several collections: ${matches.join(", ")}; use the address`);
    }

    return matches[0];
}

// body.collection / ?collection= (preferred) or the older body.contract / ?contract=
function collectionParam(source) {
    if (!source) {
        return undefined;
    }

    return source.collection !== undefined && source.collection !== "" ? source.collection : source.contract;
}

async function requireNftContract() {
    const address = await nftContractAddress();

    if (!address) {
        throw httpError(400, "NFT contract is not deployed");
    }

    return address;
}

async function highestMintedTokenId(contract) {
    const head = BigInt(await rpc(CONFIG.BESU_RPC, "eth_blockNumber", []));
    const span = 5000n;
    let max = 0n;

    for (let start = 0n; start <= head; start += span) {
        const end = start + span - 1n > head ? head : start + span - 1n;
        const logs = await rpc(CONFIG.BESU_RPC, "eth_getLogs", [{
            address: contract,
            fromBlock: ethers.toQuantity(start),
            toBlock: ethers.toQuantity(end),
            topics: [TRANSFER_TOPIC]
        }]);

        for (const log of logs) {
            if (!log.topics || log.topics.length < 4) {
                continue;
            }

            const tokenId = BigInt(log.topics[3]);

            if (tokenId > max) {
                max = tokenId;
            }
        }
    }

    return max;
}

async function allocateTokenId(contract) {
    const minted = await highestMintedTokenId(contract);

    if (minted > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw httpError(500, "token id is too large");
    }

    const key = `nft:nextId:${contract.toLowerCase()}`;

    if (!memNft.nextId.has(contract)) {
        const stored = Number(await cache(() => redis.get(key)) || 0);
        memNft.nextId.set(contract, Math.max(memNft.nextId.get(contract) || 0, stored));
    }

    // read-modify-write without an await in between: atomic within this process
    const tokenId = Math.max(memNft.nextId.get(contract), Number(minted)) + 1;
    memNft.nextId.set(contract, tokenId);
    await cache(() => redis.set(key, tokenId));
    return String(tokenId);
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

    return rpc(CONFIG.WEB3SIGNER_RPC, "eth_sendTransaction", [tx]);
}

async function sendDataFromVault(from, to, data, nonce, gas, valueHex) {
    const wallet = await vaultWallet(from);
    const tx = {
        data,
        value: valueHex,
        nonce,
        gasLimit: gas
    };

    if (to) {
        tx.to = to;
    }

    return sendRawTransaction(wallet, tx);
}

async function sendData(from, to, data, ownedBySigner, valueWei = 0n) {
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
        txHash = ownedBySigner
            ? await sendDataFromSigner(from, to, data, nonce, gas, valueHex)
            : await sendDataFromVault(from, to, data, nonce, gas, valueHex);
    } catch (error) {
        await resetNonce(from);
        throw error;
    }

    await rememberPendingWei(from, nonce, cost);

    return {
        txHash,
        nonce,
        gas: gas.toString()
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

async function callNft(contract, fn, args) {
    const data = nftInterface.encodeFunctionData(fn, args);
    const raw = await ethCall(contract, data);

    if (!raw || raw === "0x") {
        const error = new Error("empty call result");
        error.empty = true;
        throw error;
    }

    return nftInterface.decodeFunctionResult(fn, raw);
}

async function readOwner(contract, tokenId) {
    try {
        const result = await callNft(contract, "ownerOf", [tokenId]);
        return result[0];
    } catch (error) {
        if (error.empty || isRevert(error)) {
            return null;
        }

        throw error;
    }
}

// Proxy-side record of a mint ({metadata, tokenURI, to, amount, txHash}). Redis is a cache:
// if it has no record, rebuild {metadata, tokenURI} from the on-chain data: URI.
async function readStoredNft(contract, tokenId) {
    let raw = await cache(() => redis.get(nftMetaKey(contract, tokenId)));

    if (!raw && contract === await nftContractAddress()) {
        // records written before multi-collection support (default collection only)
        raw = await cache(() => redis.get(`nft:meta:${tokenId}`));
    }

    if (raw) {
        return JSON.parse(raw);
    }

    return nftFromChain(contract, tokenId);
}

async function nftFromChain(contract, tokenId) {
    if (!contract) {
        return null;
    }

    let tokenURI;

    try {
        tokenURI = (await callNft(contract, "tokenURI", [tokenId]))[0];
    } catch (error) {
        return null;
    }

    const prefix = "data:application/json;base64,";
    let metadata = null;

    if (tokenURI.startsWith(prefix)) {
        try {
            metadata = JSON.parse(Buffer.from(tokenURI.slice(prefix.length), "base64").toString("utf8"));
        } catch (error) {
            metadata = null;
        }
    }

    return { metadata, tokenURI, fromChain: true };
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

function normalizeProperties(properties) {
    if (properties === undefined) {
        return {};
    }

    if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
        throw httpError(400, "invalid properties");
    }

    const clean = {};

    for (const [key, value] of Object.entries(properties)) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
            continue;
        }

        const kind = typeof value;

        if (value !== null && kind !== "string" && kind !== "number" && kind !== "boolean") {
            throw httpError(400, "invalid properties");
        }

        clean[key] = value;
    }

    return clean;
}

function buildMetadata(body) {
    const name = collectionField(body.name, "name", 200);
    const image = collectionField(body.image, "image", 500000);
    const description = body.description === undefined ? "" : body.description;

    if (typeof description !== "string" || description.length > 5000) {
        throw httpError(400, "invalid description");
    }

    const metadata = {
        name,
        description,
        image,
        attributes: normalizeAttributes(body.attributes)
    };
    const properties = normalizeProperties(body.properties);

    if (Object.keys(properties).length > 0) {
        metadata.properties = properties;
    }

    if (Buffer.byteLength(JSON.stringify(metadata)) > NFT_META_LIMIT) {
        throw httpError(400, "metadata is too large");
    }

    return metadata;
}

async function deployCollection(name, symbol) {
    // names and symbols select collections, so each must identify exactly one
    for (const label of new Set([name, symbol])) {
        const taken = await collectionsByLabel(label);

        if (taken.length > 0) {
            throw httpError(409, `"${label}" is already used by collection ${taken[0]}; choose another name/symbol`);
        }
    }

    if (!await signerOwns(CONFIG.SENDER01)) {
        throw new Error("sender01 is not managed by Web3Signer");
    }

    const data = nftDeployData(name, symbol);
    const sent = await withSenderLock(CONFIG.SENDER01, () =>
        sendData(CONFIG.SENDER01, null, data, true)
    );
    const receipt = await waitForReceipt(sent.txHash);
    const address = receipt.contractAddress;

    if (!address || !isAddress(address)) {
        throw new Error("deployment did not create a contract");
    }

    const contract = ethers.getAddress(address);
    const code = await rpc(CONFIG.BESU_RPC, "eth_getCode", [contract, "latest"]);

    if (!code || code === "0x") {
        throw new Error("deployment produced no code");
    }

    const existingDefault = await nftContractAddress();

    if (!existingDefault) {
        await rememberNftContract(contract);
    }

    await rememberCollection(contract, { name, symbol });

    return {
        success: true,
        contract,
        default: !existingDefault,
        txHash: sent.txHash,
        name,
        symbol,
        minter: CONFIG.SENDER01,
        nonce: sent.nonce
    };
}

// Mint: every NFT is minted to SENDER01 (the collection's minter); nothing is paid.
// "amount" is the NFT's price, stored on chain in the collection (priceOf); /nft/transfer sells
// the token with buy(), where the buyer pays exactly that price to SENDER01 in one transaction.
async function mintNft(req) {
    const body = req.body || {};

    if (body.name === undefined || body.image === undefined) {
        throw httpError(400, "missing parameters");
    }

    const sender = ethers.getAddress(CONFIG.SENDER01);

    if (body.to !== undefined && body.to !== null && body.to !== "" &&
        !(isAddress(body.to) && ethers.getAddress(body.to) === sender)) {
        throw httpError(400, "\"to\" is not supported: NFTs are minted to SENDER01; "
            + "use /nft/transfer to give or sell one");
    }

    const price = body.amount === undefined || body.amount === null || body.amount === ""
        ? "0"
        : String(body.amount).trim();

    if (!/^\d+(\.\d+)?$/.test(price)) {
        throw httpError(400, "invalid amount");
    }

    const priceWei = ethToWei(price);
    const metadata = buildMetadata(body);
    const tokenURI = onChainTokenUri(metadata);
    const contract = await resolveCollection(collectionParam(body));

    if (!await signerOwns(CONFIG.SENDER01)) {
        throw new Error("sender01 is not managed by the signer");
    }

    let minter;

    try {
        minter = (await callNft(contract, "minter", []))[0];
    } catch (error) {
        if (error.empty || isRevert(error)) {
            throw httpError(400, "NFT contract is not a collection");
        }

        throw error;
    }

    if (minter.toLowerCase() !== sender.toLowerCase()) {
        throw httpError(400, "NFT minter is not sender01");
    }

    const tokenId = await allocateTokenId(contract);
    const key = nftMetaKey(contract, tokenId);
    const record = {
        metadata,
        tokenURI,
        to: sender,
        price
    };

    await cache(() => redis.set(key, JSON.stringify(record)));

    const data = nftInterface.encodeFunctionData("mint", [sender, tokenId, tokenURI, priceWei]);
    let sent;

    try {
        await assertMintFits(sender, contract, data);
        sent = await withSenderLock(sender, () => sendData(sender, contract, data, true));
    } catch (error) {
        await cache(() => redis.del(key));
        throw error;
    }

    record.txHash = sent.txHash;
    await cache(() => redis.set(key, JSON.stringify(record)));

    return {
        success: true,
        tokenId,
        contract,
        owner: sender,
        price,
        tokenURI,
        txHash: sent.txHash,
        nonce: sent.nonce
    };
}

// Sell / transfer an NFT to `to` with the collection's buy(): ONE transaction signed by the
// buyer, carrying exactly the token's price (set at mint). The NFT moves to the buyer and the
// ETH goes to SENDER01 atomically; if anything fails the whole sale reverts and no ETH moves.
// `from` is optional (default: current owner). If the owner is not SENDER01 (a resale), the
// owner first approves the collection for this token.
async function transferNft(body) {
    const tokenId = parseTokenId(body.tokenId);

    if (!body.to || !tokenId) {
        throw httpError(400, "missing parameters");
    }

    if (!isAddress(body.to) || (body.from && !isAddress(body.from))) {
        throw httpError(400, "invalid address");
    }

    const contract = await resolveCollection(collectionParam(body));
    const to = ethers.getAddress(body.to);
    const sender = ethers.getAddress(CONFIG.SENDER01);
    const owner = await readOwner(contract, tokenId);

    if (!owner) {
        throw httpError(404, "token not found");
    }

    const from = body.from ? ethers.getAddress(body.from) : ethers.getAddress(owner);

    if (owner.toLowerCase() !== from.toLowerCase()) {
        throw httpError(400, "sender is not the token owner");
    }

    if (from === to) {
        throw httpError(400, "token is already owned by to");
    }

    const priceWei = (await callNft(contract, "priceOf", [tokenId]))[0];
    const price = ethers.formatEther(priceWei).replace(/\.0$/, "");

    if (body.amount !== undefined && body.amount !== null && body.amount !== "" &&
        ethToWei(String(body.amount).trim()) !== priceWei) {
        throw httpError(400, `"amount" is not a parameter: the price of this token is ${price} `
            + "(set at mint)");
    }

    const buyerOwned = await signerOwns(to);

    if (!buyerOwned) {
        throw httpError(400, "to address (buyer) is not managed by the signer");
    }

    // resale: the current owner must allow the collection to sell this token
    let approveTxHash = null;

    if (from !== sender) {
        const approved = (await callNft(contract, "getApproved", [tokenId]))[0];
        const operator = (await callNft(contract, "isApprovedForAll", [from, contract]))[0];

        if (approved.toLowerCase() !== contract.toLowerCase() && !operator) {
            if (!await signerOwns(from)) {
                throw httpError(400, "owner is not managed by the signer");
            }

            const approveData = nftInterface.encodeFunctionData("approve", [contract, tokenId]);
            const approval = await withSenderLock(from, () => sendData(from, contract, approveData, true));
            const receipt = await waitForReceipt(approval.txHash);

            if (!receipt || BigInt(receipt.status) !== 1n) {
                throw new Error("approval for the sale failed");
            }

            approveTxHash = approval.txHash;
        }
    }

    // the sale: buyer signs buy(tokenId) with value = price (gas estimation rejects a sale
    // that would revert, e.g. insufficient balance, before anything is sent)
    const buyData = nftInterface.encodeFunctionData("buy", [tokenId]);
    let sent;

    try {
        sent = await withSenderLock(to, () => sendData(to, contract, buyData, true, priceWei));
    } catch (error) {
        if (/insufficient/i.test(error.message)) {
            throw httpError(400, `insufficient balance: the price of this token is ${price} ETH`);
        }

        throw error;
    }

    return {
        success: true,
        txHash: sent.txHash,
        from,
        to,
        tokenId,
        contract,
        price,
        approveTxHash,
        nonce: sent.nonce
    };
}

async function ownedInCollection(contract, owner) {
    const minted = Number(await highestMintedTokenId(contract));
    const stored = Math.max(
        memNft.nextId.get(contract) || 0,
        Number(await cache(() => redis.get(`nft:nextId:${contract.toLowerCase()}`)) || 0)
    );
    const latest = Math.max(minted, stored);
    const tokenIds = [];
    const batchSize = 20;

    for (let start = 1; start <= latest; start += batchSize) {
        const ids = [];

        for (let id = start; id < start + batchSize && id <= latest; id += 1) {
            ids.push(String(id));
        }

        const owners = await Promise.all(ids.map((id) => readOwner(contract, id)));

        ids.forEach((id, index) => {
            if (owners[index] && owners[index].toLowerCase() === owner.toLowerCase()) {
                tokenIds.push(id);
            }
        });
    }

    return tokenIds;
}

// ?contract=0x... -> that collection only; otherwise every known collection. The top-level
// contract/tokenIds fields keep the single-collection response shape (default collection).
async function listOwnedNfts(address, contractParam) {
    const owner = ethers.getAddress(address);

    if (contractParam) {
        const contract = await resolveCollection(contractParam);
        return { success: true, contract, owner, tokenIds: await ownedInCollection(contract, owner) };
    }

    const def = await requireNftContract();
    const collections = [];

    for (const contract of (await knownCollections()).keys()) {
        collections.push({ contract, tokenIds: await ownedInCollection(contract, owner) });
    }

    const defaultRow = collections.find((row) => row.contract === def);

    return {
        success: true,
        contract: def,
        owner,
        tokenIds: defaultRow ? defaultRow.tokenIds : [],
        collections
    };
}

app.post("/nft/deploy", async (req, res) => {
    try {
        const body = req.body || {};

        if (body.name !== undefined && typeof body.name !== "string") {
            throw httpError(400, "invalid name");
        }

        if (body.symbol !== undefined && typeof body.symbol !== "string") {
            throw httpError(400, "invalid symbol");
        }

        const name = body.name === undefined ? "Proxy NFT" : body.name;
        const symbol = body.symbol === undefined ? "PNFT" : body.symbol;
        const result = await withDeployLock(() => deployCollection(
            collectionField(name, "name", 64),
            collectionField(symbol, "symbol", 32)
        ));

        res.json(result);
    } catch (error) {
        console.error(error);

        res.status(error.statusCode || 500).json({
            error: error.message
        });
    }
});

app.post("/nft/mint", async (req, res) => {
    try {
        res.json(await mintNft(req));
    } catch (error) {
        console.error(error);

        res.status(error.statusCode || 500).json({
            error: error.message
        });
    }
});

app.post("/nft/transfer", async (req, res) => {
    try {
        res.json(await transferNft(req.body || {}));
    } catch (error) {
        console.error(error);

        res.status(error.statusCode || 500).json({
            error: error.message
        });
    }
});

app.get("/nft/contract", async (req, res) => {
    try {
        const contract = await nftContractAddress();

        if (!contract) {
            return res.status(404).json({
                error: "NFT contract is not deployed"
            });
        }

        res.json({
            success: true,
            contract
        });
    } catch (error) {
        console.error(error);

        res.status(error.statusCode || 500).json({
            error: error.message
        });
    }
});

app.get("/nft/collections", async (req, res) => {
    try {
        const def = await nftContractAddress();
        const collections = [...(await knownCollections()).entries()].map(([contract, info]) => ({
            contract,
            name: info.name,
            symbol: info.symbol,
            default: contract === def
        }));

        res.json({ success: true, minter: ethers.getAddress(CONFIG.SENDER01), collections });
    } catch (error) {
        console.error(error);

        res.status(error.statusCode || 500).json({
            error: error.message
        });
    }
});

app.get("/nft/owner/:address", async (req, res) => {
    try {
        if (!isAddress(req.params.address)) {
            return res.status(400).json({
                error: "invalid address"
            });
        }

        res.json(await listOwnedNfts(req.params.address, collectionParam(req.query)));
    } catch (error) {
        console.error(error);

        res.status(error.statusCode || 500).json({
            error: error.message
        });
    }
});

app.get("/nft/:tokenId/metadata", async (req, res) => {
    try {
        const tokenId = parseTokenId(req.params.tokenId);

        if (!tokenId) {
            return res.status(400).json({
                error: "invalid token id"
            });
        }

        const contract = await resolveCollection(collectionParam(req.query));
        const stored = await readStoredNft(contract, tokenId);

        if (!stored) {
            return res.status(404).json({
                error: "token not found"
            });
        }

        res.json(stored.metadata);
    } catch (error) {
        console.error(error);

        res.status(error.statusCode || 500).json({
            error: error.message
        });
    }
});

app.get("/nft/:tokenId", async (req, res) => {
    try {
        const tokenId = parseTokenId(req.params.tokenId);

        if (!tokenId) {
            return res.status(400).json({
                error: "invalid token id"
            });
        }

        const contract = await resolveCollection(collectionParam(req.query));
        const stored = await readStoredNft(contract, tokenId);
        const owner = await readOwner(contract, tokenId);

        if (!owner) {
            if (stored) {
                return res.status(404).json({
                    error: "token not minted yet",
                    tokenId,
                    txHash: stored.txHash || null
                });
            }

            return res.status(404).json({
                error: "token not found"
            });
        }

        const tokenURI = (await callNft(contract, "tokenURI", [tokenId]))[0];

        res.json({
            success: true,
            contract,
            tokenId,
            owner,
            tokenURI,
            txHash: stored ? stored.txHash || null : null,
            metadata: stored ? stored.metadata : null
        });
    } catch (error) {
        console.error(error);

        res.status(error.statusCode || 500).json({
            error: error.message
        });
    }
});

// =======================
// Sections (docs/sections.md)
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
function registryWrite(fn, args) {
    const run = sectionWriteChain.then(async () => {
        const data = registryIface.encodeFunctionData(fn, args);
        let sent;

        try {
            sent = await withSenderLock(CONFIG.REGISTRY_ADMIN, () =>
                sendData(CONFIG.REGISTRY_ADMIN, CONFIG.REGISTRY_CONTRACT, data, true)
            );
        } catch (error) {
            const reason = String(error.message || "").match(/revert(?:ed)?:?\s*(.*)$/i);
            throw reason ? httpError(409, `registry refused: ${reason[1] || error.message}`) : error;
        }

        const receipt = await waitForReceipt(sent.txHash);
        sectionCache.at = 0;
        return { txHash: sent.txHash, receipt };
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
    const written = await registryWrite("createSection", [name, accounts.upfront, accounts.consumption, accounts.payment, hash]);
    const created = written.receipt.logs
        .map((log) => { try { return registryIface.parseLog(log); } catch { return null; } })
        .find((log) => log && log.name === "SectionCreated");
    const id = Number(created.args.id);

    for (const [k, v] of info) {
        await registryWrite("setInfo", [id, k, v]);
    }

    console.log(`section ${id} "${name}" created: upfront ${accounts.upfront}, consumption ${accounts.consumption}, payment ${accounts.payment}`);

    return {
        success: true,
        section: await withBalances(await getSection(id, true)),
        apiKey: key,
        note: "the API key is shown only now: store it for the section's applications",
        txHash: written.txHash
    };
}));

app.post("/admin/sections/:id/name", adminGuard, adminRoute(async (req) => {
    const section = await getSection(req.params.id, true);
    const name = sectionName(req.body.name);

    if (name === section.name) {
        return { success: true, id: section.id, name };
    }

    await assertNameFree(name, section.id);
    const written = await registryWrite("setName", [section.id, name]);
    console.log(`section ${section.id}: renamed "${section.name}" -> "${name}"`);
    return { success: true, id: section.id, name, txHash: written.txHash };
}));

// Info field: { key, value }; an empty value removes the field
app.post("/admin/sections/:id/info", adminGuard, adminRoute(async (req) => {
    const section = await getSection(req.params.id, true);
    const [key, value] = infoField(req.body.key, req.body.value);
    const written = await registryWrite("setInfo", [section.id, key, value]);
    return { success: true, id: section.id, key, value, removed: value === "", txHash: written.txHash };
}));

// New API key; the old one stops working at once
app.post("/admin/sections/:id/key", adminGuard, adminRoute(async (req) => {
    const section = await getSection(req.params.id, true);
    const { key, hash } = newSectionKey();
    const written = await registryWrite("setKey", [section.id, hash]);
    console.log(`section ${section.id}: API key rotated`);
    return { success: true, id: section.id, apiKey: key, note: "the API key is shown only now", txHash: written.txHash };
}));

app.post("/admin/sections/:id/active", adminGuard, adminRoute(async (req) => {
    const section = await getSection(req.params.id, true);

    if (typeof req.body.active !== "boolean") {
        throw httpError(400, "active: true or false");
    }

    const written = await registryWrite("setActive", [section.id, req.body.active]);
    return { success: true, id: section.id, active: req.body.active, txHash: written.txHash };
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
async function sectionMove(section, from, to, amountInput, memo, quietIfEmpty = false) {
    let amount = amountInput;

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
        return pay(from, to, amount, true, memo);
    });

    if (!result) {
        return { success: true, id: section.id, operation: memo, from, to, amount: "0", txHash: null };
    }

    console.log(`section ${section.id}: ${memo}: ${amount} ETH ${from} -> ${to} (${result.txHash})`);
    return { success: true, id: section.id, operation: memo, from, to, amount, txHash: result.txHash, nonce: result.nonce };
}

// SENDER01 -> upfront_i
app.post("/admin/sections/:id/topup", adminGuard, adminRoute(async (req) => {
    const section = await getSection(req.params.id, true);
    return sectionMove(section, CONFIG.SENDER01, section.accounts.upfront, adminAmount(req.body.amount, false),
        `section ${section.id} top-up`);
}));

// consumption_i -> payment_i
app.post("/admin/sections/:id/sweep", adminGuard, adminRoute(async (req) => {
    const section = await getSection(req.params.id, true);
    return sectionMove(section, section.accounts.consumption, section.accounts.payment, adminAmount(req.body.amount, true),
        `section ${section.id} sweep`);
}));

// payment_i -> SENDER01
app.post("/admin/sections/:id/payback", adminGuard, adminRoute(async (req) => {
    const section = await getSection(req.params.id, true);
    return sectionMove(section, section.accounts.payment, CONFIG.SENDER01, adminAmount(req.body.amount, true),
        `section ${section.id} pay back`);
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
    const written = await registryWrite("replaceAccount", [section.id, SECTION_ROLES[role].kind, account]);
    accountSectionCache.clear();
    console.log(`section ${section.id}: ${role} account ${previous} -> ${account}`);
    let moved;

    try {
        moved = await sectionMove(section, previous, account, "all", `section ${section.id} ${role} account replaced`, true);
    } catch (error) {
        moved = { error: `the previous account's balance was not moved (${error.message}); move it with this request again` };
    }

    return { success: true, id: section.id, role, previous, account, txHash: written.txHash, balanceMoved: moved };
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
        returned[role] = await sectionMove(section, section.accounts[role], CONFIG.SENDER01, "all",
            `section ${section.id} archived: ${role} returned`, true);
    }

    const written = await registryWrite("archive", [section.id]);
    console.log(`section ${section.id} "${section.name}" archived`);
    return { success: true, id: section.id, archived: true, returned, txHash: written.txHash };
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
            const written = await registryWrite("createSection", [s.name, s.upfront, s.consumption, s.payment, s.keyHash]);
            const created = written.receipt.logs
                .map((log) => { try { return registryIface.parseLog(log); } catch { return null; } })
                .find((log) => log && log.name === "SectionCreated");
            newId = Number(created.args.id);

            if (!s.active) {
                await registryWrite("setActive", [newId, false]);
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
            await registryWrite("addAccounts", [newId, missing.slice(i, i + 100)]);
        }

        done.push({ id, newId, name: s.name, active: s.active, users: users.length, added: missing.length, resumed: Boolean(earlier) });
        console.log(`registry migration: section ${id} "${s.name}" -> ${newId}, ${users.length} user account(s)`);
    }

    accountSectionCache.clear();
    return { success: true, from: ethers.getAddress(from), to: ethers.getAddress(CONFIG.REGISTRY_CONTRACT), sections: done };
}));

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

    if (ethers.getAddress(address) === ethers.getAddress(CONFIG.REGISTRY_ADMIN)) {
        throw httpError(403, "the registry admin account can't be used here");
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
    const registered = await registryWrite("addAccount", [section.id, address]);
    accountSectionCache.set(address.toLowerCase(), { id: section.id, kind: ACCOUNT_USER });
    const payment = await withSenderLock(funder, async () => {
        await assertCanPay(funder, amount);
        return pay(funder, address, amount, true);
    });

    return {
        success: true,
        section: { id: section.id, name: section.name },
        address,
        from: funder,
        amount,
        pool,
        txHash: payment.txHash,
        nonce: payment.nonce,
        registryTxHash: registered.txHash
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

    if (memo !== undefined && typeof memo !== "string") {
        throw httpError(400, "invalid memo");
    }

    const memoText = memo === undefined ? "" : memo;

    if (memoBytes(memoText).length > MEMO_LIMIT) {
        throw httpError(400, "memo is too long");
    }

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
    const { txHash, nonce } = await withSenderLock(sender, () => pay(sender, recipient, value, true, memoText));

    return {
        success: true,
        section: { id: section.id, name: section.name },
        direction: negative ? "upfront -> account" : "account -> consumption",
        txHash,
        from: sender,
        to: recipient,
        amount: value,
        memo: memoText,
        nonce
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
