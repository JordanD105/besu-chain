#!/usr/bin/env node
// Deploys a compiled contract, signed by an MPC account through the coordinator, and records it in
// contracts/deployments/<address>.json (chainlens shows recorded contracts with their ABI).
//
// The deployment itself is chainlens/deploy.js (also used by chainlens' Deploy page).
// Runs in the proxy image, which has ethers (no npm install on the operator), from the repository root:
//
//   docker run --rm --network host -u "$(id -u)" -v "$PWD":/work -w /work -e NODE_PATH=/app/node_modules \
//     localhost/besu-proxy/besu-proxy node besu-production/operator/deploy-contract.js \
//     --artifact build/MyToken.json --from 0xDeployer... --args '["My token", "MTK", 1000000]'
//
// Without --yes it only checks and prints what it would send (dry run). See besu-production/README.md,
// "Deploying a contract".
//
// The deployer must be an MPC key of the coordinator (create one with the proxy's POST /createaccount)
// and must not be SENDER01 or any account the proxy sends from: the proxy keeps those nonces in
// memory, and a transaction from outside the proxy breaks its next one.
"use strict";
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const HELP = `usage: deploy-contract.js --artifact <file> --from <address> [options]
  --artifact <file>    compiled contract: Hardhat/Truffle, Foundry, Remix (artifacts/*.json) or solc output
  --contract <name>    contract name inside a solc / Remix file holding several contracts
  --from <address>     deployer: an MPC account listed by the coordinator (env DEPLOYER)
  --args <json>        constructor arguments as a JSON array, e.g. '["Name", "SYM", 1000]' (big numbers as strings)
  --name <name>        name in the record (default: the contract name)
  --coordinator <url>  MPC coordinator (env COORDINATOR_URL, default http://192.168.68.150:9100)
  --rpc <url>          Besu RPC (env RPC_URL, default http://192.168.68.150:8545)
  --sender01 <file>    file holding SENDER01, which is refused as deployer (default ansible/state/sender01)
  --max-gas <n>        the MPC policy's MAX_GAS (env MAX_GAS, default 30000000)
  --out <dir>          where the record goes (default contracts/deployments)
  --yes                sign and send; without it, a dry run`;

function parseArgs(argv) {
    const o = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--yes" || a === "-y") o.yes = true;
        else if (a === "--help" || a === "-h") o.help = true;
        else if (a.startsWith("--") && i + 1 < argv.length) o[a.slice(2)] = argv[++i];
        else throw new Error(`unknown argument ${a}`);
    }
    return o;
}

// the deployment itself, shared with chainlens' Deploy page: chainlens/deploy.js
const deploy = require(path.join(__dirname, "..", "..", "chainlens", "deploy.js"));

async function main() {
    const o = parseArgs(process.argv.slice(2));
    if (o.help || !o.artifact) { console.log(HELP); process.exit(o.help ? 0 : 1); }
    const coordinator = o.coordinator || process.env.COORDINATOR_URL || "http://192.168.68.150:9100";
    const rpcUrl = o.rpc || process.env.RPC_URL || "http://192.168.68.150:8545";
    const maxGas = BigInt(o["max-gas"] || process.env.MAX_GAS || 30000000);
    const outDir = o.out || "contracts/deployments";
    const from = o.from || process.env.DEPLOYER || "";

    const art = deploy.loadArtifact(JSON.parse(fs.readFileSync(o.artifact, "utf8")), o.contract, path.basename(o.artifact, ".json"));
    const args = o.args ? JSON.parse(o.args) : [];
    if (!Array.isArray(args)) throw new Error("--args must be a JSON array");

    // never the proxy's sender
    const s01file = o.sender01 || "ansible/state/sender01";
    let sender01 = null;
    try { sender01 = fs.readFileSync(s01file, "utf8").trim(); } catch { /* warned below */ }
    if (!sender01) {
        console.warn(`note: can't read ${s01file} (run with -u "$(id -u)" from the repository root), can't check that the deployer isn't SENDER01`);
    }

    const plan = await deploy.prepare({ art, args, name: o.name, from, rpcUrl, coordinatorUrl: coordinator, maxGas, sender01 });
    console.log(`contract     ${plan.name} (${plan.creationSize} bytes of creation code)
constructor  ${args.length ? JSON.stringify(args) : "(no arguments)"}
chain        ${plan.chainId}   rpc ${rpcUrl}
deployer     ${plan.from}   nonce ${plan.nonce}   balance ${ethers.formatEther(plan.balance)}
gas          ${plan.gas} (estimate ${plan.estimate}, MAX_GAS ${plan.maxGas}), gas price ${plan.gasPrice}
address      ${plan.address}`);
    if (!o.yes) { console.log("\ndry run: nothing signed or sent. Add --yes to deploy."); return; }

    const record = await deploy.send(plan, art, { rpcUrl, coordinatorUrl: coordinator, artifactName: path.basename(o.artifact), onStatus: (m) => console.log(m) });
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `${record.address.toLowerCase()}.json`);
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`deployed     ${record.address} in block ${record.blockNumber}, gas used ${record.gasUsed}
runtime code ${record.codeCheck}
record       ${file}  (commit it: chainlens shows the contract's functions from it)`);
    if (record.codeCheck.startsWith("DIFFERS")) process.exitCode = 3;
}

main().catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });
