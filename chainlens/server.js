const fs = require("fs");
const path = require("path");
const express = require("express");
const crypto = require("crypto");
const { ethers } = require("ethers");
const deployer = require("./deploy.js");

const BESU = process.env.BESU_RPC || "http://192.168.68.130:8545";
const PORT = Number(process.env.PORT) || 30100;
const HOST = process.env.LISTEN_HOST || "0.0.0.0";

const ZERO = "0x0000000000000000000000000000000000000000";
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

const erc721Iface = new ethers.Interface([
    "function name() view returns (string)",
    "function symbol() view returns (string)",
    "function tokenURI(uint256 tokenId) view returns (string)",
    "function ownerOf(uint256 tokenId) view returns (address)",
    "function supportsInterface(bytes4 interfaceId) view returns (bool)",
    "function balanceOf(address account) view returns (uint256)",
    "function mint(address to, uint256 tokenId, string uri) payable",
    "function mint(address to, uint256 tokenId, string uri, uint256 price)",
    "function buy(uint256 tokenId) payable",
    "function priceOf(uint256 tokenId) view returns (uint256)",
    "function transferFrom(address from, address to, uint256 tokenId)",
    "function safeTransferFrom(address from, address to, uint256 tokenId)",
    "function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)",
    "function approve(address to, uint256 tokenId)",
    "function setApprovalForAll(address operator, bool approved)",
    "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
    "event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId)",
    "event ApprovalForAll(address indexed owner, address indexed operator, bool approved)"
]);
const erc20Iface = new ethers.Interface([
    "function name() view returns (string)",
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function balanceOf(address account) view returns (uint256)",
    "event Transfer(address indexed from, address indexed to, uint256 value)"
]);

const db = {
    ready: false,
    syncing: false,
    error: null,
    head: 0,
    indexed: -1,
    chainId: null,
    genesis: null,
    blocks: [],
    txs: [],
    txByHash: new Map(),
    accounts: new Map(),
    contracts: new Map(),
    nfts: new Map(),
    node: null,
    peers: [],
    peerCount: 0
};

// ---- Contract registry: the records besu-production/operator/deploy-contract.js writes
// (contracts/deployments/<address>.json, mounted read-only). Gives contracts their name and ABI, so
// the contract page can list functions and run view/pure ones (eth_call, never a transaction).
const REGISTRY_DIR = process.env.REGISTRY_DIR || "/registry";
// records written by the Deploy page (writable; Ansible copies them back to the repository)
const REGISTRY_LOCAL_DIR = process.env.REGISTRY_LOCAL_DIR || "/registry-local";
const registry = { byAddress: new Map(), files: "", error: null };

function registryFiles() {
    const files = [];
    const problems = [];
    for (const dir of [REGISTRY_DIR, REGISTRY_LOCAL_DIR]) {
        try {
            for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
                files.push(path.join(dir, name));
            }
        } catch (error) {
            if (error.code !== "ENOENT") {
                problems.push(dir + ": " + error.message);
            }
        }
    }
    return { files, problems };
}

function loadRegistry() {
    const { files, problems } = registryFiles();
    const sig = files.map((file) => {
        try {
            const st = fs.statSync(file);
            return file + ":" + st.mtimeMs + ":" + st.size;
        } catch (error) {
            return file;
        }
    }).join("|") + "|" + problems.join("|");
    if (sig === registry.files) {
        return;
    }
    const next = new Map();
    for (const file of files) {
        try {
            const record = JSON.parse(fs.readFileSync(file, "utf8"));
            const iface = new ethers.Interface(record.abi || []);
            next.set(ethers.getAddress(record.address).toLowerCase(), { record, iface });
        } catch (error) {
            problems.push(path.basename(file) + ": " + error.message);
        }
    }
    registry.byAddress = next;
    registry.files = sig;
    registry.error = problems.length ? problems.join("; ") : null;
    if (problems.length) {
        console.error("contract registry:", registry.error);
    }
}

loadRegistry();
setInterval(loadRegistry, 15000).unref();

function contractEntry(address) {
    return registry.byAddress.get(String(address).toLowerCase()) || null;
}

function fragmentInfo(fragment) {
    return {
        name: fragment.name,
        signature: fragment.format("sighash"),
        stateMutability: fragment.stateMutability,
        inputs: fragment.inputs.map((p) => ({ name: p.name || "", type: p.format("sighash"), baseType: p.baseType })),
        outputs: (fragment.outputs || []).map((p) => ({ name: p.name || "", type: p.format("sighash") }))
    };
}

function jsonValue(value) {
    if (typeof value === "bigint") {
        return value.toString();
    }
    if (value instanceof Uint8Array) {
        return ethers.hexlify(value);
    }
    if (Array.isArray(value)) {
        return [...value].map(jsonValue);
    }
    return value;
}

const app = express();
app.use(express.static(path.join(__dirname, "public")));

function formatEth(wei) {
    const raw = ethers.formatEther(typeof wei === "bigint" ? wei : BigInt(wei));
    const negative = raw.startsWith("-");
    const [whole, frac = ""] = raw.replace("-", "").split(".");
    const wholeFmt = BigInt(whole).toLocaleString("en-US");
    const fracTrim = frac.replace(/0+$/, "").slice(0, 8);
    return (negative ? "-" : "") + (fracTrim ? `${wholeFmt}.${fracTrim}` : wholeFmt);
}

function checksum(address) {
    return ethers.getAddress(address);
}

function topicAddress(topic) {
    return checksum("0x" + topic.slice(-40));
}

function decodeMemo(input) {
    if (!input || input === "0x") {
        return null;
    }

    try {
        const bytes = ethers.getBytes(input);

        if (bytes.length === 0 || bytes.length > 4096) {
            return null;
        }

        for (const byte of bytes) {
            if (byte === 0 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13)) {
                return null;
            }
        }

        return ethers.toUtf8String(bytes);
    } catch (error) {
        return null;
    }
}

function fmtArg(value) {
    if (typeof value === "bigint") {
        return value.toString();
    }

    if (typeof value === "string") {
        return value;
    }

    if (value instanceof Uint8Array) {
        return ethers.hexlify(value);
    }

    return String(value);
}

function decodeInput(input) {
    if (!input || input === "0x") {
        return null;
    }

    for (const iface of [erc721Iface]) {
        try {
            const parsed = iface.parseTransaction({ data: input });
            return {
                name: parsed.name,
                args: parsed.fragment.inputs.map((inputDef, index) => ({
                    name: inputDef.name || String(index),
                    value: fmtArg(parsed.args[index])
                }))
            };
        } catch (error) {
            // Try the next ABI.
        }
    }

    return null;
}

function decodeLogs(logs) {
    return (logs || []).map((log) => {
        for (const iface of [erc721Iface, erc20Iface]) {
            try {
                const parsed = iface.parseLog(log);
                return {
                    address: checksum(log.address),
                    name: parsed.name,
                    args: parsed.fragment.inputs.map((inputDef, index) => ({
                        name: inputDef.name || String(index),
                        value: fmtArg(parsed.args[index])
                    }))
                };
            } catch (error) {
                // Not this event.
            }
        }

        return {
            address: checksum(log.address),
            name: log.topics && log.topics[0] ? log.topics[0].slice(0, 10) : "log",
            args: []
        };
    }).filter((log) => log.name === "Transfer" || log.args.length > 0 || log.name.startsWith("0x"));
}

