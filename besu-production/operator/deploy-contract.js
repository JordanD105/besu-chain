#!/usr/bin/env node
// Deploys a compiled contract, signed by an MPC account through the coordinator, and records it in
// contracts/deployments/<address>.json (chainlens shows recorded contracts with their ABI).
//
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

const hex = (v) => (v && !String(v).startsWith("0x") ? `0x${v}` : v);

// abi, creation bytecode and runtime bytecode from the usual artifact formats
function loadArtifact(file, wanted) {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    const pick = (c, name) => {
        const evm = c.evm || c.data || c; // solc output | Remix artifact | Hardhat/Foundry
        const bc = evm.bytecode?.object ?? evm.bytecode;
        const dbc = evm.deployedBytecode?.object ?? evm.deployedBytecode;
        if (!c.abi || typeof bc !== "string") return null;
        const immutables = evm.deployedBytecode?.immutableReferences || c.immutableReferences || null;
        return { name: c.contractName || name, abi: c.abi, bytecode: hex(bc), deployedBytecode: dbc ? hex(dbc) : null, immutables };
    };
    const single = pick(j, wanted || path.basename(file, ".json"));
    if (single) return single;
    if (j.contracts) { // solc standard JSON output: contracts[file][name]
        const all = [];
        for (const f of Object.keys(j.contracts)) for (const n of Object.keys(j.contracts[f])) all.push([n, j.contracts[f][n]]);
        const hits = all.filter(([n]) => !wanted || n === wanted).map(([n, c]) => pick(c, n)).filter(Boolean)
            .filter((c) => c.bytecode !== "0x");
        if (hits.length === 1) return hits[0];
        throw new Error(hits.length ? `several contracts in ${file}, choose one with --contract: ${hits.map((c) => c.name).join(", ")}`
            : `no deployable contract${wanted ? ` named ${wanted}` : ""} in ${file}`);
    }
    throw new Error(`${file}: no abi + bytecode found (export the compiler artifact, not only the ABI)`);
}

async function rpc(url, method, params) {
    const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(120000),
    });
    if (!r.ok) throw new Error(`${url} ${method}: HTTP ${r.status}`);
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
}

