#!/usr/bin/env node
// Signer throughput benchmark: OLD (Web3Signer + Vault, and the proxy's per-tx Vault read +
// local ethers signing) vs NEW (MPC 2-of-3 CGGMP24 signer).
//
//   node bench.js --target w3s|vault|mpc --mode sign|send --concurrency 32 --requests 1000
//
// Closed-loop load: `concurrency` workers each issue requests back-to-back until `requests`
// are done. Prints one JSON line with throughput and latency percentiles.

const fs = require("fs");
const path = require("path");
const { Wallet, Transaction, getAddress } = require("ethers");

const arg = (name, def) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : def;
};

const TARGET = arg("target", "mpc");
const MODE = arg("mode", "sign");
const CONCURRENCY = Number(arg("concurrency", 16));
const REQUESTS = Number(arg("requests", 500));
const WARMUP = Number(arg("warmup", 0));
const VERIFY = arg("verify", "true") === "true";
const LABEL = arg("label", "");

const BESU = process.env.BESU_RPC || "http://127.0.0.1:8545";
const W3S = process.env.W3S_RPC || "http://127.0.0.1:9000";
const MPC = process.env.MPC_RPC || "http://127.0.0.1:9100";
const VAULT = process.env.VAULT_ADDR || "http://127.0.0.1:8200";
const ENV_DIR = path.join(__dirname, "env");
// Vault target: KV v2 path of the key (proxy-style per-transaction read) and a token that can read it.
// Defaults are the bench stack's; OLD_STACK=existing sets them for your own Vault.
const VAULT_KEY_PATH = (process.env.VAULT_KEY_PATH || "web3signer/data/accounts/bench-vault").replace(/^\/?(v1\/)?/, "");
let CHAIN_ID = process.env.CHAIN_ID ? Number(process.env.CHAIN_ID) : null;
const TO = "0x000000000000000000000000000000000000dEaD";

async function rpc(url, method, params = []) {
    const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
}

async function readVaultKey(token) {
    const r = await fetch(`${VAULT}/v1/${VAULT_KEY_PATH}`, { headers: { "X-Vault-Token": token } });
    if (!r.ok) throw new Error(`vault read ${VAULT_KEY_PATH}: HTTP ${r.status}`);
    const body = await r.json();
    const k = body.data.data.privateKey;
    return k.startsWith("0x") ? k : "0x" + k;
}

async function setup() {
    if (CHAIN_ID === null) CHAIN_ID = Number(await rpc(BESU, "eth_chainId"));
    if (TARGET === "w3s") {
        const from = process.env.W3S_FROM || (await rpc(W3S, "eth_accounts"))[0];
        if (!from) throw new Error("Web3Signer has no accounts");
        return { from: getAddress(from) };
    }
    if (TARGET === "mpc") {
        const from = process.env.MPC_FROM || (await rpc(MPC, "eth_accounts"))[0];
        if (!from) throw new Error("MPC coordinator has no keys");
        return { from: getAddress(from) };
    }
    if (TARGET === "vault") {
        const token = process.env.VAULT_TOKEN || fs.readFileSync(path.join(ENV_DIR, ".secrets/signer-token"), "utf8").trim();
        const from = new Wallet(await readVaultKey(token)).address;
        return { from, token };
    }
    throw new Error(`unknown target ${TARGET}`);
}

// Same as proxy/stress-latest.js readPrivateKey()+vaultWallet(): one Vault read per transaction.
async function vaultSign(ctx, tx) {
    const wallet = new Wallet(await readVaultKey(ctx.token));
    return wallet.signTransaction({ ...tx, chainId: CHAIN_ID, type: 0 });
}

function txFor(ctx, nonce) {
    return { from: ctx.from, to: TO, gas: "0x5208", gasPrice: "0x0", value: "0x0", nonce: "0x" + nonce.toString(16) };
}

async function one(ctx, nonce) {
    const tx = txFor(ctx, nonce);
    if (MODE === "sign") {
        let raw;
        if (TARGET === "vault") {
            raw = await vaultSign(ctx, { to: tx.to, gasLimit: 21000, gasPrice: 0, value: 0, nonce });
        } else {
            raw = await rpc(TARGET === "w3s" ? W3S : MPC, "eth_signTransaction", [tx]);
        }
        if (VERIFY) {
            const t = Transaction.from(raw);
            if (t.from !== ctx.from || Number(t.nonce) !== nonce || Number(t.chainId) !== CHAIN_ID) {
                throw new Error(`bad signature: recovered ${t.from}`);
            }
        }
        return;
    }
    // send: sign + submit to Besu
    if (TARGET === "vault") {
        const raw = await vaultSign(ctx, { to: tx.to, gasLimit: 21000, gasPrice: 0, value: 0, nonce });
        await rpc(BESU, "eth_sendRawTransaction", [raw]);
    } else {
        await rpc(TARGET === "w3s" ? W3S : MPC, "eth_sendTransaction", [tx]);
    }
}

function pct(sorted, p) {
    if (!sorted.length) return null;
    return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function run(ctx, n, nonceBase) {
    let next = 0;
    const lat = [];
    const errors = {};
    const t0 = performance.now();
    async function worker() {
        for (;;) {
            const i = next++;
            if (i >= n) return;
            const s = performance.now();
            try {
                await one(ctx, nonceBase + i);
                lat.push(performance.now() - s);
            } catch (e) {
                const k = String(e.message).slice(0, 120);
                errors[k] = (errors[k] || 0) + 1;
            }
        }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    const wall = (performance.now() - t0) / 1000;
    lat.sort((a, b) => a - b);
    return { wall, lat, errors };
}

async function waitMined(addr, expected, timeoutMs = 300000) {
    const t0 = performance.now();
    for (;;) {
        const n = parseInt(await rpc(BESU, "eth_getTransactionCount", [addr, "latest"]), 16);
        if (n >= expected) return (performance.now() - t0) / 1000;
        if (performance.now() - t0 > timeoutMs) return null;
        await new Promise((r) => setTimeout(r, 250));
    }
}

(async () => {
    const ctx = await setup();
    let nonceBase = 0;
    if (MODE === "send") nonceBase = parseInt(await rpc(BESU, "eth_getTransactionCount", [ctx.from, "pending"]), 16);
    if (WARMUP > 0) {
        await run(ctx, WARMUP, nonceBase);
        nonceBase += WARMUP;
    }
    const r = await run(ctx, REQUESTS, nonceBase);
    const ok = r.lat.length;
    const out = {
        label: LABEL,
        target: TARGET,
        mode: MODE,
        concurrency: CONCURRENCY,
        requests: REQUESTS,
        ok,
        errors: r.errors,
        seconds: +r.wall.toFixed(3),
        tps: +(ok / r.wall).toFixed(1),
        p50_ms: +(pct(r.lat, 50) || 0).toFixed(2),
        p95_ms: +(pct(r.lat, 95) || 0).toFixed(2),
        p99_ms: +(pct(r.lat, 99) || 0).toFixed(2),
        max_ms: +(r.lat[r.lat.length - 1] || 0).toFixed(2),
    };
    if (MODE === "send") {
        const drain = await waitMined(ctx.from, nonceBase + REQUESTS);
        out.all_mined_after_s = drain === null ? "timeout" : +drain.toFixed(2);
        if (drain !== null) out.end_to_end_tps = +(ok / (r.wall + drain)).toFixed(1);
    }
    console.log(JSON.stringify(out));
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