function classify(tx) {
    if (!tx.to) {
        return { type: "create", functionName: "create", memo: "" };
    }

    const memo = decodeMemo(tx.input || tx.data);
    if ((tx.input || "0x") === "0x" || memo !== null) {
        return { type: "transfer", functionName: "send", memo: memo || "" };
    }

    const decoded = decodeInput(tx.input || tx.data);
    const selector = (tx.input || "0x").slice(0, 10);
    return {
        type: "call",
        functionName: decoded ? decoded.name : selector,
        memo: "",
        decoded
    };
}

// A non-JSON reply (e.g. Besu's "403 Host not authorized" when BESU_HOST_ALLOWLIST doesn't contain the
// host name in BESU_RPC) is reported as such instead of a JSON parse error.
async function readRpcResponse(response) {
    const text = await response.text();

    if (!response.ok) {
        throw new Error(`Besu ${BESU} replied HTTP ${response.status}: ${text.trim().slice(0, 200)}`);
    }

    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`Besu ${BESU} replied non-JSON: ${text.trim().slice(0, 200)}`);
    }
}

async function rpc(method, params) {
    const response = await fetch(BESU, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(30000)
    });
    const body = await readRpcResponse(response);

    if (body.error) {
        throw new Error(body.error.message || "RPC error");
    }

    return body.result;
}

// Besu rejects JSON-RPC batches larger than --rpc-http-max-batch-size (default 1024), so busy
// block ranges (many receipts) are sent in chunks.
const RPC_BATCH_SIZE = Math.max(1, Number(process.env.RPC_BATCH_SIZE) || 200);

async function rpcBatch(calls) {
    const results = [];

    for (let i = 0; i < calls.length; i += RPC_BATCH_SIZE) {
        results.push(...await rpcBatchChunk(calls.slice(i, i + RPC_BATCH_SIZE)));
    }

    return results;
}

async function rpcBatchChunk(calls) {
    if (calls.length === 0) {
        return [];
    }

    const payload = calls.map((call, id) => ({
        jsonrpc: "2.0",
        id,
        method: call.method,
        params: call.params
    }));
    const response = await fetch(BESU, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000)
    });
    const body = await readRpcResponse(response);
    const list = Array.isArray(body) ? body : [body];
    const byId = new Map(list.map((item) => [item.id, item]));

    return calls.map((call, id) => {
        const item = byId.get(id);

        if (!item) {
            throw new Error("Missing batch response");
        }

        if (item.error) {
            throw new Error(item.error.message || "RPC error");
        }

        return item.result;
    });
}

function ensureAccount(address) {
    if (!address || address.toLowerCase() === ZERO) {
        return null;
    }

    const key = address.toLowerCase();
    let row = db.accounts.get(key);

    if (!row) {
        row = {
            address: checksum(address),
            balanceWei: 0n,
            txCount: 0,
            erc20: new Set()
        };
        db.accounts.set(key, row);
    }

    return row;
}

function ensureContract(address, timestamp) {
    const key = address.toLowerCase();
    let row = db.contracts.get(key);

    if (!row) {
        row = {
            address: checksum(address),
            creator: null,
            createdAt: timestamp,
            lastAt: timestamp,
            txCount: 0,
            name: "",
            symbol: "",
            isErc721: false,
            isErc20: false,
            inspected: false
        };
        db.contracts.set(key, row);
    }

    return row;
}

function applyNftLog(log) {
    if (!log.topics || log.topics[0] !== TRANSFER_TOPIC) {
        return;
    }

    if (log.topics.length === 3) {
        const contract = ensureContract(log.address, 0);
        contract.isErc20 = true;
        const from = topicAddress(log.topics[1]);
        const to = topicAddress(log.topics[2]);
        const fromRow = ensureAccount(from);
        const toRow = ensureAccount(to);

        if (fromRow) {
            fromRow.erc20.add(contract.address.toLowerCase());
        }

        if (toRow) {
            toRow.erc20.add(contract.address.toLowerCase());
        }

        return;
    }

    if (log.topics.length < 4) {
        return;
    }

    const contract = ensureContract(log.address, 0);
    contract.isErc721 = true;
    const to = topicAddress(log.topics[2]);
    const tokenId = BigInt(log.topics[3]).toString();
    const key = contract.address.toLowerCase() + ":" + tokenId;
    ensureAccount(topicAddress(log.topics[1]));
    ensureAccount(to);

    if (to.toLowerCase() === ZERO) {
        db.nfts.delete(key);
        return;
    }

    const prev = db.nfts.get(key) || {
        contract: contract.address,
        tokenId,
        tokenURI: "",
        metadata: null
    };
    prev.owner = to;
    prev.contract = contract.address;
    prev.tokenId = tokenId;
    if (prev.amountWei === undefined) {
        prev.amountWei = 0n;
    }
    db.nfts.set(key, prev);
}

function mintPaymentWei(minter, recipient) {
    const buyer = recipient.toLowerCase();
    const seller = minter.toLowerCase();
    let refunded = 0n;

    for (let i = db.txs.length - 1; i >= 0; i--) {
        const tx = db.txs[i];

        if (tx.status !== "success" || !tx.to) {
            continue;
        }

        if (tx.decoded && tx.decoded.name === "mint") {
            break;
        }

        if (tx.type !== "transfer") {
            continue;
        }

        const from = tx.from.toLowerCase();
        const to = tx.to.toLowerCase();
        const value = BigInt(tx.value);

        if (from === seller && to === buyer) {
            refunded += value;
            continue;
        }

        if (from === buyer && to === seller) {
            if (refunded >= value) {
                refunded -= value;
                continue;
            }

            return value;
        }
    }

    return 0n;
}

function ingest(tx, receipt, block) {
    const kind = classify(tx);
    const from = checksum(tx.from);
    const to = tx.to ? checksum(tx.to) : null;
    const timestamp = parseInt(block.timestamp, 16);
    const fromRow = ensureAccount(from);

    if (fromRow) {
        fromRow.txCount += 1;
    }

    if (to && to.toLowerCase() !== from.toLowerCase()) {
        const toRow = ensureAccount(to);

        if (toRow && !db.contracts.has(to.toLowerCase())) {
            toRow.txCount += 1;
        }
    }

    if (!tx.to && receipt && receipt.contractAddress) {
        const created = ensureContract(receipt.contractAddress, timestamp);
        created.creator = from;
        created.createdAt = timestamp;
        created.lastAt = timestamp;
        created.txCount += 1;
    } else if (kind.type === "call" && to) {
        const called = ensureContract(to, timestamp);
        called.txCount += 1;
        called.lastAt = timestamp;
    }

    if (receipt && receipt.logs) {
        for (const log of receipt.logs) {
            applyNftLog(log);
        }
    }

    const row = {
        hash: tx.hash,
        blockNumber: parseInt(block.number, 16),
        timestamp,
        from,
        to,
        contractName: null,
        value: tx.value || "0x0",
        type: kind.type,
        functionName: kind.functionName,
        memo: kind.memo,
        decoded: kind.decoded || decodeInput(tx.input || tx.data),
        status: receipt && receipt.status && BigInt(receipt.status) === 0n ? "failed" : "success",
        contractAddress: receipt && receipt.contractAddress ? checksum(receipt.contractAddress) : null,
        events: decodeLogs(receipt && receipt.logs).filter((log) => log.name === "Transfer" || !log.name.startsWith("0x"))
    };

    if (row.decoded && row.decoded.name) {
        row.functionName = row.decoded.name;
    }

    if (row.status === "success" && row.decoded && row.decoded.name === "mint" && row.to) {
        const toArg = row.decoded.args.find((arg) => arg.name === "to");
        const idArg = row.decoded.args.find((arg) => arg.name === "tokenId");

        const priceArg = row.decoded.args.find((arg) => arg.name === "price");

        if (toArg && idArg) {
            const nft = db.nfts.get(row.to.toLowerCase() + ":" + idArg.value);

            if (nft) {
                // version-2 collections store the sale price in mint(); older ones were paid
                nft.amountWei = priceArg ? BigInt(priceArg.value) : mintPaymentWei(row.from, toArg.value);
            }
        }
    }

    db.txs.push(row);
    db.txByHash.set(row.hash.toLowerCase(), row);
}

