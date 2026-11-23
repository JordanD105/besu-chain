// Optimistic section gateway (docs/components/gateway.md).
//
// One gateway per section, next to its application. It speaks the proxy's application API with the
// section's key. While the proxy answers (online) it passes every request through and keeps a local
// ledger (balances, the section's accounts, the avatar and nickname items) up to date. When the proxy
// cannot be reached (offline) it answers by itself from that ledger and queues the writes; when the
// link is back (draining) it sends the queue in order, then checks the ledger against the chain.
//   - only this gateway moves the section's money, so a queued payment never lacks balance;
//   - /createaccount offline hands out a spare account created beforehand;
//   - a queued request that the chain refuses later (an item bought by another section first, an undo
//     period over, …) is undone in the ledger, written to the report and sent to the correction webhook.
// No npm packages: node:http, node:sqlite, fetch.
"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const MEMO = require("./memo/memo.js");

// ---------------------------------------------------------------- configuration

const CONFIG_FILE = process.env.GATEWAY_CONFIG || "/config/gateway.json";
const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
const KEY = fs.readFileSync(process.env.GATEWAY_KEY_FILE || "/config/section.key", "utf8").trim();
const L = Object.assign({
    health_check_seconds: 3, health_timeout_ms: 2000, recheck_ms: 500, offline_after_failures: 3, connect_timeout_ms: 2000,
    offline_max_hours: 24,
    // what is answered while offline: transfer, createaccount, account_pool, "<avatar|nickname|*>:<function>" for the
    // platform's items, "<0xContract>:<function>" for another contract (queued, answered without a result)
    offline_operations: ["transfer", "transfer_undo", "createaccount", "account_pool", "avatar:buy", "nickname:buy", "nickname:upgradeLevel", "*:undo", "nickname:undoLevel"],
    spare_accounts: 100, spare_alert_below: 20, answer_gateway_field: false, memo_default_lang: "en", transfer_undo_days: 7, correction_webhook: "", report_keep_days: 365,
    sync_seconds: 30, backup_keep_days: 7
}, cfg.limits || {});
const REPORT_TOKEN = (() => {
    try {
        return fs.readFileSync(process.env.GATEWAY_REPORT_TOKEN_FILE || "/config/report.token", "utf8").trim();
    } catch (error) {
        return "";
    }
})();
const REGISTRY = cfg.registry || {};    // { address, fromBlock }: the section's new accounts (AccountAdded)
const ACCOUNT_ADDED = "0xcdf90f998fb308726a3c0cc206e7170e5ad701ef1666da2ea6642ec5bddade79";  // AccountAdded(uint256,address)
const SECTION = cfg.section;            // { id, name, upfront, consumption, payment, users: [...] }
const PROXY = String(cfg.proxy).replace(/\/$/, "");
const RPC = String(cfg.rpc);
const PORT = Number(cfg.listen || 30010);
const DB_FILE = process.env.GATEWAY_DB || "/data/gateway.db";

if (!KEY || !SECTION || !SECTION.id) {
    throw new Error("gateway: the section key and section (id, accounts) are required");
}

// ---------------------------------------------------------------- storage

const db = new DatabaseSync(DB_FILE);
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS accounts (address TEXT PRIMARY KEY, display TEXT, role TEXT, chain_wei TEXT, local_wei TEXT);
CREATE TABLE IF NOT EXISTS collections (address TEXT PRIMARY KEY, display TEXT, type TEXT, name TEXT, symbol TEXT, minter TEXT,
    hold INTEGER, last_block INTEGER, levels TEXT);
CREATE TABLE IF NOT EXISTS items (contract TEXT, token_id INTEGER, label TEXT, label_key TEXT, price TEXT, owner TEXT, level INTEGER,
    payments TEXT, uri TEXT, PRIMARY KEY (contract, token_id));
CREATE INDEX IF NOT EXISTS items_label ON items (contract, label_key);
CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT UNIQUE, cut INTEGER, created INTEGER, kind TEXT,
    signer TEXT, path TEXT, body TEXT, token TEXT, deltas TEXT, spend_account TEXT, spend_wei TEXT, status TEXT, temp_hash TEXT,
    real_hash TEXT, result TEXT, error TEXT, nonce_before INTEGER, attempts INTEGER DEFAULT 0, answer TEXT);
CREATE INDEX IF NOT EXISTS outbox_status ON outbox (status, id);
CREATE TABLE IF NOT EXISTS spares (address TEXT PRIMARY KEY, display TEXT, created INTEGER, used INTEGER);
CREATE TABLE IF NOT EXISTS cache (k TEXT PRIMARY KEY, body TEXT, at INTEGER);
CREATE TABLE IF NOT EXISTS undone (hash TEXT PRIMARY KEY, uid TEXT, at INTEGER);
CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, uid TEXT, kind TEXT, detail TEXT, delivered INTEGER DEFAULT 0);
`);
// added later: correction kind, ETH refunded, acknowledgement (chainlens)
for (const col of ["correction TEXT", "refund_wei TEXT", "acked_at INTEGER", "acked_by TEXT"]) {
    try {
        db.exec(`ALTER TABLE reports ADD COLUMN ${col}`);
    } catch (error) {
        // already there
    }
}

const q = (sql) => db.prepare(sql);
const getMeta = (k, d) => { const r = q("SELECT v FROM meta WHERE k = ?").get(k); return r ? r.v : d; };
const setMeta = (k, v) => q("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, String(v));

// ---------------------------------------------------------------- small helpers

const lower = (a) => String(a || "").toLowerCase();
const isAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ""));
const now = () => Date.now();
const iso = (ms) => new Date(ms).toISOString();

function ethToWei(text) {
    const s = String(text).trim();
    const neg = s.startsWith("-");
    const m = (neg ? s.slice(1) : s).match(/^(\d+)(?:\.(\d{0,18}))?$/);
    if (!m) {
        throw httpError(400, `amount: ETH, e.g. "1.5" (got ${text})`);
    }
    const wei = BigInt(m[1]) * 10n ** 18n + BigInt((m[2] || "").padEnd(18, "0") || "0");
    return neg ? -wei : wei;
}

function weiToEth(wei) {
    const w = BigInt(wei);
    const neg = w < 0n;
    const a = neg ? -w : w;
    const whole = a / 10n ** 18n;
    const frac = (a % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
    return (neg ? "-" : "") + whole.toString() + (frac ? "." + frac : "");
}

function httpError(status, message) {
    const e = new Error(message);
    e.status = status;
    return e;
}

function tempHash(uid) {
    return "0x" + crypto.createHash("sha256").update("gateway:" + uid).digest("hex");
}

// A call to the proxy: the connection must open within connect_timeout_ms (else the link is down), the
// answer may take up to timeoutMs (a write waits for its block). track: abortable when the gateway goes
// offline (the requests waiting on the proxy are then answered from the ledger).
const inflight = new Set();

function proxy(method, path, body, timeoutMs = 120000, track = false, connectMs = L.connect_timeout_ms, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(PROXY + path);
        const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
        let settled = false;
        let connectTimer = null;
        const entry = {};
        const finish = () => {
            settled = true;
            clearTimeout(connectTimer);
            clearTimeout(answerTimer);
            inflight.delete(entry);
        };
        const fail = (error) => {
            if (!settled) {
                finish();
                reject(error);
            }
        };
        const req = http.request({
            hostname: url.hostname, port: url.port || 80, path: url.pathname + url.search, method, agent: false,
            headers: Object.assign({ "x-section-key": KEY }, extraHeaders, payload ? { "content-type": "application/json", "content-length": payload.length } : {})
        }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
                if (settled) {
                    return;
                }
                finish();
                let data;
                try {
                    data = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
                } catch (error) {
                    data = { error: "the proxy answered HTTP " + res.statusCode };
                }
                resolve({ status: res.statusCode, data });
            });
            res.on("error", fail);
        });
        entry.abort = (reason) => req.destroy(Object.assign(new Error(reason), { aborted: true }));
        connectTimer = setTimeout(() => req.destroy(Object.assign(new Error(`no connection to the proxy within ${connectMs} ms`), { notSent: true })), connectMs);
        req.on("socket", (socket) => {
            if (socket.connecting) {
                socket.once("connect", () => clearTimeout(connectTimer));
            } else {
                clearTimeout(connectTimer);
            }
        });
        const answerTimer = setTimeout(() => req.destroy(new Error(`the proxy did not answer within ${timeoutMs} ms`)), timeoutMs);
        req.on("error", (error) => {
            if (!error.notSent && /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND/.test(error.code || error.message)) {
                error.notSent = true;  // refused: the request never reached the proxy
            }
            fail(error);
        });
        if (track) {
            inflight.add(entry);
        }
        if (payload) {
            req.write(payload);
        }
        req.end();
    });
}

async function rpc(method, params, timeoutMs = 8000) {
    const res = await fetch(RPC, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs)
    });
    const d = await res.json();
    if (d.error) {
        throw new Error(d.error.message);
    }
    return d.result;
}

async function rpcBatch(calls, timeoutMs = 15000) {
    if (!calls.length) {
        return [];
    }
    const res = await fetch(RPC, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(calls.map(([method, params], i) => ({ jsonrpc: "2.0", id: i, method, params }))), signal: AbortSignal.timeout(timeoutMs)
    });
    const list = await res.json();
    const out = [];
    for (const r of list) {
        out[r.id] = r.error ? null : r.result;
    }
    return out;
}

async function callsOk(calls) {
    const out = [];
    for (let i = 0; i < calls.length; i += 50) {
        const r = await proxy("POST", "/contract/call", { calls: calls.slice(i, i + 50) });
        if (r.status !== 200) {
            throw new Error(r.data.error || "contract/call " + r.status);
        }
        out.push(...r.data.results.map((x) => (x.success ? x.result : null)));
    }
    return out;
}

// ---------------------------------------------------------------- ledger: accounts

function account(addr) {
    return q("SELECT * FROM accounts WHERE address = ?").get(lower(addr));
}

function upsertAccount(display, role, chainWei) {
    const a = account(display);
    if (a) {
        q("UPDATE accounts SET role = COALESCE(?, role), display = ? WHERE address = ?").run(role || null, display, lower(display));
        return;
    }
    const w = String(chainWei === undefined ? 0n : chainWei);
    q("INSERT INTO accounts (address, display, role, chain_wei, local_wei) VALUES (?, ?, ?, ?, ?)").run(lower(display), display, role || "user", w, w);
}

function localWei(addr) {
    const a = account(addr);
    return a ? BigInt(a.local_wei) : 0n;
}

function applyDeltas(deltas, sign = 1n) {
    for (const [addr, wei] of deltas) {
        const a = account(addr);
        if (a) {
            q("UPDATE accounts SET local_wei = ? WHERE address = ?").run(String(BigInt(a.local_wei) + sign * BigInt(wei)), lower(addr));
        }
    }
}

for (const [role, addr] of [["upfront", SECTION.upfront], ["consumption", SECTION.consumption], ["payment", SECTION.payment]]) {
    if (isAddress(addr)) {
        upsertAccount(addr, role);
    }
}
for (const u of SECTION.users || []) {
    if (isAddress(u)) {
        upsertAccount(u, "user");
    }
}

// ---------------------------------------------------------------- state: online / offline / draining

const state = { mode: getMeta("mode", "online"), failures: 0, lastOk: 0, lastSync: Number(getMeta("lastSync", 0)), syncing: false,
    draining: false, conflicts: Number(getMeta("conflicts", 0)), authFailures: Number(getMeta("authFailures", 0)) };

function setMode(mode) {
    if (state.mode === mode) {
        return;
    }
    console.log(`gateway: ${state.mode} -> ${mode}`);
    if (mode === "offline" && state.mode === "online") {
        setMeta("offlineSince", now());
        setMeta("cut", Number(getMeta("cut", 0)) + 1);
    }
    if (mode === "online") {
        setMeta("offlineSeconds", Number(getMeta("offlineSeconds", 0)) + Math.round((now() - Number(getMeta("offlineSince", now()))) / 1000));
    }
    state.mode = mode;
    setMeta("mode", mode);
    if (mode === "offline") {
        // the requests still waiting on the proxy are answered from the ledger now
        for (const entry of [...inflight]) {
            entry.abort("the gateway went offline");
        }
    } else if (mode === "draining") {
        setTimeout(() => drain().catch((e) => console.error("gateway: drain:", e.message)), 0);
    }
}

const queued = () => q("SELECT COUNT(*) AS n FROM outbox WHERE status IN ('queued', 'sending', 'uncertain')").get().n;

// a failed contact with the proxy (a health check, or a request's network error)
function proxyFailed() {
    state.failures += 1;
    if (state.failures >= L.offline_after_failures && state.mode !== "offline") {
        setMode("offline");
    }
}

async function healthCheck() {
    try {
        const r = await proxy("GET", "/contract/list?type=none", undefined, L.health_timeout_ms, false, L.health_timeout_ms);
        if (r.status !== 200) {
            throw new Error("HTTP " + r.status);
        }
        state.failures = 0;
        state.lastOk = now();
        if (state.mode === "offline") {
            setMode(queued() ? "draining" : "online");
        }
    } catch (error) {
        proxyFailed();
    }
}

// its own timer: never delayed by the sync, the spare accounts or the queue. After a failure (and not yet
// offline) the next check comes after recheck_ms instead of health_check_seconds.
let healthBusy = false;
async function healthLoop() {
    if (!healthBusy) {
        healthBusy = true;
        try {
            await healthCheck();
        } finally {
            healthBusy = false;
        }
    }
    setTimeout(healthLoop, state.failures > 0 && state.mode !== "offline" ? L.recheck_ms : L.health_check_seconds * 1000);
}

// ---------------------------------------------------------------- items: avatar and nickname cache

function collection(addr) {
    return q("SELECT * FROM collections WHERE address = ?").get(lower(addr));
}

function item(contract, tokenId) {
    const r = q("SELECT * FROM items WHERE contract = ? AND token_id = ?").get(lower(contract), Number(tokenId));
    return r ? Object.assign(r, { payments: JSON.parse(r.payments || "[]") }) : null;
}

function saveItem(it) {
    q(`INSERT INTO items (contract, token_id, label, label_key, price, owner, level, payments, uri) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(contract, token_id) DO UPDATE SET label = excluded.label, label_key = excluded.label_key, price = excluded.price,
       owner = excluded.owner, level = excluded.level, payments = excluded.payments, uri = excluded.uri`)
        .run(lower(it.contract), Number(it.token_id), it.label, it.label_key, it.price, it.owner, it.level || 0, JSON.stringify(it.payments || []), it.uri || "");
}

const labelKey = (type, text) => (type === "nickname" ? String(text).normalize("NFC").trim().replace(/[A-Z]/g, (c) => c.toLowerCase()) : String(text));

async function refreshItems(c, ids) {
    const per = c.type === "nickname" ? 5 : 5;
    const calls = ids.flatMap((tokenId) => {
        const args = { tokenId: String(tokenId) };
        return [
            { contract: c.display, function: "ownerOf", args }, { contract: c.display, function: "priceOf", args },
            { contract: c.display, function: c.type === "nickname" ? "nicknameOf" : "imageOf", args },
            { contract: c.display, function: "paymentsOf", args },
            c.type === "nickname" ? { contract: c.display, function: "levelOf", args } : { contract: c.display, function: "tokenURI", args }
        ];
    });
    const out = await callsOk(calls);
    ids.forEach((tokenId, i) => {
        const [owner, price, label, payments, extra] = out.slice(i * per, i * per + per);
        if (!owner) {
            return;
        }
        const text = label ? (label.nickname !== undefined ? label.nickname : label.image) : "";
        saveItem({
            contract: c.address, token_id: tokenId, label: text, label_key: labelKey(c.type, text), price: price ? price.price : "0",
            owner: owner.owner, level: c.type === "nickname" && extra ? extra.level : 0, payments: payments || [],
            uri: c.type === "avatar" && extra && extra.metadata ? JSON.stringify(extra.metadata) : ""
        });
    });
}

async function syncCollections() {
    const head = parseInt(await rpc("eth_blockNumber", []), 16);
    for (const type of ["avatar", "nickname"]) {
        const r = await proxy("GET", "/contract/list?type=" + type);
        if (r.status !== 200) {
            continue;
        }
        for (const c of r.data.contracts) {
            let row = collection(c.address);
            const reads = await callsOk([{ contract: c.address, function: "holdSeconds" }, { contract: c.address, function: "totalSupply" }]
                .concat(type === "nickname" ? [{ contract: c.address, function: "levelCount" }] : []));
            const hold = Number(reads[0] || 0);
            const supply = Number(reads[1] || 0);
            const levels = type === "nickname" && reads[2] ? JSON.stringify(reads[2].levels) : "[]";
            if (!row) {
                q("INSERT INTO collections (address, display, type, name, symbol, minter, hold, last_block, levels) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
                    .run(lower(c.address), c.address, type, c.name, c.symbol || "", c.minter || "", hold, -1, levels);
                row = collection(c.address);
            } else {
                q("UPDATE collections SET hold = ?, levels = ?, name = ?, minter = ? WHERE address = ?").run(hold, levels, c.name, c.minter || row.minter, lower(c.address));
            }
            let ids = [];
            if (row.last_block < 0) {
                for (let t = 1; t <= supply; t++) {
                    ids.push(t);
                }
            } else {
                const changed = new Set();
                for (const ev of ["Transfer", "PriceSet", "Minted"].concat(type === "nickname" ? ["LevelUpgraded", "LevelUndone"] : [])) {
                    const e = await proxy("POST", "/contract/events", { contract: c.address, event: ev, fromBlock: row.last_block + 1, toBlock: head, limit: 1000 });
                    if (e.status === 200) {
                        e.data.events.forEach((x) => changed.add(Number(x.args.tokenId)));
                    }
                }
                ids = [...changed];
                const known = q("SELECT COUNT(*) AS n FROM items WHERE contract = ?").get(lower(c.address)).n;
                for (let t = known + 1; t <= supply; t++) {
                    if (!ids.includes(t)) {
                        ids.push(t);
                    }
                }
            }
            for (let i = 0; i < ids.length; i += 40) {
                await refreshItems(row, ids.slice(i, i + 40));
            }
            q("UPDATE collections SET last_block = ? WHERE address = ?").run(head, lower(c.address));
        }
    }
}

async function syncBalances() {
    const list = q("SELECT address, display FROM accounts").all();
    for (let i = 0; i < list.length; i += 500) {
        const part = list.slice(i, i + 500);
        const out = await rpcBatch(part.map((a) => ["eth_getBalance", [a.display, "latest"]]));
        part.forEach((a, j) => {
            if (out[j] !== null && out[j] !== undefined) {
                const w = BigInt(out[j]).toString();
                if (queued()) {
                    q("UPDATE accounts SET chain_wei = ? WHERE address = ?").run(w, a.address);
                } else {
                    q("UPDATE accounts SET chain_wei = ?, local_wei = ? WHERE address = ?").run(w, w, a.address);
                }
            }
        });
    }
}

// accounts of the section made outside the gateway (at the proxy, chainlens): AccountAdded(section id, account)
async function learnAccounts() {
    if (!isAddress(REGISTRY.address)) {
        return;
    }
    const latest = Number(await rpc("eth_blockNumber", []));
    let from = Number(getMeta("accountsBlock", REGISTRY.fromBlock || 0));
    const topic = "0x" + BigInt(SECTION.id).toString(16).padStart(64, "0");
    while (from <= latest) {
        const to = Math.min(latest, from + 4999);
        const logs = await rpc("eth_getLogs", [{ address: REGISTRY.address, topics: [ACCOUNT_ADDED, topic],
            fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) }], 20000);
        for (const log of logs) {
            const addr = "0x" + log.topics[2].slice(26);
            if (!account(addr)) {
                upsertAccount(addr, "user");
                console.log(`gateway: new section account ${addr} (from the registry)`);
            }
        }
        from = to + 1;
        setMeta("accountsBlock", from);
    }
}

// The full sync (online, nothing queued): balances, items; differences against the ledger are reported
async function sync(reportDiff) {
    if (state.syncing) {
        return;
    }
    state.syncing = true;
    try {
        const before = new Map(q("SELECT address, local_wei FROM accounts").all().map((a) => [a.address, a.local_wei]));
        await learnAccounts();
        await syncBalances();
        await syncCollections();
        if (reportDiff) {
            const diffs = q("SELECT address, display, local_wei FROM accounts").all()
                .filter((a) => before.has(a.address) && before.get(a.address) !== a.local_wei)
                .map((a) => ({ account: a.display, ledger: weiToEth(before.get(a.address)), chain: weiToEth(a.local_wei) }));
            report(null, "reconcile", { differences: diffs });
        }
        state.lastSync = now();
        setMeta("lastSync", state.lastSync);
    } catch (error) {
        console.error("gateway: sync:", error.message);
    } finally {
        state.syncing = false;
    }
}

// ---------------------------------------------------------------- reports and the correction webhook

// the kind of a correction, from the chain's reason
function correctionKind(reason) {
    const r = String(reason || "");
    if (/already sold|not owned/i.test(r)) {
        return "already_sold";
    }
    if (/value: the price is|wrong price/i.test(r)) {
        return "price_changed";
    }
    if (/undo period/i.test(r)) {
        return "undo_period_over";
    }
    if (/level/i.test(r)) {
        return "level";
    }
    if (/insufficient|balance/i.test(r)) {
        return "balance";
    }
    return "other";
}

function report(uid, kind, detail) {
    const refund = kind === "conflict" ? (detail.refund || []).reduce((s, x) => s + ethToWei(x.amount), 0n) : 0n;
    q("INSERT INTO reports (at, uid, kind, detail, correction, refund_wei) VALUES (?, ?, ?, ?, ?, ?)")
        .run(now(), uid, kind, JSON.stringify(detail), kind === "conflict" ? correctionKind(detail.reason) : null, String(refund));
    if (kind === "conflict") {
        state.conflicts += 1;
        setMeta("conflicts", state.conflicts);
    }
    console.log(`gateway: report ${kind} ${uid || ""} ${JSON.stringify(detail).slice(0, 300)}`);
}

async function deliverReports() {
    if (!L.correction_webhook) {
        return;
    }
    for (const r of q("SELECT * FROM reports WHERE delivered = 0 AND kind = 'conflict' ORDER BY id LIMIT 20").all()) {
        try {
            const res = await fetch(L.correction_webhook, {
                method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify({ id: r.uid, section: SECTION.id, at: iso(r.at), ...JSON.parse(r.detail) }), signal: AbortSignal.timeout(5000)
            });
            if (res.ok) {
                q("UPDATE reports SET delivered = 1 WHERE id = ?").run(r.id);
            }
        } catch (error) {
            return;  // try again later
        }
    }
    q("DELETE FROM reports WHERE at < ?").run(now() - L.report_keep_days * 86400000);
}

// ---------------------------------------------------------------- offline limits

// operation: "transfer", "createaccount", "account_pool", "avatar:buy", "nickname:upgradeLevel", "0x…:function"
function operationAllowed(operation) {
    const [kind, fn] = operation.split(":");
    return L.offline_operations.some((entry) => {
        const e = String(entry);
        if (!fn) {
            return e === operation;
        }
        const [k, f] = e.split(":");
        return f !== undefined && lower(f) === lower(fn) && (k === "*" || lower(k) === lower(kind));
    });
}

function offlineAllowed(operation) {
    if (!operationAllowed(operation)) {
        throw httpError(503, `${operation} is not available while the proxy cannot be reached`);
    }
    const since = Number(getMeta("offlineSince", now()));
    if (state.mode === "offline" && now() - since > L.offline_max_hours * 3600000) {
        throw httpError(503, `offline for more than ${L.offline_max_hours} h: no more optimistic answers`);
    }
}

// ---------------------------------------------------------------- the outbox

function enqueue(o) {
    const uid = o.uid || crypto.randomUUID();
    q(`INSERT INTO outbox (uid, cut, created, kind, signer, path, body, token, deltas, spend_account, spend_wei, status, temp_hash, nonce_before, answer)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(uid, Number(getMeta("cut", 0)), now(), o.kind, o.signer || "", o.path, JSON.stringify(o.body),
        o.token || null, JSON.stringify((o.deltas || []).map(([a, w]) => [a, String(w)])), o.spendAccount || "", String(o.spendWei || 0n),
        o.status || "queued", o.tempHash || tempHash(uid), o.nonceBefore === undefined ? null : o.nonceBefore, JSON.stringify(o.answer || null));
    applyDeltas(o.deltas || []);
    return uid;
}

async function nonceOf(addr, tag = "pending") {
    return parseInt(await rpc("eth_getTransactionCount", [addr, tag]), 16);
}

// a transaction of `signer` with `nonce` in the last blocks (a send whose answer was lost)
async function findTx(signer, nonce) {
    const head = parseInt(await rpc("eth_blockNumber", []), 16);
    for (let b = head; b > head - 60 && b >= 0; b--) {
        const block = await rpc("eth_getBlockByNumber", ["0x" + b.toString(16), true]);
        const tx = (block.transactions || []).find((t) => lower(t.from) === lower(signer) && parseInt(t.nonce, 16) === nonce);
        if (tx) {
            return tx.hash;
        }
    }
    return null;
}

// a queued request refused by the chain: undo it in the ledger, cancel the queued ones that depend on
// it (the same item), report it and send the correction
function conflict(row, error) {
    applyDeltas(JSON.parse(row.deltas), -1n);
    q("UPDATE outbox SET status = 'failed', error = ? WHERE id = ?").run(error, row.id);
    const cancelled = [];
    if (row.token) {
        for (const later of q("SELECT * FROM outbox WHERE token = ? AND id > ? AND status IN ('queued', 'uncertain')").all(row.token, row.id)) {
            applyDeltas(JSON.parse(later.deltas), -1n);
            q("UPDATE outbox SET status = 'cancelled', error = ? WHERE id = ?").run("cancelled: request " + row.uid + " failed", later.id);
            cancelled.push(later.uid);
        }
    }
    const answer = JSON.parse(row.answer || "null");
    report(row.uid, "conflict", {
        request: row.uid, txHash: row.temp_hash, operation: row.kind, path: row.path, body: JSON.parse(row.body), promised: answer && answer.result,
        result: "failed", reason: error,
        refund: JSON.parse(row.deltas).filter(([, w]) => BigInt(w) < 0n).map(([a, w]) => ({ account: a, amount: weiToEth(-BigInt(w)) })),
        cancelled
    });
}

