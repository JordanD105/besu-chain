#!/usr/bin/env node
// Render a benchmark .jsonl file as a markdown report.
const fs = require("fs");
const rows = fs.readFileSync(process.argv[2], "utf8").trim().split("\n").map((l) => JSON.parse(l));
const name = { w3s: "OLD Web3Signer (key from Vault)", vault: "OLD proxy: Vault read + local sign", mpc: "NEW MPC 2-of-3" };
const out = [];
const m = rows.find((r) => r.label === "machine");
out.push(`# Signer throughput: Vault + Web3Signer vs MPC (CGGMP24)\n`);
if (m) out.push(`Host: ${m.cpus} vCPU (${m.cpu}), ${m.mem_gb} GB. MPC binary: \`${m.mpc_bin}\`. All components on one host.\n`);

const a = rows.find((r) => r.label === "A presign capacity");
if (a) {
    out.push(`## A. Presignature generation capacity\n`);
    out.push(`| presignatures | seconds | presignatures/s | avg session (ms) | node CPU-s per presig per party |`);
    out.push(`|---:|---:|---:|---:|---:|`);
    out.push(`| ${a.presigs} | ${a.seconds} | **${a.presigs_per_s}** | ${a.avg_session_ms} | ${a.node_cpu_s_per_presig_per_party} |\n`);
}

const table = (label, title, extra = false) => {
    const rs = rows.filter((r) => r.label === label);
    if (!rs.length) return;
    out.push(`## ${title}\n`);
    out.push(`| signer | concurrency | ok/requests | TPS | p50 ms | p95 ms | p99 ms |${extra ? " mined after (s) | end-to-end TPS |" : ""}`);
    out.push(`|---|---:|---:|---:|---:|---:|---:|${extra ? "---:|---:|" : ""}`);
    for (const r of rs) {
        const errs = Object.keys(r.errors || {}).length ? ` ⚠ ${JSON.stringify(r.errors)}` : "";
        out.push(
            `| ${name[r.target]} | ${r.concurrency} | ${r.ok}/${r.requests}${errs} | **${r.tps}** | ${r.p50_ms} | ${r.p95_ms} | ${r.p99_ms} |` +
                (extra ? ` ${r.all_mined_after_s} | ${r.end_to_end_tps ?? "-"} |` : "")
        );
    }
    out.push("");
};
table("B sign", "B. Signing throughput (`eth_signTransaction`; MPC pool pre-filled, refill paused)");
table("C send", "C. End-to-end (sign + submit to Besu, then wait until all mined)", true);
table("D cold", "D. MPC cold path (pool empty → full interactive 3+1-round signing)");
table("E sustained", "E. MPC sustained (pool empty at start, refill running during load)");
const e = rows.find((r) => r.label === "E pool stats");
if (e) out.push(`Pool stats after E: hot=${e.hot_signs}, cold=${e.cold_signs}, failed=${e.failed_signs}, presigs generated=${e.presigs_generated}.\n`);
console.log(out.join("\n"));