async function ethCall(to, data) {
    return rpc("eth_call", [{ to, data }, "latest"]);
}

async function refreshContracts() {
    for (const contract of db.contracts.values()) {
        if (contract.inspected) {
            continue;
        }

        contract.inspected = true;

        try {
            const supported = await ethCall(
                contract.address,
                erc721Iface.encodeFunctionData("supportsInterface", ["0x80ac58cd"])
            );
            const value = erc721Iface.decodeFunctionResult("supportsInterface", supported)[0];
            if (value) {
                contract.isErc721 = true;
            }
        } catch (error) {
            // Not ERC-721.
        }

        try {
            const rawName = await ethCall(contract.address, erc721Iface.encodeFunctionData("name", []));
            const rawSymbol = await ethCall(contract.address, erc721Iface.encodeFunctionData("symbol", []));
            contract.name = erc721Iface.decodeFunctionResult("name", rawName)[0];
            contract.symbol = erc721Iface.decodeFunctionResult("symbol", rawSymbol)[0];
        } catch (error) {
            // No token metadata.
        }
    }
}

function parseMintMemo(memo) {
    const match = String(memo || "").match(/^New NFT Token mint: ([\s\S]*) - (https?:\/\/\S+)$/);

    if (!match) {
        return null;
    }

    return {
        name: match[1],
        description: "",
        image: match[2],
        attributes: []
    };
}

function metadataFromMintMemo(contract, tokenId) {
    const key = contract.toLowerCase();
    const id = String(tokenId);
    let mint = null;

    for (let index = db.txs.length - 1; index >= 0; index -= 1) {
        const tx = db.txs[index];

        if (tx.status !== "success" || !tx.decoded || tx.decoded.name !== "mint" || !tx.to || tx.to.toLowerCase() !== key) {
            continue;
        }

        const idArg = tx.decoded.args.find((arg) => arg.name === "tokenId");

        if (idArg && String(idArg.value) === id) {
            mint = tx;
            break;
        }
    }

    if (!mint) {
        return null;
    }

    const toArg = mint.decoded.args.find((arg) => arg.name === "to");

    if (!toArg) {
        return null;
    }

    const buyer = String(toArg.value).toLowerCase();
    const seller = mint.from.toLowerCase();
    let refunded = 0n;

    for (let index = db.txs.indexOf(mint) - 1; index >= 0; index -= 1) {
        const tx = db.txs[index];

        if (tx.status !== "success" || !tx.to) {
            continue;
        }

        if (tx.decoded && tx.decoded.name === "mint") {
            break;
        }

        if (tx.type !== "transfer") {
            continue;
        }

        const from = tx.from.toLowerCase();
        const to = tx.to.toLowerCase();
        const value = BigInt(tx.value);

        if (from === seller && to === buyer) {
            refunded += value;
            continue;
        }

        if (from === buyer && to === seller) {
            if (refunded >= value) {
                refunded -= value;
                continue;
            }

            return parseMintMemo(tx.memo);
        }
    }

    return null;
}

async function refreshNfts() {
    for (const nft of db.nfts.values()) {
        try {
            const rawOwner = await ethCall(
                nft.contract,
                erc721Iface.encodeFunctionData("ownerOf", [nft.tokenId])
            );
            nft.owner = erc721Iface.decodeFunctionResult("ownerOf", rawOwner)[0];
        } catch (error) {
            continue;
        }

        if (nft.metadata) {
            continue;
        }

        try {
            const rawUri = await ethCall(
                nft.contract,
                erc721Iface.encodeFunctionData("tokenURI", [nft.tokenId])
            );
            nft.tokenURI = erc721Iface.decodeFunctionResult("tokenURI", rawUri)[0];
            nft.metadata = await fetchMetadata(nft.tokenURI);
        } catch (error) {
            nft.metadata = nft.metadata || null;
        }

        if (!nft.metadata || (!nft.metadata.name && !nft.metadata.image)) {
            nft.metadata = metadataFromMintMemo(nft.contract, nft.tokenId) || nft.metadata;
        }
    }
}

function metadataAttributes(value) {
    if (!Array.isArray(value)) {
        return [];
    }

    return value.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
            return [];
        }

        if (typeof item.trait_type !== "string" || item.trait_type === "") {
            return [];
        }

        const kind = typeof item.value;

        if (kind !== "string" && kind !== "number" && kind !== "boolean") {
            return [];
        }

        const attribute = {
            trait_type: item.trait_type,
            value: item.value
        };

        if (typeof item.display_type === "string" && item.display_type !== "") {
            attribute.display_type = item.display_type;
        }

        if (typeof item.max_value === "string" || typeof item.max_value === "number") {
            attribute.max_value = item.max_value;
        }

        return [attribute];
    });
}

function metadataProperties(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return {};
    }

    const clean = {};

    for (const [key, item] of Object.entries(value)) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
            continue;
        }

        if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
            clean[key] = item;
        }
    }

    return clean;
}

function metadataFromJson(text) {
    if (!text || text.length > 600000) {
        return null;
    }

    const body = JSON.parse(text);

    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return null;
    }

    const properties = metadataProperties(body.properties);
    const metadata = {
        name: typeof body.name === "string" ? body.name : "",
        description: typeof body.description === "string" ? body.description : "",
        image: typeof body.image === "string" ? body.image : "",
        attributes: metadataAttributes(body.attributes)
    };

    if (Object.keys(properties).length > 0) {
        metadata.properties = properties;
    }

    return metadata;
}

function metadataFromDataUri(uri) {
    const comma = uri.indexOf(",");

    if (comma < 0) {
        return null;
    }

    const header = uri.slice(0, comma);
    let payload = uri.slice(comma + 1);

    if (/;base64/i.test(header)) {
        payload = Buffer.from(payload, "base64").toString("utf8");
    } else {
        payload = decodeURIComponent(payload);
    }

    return metadataFromJson(payload);
}

async function fetchMetadata(uri) {
    if (!uri) {
        return null;
    }

    if (uri.startsWith("data:")) {
        return metadataFromDataUri(uri);
    }

    if (uri.trim().startsWith("{")) {
        return metadataFromJson(uri);
    }

    if (!/^https?:\/\//i.test(uri)) {
        return null;
    }

    const response = await fetch(uri, { signal: AbortSignal.timeout(5000) });

    if (!response.ok) {
        return null;
    }

    return metadataFromJson(await response.text());
}

async function refreshBalances() {
    const rows = [...db.accounts.values()];

    for (let index = 0; index < rows.length; index += 40) {
        const slice = rows.slice(index, index + 40);
        const balances = await rpcBatch(slice.map((row) => ({
            method: "eth_getBalance",
            params: [row.address, "latest"]
        })));

        slice.forEach((row, offset) => {
            row.balanceWei = BigInt(balances[offset]);
        });
    }
}

async function refreshNetwork() {
    try {
        db.node = await rpc("admin_nodeInfo", []);
        db.peers = await rpc("admin_peers", []);
        db.peerCount = db.peers.length;
        db.adminApi = true;
    } catch (error) {
        // Production RPC nodes don't enable the ADMIN API (BESU_RPC_HTTP_API=ETH,NET,WEB3[,TXPOOL]):
        // only the peer count is available then.
        db.adminApi = false;
        db.node = null;
        db.peers = [];

        try {
            db.peerCount = parseInt(await rpc("net_peerCount", []), 16);
        } catch (inner) {
            db.peerCount = 0;
        }
    }
}

// The index lives in memory and only fetches blocks after db.indexed. If the chain is reset
// (e.g. besu-test-network remove.sh + run.sh) or replaced, those block numbers belong to a
// different chain, so start over instead of showing the old chain's data.
function resetIndex(reason) {
    console.log(`chain changed (${reason}): re-indexing from block 0`);
    Object.assign(db, {
        ready: false,
        head: 0,
        indexed: -1,
        chainId: null,
        genesis: null,
        blocks: [],
        txs: [],
        txByHash: new Map(),
        accounts: new Map(),
        contracts: new Map(),
        nfts: new Map()
    });
}

async function detectChainChange(head) {
    const genesis = (await rpc("eth_getBlockByNumber", ["0x0", false]))?.hash || null;

    if (db.genesis && genesis !== db.genesis) {
        resetIndex("different genesis block");
    } else if (db.indexed > head) {
        resetIndex(`chain head ${head} is below indexed block ${db.indexed}`);
    } else if (db.indexed >= 0 && db.blocks[db.indexed]) {
        const block = await rpc("eth_getBlockByNumber", ["0x" + db.indexed.toString(16), false]);

        if (!block || block.hash !== db.blocks[db.indexed].hash) {
            resetIndex(`block ${db.indexed} hash changed`);
        }
    }

    db.genesis = genesis;
}

async function syncOnce() {
    const head = parseInt(await rpc("eth_blockNumber", []), 16);
    await detectChainChange(head);

    if (db.chainId === null) {
        db.chainId = parseInt(await rpc("eth_chainId", []), 16);
    }

    db.head = head;

    for (let start = db.indexed + 1; start <= head; start += 20) {
        const end = Math.min(head, start + 19);
        const calls = [];

        for (let number = start; number <= end; number += 1) {
            calls.push({
                method: "eth_getBlockByNumber",
                params: ["0x" + number.toString(16), true]
            });
        }

        const blocks = await rpcBatch(calls);
        const pending = [];

        for (const block of blocks) {
            if (!block) {
                continue;
            }

            const number = parseInt(block.number, 16);
            db.blocks[number] = {
                number,
                hash: block.hash,
                timestamp: parseInt(block.timestamp, 16),
                txCount: block.transactions.length
            };

            for (const tx of block.transactions) {
                pending.push({ tx, block });
            }
        }

        const receipts = await rpcBatch(pending.map((item) => ({
            method: "eth_getTransactionReceipt",
            params: [item.tx.hash]
        })));

        pending.forEach((item, index) => ingest(item.tx, receipts[index], item.block));
        db.indexed = end;
    }

    await refreshContracts();
    await refreshNfts();
    await refreshBalances();
    await refreshNetwork();
    db.ready = true;
    db.error = null;
}

async function loop() {
    if (!db.syncing) {
        db.syncing = true;
        const previousError = db.error;

        try {
            await syncOnce();

            if (previousError) {
                console.log("Besu sync OK again");
            }
        } catch (error) {
            const message = error.cause ? `${error.message} (${error.cause.code || error.cause.message})` : error.message;

            if (message !== previousError) {
                console.error(`Besu sync failed: ${message}`);
            }

            db.error = message;
        }

        db.syncing = false;
    }

    setTimeout(loop, 4000);
}

function contractLabel(address) {
    if (!address) {
        return null;
    }

    const row = db.contracts.get(address.toLowerCase());
    const entry = contractEntry(address);

    if (row && row.name && row.symbol) {
        return `${row.name} (${row.symbol})`;
    }

    return (row && row.name) || (entry && entry.record.name) || null;
}

// A successful buy(tokenId) on an NFT collection: describe it like a payment memo so the
// explorer can show the NFT image ("NFT buy: <collection> #<id> - <image URL>").
function buyMemo(tx) {
    if (tx.status !== "success" || !tx.to || !tx.decoded || tx.decoded.name !== "buy") {
        return "";
    }

    const idArg = tx.decoded.args.find((arg) => arg.name === "tokenId");
    const nft = idArg ? db.nfts.get(tx.to.toLowerCase() + ":" + idArg.value) : null;
    const contract = db.contracts.get(tx.to.toLowerCase());
    const label = (contract && (contract.symbol || contract.name)) || tx.to;
    const base = `NFT buy: ${label} #${idArg ? idArg.value : "?"}`;
    const image = nft && nft.metadata && typeof nft.metadata.image === "string" ? nft.metadata.image : "";

    return /^https?:\/\/\S+$/.test(image) ? `${base} - ${image}` : base;
}

function publicTx(tx) {
    return {
        hash: tx.hash,
        blockNumber: tx.blockNumber,
        timestamp: tx.timestamp,
        from: tx.from,
        to: tx.to,
        toLabel: contractLabel(tx.to) || contractLabel(tx.contractAddress),
        value: formatEth(tx.value),
        valueWei: BigInt(tx.value).toString(),
        type: tx.type,
        functionName: tx.functionName,
        memo: tx.memo || buyMemo(tx),
        status: tx.status,
        contractAddress: tx.contractAddress,
        decoded: tx.decoded,
        events: tx.events
    };
}

function txCountFor(address) {
    const key = address.toLowerCase();
    return db.txs.filter((tx) => {
        return tx.from.toLowerCase() === key || (tx.to && tx.to.toLowerCase() === key);
    }).length;
}

function publicAccount(row) {
    return {
        address: row.address,
        balance: formatEth(row.balanceWei),
        balanceWei: row.balanceWei.toString(),
        tokens: row.erc20.size,
        nfts: nftsOf(row.address).length,
        transactions: txCountFor(row.address)
    };
}

