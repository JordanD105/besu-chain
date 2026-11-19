// Contract deployment signed by an MPC account through the coordinator. Shared by chainlens' Deploy
// page (server.js) and the operator script besu-production/operator/deploy-contract.js, so both run
// exactly the same checks:
//   - the deployer is an MPC key of the coordinator and not SENDER01;
//   - the constructor arguments fit the ABI; the creation does not revert (eth_estimateGas);
//   - the gas stays within the MPC policy's MAX_GAS; no transaction of the deployer is pending;
//   - the signed transaction is the one requested; the code on chain is the artifact's.
"use strict";
const { ethers } = require("ethers");

const hex = (v) => (v && !String(v).startsWith("0x") ? `0x${v}` : v);

// abi, creation and runtime bytecode of one contract entry (solc output, Remix, Hardhat, Foundry)
function pick(c, name) {
    if (!c || typeof c !== "object") return null;
    const evm = c.evm || c.data || c;
    const bc = evm.bytecode?.object ?? evm.bytecode;
    const dbc = evm.deployedBytecode?.object ?? evm.deployedBytecode;
    if (!Array.isArray(c.abi) || typeof bc !== "string") return null;
    const immutables = evm.deployedBytecode?.immutableReferences || c.immutableReferences || null;
    return { name: c.contractName || name, abi: c.abi, bytecode: hex(bc), deployedBytecode: dbc ? hex(dbc) : null, immutables };
}

// Every deployable contract in a parsed artifact file
function listContracts(json, fallbackName) {
    const single = pick(json, fallbackName || "Contract");
    if (single) return single.bytecode !== "0x" ? [single] : [];
    const out = [];
    if (json && json.contracts && typeof json.contracts === "object") { // solc standard JSON: contracts[file][name]
        for (const f of Object.keys(json.contracts)) {
            for (const n of Object.keys(json.contracts[f] || {})) {
                const c = pick(json.contracts[f][n], n);
                if (c && c.bytecode !== "0x") out.push(c);
            }
        }
    }
    return out;
}

// The contract to deploy: the only one, or the one named `wanted`
function loadArtifact(json, wanted, fallbackName) {
    const all = listContracts(json, fallbackName);
    const hits = all.filter((c) => !wanted || c.name === wanted);
    if (hits.length === 1) return hits[0];
    if (!all.length) throw new Error("no abi + bytecode found: export the full compiler artifact, not only the ABI");
    if (!hits.length) throw new Error(`no contract named ${wanted}; the file holds ${all.map((c) => c.name).join(", ")}`);
    throw new Error(`several contracts in the file, choose one (deploy-contract.js: --contract): ${hits.map((c) => c.name).join(", ")}`);
}

function constructorInputs(abi) {
    const iface = new ethers.Interface(abi);
    return { inputs: iface.deploy.inputs.map((p) => ({ name: p.name || "", type: p.format("sighash"), baseType: p.baseType })), payable: iface.deploy.payable };
}

// Arguments typed as text (a form) to ABI values: arrays and tuples as JSON, booleans as true/false
function coerceArgs(abi, raw) {
    const inputs = new ethers.Interface(abi).deploy.inputs;
    return inputs.map((p, i) => {
        const v = raw[i];
        if (typeof v !== "string") return v;
        if (p.baseType === "array" || p.baseType === "tuple") return JSON.parse(v);
        if (p.baseType === "bool") return v.trim().toLowerCase() === "true";
        return v.trim();
    });
}

async function rpc(url, method, params) {
    const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(120000)
    });
    if (!r.ok) throw new Error(`${method}: HTTP ${r.status} from ${url}`);
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
}

// Checks everything and computes the transaction; signs and sends nothing.
async function prepare({ art, args, name, from, rpcUrl, coordinatorUrl, maxGas, sender01 }) {
    if (!ethers.isAddress(from || "")) throw new Error("no valid deployer address");
    from = ethers.getAddress(from);
    if (sender01 && ethers.isAddress(sender01) && ethers.getAddress(sender01) === from) {
        throw new Error("the deployer is SENDER01: the proxy sends from it and tracks its nonce. Use a dedicated MPC account (POST /createaccount)");
    }
    if (art.bytecode.includes("__$")) throw new Error("the bytecode has unlinked library placeholders (__$...$__): deploy and link the libraries first");
    if (!Array.isArray(args)) throw new Error("the constructor arguments must be a list");
    const iface = new ethers.Interface(art.abi);
    const ctor = iface.deploy.inputs.map((i) => `${i.type}${i.name ? ` ${i.name}` : ""}`).join(", ");
    let encoded;
    try {
        encoded = iface.encodeDeploy(args);
    } catch (e) {
        throw new Error(`constructor(${ctor}) does not take ${JSON.stringify(args)}: ${e.shortMessage || e.message}`);
    }
    const data = ethers.concat([art.bytecode, encoded]);
    maxGas = BigInt(maxGas || 30000000);

    const chainId = BigInt(await rpc(rpcUrl, "eth_chainId", []));
    const accounts = (await rpc(coordinatorUrl, "eth_accounts", [])).map((a) => ethers.getAddress(a));
    if (!accounts.includes(from)) throw new Error(`${from} is not an MPC key of the coordinator; create one with POST /createaccount`);
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
    return {
        name: name || art.name, ctor, args, data, from, chainId, nonce, gasPrice, balance, estimate, gas, maxGas,
        address: ethers.getCreateAddress({ from, nonce }), creationSize: ethers.dataLength(art.bytecode)
    };
}

// The plan in JSON-friendly form (for printing or an HTTP answer)
function planSummary(plan) {
    return {
        name: plan.name, constructor: plan.ctor, args: plan.args, chainId: plan.chainId.toString(), from: plan.from,
        nonce: plan.nonce.toString(), balance: ethers.formatEther(plan.balance), gas: plan.gas.toString(),
        estimate: plan.estimate.toString(), maxGas: plan.maxGas.toString(), gasPrice: plan.gasPrice.toString(),
        address: plan.address, creationSize: plan.creationSize
    };
}

// Signs through the coordinator (MPC threshold signature), sends, waits for the receipt, checks the
// code. Returns the registry record.
async function send(plan, art, { rpcUrl, coordinatorUrl, artifactName, onStatus }) {
    const status = onStatus || (() => {});
    const raw = await rpc(coordinatorUrl, "eth_signTransaction", [{
        from: plan.from, nonce: ethers.toQuantity(plan.nonce), gas: ethers.toQuantity(plan.gas),
        gasPrice: ethers.toQuantity(plan.gasPrice), value: "0x0", data: plan.data
    }]);
    const tx = ethers.Transaction.from(raw);
    if (tx.from !== plan.from || tx.to !== null || tx.nonce !== Number(plan.nonce) || tx.data !== ethers.hexlify(plan.data) || tx.chainId !== plan.chainId) {
        throw new Error("the signed transaction does not match the request: not sent");
    }
    const hash = await rpc(rpcUrl, "eth_sendRawTransaction", [raw]);
    status(`sent         ${hash}`);

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

    return {
        name: plan.name, address: deployed, chainId: Number(plan.chainId), deployer: plan.from, txHash: hash,
        blockNumber: Number(BigInt(receipt.blockNumber)), gasUsed: Number(BigInt(receipt.gasUsed)),
        deployedAt: new Date().toISOString(), artifact: artifactName || "", constructorArgs: plan.args.map(jsonArg),
        codeHash: ethers.keccak256(code), codeCheck, abi: art.abi
    };
}

function jsonArg(v) {
    if (typeof v === "bigint") return v.toString();
    if (Array.isArray(v)) return v.map(jsonArg);
    return v;
}

module.exports = { listContracts, loadArtifact, constructorInputs, coerceArgs, prepare, planSummary, send, rpc };