async function main() {
    const o = parseArgs(process.argv.slice(2));
    if (o.help || !o.artifact) { console.log(HELP); process.exit(o.help ? 0 : 1); }
    const coordinator = o.coordinator || process.env.COORDINATOR_URL || "http://192.168.68.150:9100";
    const rpcUrl = o.rpc || process.env.RPC_URL || "http://192.168.68.150:8545";
    const maxGas = BigInt(o["max-gas"] || process.env.MAX_GAS || 30000000);
    const outDir = o.out || "contracts/deployments";
    const from = ethers.getAddress(o.from || process.env.DEPLOYER || "");

    const art = loadArtifact(o.artifact, o.contract);
    if (art.bytecode.includes("__$")) throw new Error("the bytecode has unlinked library placeholders (__$...$__): deploy and link the libraries first");
    const iface = new ethers.Interface(art.abi);
    const args = o.args ? JSON.parse(o.args) : [];
    if (!Array.isArray(args)) throw new Error("--args must be a JSON array");
    const ctor = iface.deploy.inputs.map((i) => `${i.type}${i.name ? ` ${i.name}` : ""}`).join(", ");
    let encoded;
    try {
        encoded = iface.encodeDeploy(args);
    } catch (e) {
        throw new Error(`constructor(${ctor}) does not take --args ${JSON.stringify(args)}: ${e.shortMessage || e.message}`);
    }
    const data = ethers.concat([art.bytecode, encoded]);
    const name = o.name || art.name;

    // never the proxy's sender
    const s01file = o.sender01 || "ansible/state/sender01";
    let s01 = null;
    try { s01 = fs.readFileSync(s01file, "utf8").trim(); } catch { /* checked below */ }
    if (s01) {
        if (ethers.isAddress(s01) && ethers.getAddress(s01) === from) {
            throw new Error("the deployer is SENDER01: the proxy sends from it and tracks its nonce. Use a dedicated MPC account (POST /createaccount)");
        }
    } else {
        console.warn(`note: can't read ${s01file} (run with -u "$(id -u)" from the repository root), can't check that the deployer isn't SENDER01`);
    }

    const chainId = BigInt(await rpc(rpcUrl, "eth_chainId", []));
    const accounts = (await rpc(coordinator, "eth_accounts", [])).map((a) => ethers.getAddress(a));
    if (!accounts.includes(from)) throw new Error(`${from} is not an MPC key of the coordinator (${coordinator}); create one with POST /createaccount`);

    const nonce = BigInt(await rpc(rpcUrl, "eth_getTransactionCount", [from, "pending"]));
    const mined = BigInt(await rpc(rpcUrl, "eth_getTransactionCount", [from, "latest"]));
    if (nonce !== mined) throw new Error(`${from} has ${nonce - mined} pending transaction(s); wait until they are mined`);
    const gasPrice = BigInt(await rpc(rpcUrl, "eth_gasPrice", []));
    const balance = BigInt(await rpc(rpcUrl, "eth_getBalance", [from, "latest"]));
    let estimate;
    try {
        estimate = BigInt(await rpc(rpcUrl, "eth_estimateGas", [{ from, data, value: "0x0" }]));
    } catch (e) {
        throw new Error(`the deployment reverts or is invalid (${e.message}). Check the constructor arguments and the EVM version (cancun at the latest)`);
    }
    if (estimate > maxGas) throw new Error(`needs ${estimate} gas, above the MPC policy limit MAX_GAS ${maxGas}`);
    let gas = (estimate * 125n) / 100n;
    if (gas > maxGas) gas = maxGas;
    if (gasPrice * gas > balance) throw new Error(`${from} can't pay ${ethers.formatEther(gasPrice * gas)} for gas (balance ${ethers.formatEther(balance)})`);
    const address = ethers.getCreateAddress({ from, nonce });

    console.log(`contract     ${name} (${(ethers.dataLength(art.bytecode))} bytes of creation code)
constructor  ${args.length ? JSON.stringify(args) : "(no arguments)"}
chain        ${chainId}   rpc ${rpcUrl}
deployer     ${from}   nonce ${nonce}   balance ${ethers.formatEther(balance)}
gas          ${gas} (estimate ${estimate}, MAX_GAS ${maxGas}), gas price ${gasPrice}
address      ${address}`);
    if (!o.yes) { console.log("\ndry run: nothing signed or sent. Add --yes to deploy."); return; }

    // sign through the coordinator (MPC threshold signature), send through the RPC VIP
    const raw = await rpc(coordinator, "eth_signTransaction", [{
        from, nonce: ethers.toQuantity(nonce), gas: ethers.toQuantity(gas), gasPrice: ethers.toQuantity(gasPrice),
        value: "0x0", data,
    }]);
    const tx = ethers.Transaction.from(raw);
    if (tx.from !== from || tx.to !== null || tx.nonce !== Number(nonce) || tx.data !== ethers.hexlify(data) || tx.chainId !== chainId) {
        throw new Error("the signed transaction does not match the request: not sent");
    }
    const hash = await rpc(rpcUrl, "eth_sendRawTransaction", [raw]);
    console.log(`sent         ${hash}`);

    let receipt = null;
    for (let i = 0; i < 120 && !receipt; i++) {
        receipt = await rpc(rpcUrl, "eth_getTransactionReceipt", [hash]);
        if (!receipt) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!receipt) throw new Error(`not mined after 120 s: check ${hash} later (chainlens or eth_getTransactionReceipt)`);
    if (receipt.status !== "0x1") throw new Error(`the deployment reverted in block ${BigInt(receipt.blockNumber)} (gas used ${BigInt(receipt.gasUsed)})`);
    const deployed = ethers.getAddress(receipt.contractAddress);

    const code = await rpc(rpcUrl, "eth_getCode", [deployed, "latest"]);
    let codeCheck = "not checked (no deployedBytecode in the artifact)";
    if (art.deployedBytecode && art.deployedBytecode !== "0x") {
        if (code.toLowerCase() === art.deployedBytecode.toLowerCase()) codeCheck = "matches the artifact";
        else if (ethers.dataLength(code) !== ethers.dataLength(art.deployedBytecode)) codeCheck = "DIFFERS from the artifact";
        else if (art.immutables && Object.keys(art.immutables).length) {
            // immutable variables are written into the code by the constructor: compare without them
            const a = ethers.getBytes(code).slice(), b = ethers.getBytes(art.deployedBytecode).slice();
            for (const refs of Object.values(art.immutables)) for (const { start, length } of refs) { a.fill(0, start, start + length); b.fill(0, start, start + length); }
            codeCheck = ethers.hexlify(a) === ethers.hexlify(b) ? "matches the artifact (immutable values excluded)" : "DIFFERS from the artifact";
        } else codeCheck = "same length as the artifact, not identical (immutables? the artifact has no immutableReferences)";
    }

    const record = {
        name, address: deployed, chainId: Number(chainId), deployer: from, txHash: hash,
        blockNumber: Number(BigInt(receipt.blockNumber)), gasUsed: Number(BigInt(receipt.gasUsed)),
        deployedAt: new Date().toISOString(), artifact: path.basename(o.artifact), constructorArgs: args,
        codeHash: ethers.keccak256(code), codeCheck, abi: art.abi,
    };
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `${deployed.toLowerCase()}.json`);
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`deployed     ${deployed} in block ${record.blockNumber}, gas used ${record.gasUsed}
runtime code ${codeCheck}
record       ${file}  (commit it: chainlens shows the contract's functions from it)`);
    if (codeCheck.startsWith("DIFFERS")) process.exitCode = 3;
}

main().catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });
