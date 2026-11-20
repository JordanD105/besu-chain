#!/usr/bin/env node
// Signer throughput benchmark for the MPC 2-of-3 CGGMP24 signer (coordinator JSON-RPC).
//
//   node bench.js --mode sign|send --concurrency 32 --requests 1000 [--warmup N] [--label L]
//
// Closed-loop load: `concurrency` workers each issue requests back-to-back until `requests`
// are done. Prints one JSON line with throughput and latency percentiles.

const { Transaction, getAddress } = require("ethers");

const arg = (name, def) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : def;
};

const MODE = arg("mode", "sign");
const CONCURRENCY = Number(arg("concurrency", 16));
const REQUESTS = Number(arg("requests", 500));
const WARMUP = Number(arg("warmup", 0));
const VERIFY = arg("verify", "true") === "true";
const LABEL = arg("label", "");

const BESU = process.env.BESU_RPC || "http://127.0.0.1:8545";
const MPC = process.env.MPC_RPC || "http://127.0.0.1:9100";
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

async function setup() {
    if (CHAIN_ID === null) CHAIN_ID = Number(await rpc(BESU, "eth_chainId"));
    const from = process.env.MPC_FROM || (await rpc(MPC, "eth_accounts"))[0];
    if (!from) throw new Error("MPC coordinator has no keys");
    return { from: getAddress(from) };
}

function txFor(ctx, nonce) {
    return { from: ctx.from, to: TO, gas: "0x5208", gasPrice: "0x0", value: "0x0", nonce: "0x" + nonce.toString(16) };
}

async function one(ctx, nonce) {
    const tx = txFor(ctx, nonce);
    if (MODE === "sign") {
        const raw = await rpc(MPC, "eth_signTransaction", [tx]);
        if (VERIFY) {
            const t = Transaction.from(raw);
            if (t.from !== ctx.from || Number(t.nonce) !== nonce || Number(t.chainId) !== CHAIN_ID) {
                throw new Error(`bad signature: recovered ${t.from}`);
            }
        }
        return;
    }
    // send: sign + submit to Besu (the coordinator forwards eth_sendTransaction)
    await rpc(MPC, "eth_sendTransaction", [tx]);
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
        target: "mpc",
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