async function drainOne() {
    const row = q("SELECT * FROM outbox WHERE status IN ('queued', 'sending', 'uncertain') ORDER BY id LIMIT 1").get();
    if (!row) {
        return false;
    }
    // a send whose answer was lost (or cut off before the answer): did it happen?
    if ((row.status === "uncertain" || row.status === "sending") && row.signer && row.nonce_before !== null) {
        const latest = await nonceOf(row.signer, "latest");
        if (latest > row.nonce_before) {
            const hash = await findTx(row.signer, row.nonce_before);
            q("UPDATE outbox SET status = 'done', real_hash = ?, result = ? WHERE id = ?").run(hash, JSON.stringify({ recovered: true, txHash: hash }), row.id);
            return true;
        }
    }
    const nonce = row.signer ? await nonceOf(row.signer) : null;
    q("UPDATE outbox SET status = 'sending', nonce_before = ?, attempts = attempts + 1 WHERE id = ?").run(nonce, row.id);
    let r;
    try {
        r = await proxy("POST", row.path, JSON.parse(row.body));
    } catch (error) {
        q("UPDATE outbox SET status = 'uncertain' WHERE id = ?").run(row.id);
        throw error;  // the link dropped again: the health check decides the mode
    }
    if (r.status === 200 && r.data.success !== false) {
        q("UPDATE outbox SET status = 'done', real_hash = ?, result = ? WHERE id = ?").run(r.data.txHash || null, JSON.stringify(r.data), row.id);
        return true;
    }
    if (r.status >= 500) {
        q("UPDATE outbox SET status = 'uncertain' WHERE id = ?").run(row.id);
        throw new Error(r.data.error || "proxy " + r.status);
    }
    conflict(row, r.data.error || "HTTP " + r.status);
    return true;
}

async function drain() {
    if (state.draining || state.mode === "offline") {
        return;
    }
    state.draining = true;
    try {
        let sent = 0;
        while (state.mode !== "offline" && await drainOne()) {
            sent += 1;
        }
        if (state.mode === "draining" && !queued()) {
            await sync(true);
            setMode("online");
        } else if (sent && !queued()) {
            await sync(false);
        }
    } catch (error) {
        console.error("gateway: drain:", error.message);
    } finally {
        state.draining = false;
    }
}

// ---------------------------------------------------------------- spare accounts (for /createaccount offline)

async function keepSpares() {
    if (state.mode !== "online" || queued()) {
        return;
    }
    const n = q("SELECT COUNT(*) AS n FROM spares WHERE used IS NULL").get().n;
    if (n >= L.spare_accounts) {
        return;
    }
    const r = await proxy("POST", "/createaccount", { amount: "0", pool: "none" }, 180000, true);
    if (r.status === 200 && isAddress(r.data.address)) {
        q("INSERT INTO spares (address, display, created) VALUES (?, ?, ?)").run(lower(r.data.address), r.data.address, now());
        console.log(`gateway: spare account ${r.data.address} (${n + 1}/${L.spare_accounts})`);
    } else {
        console.error("gateway: spare account:", r.data.error);
    }
}

// ---------------------------------------------------------------- answering while offline

function section() {
    return { id: SECTION.id, name: SECTION.name };
}

function gw(uid) {
    return { mode: state.mode, queued: true, request: uid };
}

function needUser(addr) {
    const a = account(addr);
    if (!isAddress(addr) || !a || a.role !== "user") {
        throw httpError(403, `${addr} is not a user account of section "${SECTION.name}" known to the gateway`);
    }
    return a;
}

function needFunds(addr, wei) {
    const have = localWei(addr);
    if (have < wei) {
        throw httpError(400, `insufficient balance: ${weiToEth(wei)} ETH is needed, ${account(addr).display} has ${weiToEth(have)} ETH`);
    }
}

// The memo fields of an offline answer: the same record the proxy will write when the request is
// sent (docs/features/memos.md), in the language of the request
let answerLang = "en";
function offlineMemo(t, p, body, uid) {
    const rec = MEMO.record({ t, s: [SECTION.id, SECTION.name], p, u: MEMO.userMemo(body && body.memo), r: String(uid).replace(/-/g, "").slice(0, 8) });
    return MEMO.answer(rec, answerLang);
}

function offlineTransfer(body, uid) {
    const amount = ethToWei(body.amount);
    const user = needUser(body.account);
    if (amount === 0n) {
        throw httpError(400, "amount: not 0");
    }
    const plus = amount > 0n;
    const from = plus ? user.display : SECTION.upfront;
    const to = plus ? SECTION.consumption : user.display;
    const x = plus ? amount : -amount;
    offlineAllowed("transfer");
    needFunds(from, x);
    const answer = { success: true, section: section(), direction: plus ? "account -> consumption" : "upfront -> account", from, to,
        amount: weiToEth(x), txHash: tempHash(uid), ...offlineMemo(plus ? "transfer.in" : "transfer.out", { amount: weiToEth(x) }, body, uid) };
    enqueue({ uid, kind: "transfer", signer: from, path: "/transfer", body, deltas: [[from, -x], [to, x]], spendAccount: from, spendWei: x, answer: { result: answer } });
    return Object.assign(answer, { gateway: gw(uid) });
}

// Undo of a +x / -x made through this gateway (docs/features/transfer-undo.md). Still queued: the
// transfer is cancelled (nothing goes on chain). Already sent: the undo is queued (the proxy sends it
// through the TransferUndo contract, which refuses a second undo).
function offlineTransferUndo(body, uid) {
    offlineAllowed("transfer_undo");
    const hash = lower(body && body.txHash);
    const row = /^0x[0-9a-f]{64}$/.test(hash) ? q("SELECT * FROM outbox WHERE (temp_hash = ? OR real_hash = ?) AND kind = 'transfer'").get(hash, hash) : null;
    if (!row) {
        throw httpError(503, "only transfers made through this gateway can be undone while the proxy cannot be reached");
    }
    if (q("SELECT 1 FROM undone WHERE hash IN (?, ?)").get(row.temp_hash, row.real_hash || "")) {
        throw httpError(409, "already undone");
    }
    if (now() - row.created > L.transfer_undo_days * 86400000) {
        throw httpError(409, `too late: a transfer can be undone for ${L.transfer_undo_days} days`);
    }
    if (row.status === "failed" || row.status === "cancelled") {
        throw httpError(409, "that transfer did not happen: nothing to undo");
    }
    if (row.status === "sending" || row.status === "uncertain") {
        throw httpError(409, "that transfer is being sent: try again in a moment");
    }
    const deltas = JSON.parse(row.deltas);               // [[from, -x], [to, x]]
    const x = -BigInt(deltas[0][1]);
    const plus = JSON.parse(row.body).amount && !String(JSON.parse(row.body).amount).trim().startsWith("-");
    const payer = deltas[1][0];
    const recipient = deltas[0][0];
    const answer = { success: true, section: section(), undoOf: body.txHash, direction: plus ? "consumption -> account" : "account -> upfront",
        from: payer, to: recipient, amount: weiToEth(x), txHash: tempHash(uid),
        ...offlineMemo(plus ? "transfer.undoIn" : "transfer.undoOut", { amount: weiToEth(x), undoOf: lower(body.txHash) }, body, uid) };
    if (row.status === "queued") {
        applyDeltas(deltas, -1n);
        q("UPDATE outbox SET status = 'cancelled', error = ? WHERE id = ?").run("undone before it was sent (request " + uid + ")", row.id);
        q(`INSERT INTO outbox (uid, cut, created, kind, path, body, status, temp_hash, answer) VALUES (?, ?, ?, 'transfer_undo', '/transfer/undo', ?, 'void', ?, ?)`)
            .run(uid, Number(getMeta("cut", 0)), now(), JSON.stringify(body), tempHash(uid), JSON.stringify({ result: answer }));
    } else {
        needFunds(payer, x);
        enqueue({ uid, kind: "transfer_undo", signer: payer, path: "/transfer/undo", body: Object.assign({}, body, { txHash: row.real_hash }),
            deltas: [[payer, -x], [recipient, x]], spendAccount: payer, spendWei: x, answer: { result: answer } });
    }
    q("INSERT INTO undone (hash, uid, at) VALUES (?, ?, ?)").run(row.temp_hash, uid, now());
    if (row.real_hash) {
        q("INSERT OR IGNORE INTO undone (hash, uid, at) VALUES (?, ?, ?)").run(row.real_hash, uid, now());
    }
    return Object.assign(answer, { gateway: gw(uid) });
}

function offlineCreateAccount(body, uid) {
    const amount = ethToWei(body.amount === undefined ? "0" : body.amount);
    offlineAllowed("createaccount");
    needFunds(SECTION.upfront, amount);
    const spare = q("SELECT * FROM spares WHERE used IS NULL ORDER BY created LIMIT 1").get();
    if (!spare) {
        throw httpError(503, "no spare account left: new accounts need the proxy (all 3 MPC nodes)");
    }
    q("UPDATE spares SET used = ? WHERE address = ?").run(now(), spare.address);
    upsertAccount(spare.display, "user", 0n);
    const answer = { success: true, section: section(), address: spare.display, from: SECTION.upfront, amount: weiToEth(amount),
        pool: body.pool || "small", txHash: amount > 0n ? tempHash(uid) : null, registryTxHash: null,
        ...offlineMemo("account.fund", { account: spare.display, amount: weiToEth(amount) }, body, uid) };
    if (amount > 0n) {
        enqueue({ uid, kind: "createaccount", signer: SECTION.upfront, path: "/transfer", body: { account: spare.display, amount: "-" + weiToEth(amount), memo: body.memo || undefined },
            deltas: [[SECTION.upfront, -amount], [spare.display, amount]], spendAccount: SECTION.upfront, spendWei: amount, answer: { result: answer } });
    }
    enqueue({ uid: uid + ":pool", kind: "account_pool", path: "/account/pool", body: { address: spare.display, pool: body.pool || "small" } });
    return Object.assign(answer, { gateway: gw(uid) });
}

// the token a buy names: { tokenId } or { imageUrl } / { nickname }, or [tokenId]
function tokenOfArgs(c, args) {
    const a = Array.isArray(args) ? { tokenId: args[0] } : (args || {});
    if (a.tokenId !== undefined) {
        return Number(a.tokenId);
    }
    const key = c.type === "nickname" ? (a.nickname !== undefined ? labelKey("nickname", a.nickname) : null) : (a.imageUrl !== undefined ? String(a.imageUrl) : null);
    const r = key === null ? null : q("SELECT token_id FROM items WHERE contract = ? AND label_key = ?").get(c.address, key);
    if (!r) {
        throw httpError(404, key === null ? "tokenId: a token id (1, 2, …)" : `${c.type === "nickname" ? "nickname" : "image"} ${key} is not minted`);
    }
    return r.token_id;
}

function needItem(c, tokenId) {
    const it = item(c.address, tokenId);
    if (!it) {
        throw httpError(404, `token ${tokenId} is not minted`);
    }
    return it;
}

const holdMs = (c) => Number(c.hold) * 1000;
const currentPayments = (it) => {
    let sale = -1;
    it.payments.forEach((p, i) => { if (p.kind === "sale") { sale = i; } });
    return sale >= 0 && !it.payments[sale].undone ? it.payments.slice(sale).filter((p) => !p.undone) : [];
};
const open = (p) => !p.undone && now() <= Date.parse(p.undoUntil);
const summary = (c, it) => (c.type === "nickname"
    ? { tokenId: String(it.token_id), nickname: it.label, level: it.level, price: it.price }
    : { tokenId: String(it.token_id), image: it.label, price: it.price });

function offlineContractSend(body, uid) {
    const c = collection(body.contract || "");
    const fn = String(body.function || "").split("(")[0];
    if (!c) {
        offlineAllowed(`${lower(body.contract)}:${fn}`);
        enqueue({ uid, kind: "contract_send", signer: body.from, path: "/contract/send", body });
        return { success: true, section: section(), contract: body.contract, function: body.function, from: body.from, txHash: tempHash(uid),
            result: null, events: [], gateway: gw(uid), ...offlineMemo("contract.call", { function: fn, contract: body.contract }, body, uid) };
    }
    const base = (from, valueWei, result) => ({ success: true, section: section(), contract: c.display, function: fn, from, value: weiToEth(valueWei),
        txHash: tempHash(uid), blockNumber: null, gasUsed: null, result, events: [], gateway: gw(uid),
        ...offlineMemo(MEMO.CATALOGUE.types[`${c.type}.${fn}`] ? `${c.type}.${fn}` : "contract.call",
            Object.assign({ tokenId: result && result.tokenId, nickname: result && result.nickname, level: result && result.level },
                valueWei > 0n ? { amount: weiToEth(valueWei) } : {}), body, uid) });
    const tokenKey = (id) => c.address + ":" + id;

    if (fn === "buy") {
        const user = needUser(body.from);
        const tokenId = tokenOfArgs(c, body.args);
        const it = needItem(c, tokenId);
        if (lower(it.owner) !== lower(c.minter)) {
            throw httpError(409, `token ${tokenId} is already sold`);
        }
        const price = ethToWei(it.price);
        offlineAllowed(`${c.type}:buy`);
        needFunds(user.display, price);
        const paidAt = now();
        it.owner = user.display;
        it.payments.push({ kind: "sale", amount: it.price, payer: user.display, paidTo: SECTION.consumption, paidAt: iso(paidAt),
            undoUntil: iso(paidAt + holdMs(c)), undone: false, undoable: true, current: true, pending: true });
        saveItem(it);
        const result = Object.assign(summary(c, it), { buyer: user.display, paid: it.price, paidTo: SECTION.consumption, undoUntil: iso(paidAt + holdMs(c)) });
        enqueue({ uid, kind: c.type + "_buy", signer: user.display, path: "/contract/send", body: { contract: c.display, function: "buy", args: { tokenId: String(tokenId) }, from: user.display, value: it.price },
            token: tokenKey(tokenId), deltas: [[user.display, -price], [SECTION.consumption, price]], spendAccount: user.display, spendWei: price, answer: { result } });
        return base(user.display, price, result);
    }

    if (fn === "upgradeLevel" && c.type === "nickname") {
        const user = needUser(body.from);
        const a = Array.isArray(body.args) ? { tokenId: body.args[0], level: body.args[1] } : (body.args || {});
        const it = needItem(c, Number(a.tokenId));
        if (lower(it.owner) !== lower(user.display)) {
            throw httpError(403, `token ${a.tokenId} is not owned by ${user.display}`);
        }
        const levels = JSON.parse(c.levels || "[]");
        const to = Number(a.level);
        if (!Number.isInteger(to) || to <= it.level) {
            throw httpError(400, `level ${a.level}: the level can only go up`);
        }
        if (!levels[to]) {
            throw httpError(400, `level ${a.level}: no such level`);
        }
        let price = 0n;
        for (let l = it.level + 1; l <= to; l++) {
            if (!levels[l].forSale) {
                throw httpError(400, `level ${a.level}: level not for sale`);
            }
            price += ethToWei(levels[l].price);
        }
        offlineAllowed("nickname:upgradeLevel");
        needFunds(user.display, price);
        const paidAt = now();
        it.payments.push({ kind: "level", fromLevel: it.level, toLevel: to, amount: weiToEth(price), payer: user.display, paidTo: SECTION.consumption,
            paidAt: iso(paidAt), undoUntil: iso(paidAt + holdMs(c)), undone: false, undoable: true, current: true, pending: true });
        const fromLevel = it.level;
        it.level = to;
        saveItem(it);
        const result = Object.assign(summary(c, it), { fromLevel, paid: weiToEth(price), paidTo: SECTION.consumption, undoUntil: iso(paidAt + holdMs(c)) });
        enqueue({ uid, kind: "level_upgrade", signer: user.display, path: "/contract/send",
            body: { contract: c.display, function: "upgradeLevel", args: { tokenId: String(it.token_id), level: to }, from: user.display, value: weiToEth(price) },
            token: tokenKey(it.token_id), deltas: [[user.display, -price], [SECTION.consumption, price]], spendAccount: user.display, spendWei: price, answer: { result } });
        return base(user.display, price, result);
    }

    if (fn === "undo" || (fn === "undoLevel" && c.type === "nickname")) {
        const a = Array.isArray(body.args) ? { tokenId: body.args[0] } : (body.args || {});
        const it = needItem(c, Number(a.tokenId));
        const current = currentPayments(it);
        if (!current.length) {
            throw httpError(409, `token ${a.tokenId} is not sold`);
        }
        let refund = 0n;
        let target;
        if (fn === "undo") {
            target = current[0];
            if (!open(target)) {
                throw httpError(409, `the undo period of token ${a.tokenId} ended at ${target.undoUntil}`);
            }
            refund = current.reduce((s, p) => s + ethToWei(p.amount), 0n);
        } else {
            const lv = current.filter((p) => p.kind === "level");
            target = lv[lv.length - 1];
            if (!target) {
                throw httpError(409, `token ${a.tokenId} has no level upgrade to undo`);
            }
            if (!open(target)) {
                throw httpError(409, `the undo period of the level ${target.fromLevel} -> ${target.toLevel} upgrade ended at ${target.undoUntil}`);
            }
            refund = ethToWei(target.amount);
        }
        const payer = target.paidTo;
        const buyer = target.payer;
        offlineAllowed(`${c.type}:${fn}`);
        needFunds(payer, refund);
        let result;
        if (fn === "undo") {
            current.forEach((p) => { p.undone = true; p.undoable = false; });
            it.owner = c.minter;
            it.level = 0;
            result = { tokenId: String(it.token_id), undone: "sale", buyer, refunded: weiToEth(refund), by: payer };
        } else {
            target.undone = true;
            target.undoable = false;
            it.level = target.fromLevel;
            result = { tokenId: String(it.token_id), undone: "level", level: target.fromLevel, undoneLevel: target.toLevel, refunded: weiToEth(refund) };
        }
        saveItem(it);
        enqueue({ uid, kind: fn, signer: payer, path: "/contract/send", body: { contract: c.display, function: fn, args: { tokenId: String(it.token_id) }, value: weiToEth(refund) },
            token: tokenKey(it.token_id), deltas: [[payer, -refund], [buyer, refund]], spendAccount: payer, spendWei: refund, answer: { result } });
        return base(payer, refund, result);
    }

    throw httpError(503, `${fn} is not available while the proxy cannot be reached (admin work is done on the main side)`);
}

// ---------------------------------------------------------------- reads while offline (and from the ledger while draining)

function itemRead(call) {
    const c = collection(call.contract || "");
    if (!c) {
        return null;
    }
    const fn = String(call.function || "").split("(")[0];
    const a = Array.isArray(call.args) ? { tokenId: call.args[0], account: call.args[0], owner: call.args[0], level: call.args[0] } : (call.args || {});
    const one = (result) => ({ success: true, contract: c.display, function: fn, result, outputs: [], gateway: { mode: state.mode, fromLedger: true } });
    const minter = lower(c.minter);
    switch (fn) {
    case "ownerOf": { const it = needItem(c, a.tokenId); return one({ tokenId: String(it.token_id), owner: it.owner, sold: lower(it.owner) !== minter }); }
    case "priceOf": { const it = needItem(c, a.tokenId); return one({ tokenId: String(it.token_id), price: it.price }); }
    case "imageOf": { const it = needItem(c, a.tokenId); return one({ tokenId: String(it.token_id), image: it.label }); }
    case "nicknameOf": { const it = needItem(c, a.tokenId); return one({ tokenId: String(it.token_id), nickname: it.label }); }
    case "levelOf": { const it = needItem(c, a.tokenId); return one({ tokenId: String(it.token_id), level: it.level }); }
    case "tokenURI": {
        const it = needItem(c, a.tokenId);
        const metadata = c.type === "nickname"
            ? { name: it.label, description: "Nickname", attributes: [{ trait_type: "user level", display_type: "number", value: it.level }] }
            : (it.uri ? JSON.parse(it.uri) : { image: it.label });
        return one(Object.assign({ tokenId: String(it.token_id), metadata }, c.type === "avatar" ? { image: metadata.image || it.label } : {}));
    }
    case "paymentsOf": {
        const it = needItem(c, a.tokenId);
        const current = currentPayments(it);
        const lv = current.filter((p) => p.kind === "level");
        return one(it.payments.map((p) => Object.assign({}, p, {
            undoable: open(p) && (p.kind === "sale" ? current[0] === p : lv[lv.length - 1] === p)
        })));
    }
    case "tokensOf": {
        const owner = a.account || a.owner;
        return one(q("SELECT * FROM items WHERE contract = ? AND lower(owner) = ? ORDER BY token_id").all(c.address, lower(owner))
            .map((r) => summary(c, r)));
    }
    case "balanceOf": return one({ owner: a.owner || a.account, tokens: q("SELECT COUNT(*) AS n FROM items WHERE contract = ? AND lower(owner) = ?").get(c.address, lower(a.owner || a.account)).n });
    case "tokenOf": {
        const key = c.type === "nickname" ? labelKey("nickname", a.nickname) : String(a.imageUrl);
        const r = q("SELECT * FROM items WHERE contract = ? AND label_key = ?").get(c.address, key);
        return one(r ? { tokenId: String(r.token_id), minted: true, sold: lower(r.owner) !== minter, owner: r.owner, price: r.price } : { tokenId: null, minted: false });
    }
    case "levelCount": { const levels = JSON.parse(c.levels || "[]"); return one({ count: levels.length, levels }); }
    case "levelInfo": { const l = JSON.parse(c.levels || "[]")[Number(a.level)]; if (!l) { throw httpError(400, "no such level"); } return one(l); }
    case "quote": {
        const it = needItem(c, a.tokenId);
        const levels = JSON.parse(c.levels || "[]");
        let price = 0n;
        for (let l = it.level + 1; l <= Number(a.level); l++) {
            if (!levels[l] || !levels[l].forSale) {
                throw httpError(400, `level ${a.level}: not for sale`);
            }
            price += ethToWei(levels[l].price);
        }
        return one({ tokenId: String(it.token_id), level: Number(a.level), price: weiToEth(price) });
    }
    case "holdSeconds": return one(String(c.hold));
    case "totalSupply": return one(String(q("SELECT COUNT(*) AS n FROM items WHERE contract = ?").get(c.address).n));
    case "minter": return one(c.minter);
    case "name": return one(c.name);
    case "symbol": return one(c.symbol);
    default: return null;
    }
}

const cacheKey = (path, body) => path + " " + JSON.stringify(body || null);

function readCached(path, body) {
    const r = q("SELECT body, at FROM cache WHERE k = ?").get(cacheKey(path, body));
    if (!r) {
        throw httpError(503, "the proxy cannot be reached and this answer is not cached");
    }
    return Object.assign(JSON.parse(r.body), { gateway: { mode: state.mode, cachedAt: iso(r.at) } });
}

function remember(path, body, answer) {
    q("INSERT INTO cache (k, body, at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET body = excluded.body, at = excluded.at")
        .run(cacheKey(path, body), JSON.stringify(answer), now());
}

function offlineCall(body) {
    const one = (call) => {
        const fromItems = itemRead(call);
        if (fromItems) {
            return fromItems;
        }
        return readCached("/contract/call", { contract: call.contract, function: call.function, args: call.args });
    };
    if (Array.isArray(body.calls)) {
        const results = body.calls.map((call) => {
            try {
                return one(call);
            } catch (error) {
                return { success: false, status: error.status || 500, error: error.message };
            }
        });
        return { success: results.every((r) => r.success), results, gateway: { mode: state.mode } };
    }
    return one(body);
}

// ---------------------------------------------------------------- online pass-through

// the account that signs a write (for the nonce check of a send whose answer is lost)
function signerOf(path, body) {
    if (path === "/transfer/undo") {
        // +x undo: the consumption account pays back; -x undo: the user
        const row = q("SELECT deltas FROM outbox WHERE (temp_hash = ? OR real_hash = ?) AND kind = 'transfer'").get(lower(body.txHash), lower(body.txHash));
        return row ? JSON.parse(row.deltas)[1][0] : null;
    }
    if (path === "/transfer") {
        return String(body.amount || "").trim().startsWith("-") ? SECTION.upfront : body.account;
    }
    if (path === "/contract/send") {
        const fn = String(body.function || "").split("(")[0];
        if (fn === "undo" || fn === "undoLevel") {
            const c = collection(body.contract || "");
            const a = Array.isArray(body.args) ? { tokenId: body.args[0] } : (body.args || {});
            const it = c ? item(c.address, Number(a.tokenId)) : null;
            const cur = it ? currentPayments(it) : [];
            return cur.length ? cur[cur.length - 1].paidTo : SECTION.consumption;
        }
        return body.from;
    }
    return null;
}

async function passWrite(path, body, uid, langHeader = {}) {
    const signer = signerOf(path, body);
    let nonce = null;
    try {
        nonce = signer && isAddress(signer) ? await nonceOf(signer) : null;
    } catch (error) {
        nonce = null;
    }
    let r;
    try {
        r = await proxy("POST", path, body, 120000, true, L.connect_timeout_ms, langHeader);
    } catch (error) {
        if (!error.aborted) {
            proxyFailed();  // a network error counts as a failed health check
        }
        if (error.notSent) {
            // the request never reached the proxy: queued like any offline request
            answerLang = langHeader["accept-language"] || "en";
            return { status: 200, data: offlineWrite(path, body, uid) };
        }
        if (path === "/createaccount") {
            // the proxy may have made the account already: no spare account in its place
            throw httpError(503, "the proxy did not answer: try again");
        }
        // cut off after it was sent: answered from the ledger; before resending, the queue checks the nonce
        let answer;
        try {
            answerLang = langHeader["accept-language"] || "en";
            answer = offlineWrite(path, body, uid);
        } catch (e) {
            throw httpError(503, "the proxy did not answer: the result is not known yet");
        }
        q("UPDATE outbox SET status = 'uncertain', nonce_before = ? WHERE uid = ?").run(nonce, uid);
        return { status: 200, data: answer };
    }
    if (r.status === 200) {
        afterWrite(path, body, r.data).catch((e) => console.error("gateway: after write:", e.message));
    }
    return r;
}

// keep the ledger up to date after a write that went through
async function afterWrite(path, body, data) {
    // a +x / -x sent online is recorded too, so it can be undone later while offline (cut -1: not a cut's spending)
    if (path === "/transfer" && /^0x[0-9a-fA-F]{64}$/.test(String(data.txHash || "")) && isAddress(data.from) && isAddress(data.to)) {
        const w = ethToWei(data.amount);
        q(`INSERT OR IGNORE INTO outbox (uid, cut, created, kind, signer, path, body, deltas, status, temp_hash, real_hash, result)
           VALUES (?, -1, ?, 'transfer', ?, '/transfer', ?, ?, 'done', ?, ?, ?)`)
            .run(crypto.randomUUID(), now(), data.from, JSON.stringify(body), JSON.stringify([[data.from, String(-w)], [data.to, String(w)]]),
                lower(data.txHash), lower(data.txHash), JSON.stringify(data));
    }
    if (path === "/createaccount" && isAddress(data.address)) {
        upsertAccount(data.address, "user");
    }
    const touched = [data.from, data.to, data.address, body.account, body.from, SECTION.upfront, SECTION.consumption].filter(isAddress);
    const out = await rpcBatch(touched.map((a) => ["eth_getBalance", [a, "latest"]]));
    touched.forEach((a, i) => {
        if (out[i] && account(a)) {
            const w = BigInt(out[i]).toString();
            q("UPDATE accounts SET chain_wei = ?, local_wei = ? WHERE address = ?").run(w, w, lower(a));
        }
    });
    if (path === "/contract/send") {
        const c = collection(body.contract || "");
        const tokenId = data.result && data.result.tokenId;
        if (c && tokenId) {
            await refreshItems(c, [Number(tokenId)]);
        }
    }
}

function offlineWrite(path, body, uid) {
    if (path === "/transfer") {
        return offlineTransfer(body, uid);
    }
    if (path === "/createaccount") {
        return offlineCreateAccount(body, uid);
    }
    if (path === "/transfer/undo") {
        return offlineTransferUndo(body, uid);
    }
    if (path === "/account/pool") {
        offlineAllowed("account_pool");
        enqueue({ uid, kind: "account_pool", path, body });
        return { success: true, address: body.address, pool: body.pool, gateway: gw(uid) };
    }
    if (path === "/contract/send") {
        return offlineContractSend(body, uid);
    }
    throw httpError(503, "not available while the proxy cannot be reached");
}

// ---------------------------------------------------------------- HTTP

function keyOk(req) {
    const given = Buffer.from(String(req.headers["x-section-key"] || ""));
    const want = Buffer.from(KEY);
    return given.length === want.length && crypto.timingSafeEqual(given, want);
}

function send(res, status, data) {
    const body = typeof data === "string" ? data : JSON.stringify(data);
    res.writeHead(status, { "content-type": typeof data === "string" ? "text/plain; version=0.0.4" : "application/json" });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const parts = [];
        req.on("data", (c) => {
            size += c.length;
            if (size > 1024 * 1024) {
                reject(httpError(413, "body too large"));
                req.destroy();
            } else {
                parts.push(c);
            }
        });
        req.on("end", () => {
            const text = Buffer.concat(parts).toString("utf8");
            try {
                resolve(text ? JSON.parse(text) : {});
            } catch (error) {
                reject(httpError(400, "body: JSON"));
            }
        });
        req.on("error", reject);
    });
}

// ETH given back by a correction (reports from before the refund_wei column: from its detail)
function refundOf(r) {
    if (r.refund_wei !== null && r.refund_wei !== undefined) {
        return BigInt(r.refund_wei);
    }
    return (JSON.parse(r.detail).refund || []).reduce((sum, x) => sum + ethToWei(x.amount), 0n);
}

function corrections() {
    const rows = q("SELECT correction, detail, refund_wei, acked_at, delivered FROM reports WHERE kind = 'conflict'").all();
    const byKind = {};
    let refunded = 0n;
    for (const r of rows) {
        const kind = r.correction || correctionKind(JSON.parse(r.detail).reason);
        byKind[kind] = (byKind[kind] || 0) + 1;
        refunded += refundOf(r);
    }
    return { total: rows.length, open: rows.filter((r) => !r.acked_at).length, byKind, refundedEth: weiToEth(refunded),
        undelivered: L.correction_webhook ? rows.filter((r) => !r.delivered).length : 0 };
}

function status() {
    const oldest = q("SELECT MIN(created) AS t FROM outbox WHERE status IN ('queued', 'sending', 'uncertain')").get().t;
    const cutNo = Number(getMeta("cut", 0));
    const spent = q("SELECT spend_wei FROM outbox WHERE cut = ? AND status IN ('queued', 'sending', 'uncertain', 'done')").all(cutNo)
        .reduce((s, r) => s + BigInt(r.spend_wei || "0"), 0n);
    const c = corrections();
    return {
        section: section(), mode: state.mode, since: state.mode === "online" ? null : iso(Number(getMeta("offlineSince", now()))),
        queue: queued(), oldestSeconds: oldest ? Math.round((now() - oldest) / 1000) : 0,
        spares: q("SELECT COUNT(*) AS n FROM spares WHERE used IS NULL").get().n,
        offlineEth: state.mode === "online" ? "0" : weiToEth(spent), conflicts: state.conflicts,
        corrections: { open: c.open, total: c.total, refundedEth: c.refundedEth, undelivered: c.undelivered },
        cuts: cutNo, lastSync: state.lastSync ? iso(state.lastSync) : null, lastBackup: Number(getMeta("lastBackup", 0)) ? iso(Number(getMeta("lastBackup", 0))) : null,
        limits: { offlineMaxHours: L.offline_max_hours, spareAccounts: L.spare_accounts, operations: L.offline_operations }
    };
}

function metrics() {
    const s = status();
    const c = corrections();
    const lbl = `section_id="${SECTION.id}",section="${String(SECTION.name).replace(/"/g, "'")}"`;
    const m = (name, type, help, value, extra = "") => [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, `${name}{${lbl}${extra}} ${value}`];
    const kinds = ["already_sold", "price_changed", "level", "undo_period_over", "balance", "other"];
    let offlineSeconds = Number(getMeta("offlineSeconds", 0));
    if (state.mode !== "online") {
        offlineSeconds += Math.round((now() - Number(getMeta("offlineSince", now()))) / 1000);
    }
    return [
        ...m("gateway_mode", "gauge", "0 online, 1 offline, 2 draining", { online: 0, offline: 1, draining: 2 }[s.mode]),
        ...m("gateway_queue_length", "gauge", "requests waiting to be sent", s.queue),
        ...m("gateway_queue_oldest_seconds", "gauge", "age of the oldest waiting request", s.oldestSeconds),
        ...m("gateway_offline_eth", "gauge", "ETH spent during the current cut", Number(s.offlineEth)),
        ...m("gateway_spare_accounts", "gauge", "spare accounts left for /createaccount offline", s.spares),
        ...m("gateway_spare_target", "gauge", "spare accounts wanted", L.spare_accounts),
        ...m("gateway_spare_alert_below", "gauge", "the GatewaySparesLow threshold", L.spare_alert_below),
        ...m("gateway_conflicts_total", "counter", "queued requests the chain refused after reconnecting", s.conflicts),
        "# HELP gateway_corrections_total corrections (queued requests the chain refused), by kind", "# TYPE gateway_corrections_total counter",
        ...kinds.map((k) => `gateway_corrections_total{${lbl},kind="${k}"} ${c.byKind[k] || 0}`),
        ...m("gateway_corrections_refunded_eth_total", "counter", "ETH given back to accounts by corrections", Number(c.refundedEth)),
        ...m("gateway_corrections_open", "gauge", "corrections not acknowledged yet (chainlens)", c.open),
        ...m("gateway_corrections_undelivered", "gauge", "corrections the webhook has not taken yet", c.undelivered),
        ...m("gateway_cuts_total", "counter", "times the gateway went offline", s.cuts),
        ...m("gateway_offline_seconds_total", "counter", "seconds spent offline or draining", offlineSeconds),
        ...m("gateway_auth_failures_total", "counter", "requests with a wrong section key", state.authFailures),
        ...m("gateway_last_sync_timestamp_seconds", "gauge", "the last full sync with the chain", Math.round(state.lastSync / 1000)),
        ...m("gateway_last_backup_timestamp_seconds", "gauge", "the last database snapshot", Math.round(Number(getMeta("lastBackup", 0)) / 1000)),
        ""
    ].join("\n");
}

const WRITES = new Set(["/transfer", "/transfer/undo", "/createaccount", "/account/pool", "/contract/send"]);

// wrong keys: answered at once (401); 10 wrong keys from one address within 60 s -> 429 for 60 s
const brake = new Map();
function braked(ip) {
    const b = brake.get(ip);
    return Boolean(b && b.until > now());
}
function wrongKey(ip) {
    state.authFailures += 1;
    setMeta("authFailures", state.authFailures);
    const t = now();
    const b = brake.get(ip) || { start: t, count: 0, until: 0 };
    if (t - b.start > 60000) {
        b.start = t;
        b.count = 0;
    }
    b.count += 1;
    if (b.count >= 10) {
        b.until = t + 60000;
        b.count = 0;
        b.start = t;
    }
    brake.set(ip, b);
    if (brake.size > 10000) {
        for (const [k, v] of brake) {
            if (v.until < t && t - v.start > 60000) {
                brake.delete(k);
            }
        }
    }
}

function tokenEq(given, want) {
    const g = Buffer.from(String(given || ""));
    const w = Buffer.from(String(want || ""));
    return w.length > 0 && g.length === w.length && crypto.timingSafeEqual(g, w);
}
const reportTokenOk = (req) => Boolean(REPORT_TOKEN) && tokenEq(String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""), REPORT_TOKEN);

// the answers are the proxy's, unchanged: the gateway's own field only with answer_gateway_field
function plain(data) {
    if (L.answer_gateway_field || !data || typeof data !== "object") {
        return data;
    }
    delete data.gateway;
    if (Array.isArray(data.results)) {
        data.results.forEach((r) => r && typeof r === "object" && delete r.gateway);
    }
    return data;
}