function publicContract(row) {
    return {
        address: row.address,
        label: contractLabel(row.address) || row.address,
        name: row.name,
        symbol: row.symbol,
        type: row.isErc721 ? "ERC721" : (row.isErc20 ? "ERC20" : "Contract"),
        txCount: row.txCount,
        createdAt: row.createdAt,
        lastAt: row.lastAt,
        creator: row.creator,
        registered: Boolean(contractEntry(row.address))
    };
}

function publicNft(nft) {
    const contract = db.contracts.get(nft.contract.toLowerCase());
    return {
        contract: nft.contract,
        collection: contractLabel(nft.contract) || (contract && contract.name) || nft.contract,
        name: nft.metadata && nft.metadata.name ? nft.metadata.name : "",
        description: nft.metadata && nft.metadata.description ? nft.metadata.description : "",
        image: nft.metadata && nft.metadata.image ? nft.metadata.image : "",
        attributes: nft.metadata && nft.metadata.attributes ? nft.metadata.attributes : [],
        properties: nft.metadata && nft.metadata.properties ? nft.metadata.properties : {},
        tokenId: nft.tokenId,
        owner: nft.owner,
        amount: formatEth(nft.amountWei || 0n),
        amountWei: (nft.amountWei || 0n).toString(),
        type: "ERC721",
        tokenURI: nft.tokenURI || ""
    };
}

function nftsOf(address) {
    const key = address.toLowerCase();
    return [...db.nfts.values()].filter((nft) => nft.owner && nft.owner.toLowerCase() === key);
}

function pageOf(list, req) {
    const limit = Math.min(20000, Math.max(1, Number(req.query.limit) || 20));
    const page = Math.max(1, Number(req.query.page) || 1);
    const start = (page - 1) * limit;
    return {
        page,
        limit,
        total: list.length,
        items: list.slice(start, start + limit)
    };
}

app.get("/api/status", (req, res) => {
    res.json({
        ready: db.ready,
        syncing: db.syncing,
        error: db.error,
        head: db.head,
        indexed: db.indexed,
        chainId: db.chainId,
        transactions: db.txs.length,
        accounts: [...db.accounts.keys()].filter((key) => !db.contracts.has(key)).length,
        contracts: db.contracts.size,
        nfts: db.nfts.size,
        peers: db.peerCount,
        besu: BESU
    });
});

function chartDay(date) {
    const pad = (value) => String(value).padStart(2, "0");
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
}

function parseChartDay(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) {
        return null;
    }

    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(year, month - 1, day);

    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
        return null;
    }

    date.setHours(0, 0, 0, 0);
    return date;
}

function chartFor(fromText, toText) {
    const pad = (value) => String(value).padStart(2, "0");
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let from = parseChartDay(fromText) || new Date(today);
    let to = parseChartDay(toText) || new Date(today);

    if (from > to) {
        const swap = from;
        from = to;
        to = swap;
    }

    const span = Math.round((to - from) / 86400000) + 1;
    const bucketDays = span > 160 ? Math.ceil(span / 160) : 1;
    const hourly = from.getTime() === to.getTime();
    const buckets = [];

    if (hourly) {
        for (let hour = 0; hour < 24; hour += 1) {
            buckets.push({
                key: chartDay(from) + "-" + pad(hour),
                hour,
                transfer: 0,
                call: 0,
                create: 0
            });
        }
    } else {
        const cursor = new Date(from);

        while (cursor <= to) {
            buckets.push({
                key: chartDay(cursor),
                label: span > 366
                    ? cursor.getFullYear() + "." + pad(cursor.getMonth() + 1) + "." + pad(cursor.getDate())
                    : pad(cursor.getMonth() + 1) + "." + pad(cursor.getDate()),
                transfer: 0,
                call: 0,
                create: 0
            });
            cursor.setDate(cursor.getDate() + bucketDays);
        }
    }

    const byKey = new Map(buckets.map((bucket) => [bucket.key, bucket]));

    for (const tx of db.txs) {
        const date = new Date(tx.timestamp * 1000);
        const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        let key = "";

        if (hourly) {
            key = chartDay(date) + "-" + pad(date.getHours());
        } else if (day >= from && day <= to) {
            const offset = Math.floor(Math.round((day - from) / 86400000) / bucketDays) * bucketDays;
            const bucketDay = new Date(from);
            bucketDay.setDate(from.getDate() + offset);
            key = chartDay(bucketDay);
        }

        const bucket = byKey.get(key);

        if (bucket && Object.prototype.hasOwnProperty.call(bucket, tx.type)) {
            bucket[tx.type] += 1;
        }
    }

    return buckets.map(({ key, ...bucket }) => bucket);
}

app.get("/api/dashboard", (req, res) => {
    const tokenContracts = [...db.contracts.values()].filter((row) => row.isErc721 || row.isErc20);
    const erc721 = tokenContracts.filter((row) => row.isErc721).length;
    const erc20 = tokenContracts.filter((row) => row.isErc20 && !row.isErc721).length;

    const contracts = [...db.contracts.values()]
        .map(publicContract)
        .sort((a, b) => b.txCount - a.txCount)
        .slice(0, 5);

    res.json({
        transactions: db.txs.length,
        tokens: tokenContracts.length,
        contracts: db.contracts.size,
        peers: db.peerCount,
        nfts: db.nfts.size,
        chart: chartFor(req.query.from, req.query.to),
        contractsActive: contracts,
        pie: [
            { kind: "erc721", count: erc721 },
            { kind: "erc20", count: erc20 }
        ].filter((item) => item.count > 0)
    });
});

app.get("/api/accounts", (req, res) => {
    const rows = [...db.accounts.values()]
        .filter((row) => !db.contracts.has(row.address.toLowerCase()))
        .map(publicAccount)
        .sort((a, b) => (BigInt(b.balanceWei) > BigInt(a.balanceWei) ? 1 : -1));
    res.json(pageOf(rows, req));
});

app.get("/api/accounts/:address", async (req, res) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(req.params.address)) {
        return res.status(400).json({ error: "invalid address" });
    }

    const key = req.params.address.toLowerCase();
    let row = db.accounts.get(key);

    if (!row) {
        try {
            const balance = await rpc("eth_getBalance", [req.params.address, "latest"]);
            row = {
                address: checksum(req.params.address),
                balanceWei: BigInt(balance),
                txCount: 0,
                erc20: new Set()
            };
        } catch (error) {
            return res.status(404).json({ error: "account not found" });
        }
    }

    const txs = db.txs.filter((tx) => {
        const from = tx.from.toLowerCase();
        const to = tx.to ? tx.to.toLowerCase() : "";
        return from === key || to === key;
    }).reverse().map(publicTx);

    res.json({
        ...publicAccount(row),
        transactionsList: txs,
        nftList: nftsOf(row.address).map(publicNft),
        tokenList: [...row.erc20].map((token) => {
            const contract = db.contracts.get(token);
            return {
                address: contract.address,
                name: contract.name,
                symbol: contract.symbol,
                type: "ERC20"
            };
        })
    });
});

app.get("/api/contracts", (req, res) => {
    let rows = [...db.contracts.values()].map(publicContract);

    if (req.query.type === "ERC721") {
        rows = rows.filter((row) => row.type === "ERC721");
    }

    rows.sort((a, b) => b.txCount - a.txCount);
    res.json(pageOf(rows, req));
});

app.get("/api/contracts/:address", async (req, res) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(req.params.address)) {
        return res.status(400).json({ error: "invalid address" });
    }
    const address = checksum(req.params.address);
    const row = db.contracts.get(address.toLowerCase());
    const entry = contractEntry(address);
    let code = "0x";
    try {
        code = await rpc("eth_getCode", [address, "latest"]);
    } catch (error) {
        return res.status(502).json({ error: error.message });
    }
    if (code === "0x" && !row && !entry) {
        return res.status(404).json({ error: "no contract at this address" });
    }
    const out = {
        ...(row ? publicContract(row) : { address, label: address, name: "", symbol: "", type: "Contract", txCount: 0 }),
        codeSize: code === "0x" ? 0 : ethers.dataLength(code),
        registered: Boolean(entry),
        registryError: registry.error
    };
    if (entry) {
        const r = entry.record;
        out.label = contractLabel(address) || out.label;
        out.record = {
            name: r.name, deployer: r.deployer, txHash: r.txHash, blockNumber: r.blockNumber,
            deployedAt: r.deployedAt, artifact: r.artifact, constructorArgs: r.constructorArgs, codeCheck: r.codeCheck
        };
        // the code on chain is the code that was recorded (not replaced by a different contract)
        out.codeMatchesRecord = r.codeHash ? ethers.keccak256(code) === r.codeHash : null;
        const fns = entry.iface.fragments.filter((f) => f.type === "function");
        out.read = fns.filter((f) => f.stateMutability === "view" || f.stateMutability === "pure").map(fragmentInfo);
        out.write = fns.filter((f) => f.stateMutability !== "view" && f.stateMutability !== "pure").map(fragmentInfo);
        out.events = entry.iface.fragments.filter((f) => f.type === "event").map((f) => f.format("sighash"));
    }
    res.json(out);
});

// Runs a view/pure function of a registered contract (eth_call on the latest block): read only.
app.post("/api/contracts/:address/call", express.json({ limit: "64kb" }), async (req, res) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(req.params.address)) {
        return res.status(400).json({ error: "invalid address" });
    }
    const entry = contractEntry(req.params.address);
    if (!entry) {
        return res.status(404).json({ error: "contract not in the registry (no ABI)" });
    }
    const signature = String((req.body && req.body.signature) || "");
    let fragment;
    try {
        fragment = entry.iface.getFunction(signature);
    } catch (error) {
        fragment = null;
    }
    if (!fragment) {
        return res.status(400).json({ error: "unknown function " + signature });
    }
    if (fragment.stateMutability !== "view" && fragment.stateMutability !== "pure") {
        return res.status(403).json({ error: "only view and pure functions can be called here" });
    }
    const raw = Array.isArray(req.body.args) ? req.body.args : [];
    let data;
    try {
        const args = fragment.inputs.map((p, i) => {
            const v = raw[i];
            if (p.baseType === "array" || p.baseType === "tuple") {
                return typeof v === "string" ? JSON.parse(v) : v;
            }
            if (p.baseType === "bool") {
                return v === true || String(v).trim().toLowerCase() === "true";
            }
            return typeof v === "string" ? v.trim() : v;
        });
        data = entry.iface.encodeFunctionData(fragment, args);
    } catch (error) {
        return res.status(400).json({ error: "arguments: " + (error.shortMessage || error.message) });
    }
    try {
        const result = await ethCall(checksum(req.params.address), data);
        const decoded = entry.iface.decodeFunctionResult(fragment, result);
        res.json({
            signature: fragment.format("sighash"),
            block: db.head,
            outputs: fragment.outputs.map((p, i) => ({ name: p.name || String(i), type: p.format("sighash"), value: jsonValue(decoded[i]) }))
        });
    } catch (error) {
        res.status(400).json({ error: "call failed: " + (error.shortMessage || error.message) });
    }
});

// ---- Deploy page (off unless DEPLOY_ENABLED=true). Deploys a contract signed by ONE fixed MPC
// account (DEPLOYER) through the coordinator, with the checks of deploy.js. Allowed only from the
// operator's IP (DEPLOY_ALLOWED_IPS) and with the token (DEPLOY_TOKEN). The record goes to
// REGISTRY_LOCAL_DIR; the Ansible deployment copies it back to the repository.
// The admin pages (Deploy, Sections) share one gate: the token and the allowed source addresses.
const DEPLOY = {
    enabled: String(process.env.DEPLOY_ENABLED || "").toLowerCase() === "true",
    token: process.env.ADMIN_TOKEN || process.env.DEPLOY_TOKEN || "",
    from: process.env.DEPLOYER || "",
    coordinator: process.env.COORDINATOR_URL || "",
    rpc: process.env.DEPLOY_RPC || BESU,
    sender01: process.env.SENDER01 || "",
    maxGas: process.env.MAX_GAS || "30000000",
    allowed: (process.env.ADMIN_ALLOWED_IPS || process.env.DEPLOY_ALLOWED_IPS || "").split(/[\s,]+/).filter(Boolean),
    busy: false
};
// Sections page (SECTIONS_ENABLED): forwards to the proxy's admin API, server-side (the proxy's
// token never reaches the browser).
const SECTIONS = {
    enabled: String(process.env.SECTIONS_ENABLED || "").toLowerCase() === "true",
    proxy: String(process.env.PROXY_ADMIN_URL || "").replace(/\/$/, ""),
    proxyToken: process.env.PROXY_ADMIN_TOKEN || ""
};
if (SECTIONS.enabled && (!DEPLOY.token || DEPLOY.token.length < 16 || !DEPLOY.allowed.length || !SECTIONS.proxy || !SECTIONS.proxyToken)) {
    console.error("Sections page: ADMIN_TOKEN (16+ characters), ADMIN_ALLOWED_IPS, PROXY_ADMIN_URL and PROXY_ADMIN_TOKEN are required; the page stays off");
    SECTIONS.enabled = false;
}
if (DEPLOY.enabled && (!DEPLOY.token || DEPLOY.token.length < 16 || !ethers.isAddress(DEPLOY.from) || !DEPLOY.coordinator || !DEPLOY.allowed.length)) {
    console.error("Deploy page: DEPLOY_TOKEN (16+ characters), DEPLOYER, COORDINATOR_URL and DEPLOY_ALLOWED_IPS are required; the page stays off");
    DEPLOY.enabled = false;
}

function ipv4ToInt(ip) {
    const parts = ip.split(".").map(Number);
    return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
        ? ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0 : null;
}

function ipAllowed(ip) {
    const addr = ipv4ToInt(String(ip || "").replace(/^::ffff:/, ""));
    if (addr === null) {
        return false;
    }
    return DEPLOY.allowed.some((entry) => {
        const [net, bits = "32"] = entry.split("/");
        const base = ipv4ToInt(net);
        const n = Number(bits);
        if (base === null || !(n >= 0 && n <= 32)) {
            return false;
        }
        const mask = n === 0 ? 0 : (0xffffffff << (32 - n)) >>> 0;
        return ((addr & mask) >>> 0) === ((base & mask) >>> 0);
    });
}

function tokenOk(req) {
    const given = Buffer.from(String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
    const want = Buffer.from(DEPLOY.token);
    return given.length === want.length && crypto.timingSafeEqual(given, want);
}

function deployGuard(req, res, next) {
    if (!DEPLOY.enabled) {
        return res.status(404).json({ error: "the Deploy page is off (chainlens_deploy_enabled)" });
    }
    if (!ipAllowed(req.socket.remoteAddress)) {
        return res.status(403).json({ error: "deploying is only allowed from operator_ip and chainlens_deploy_ips" });
    }
    if (!tokenOk(req)) {
        console.warn("deploy: wrong token from", req.socket.remoteAddress);
        return setTimeout(() => res.status(401).json({ error: "wrong deploy token" }), 1000);
    }
    next();
}

// The contract to deploy and its typed arguments, from a request body
function deployInput(body) {
    const json = body && body.artifact;
    if (!json || typeof json !== "object") {
        throw new Error("no artifact: choose the compiler's JSON file");
    }
    const art = deployer.loadArtifact(json, body.contract || "", String(body.artifactName || "Contract").replace(/\.json$/i, ""));
    let args;
    try {
        args = deployer.coerceArgs(art.abi, Array.isArray(body.args) ? body.args : []);
    } catch (error) {
        throw new Error("constructor arguments: arrays and tuples are written as JSON (" + error.message + ")");
    }
    const name = String(body.name || "").trim().slice(0, 80) || art.name;
    return { art, args, name };
}

async function deployPlan(input) {
    return deployer.prepare({
        art: input.art, args: input.args, name: input.name, from: DEPLOY.from, rpcUrl: DEPLOY.rpc,
        coordinatorUrl: DEPLOY.coordinator, maxGas: DEPLOY.maxGas, sender01: DEPLOY.sender01
    });
}

// ---- Sections page (docs/sections.md): the operator's and chainlens_deploy_ips' browsers, with the
// admin token. Every action is forwarded to the proxy's admin API.
function sectionsGuard(req, res, next) {
    if (!SECTIONS.enabled) {
        return res.status(404).json({ error: "the Sections page is off (chainlens_sections_enabled)" });
    }
    if (!ipAllowed(req.socket.remoteAddress)) {
        return res.status(403).json({ error: "the Sections page is only allowed from operator_ip and chainlens_deploy_ips" });
    }
    if (!tokenOk(req)) {
        console.warn("sections: wrong token from", req.socket.remoteAddress);
        return setTimeout(() => res.status(401).json({ error: "wrong admin token" }), 1000);
    }
    next();
}

async function proxyAdmin(method, pathname, body) {
    const response = await fetch(SECTIONS.proxy + pathname, {
        method,
        headers: { authorization: "Bearer " + SECTIONS.proxyToken, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(300000)
    });
    const data = await response.json().catch(() => ({ error: "the proxy answered HTTP " + response.status }));
    return { status: response.status, data };
}

app.get("/api/sections/status", (req, res) => {
    res.json({ enabled: SECTIONS.enabled && ipAllowed(req.socket.remoteAddress) });
});

const sectionsJson = express.json({ limit: "64kb" });
const SECTION_ACTIONS = ["key", "ips", "active", "topup", "sweep", "payback"];

app.get("/api/sections", sectionsGuard, async (req, res) => {
    try {
        const r = await proxyAdmin("GET", "/admin/sections?fresh=1");
        res.status(r.status).json(r.data);
    } catch (error) {
        res.status(502).json({ error: "proxy: " + error.message });
    }
});

app.post("/api/sections", sectionsJson, sectionsGuard, async (req, res) => {
    try {
        const r = await proxyAdmin("POST", "/admin/sections", { name: req.body.name, allowedIps: req.body.allowedIps });
        console.log("sections: create", JSON.stringify(req.body.name), "from", req.socket.remoteAddress, "->", r.status);
        res.status(r.status).json(r.data);
    } catch (error) {
        res.status(502).json({ error: "proxy: " + error.message });
    }
});

app.get("/api/sections/:id", sectionsGuard, async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) {
        return res.status(400).json({ error: "invalid section id" });
    }
    try {
        const r = await proxyAdmin("GET", "/admin/sections/" + req.params.id);
        res.status(r.status).json(r.data);
    } catch (error) {
        res.status(502).json({ error: "proxy: " + error.message });
    }
});

app.post("/api/sections/:id/:action", sectionsJson, sectionsGuard, async (req, res) => {
    if (!/^\d+$/.test(req.params.id) || !SECTION_ACTIONS.includes(req.params.action)) {
        return res.status(404).json({ error: "unknown section action" });
    }
    try {
        const r = await proxyAdmin("POST", "/admin/sections/" + req.params.id + "/" + req.params.action, req.body || {});
        console.log("sections:", req.params.action, "section", req.params.id, JSON.stringify(req.body || {}), "from", req.socket.remoteAddress, "->", r.status);
        res.status(r.status).json(r.data);
    } catch (error) {
        res.status(502).json({ error: "proxy: " + error.message });
    }
});

// Money history of a section: every indexed transaction of its three accounts, labelled
app.get("/api/sections/:id/history", sectionsGuard, async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) {
        return res.status(400).json({ error: "invalid section id" });
    }
    try {
        const r = await proxyAdmin("GET", "/admin/sections/" + req.params.id);
        if (r.status !== 200) {
            return res.status(r.status).json(r.data);
        }
        const acc = r.data.section.accounts;
        const up = acc.upfront.toLowerCase();
        const co = acc.consumption.toLowerCase();
        const pa = acc.payment.toLowerCase();
        const s01 = String(process.env.SENDER01 || "").toLowerCase();
        const kind = (from, to) => {
            if (to === up && from === s01) return "top-up";
            if (from === co && to === pa) return "sweep";
            if (from === pa && to === s01) return "pay back";
            if (from === up) return "upfront -> account";
            if (to === co) return "account -> consumption";
            if (to === up || to === pa) return "received";
            return "other";
        };
        const rows = db.txs.filter((tx) => {
            const from = tx.from.toLowerCase();
            const to = tx.to ? tx.to.toLowerCase() : "";
            return [up, co, pa].includes(from) || [up, co, pa].includes(to);
        }).slice(-500).reverse().map((tx) => ({
            ...publicTx(tx),
            kind: kind(tx.from.toLowerCase(), tx.to ? tx.to.toLowerCase() : "")
        }));
        res.json({ section: r.data.section, history: rows, indexed: db.indexed, head: db.head });
    } catch (error) {
        res.status(502).json({ error: "proxy: " + error.message });
    }
});

app.get("/api/deploy/status", (req, res) => {
    if (!DEPLOY.enabled || !ipAllowed(req.socket.remoteAddress)) {
        return res.json({ enabled: false });
    }
    res.json({ enabled: true, deployer: ethers.getAddress(DEPLOY.from), busy: DEPLOY.busy });
});

const deployJson = express.json({ limit: "25mb" });

// The contracts in an artifact and their constructor arguments
app.post("/api/deploy/inspect", deployJson, deployGuard, (req, res) => {
    try {
        const json = req.body && req.body.artifact;
        const contracts = deployer.listContracts(json, String(req.body.artifactName || "Contract").replace(/\.json$/i, ""));
        if (!contracts.length) {
            throw new Error("no abi + bytecode found: export the full compiler artifact, not only the ABI");
        }
        res.json({ contracts: contracts.map((c) => ({ name: c.name, ...deployer.constructorInputs(c.abi), size: ethers.dataLength(c.bytecode), runtimeCheck: Boolean(c.deployedBytecode) })) });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Dry run: every check, nothing signed or sent
app.post("/api/deploy/check", deployJson, deployGuard, async (req, res) => {
    try {
        const plan = await deployPlan(deployInput(req.body));
        res.json(deployer.planSummary(plan));
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Deploy: the same checks again; the address must be the one the check showed (nothing changed)
app.post("/api/deploy/send", deployJson, deployGuard, async (req, res) => {
    if (DEPLOY.busy) {
        return res.status(409).json({ error: "another deployment is running: try again when it is done" });
    }
    DEPLOY.busy = true;
    try {
        const input = deployInput(req.body);
        const plan = await deployPlan(input);
        if (!req.body.expectAddress || plan.address.toLowerCase() !== String(req.body.expectAddress).toLowerCase()) {
            return res.status(409).json({ error: "the deployer's state changed since the check (address " + plan.address + "): check again" });
        }
        console.log("deploy:", plan.name, "->", plan.address, "from", req.socket.remoteAddress);
        const record = await deployer.send(plan, input.art, { rpcUrl: DEPLOY.rpc, coordinatorUrl: DEPLOY.coordinator, artifactName: String(req.body.artifactName || "") });
        let saved = true;
        try {
            fs.mkdirSync(REGISTRY_LOCAL_DIR, { recursive: true });
            fs.writeFileSync(path.join(REGISTRY_LOCAL_DIR, record.address.toLowerCase() + ".json"), JSON.stringify(record, null, 2) + "\n");
            loadRegistry();
        } catch (error) {
            saved = false;
            console.error("deploy: record not saved:", error.message);
        }
        const { abi, ...rest } = record;
        res.json({ ...rest, saved });
    } catch (error) {
        res.status(400).json({ error: error.message });
    } finally {
        DEPLOY.busy = false;
    }
});

app.get("/api/transactions", (req, res) => {
    let rows = db.txs.slice().reverse();

    if (req.query.type && req.query.type !== "all") {
        rows = rows.filter((tx) => tx.type === req.query.type);
    }

    if (req.query.address && /^0x[0-9a-fA-F]{40}$/.test(req.query.address)) {
        const key = req.query.address.toLowerCase();
        rows = rows.filter((tx) => tx.from.toLowerCase() === key || (tx.to && tx.to.toLowerCase() === key));
    }

    res.json(pageOf(rows.map(publicTx), req));
});

app.get("/api/transactions/:hash", (req, res) => {
    const tx = db.txByHash.get(req.params.hash.toLowerCase());

    if (!tx) {
        return res.status(404).json({ error: "transaction not found" });
    }

    res.json(publicTx(tx));
});

app.get("/api/blocks", (req, res) => {
    const rows = [];

    for (let number = db.head; number >= 0; number -= 1) {
        if (db.blocks[number]) {
            rows.push(db.blocks[number]);
        }
    }

    res.json(pageOf(rows, req));
});

app.get("/api/blocks/:id", (req, res) => {
    const id = req.params.id;
    let block = null;

    if (/^\d+$/.test(id)) {
        block = db.blocks[Number(id)] || null;
    } else if (/^0x[0-9a-fA-F]{64}$/.test(id)) {
        block = db.blocks.find((item) => item && item.hash.toLowerCase() === id.toLowerCase()) || null;
    }

    if (!block) {
        return res.status(404).json({ error: "block not found" });
    }

    const txs = db.txs.filter((tx) => tx.blockNumber === block.number).map(publicTx);
    res.json({ ...block, transactions: txs });
});

app.get("/api/network", (req, res) => {
    const node = db.node || {};
    res.json({
        name: node.name || "",
        enode: node.enode || "",
        id: node.id || "",
        address: node.listenAddr || (node.ports && node.ports.listener) || "",
        peerCount: db.peerCount,
        adminApi: db.adminApi !== false,
        peers: (db.peers || []).map((peer) => ({
            id: peer.id,
            name: peer.name,
            address: peer.network && (peer.network.remoteAddress || peer.network.localAddress) || ""
        }))
    });
});

app.get("/api/nfts", (req, res) => {
    let rows = [...db.nfts.values()].map(publicNft);

    if (req.query.owner && /^0x[0-9a-fA-F]{40}$/.test(req.query.owner)) {
        const key = req.query.owner.toLowerCase();
        rows = rows.filter((nft) => nft.owner.toLowerCase() === key);
    }

    rows.sort((a, b) => Number(a.tokenId) - Number(b.tokenId));
    res.json(pageOf(rows, req));
});

app.get("/api/nfts/:contract/:tokenId", (req, res) => {
    const key = req.params.contract.toLowerCase() + ":" + req.params.tokenId;
    const nft = db.nfts.get(key);

    if (!nft) {
        return res.status(404).json({ error: "token not found" });
    }

    res.json(publicNft(nft));
});

app.get("/api/search", (req, res) => {
    const q = String(req.query.q || "").trim();
    const results = [];

    if (/^0x[0-9a-fA-F]{40}$/.test(q)) {
        results.push({ kind: "account", href: "#/accounts/" + checksum(q) });
    } else if (/^0x[0-9a-fA-F]{64}$/.test(q)) {
        if (db.txByHash.has(q.toLowerCase())) {
            results.push({ kind: "transaction", href: "#/transactions/" + q });
        }

        const block = db.blocks.find((item) => item && item.hash.toLowerCase() === q.toLowerCase());

        if (block) {
            results.push({ kind: "block", href: "#/blocks/" + block.number });
        }
    } else if (/^\d+$/.test(q)) {
        if (db.blocks[Number(q)]) {
            results.push({ kind: "block", href: "#/blocks/" + q });
        }

        for (const nft of db.nfts.values()) {
            if (nft.tokenId === q) {
                results.push({
                    kind: "nft",
                    href: "#/nfts/" + nft.contract + "/" + nft.tokenId
                });
            }
        }
    } else if (q) {
        const needle = q.toLowerCase();

        for (const nft of db.nfts.values()) {
            const name = nft.metadata && nft.metadata.name ? nft.metadata.name.toLowerCase() : "";

            if (name.includes(needle)) {
                results.push({
                    kind: "nft",
                    href: "#/nfts/" + nft.contract + "/" + nft.tokenId
                });
            }
        }
    }

    res.json({ results });
});

app.listen(PORT, HOST, () => {
    console.log(`Chainlens http://${HOST}:${PORT}`);
    console.log(`Besu ${BESU}`);
    console.log(SECTIONS.enabled ? `Sections page on: proxy ${SECTIONS.proxy}, from ${DEPLOY.allowed.join(" ")}` : "Sections page off");
    console.log(DEPLOY.enabled ? `Deploy page on: deployer ${DEPLOY.from}, from ${DEPLOY.allowed.join(" ")}` : "Deploy page off");
    loop();
});