function reportRow(r) {
    const d = JSON.parse(r.detail);
    return { id: r.id, at: iso(r.at), request: r.uid, kind: r.kind, correction: r.kind === "conflict" ? (r.correction || correctionKind(d.reason)) : undefined,
        refundEth: r.kind === "conflict" ? weiToEth(refundOf(r)) : undefined, ...d,
        delivered: Boolean(r.delivered), acked: r.acked_at ? { at: iso(r.acked_at), by: r.acked_by } : null };
}

async function handle(req, res) {
    const url = new URL(req.url, "http://gateway");
    const path = url.pathname;
    const ip = String(req.socket.remoteAddress || "");

    if (req.method === "GET" && path === "/gateway/status") {
        return send(res, 200, status());
    }
    if (req.method === "GET" && path === "/metrics") {
        return send(res, 200, metrics());
    }
    if (braked(ip)) {
        return send(res, 429, { error: "too many wrong keys: wait a minute" });
    }

    // reports: the section key, or the read-and-acknowledge report token (chainlens)
    // the spare accounts not handed out yet (chainlens shows them apart from the real user accounts)
    if (req.method === "GET" && path === "/gateway/spares") {
        if (!keyOk(req) && !reportTokenOk(req)) {
            wrongKey(ip);
            return send(res, 401, { error: "the section key or the report token is required" });
        }
        return send(res, 200, { success: true, section: section(), spares: q("SELECT display FROM spares WHERE used IS NULL ORDER BY created").all().map((r) => r.display),
            used: q("SELECT COUNT(*) AS n FROM spares WHERE used IS NOT NULL").get().n });
    }

    if (path === "/gateway/report" || /^\/gateway\/report\/\d+\/ack$/.test(path)) {
        if (!keyOk(req) && !reportTokenOk(req)) {
            wrongKey(ip);
            return send(res, 401, { error: "the section key or the report token is required" });
        }
        if (req.method === "GET" && path === "/gateway/report") {
            const since = Date.parse(url.searchParams.get("since") || "") || 0;
            const open = url.searchParams.get("open") === "1";
            const kind = url.searchParams.get("kind");
            const rows = q("SELECT * FROM reports WHERE at >= ? ORDER BY id DESC LIMIT 500").all(since)
                .filter((r) => (!open || (r.kind === "conflict" && !r.acked_at)) && (!kind || r.kind === kind));
            return send(res, 200, { success: true, section: section(), corrections: corrections(), reports: rows.map(reportRow) });
        }
        if (req.method === "POST") {
            const body = await readBody(req);
            const id = Number(path.split("/")[3]);
            const r = q("SELECT * FROM reports WHERE id = ?").get(id);
            if (!r) {
                return send(res, 404, { error: "unknown report" });
            }
            if (!r.acked_at) {
                q("UPDATE reports SET acked_at = ?, acked_by = ? WHERE id = ?").run(now(), String(body.by || "").slice(0, 100) || null, id);
            }
            return send(res, 200, { success: true, report: reportRow(q("SELECT * FROM reports WHERE id = ?").get(id)) });
        }
        return send(res, 405, { error: "GET /gateway/report, POST /gateway/report/:id/ack" });
    }

    if (!keyOk(req)) {
        wrongKey(ip);
        return send(res, 401, { error: "X-Section-Key: the section's key is required" });
    }
    if (req.method === "GET" && path.startsWith("/gateway/request/")) {
        const r = q("SELECT * FROM outbox WHERE uid = ? OR temp_hash = ?").get(path.slice(17), path.slice(17));
        return r ? send(res, 200, { request: r.uid, status: r.status, txHash: r.real_hash || r.temp_hash, error: r.error, created: iso(r.created) })
            : send(res, 404, { error: "unknown request" });
    }

    const body = req.method === "POST" ? await readBody(req) : undefined;
    const uid = crypto.randomUUID();
    // the memo language: answered here when offline, passed to the proxy when online
    const lang = MEMO.lang(url.searchParams.get("lang"), req.headers["accept-language"], L.memo_default_lang);
    const langHeader = { "accept-language": lang };
    if (body && typeof body === "object") {
        MEMO.userMemo(body.memo);  // 400 for a memo that is not a string or too long, as the proxy
    }

    if (req.method === "POST" && WRITES.has(path)) {
        if (path === "/transfer/undo" && body && typeof body.txHash === "string") {
            // the application may know a transfer by the gateway's temporary hash
            const sent = q("SELECT real_hash FROM outbox WHERE temp_hash = ? AND real_hash IS NOT NULL").get(lower(body.txHash));
            if (sent) {
                body.txHash = sent.real_hash;
            }
        }
        if (state.mode === "online" && !queued()) {
            const r = await passWrite(path, body, uid, langHeader);
            return send(res, r.status, plain(r.data));
        }
        answerLang = lang;
        return send(res, 200, plain(offlineWrite(path, body, uid)));
    }

    if (req.method === "GET" && path.startsWith("/transfer/")) {
        const hash = path.slice(10);
        const row = q("SELECT * FROM outbox WHERE temp_hash = ? OR real_hash = ?").get(hash, hash);
        if (row && !row.real_hash) {
            const promised = (JSON.parse(row.answer || "null") || {}).result || {};
            const memoFields = {};
            for (const k of ["memo", "memoType", "memoText", "memoParams", "userMemo", "memoRequest"]) {
                if (promised[k] !== undefined) {
                    memoFields[k] = promised[k];
                }
            }
            const st = row.status === "void" ? "success" : (row.status === "failed" || row.status === "cancelled" ? "failed" : "pending");
            return send(res, 200, plain({ success: true, txHash: hash, status: st,
                error: row.error || undefined, ...memoFields, gateway: { mode: state.mode, request: row.uid, status: row.status } }));
        }
        if (state.mode === "online") {
            try {
                const r = await proxy("GET", "/transfer/" + (row ? row.real_hash : hash), undefined, 30000, true, L.connect_timeout_ms, langHeader);
                if (r.status === 200 && row && r.data && r.data.txHash) {
                    r.data.txHash = hash;  // the hash the application was given
                }
                return send(res, r.status, r.data);
            } catch (error) {
                if (!error.aborted) {
                    proxyFailed();
                }
            }
        }
        return send(res, 200, plain({ success: true, txHash: hash, status: row ? "success" : "pending", gateway: { mode: state.mode } }));
    }

    // reads
    const readPath = path + url.search;
    if (state.mode === "online") {
        try {
            const r = await proxy(req.method, readPath, body, 120000, true, L.connect_timeout_ms, langHeader);
            if (r.status === 200) {
                if (path === "/contract/call" && Array.isArray(body.calls)) {
                    body.calls.forEach((c, i) => r.data.results[i] && r.data.results[i].success && remember("/contract/call", { contract: c.contract, function: c.function, args: c.args }, r.data.results[i]));
                } else if (path === "/contract/call") {
                    remember("/contract/call", { contract: body.contract, function: body.function, args: body.args }, r.data);
                } else {
                    remember(readPath, body, r.data);
                }
            }
            return send(res, r.status, r.data);
        } catch (error) {
            if (!error.aborted) {
                proxyFailed();
            }
        }
    }
    if (path === "/contract/call") {
        return send(res, 200, plain(offlineCall(body || {})));
    }
    return send(res, 200, plain(readCached(readPath, body)));
}

const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
        if (!error.status) {
            console.error("gateway:", error);
        }
        send(res, error.status || 500, { error: error.message });
    });
});

// ---------------------------------------------------------------- loops (the health check runs on its own: healthLoop)

// a daily snapshot of the ledger: <data>/backup/gateway-YYYYMMDD.db, kept backup_keep_days
function backup() {
    if (now() - Number(getMeta("lastBackup", 0)) < 86400000) {
        return;
    }
    const dir = require("node:path").join(require("node:path").dirname(DB_FILE), "backup");
    fs.mkdirSync(dir, { recursive: true });
    const file = require("node:path").join(dir, `gateway-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.db`);
    fs.rmSync(file, { force: true });
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    setMeta("lastBackup", now());
    for (const f of fs.readdirSync(dir)) {
        const full = require("node:path").join(dir, f);
        if (/^gateway-\d{8}\.db$/.test(f) && now() - fs.statSync(full).mtimeMs > L.backup_keep_days * 86400000) {
            fs.rmSync(full, { force: true });
        }
    }
    console.log(`gateway: snapshot ${file}`);
}

let busy = false;
async function jobs() {
    if (busy) {
        return;
    }
    busy = true;
    try {
        backup();
        if (state.mode === "draining" || (state.mode !== "offline" && queued())) {
            await drain();
        } else if (state.mode === "online") {
            if (now() - state.lastSync > L.sync_seconds * 1000) {
                await sync(false);
            }
            await keepSpares();
            await deliverReports();
        }
    } catch (error) {
        console.error("gateway: jobs:", error.message);
    } finally {
        busy = false;
    }
}

server.listen(PORT, () => {
    console.log(`gateway for section ${SECTION.id} ("${SECTION.name}") on :${PORT}, proxy ${PROXY}, mode ${state.mode}`);
    healthLoop();
    setInterval(jobs, 1000);
    jobs();
});
