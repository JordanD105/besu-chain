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
    "function buy(uint256 tokenId, address payee) payable",
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

// Contracts registered on chain (SectionRegistry ContractRegistered events: deployed through the proxy)
const REGISTRY_CONTRACT = (process.env.REGISTRY_CONTRACT || "").trim();
const REGISTRY_FROM_BLOCK = Math.max(0, parseInt(process.env.REGISTRY_FROM_BLOCK || "0", 10) || 0);
const registryEvents = new ethers.Interface([
    "event ContractRegistered(address indexed contractAddress, uint8 kind, string name, string abiJson)",
    "event AdminChanged(address indexed previous, address indexed admin)",
    "event SectionCreated(uint256 indexed id, string name, address upfront, address consumption, address payment)",
    "event SectionRenamed(uint256 indexed id, string name)",
    "event SectionActiveChanged(uint256 indexed id, bool active)",
    "event SectionAccountReplaced(uint256 indexed id, uint8 role, address previous, address account)",
    "event SectionArchived(uint256 indexed id)",
    "event AccountAdded(uint256 indexed id, address indexed account)"
]);
const chainRegistry = { byAddress: new Map(), scannedTo: -1, running: null };
// Sections (docs/sections.md), from the same registry: id -> { name, active, archived }, and
// address -> { id, role } for every section account (user, upfront, consumption, payment, retired)
const sectionBook = { sections: new Map(), accounts: new Map(), admin: null, added: [] };
const SECTION_ROLE_NAMES = { 2: "upfront", 3: "consumption", 4: "payment" };
const CONTRACT_CENTER = (process.env.CONTRACT_CENTER || "").trim();

function applySectionEvent(parsed) {
    const a = parsed.args;
    const setAccount = (address, id, role) => sectionBook.accounts.set(ethers.getAddress(address).toLowerCase(), { id: Number(id), role });
    switch (parsed.name) {
        case "AdminChanged":
            sectionBook.admin = ethers.getAddress(a.admin);
            break;
        case "SectionCreated":
            sectionBook.sections.set(Number(a.id), { name: a.name, active: true, archived: false });
            setAccount(a.upfront, a.id, "upfront");
            setAccount(a.consumption, a.id, "consumption");
            setAccount(a.payment, a.id, "payment");
            break;
        case "SectionRenamed": {
            const s = sectionBook.sections.get(Number(a.id));
            if (s) {
                s.name = a.name;
            }
            break;
        }
        case "SectionActiveChanged": {
            const s = sectionBook.sections.get(Number(a.id));
            if (s) {
                s.active = a.active;
            }
            break;
        }
        case "SectionArchived": {
            const s = sectionBook.sections.get(Number(a.id));
            if (s) {
                s.archived = true;
                s.active = false;
            }
            break;
        }
        case "SectionAccountReplaced":
            setAccount(a.previous, a.id, "retired");
            setAccount(a.account, a.id, SECTION_ROLE_NAMES[Number(a.role)] || "retired");
            break;
        case "AccountAdded":
            setAccount(a.account, a.id, "user");
            break;
        default:
            break;
    }
}

// The section information of an address (null when it belongs to none), or a special account
function sectionOf(address) {
    const key = String(address || "").toLowerCase();
    const entry = sectionBook.accounts.get(key);
    if (entry) {
        const s = sectionBook.sections.get(entry.id) || { name: "#" + entry.id, active: false, archived: false };
        return { sectionId: entry.id, section: s.name, role: entry.role, sectionActive: s.active, sectionArchived: s.archived };
    }
    const special = (process.env.SENDER01 && key === process.env.SENDER01.toLowerCase()) ? "sender01"
        : (CONTRACT_CENTER && key === CONTRACT_CENTER.toLowerCase()) ? "contract center"
            : (sectionBook.admin && key === sectionBook.admin.toLowerCase()) ? "registry admin" : null;
    return special ? { sectionId: null, section: null, role: special } : null;
}

function chainRegistryScan() {
    if (!ethers.isAddress(REGISTRY_CONTRACT)) {
        return Promise.resolve();
    }
    if (!chainRegistry.running) {
        chainRegistry.running = (async () => {
            const head = parseInt(await rpc("eth_blockNumber", []), 16);
            const topics = [registryEvents.fragments.filter((f) => f.type === "event").map((f) => f.topicHash)];
            for (let start = chainRegistry.scannedTo >= 0 ? chainRegistry.scannedTo + 1 : REGISTRY_FROM_BLOCK; start <= head; start += 1000) {
                const end = Math.min(start + 999, head);
                const logs = await rpc("eth_getLogs", [{ address: REGISTRY_CONTRACT, fromBlock: ethers.toQuantity(start), toBlock: ethers.toQuantity(end), topics }]);
                for (const log of logs) {
                    try {
                        const parsed = registryEvents.parseLog(log);
                        if (parsed.name !== "ContractRegistered") {
                            applySectionEvent(parsed);
                            if (parsed.name === "AccountAdded") {
                                sectionBook.added.push({ id: Number(parsed.args.id), account: parsed.args.account.toLowerCase(), txHash: log.transactionHash.toLowerCase() });
                            }
                            continue;
                        }
                        const abi = JSON.parse(parsed.args.abiJson);
                        const address = ethers.getAddress(parsed.args.contractAddress);
                        chainRegistry.byAddress.set(address.toLowerCase(), {
                            record: { name: parsed.args.name, address, abi, kind: Number(parsed.args.kind) === 2 ? "NFT collection" : "common", source: "registry" },
                            iface: new ethers.Interface(abi)
                        });
                    } catch (error) {
                        console.error("contract registry (chain): unreadable entry:", error.message);
                    }
                }
                chainRegistry.scannedTo = end;
            }
        })().catch((error) => console.error("contract registry (chain):", error.message))
            .finally(() => { chainRegistry.running = null; });
    }
    return chainRegistry.running;
}

setTimeout(() => chainRegistryScan(), 3000).unref();
setInterval(() => chainRegistryScan(), 15000).unref();

// A contract's record: the repository's files first, then the chain's registry
function contractEntry(address) {
    const key = String(address).toLowerCase();
    return registry.byAddress.get(key) || chainRegistry.byAddress.get(key) || null;
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
        transactions: txCountFor(row.address),
        ...(sectionOf(row.address) || {})
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

// ---- Platform overview (dashboard): system accounts, contracts, sections. Balances are read every
// 15 s in the background, so the page answers at once.
const overview = { data: null, at: 0, running: null };

async function balanceEth(address) {
    try {
        return Number(ethers.formatEther(BigInt(await rpc("eth_getBalance", [address, "latest"]))));
    } catch (error) {
        return null;
    }
}

async function buildOverview() {
    const sender01 = ethers.isAddress(process.env.SENDER01 || "") ? ethers.getAddress(process.env.SENDER01) : null;
    const center = ethers.isAddress(CONTRACT_CENTER) ? ethers.getAddress(CONTRACT_CENTER) : null;
    const registered = [...chainRegistry.byAddress.values()].map((e) => e.record);
    const byRole = new Map(); // "id|role" -> address
    const users = new Map(); // id -> count
    const usersWei = new Map(); // id -> the user accounts' balances (indexed, refreshed with every block scan)
    for (const [address, entry] of sectionBook.accounts) {
        if (entry.role === "user") {
            users.set(entry.id, (users.get(entry.id) || 0) + 1);
            const account = db.accounts.get(address);
            usersWei.set(entry.id, (usersWei.get(entry.id) || 0n) + (account && account.balanceWei ? BigInt(account.balanceWei) : 0n));
        } else if (entry.role !== "retired") {
            byRole.set(entry.id + "|" + entry.role, address);
        }
    }
    const sections = [];
    for (const [id, s] of [...sectionBook.sections.entries()].sort((a, b) => a[0] - b[0])) {
        const row = { id, name: s.name, active: s.active, archived: s.archived, users: users.get(id) || 0, balances: {} };
        if (!s.archived) {
            for (const role of ["upfront", "consumption", "payment"]) {
                const address = byRole.get(id + "|" + role);
                row.balances[role] = address ? await balanceEth(address) : null;
            }
            row.balances.users = Number(ethers.formatEther(usersWei.get(id) || 0n));
        }
        sections.push(row);
    }
    const live = sections.filter((s) => !s.archived);
    const accountRows = [...db.accounts.values()].filter((row) => !db.contracts.has(row.address.toLowerCase()));
    return {
        updatedAt: Date.now(),
        sender01: sender01 ? { address: sender01, balance: await balanceEth(sender01) } : null,
        center: center ? {
            address: center,
            balance: await balanceEth(center),
            contracts: registered.length,
            common: registered.filter((r) => r.kind === "common").length,
            nft: registered.filter((r) => r.kind !== "common").length
        } : null,
        registry: ethers.isAddress(REGISTRY_CONTRACT) ? { address: ethers.getAddress(REGISTRY_CONTRACT), admin: sectionBook.admin } : null,
        sectionCounts: {
            total: sections.length,
            active: live.filter((s) => s.active).length,
            disabled: live.filter((s) => !s.active).length,
            archived: sections.length - live.length,
            users: [...users.values()].reduce((a, b) => a + b, 0)
        },
        sections: live,
        accounts: {
            indexed: accountRows.length,
            inSections: accountRows.filter((row) => sectionBook.accounts.has(row.address.toLowerCase())).length
        },
        contracts: { indexed: db.contracts.size, registered: registered.length, files: registry.byAddress.size }
    };
}

function refreshOverview() {
    if (!overview.running) {
        overview.running = buildOverview()
            .then((data) => { overview.data = data; overview.at = Date.now(); })
            .catch((error) => console.error("overview:", error.message))
            .finally(() => { overview.running = null; });
    }
    return overview.running;
}

setTimeout(refreshOverview, 6000).unref();
setInterval(refreshOverview, 15000).unref();


// ---- Section statistics per week / month / quarter / year (UTC), from the indexed transactions and
// the registry's AccountAdded events. Money flows are classified by the roles of sender and receiver.
const STAT_PERIODS = { day: 14, week: 12, month: 12, quarter: 8, year: 5 };
const STAT_METRICS = ["newUsers", "income", "fromUsers", "nftSales", "nftFirstSales", "nftEth", "toUsers", "topup", "sweep", "payback", "txs"];
const statsCache = new Map(); // period -> { at, data }

function periodStart(ms, period) {
    const d = new Date(ms);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    if (period === "year") {
        return Date.UTC(y, 0, 1);
    }
    if (period === "quarter") {
        return Date.UTC(y, m - (m % 3), 1);
    }
    if (period === "month") {
        return Date.UTC(y, m, 1);
    }
    const day = Date.UTC(y, m, d.getUTCDate());
    if (period === "day") {
        return day;
    }
    return day - ((new Date(day).getUTCDay() + 6) % 7) * 86400000; // Monday
}

function previousStart(start, period) {
    const d = new Date(start);
    if (period === "day") {
        return start - 86400000;
    }
    if (period === "week") {
        return start - 7 * 86400000;
    }
    const months = period === "year" ? 12 : period === "quarter" ? 3 : 1;
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - months, 1);
}

function periodLabel(start, period) {
    const d = new Date(start);
    const y = d.getUTCFullYear();
    if (period === "year") {
        return String(y);
    }
    if (period === "quarter") {
        return y + " Q" + (Math.floor(d.getUTCMonth() / 3) + 1);
    }
    if (period === "month") {
        return y + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
    }
    if (period === "day") {
        return y + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
    }
    // ISO week number
    const thursday = new Date(start + 3 * 86400000);
    const firstThursday = Date.UTC(thursday.getUTCFullYear(), 0, 4);
    const week = 1 + Math.round((thursday.getTime() - periodStart(firstThursday, "week")) / (7 * 86400000));
    return thursday.getUTCFullYear() + "-W" + String(week).padStart(2, "0");
}

function buildSectionStats(period) {
    const count = STAT_PERIODS[period];
    const starts = [periodStart(Date.now(), period)];
    while (starts.length < count) {
        starts.unshift(previousStart(starts[0], period));
    }
    const first = starts[0];
    const indexOf = (ms) => {
        if (ms < first) {
            return -1;
        }
        let i = starts.length - 1;
        while (i > 0 && ms < starts[i]) {
            i -= 1;
        }
        return i;
    };
    const sections = [...sectionBook.sections.entries()].filter(([, s]) => !s.archived).sort((a, b) => a[0] - b[0]);
    const data = new Map(sections.map(([id]) => [id, starts.map(() => Object.fromEntries(STAT_METRICS.map((k) => [k, 0])))]));
    const add = (id, ms, metric, amount) => {
        const rows = data.get(id);
        const i = indexOf(ms);
        if (rows && i >= 0) {
            rows[i][metric] += amount;
        }
    };
    const center = CONTRACT_CENTER.toLowerCase();
    const firstFunding = new Map(); // user -> first time its section's upfront account paid it
    // balance changes of the section accounts, to rebuild each period's closing balances backwards
    // from today's (gas is free on this chain: min-gas-price 0)
    const BALANCE_ROLES = { upfront: "upfront", consumption: "consumption", payment: "payment", user: "users" };
    const deltas = []; // { id, role, ms, eth }
    const move = (info, ms, eth) => {
        if (info && info.sectionId && BALANCE_ROLES[info.role] && eth !== 0) {
            deltas.push({ id: info.sectionId, role: BALANCE_ROLES[info.role], ms, eth });
        }
    };

    for (const tx of db.txs) {
        if (tx.status !== "success") {
            continue;
        }
        const ms = tx.timestamp * 1000;
        const f = sectionOf(tx.from);
        const t = tx.to ? sectionOf(tx.to) : null;
        if (!f && !t) {
            continue;
        }
        const fid = f && f.sectionId;
        const tid = t && t.sectionId;
        if (fid) {
            add(fid, ms, "txs", 1);
        }
        if (tid && tid !== fid) {
            add(tid, ms, "txs", 1);
        }
        const eth = Number(ethers.formatEther(BigInt(tx.value || "0x0")));
        const fr = f && f.role;
        const tr = t && t.role;
        if (eth > 0) {
            move(f, ms, -eth);
            move(t, ms, eth);
            if (tx.functionName === "buy" && fr === "user") {
                // the collection passes the price on: to the buyer's section's consumption account on a
                // first sale (center was the seller), to the seller on a resale
                const transfer = (tx.events || []).find((e) => e.name === "Transfer" && e.args[0]);
                const seller = transfer ? String(transfer.args[0].value).toLowerCase() : null;
                if (seller === center) {
                    move({ sectionId: fid, role: "consumption" }, ms, eth);
                } else if (seller) {
                    move(sectionOf(seller), ms, eth);
                }
            }
        }
        if (fr === "sender01" && tr === "upfront") {
            add(tid, ms, "topup", eth);
        } else if (fr === "upfront" && tr === "user" && fid === tid) {
            add(fid, ms, "toUsers", eth);
            const key = tx.to.toLowerCase();
            if (!firstFunding.has(key)) {
                firstFunding.set(key, ms);
            }
        } else if (fr === "user" && tr === "consumption" && fid === tid) {
            add(fid, ms, "fromUsers", eth);
            add(fid, ms, "income", eth);
        } else if (fr === "consumption" && tr === "payment" && fid === tid) {
            add(fid, ms, "sweep", eth);
        } else if (fr === "payment" && tr === "sender01") {
            add(fid, ms, "payback", eth);
        } else if (fr === "user" && tx.functionName === "buy" && eth > 0) {
            const firstSale = (tx.events || []).some((e) => e.name === "Transfer" && e.args[0] && String(e.args[0].value).toLowerCase() === center);
            add(fid, ms, "nftSales", 1);
            add(fid, ms, "nftEth", eth);
            if (firstSale) {
                add(fid, ms, "nftFirstSales", 1);
                add(fid, ms, "income", eth);
            }
        }
    }

    // a new user: the earlier of its registration (AccountAdded) and its first funding
    const seen = new Set();
    for (const a of sectionBook.added) {
        if (seen.has(a.account)) {
            continue;
        }
        seen.add(a.account);
        const registered = db.txByHash.get(a.txHash);
        const times = [registered ? registered.timestamp * 1000 : null, firstFunding.get(a.account) || null].filter((x) => x !== null);
        if (times.length) {
            add(a.id, Math.min(...times), "newUsers", 1);
        }
    }

    // closing balances: today's, minus every change after the period's end
    const current = new Map(((overview.data && overview.data.sections) || []).map((x) => [x.id, x.balances || {}]));
    const ends = starts.slice(1).concat([Infinity]);
    for (const [id] of sections) {
        const now = current.get(id) || {};
        const mine = deltas.filter((d) => d.id === id);
        data.get(id).forEach((row, i) => {
            row.balances = {};
            for (const role of ["upfront", "consumption", "payment", "users"]) {
                const later = mine.filter((d) => d.role === role && d.ms >= ends[i]).reduce((sum, d) => sum + d.eth, 0);
                row.balances[role] = Math.max(0, Math.round(((now[role] || 0) - later) * 1e6) / 1e6);
            }
        });
    }

    const round = (v) => Math.round(v * 1e6) / 1e6;
    return {
        period,
        updatedAt: Date.now(),
        metrics: STAT_METRICS,
        periods: starts.map((start) => ({ start, label: periodLabel(start, period) })),
        sections: sections.map(([id, s]) => ({
            id, name: s.name, active: s.active,
            values: data.get(id).map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === "number" ? round(v) : v])))
        }))
    };
}

app.get("/api/sections/stats", (req, res) => {
    const period = String(req.query.period || "month");
    if (!STAT_PERIODS[period]) {
        return res.status(400).json({ error: "period: day, week, month, quarter or year" });
    }
    const cached = statsCache.get(period);
    if (!cached || Date.now() - cached.at > 15000) {
        statsCache.set(period, { at: Date.now(), data: buildSectionStats(period) });
    }
    res.json(statsCache.get(period).data);
});

app.get("/api/overview", async (req, res) => {
    if (!overview.data) {
        await refreshOverview();
    }
    res.json(overview.data || { updatedAt: 0, sections: [], sectionCounts: { total: 0, active: 0, disabled: 0, archived: 0, users: 0 } });
});

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
            deployedAt: r.deployedAt, artifact: r.artifact, constructorArgs: r.constructorArgs, codeCheck: r.codeCheck,
            kind: r.kind, source: r.source || "file"
        };
        if (r.source === "registry") {
            // registered on chain: the deployment comes from the indexed transactions
            const creation = db.txs.find((tx) => tx.contractAddress && tx.contractAddress.toLowerCase() === address.toLowerCase());
            if (creation) {
                out.record.deployer = creation.from;
                out.record.txHash = creation.hash;
                out.record.blockNumber = creation.blockNumber;
                out.record.deployedAt = creation.timestamp ? new Date(creation.timestamp * 1000).toISOString() : null;
            }
        }
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
// The Deploy page deploys through the proxy (signed by the contract account center, registered on chain)
if (DEPLOY.enabled && (!DEPLOY.token || DEPLOY.token.length < 16 || !DEPLOY.allowed.length || !SECTIONS.proxy || !SECTIONS.proxyToken)) {
    console.error("Deploy page: ADMIN_TOKEN (16+ characters), ADMIN_ALLOWED_IPS, PROXY_ADMIN_URL and PROXY_ADMIN_TOKEN are required; the page stays off");
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

// The contract to deploy, from a request body: only what the proxy needs (the artifact may be large)
function deployBodyForProxy(body) {
    const json = body && body.artifact;
    if (!json || typeof json !== "object") {
        throw new Error("no artifact: choose the compiler's JSON file");
    }
    const art = deployer.loadArtifact(json, body.contract || "", String(body.artifactName || "Contract").replace(/\.json$/i, ""));
    return {
        kind: body.kind === "nft" ? "nft" : "common",
        name: String(body.name || "").trim().slice(0, 80) || art.name,
        abi: art.abi,
        bytecode: art.bytecode,
        deployedBytecode: art.deployedBytecode,
        immutableReferences: art.immutables || undefined,
        args: Array.isArray(body.args) ? body.args : []
    };
}

let deployCenter = { address: null, at: 0 };

async function centerAddress() {
    if (!deployCenter.address || Date.now() - deployCenter.at > 60000) {
        const r = await proxyAdmin("GET", "/admin/contracts");
        deployCenter = { address: r.status === 200 ? r.data.center : null, at: Date.now() };
    }
    return deployCenter.address;
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

// ---- NFT mint and sale from the contract page (admin pages' gate), forwarded to the proxy's
// /nft/mint and /nft/transfer
function nftAdminEnabled() {
    return (DEPLOY.enabled || SECTIONS.enabled) && Boolean(SECTIONS.proxy);
}

function nftGuard(req, res, next) {
    if (!nftAdminEnabled()) {
        return res.status(404).json({ error: "NFT mint and sale need the Deploy or Sections page on" });
    }
    if (!ipAllowed(req.socket.remoteAddress)) {
        return res.status(403).json({ error: "only allowed from operator_ip and chainlens_deploy_ips" });
    }
    if (!tokenOk(req)) {
        console.warn("nft: wrong token from", req.socket.remoteAddress);
        return setTimeout(() => res.status(401).json({ error: "wrong admin token" }), 1000);
    }
    next();
}

app.get("/api/nftadmin/status", (req, res) => {
    res.json({ enabled: nftAdminEnabled() && ipAllowed(req.socket.remoteAddress) });
});

app.post("/api/nftadmin/:action", express.json({ limit: "256kb" }), nftGuard, async (req, res) => {
    const action = req.params.action;
    if (action !== "mint" && action !== "transfer") {
        return res.status(404).json({ error: "unknown NFT action" });
    }
    try {
        const r = await proxyAdmin("POST", "/nft/" + action, req.body || {});
        console.log("nft:", action, JSON.stringify({ collection: req.body.collection, tokenId: req.body.tokenId, to: req.body.to }), "from", req.socket.remoteAddress, "->", r.status);
        res.status(r.status).json(r.data);
    } catch (error) {
        res.status(502).json({ error: "proxy: " + error.message });
    }
});

app.get("/api/sections/status", (req, res) => {
    res.json({ enabled: SECTIONS.enabled && ipAllowed(req.socket.remoteAddress) });
});

const sectionsJson = express.json({ limit: "64kb" });
const SECTION_ACTIONS = ["name", "info", "key", "active", "topup", "sweep", "payback", "account", "archive", "accounts", "transfer"];

app.get("/api/sections", sectionsGuard, async (req, res) => {
    try {
        const r = await proxyAdmin("GET", "/admin/sections?fresh=1" + (req.query.archived === "1" ? "&archived=1" : ""));
        res.status(r.status).json(r.data);
    } catch (error) {
        res.status(502).json({ error: "proxy: " + error.message });
    }
});

app.post("/api/sections", sectionsJson, sectionsGuard, async (req, res) => {
    try {
        const r = await proxyAdmin("POST", "/admin/sections", { name: req.body.name, info: req.body.info || {} });
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

// The section's user accounts with their balances
app.get("/api/sections/:id/accounts", sectionsGuard, async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) {
        return res.status(400).json({ error: "invalid section id" });
    }
    try {
        const r = await proxyAdmin("GET", "/admin/sections/" + req.params.id + "/accounts");
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

app.get("/api/deploy/status", async (req, res) => {
    if (!DEPLOY.enabled || !ipAllowed(req.socket.remoteAddress)) {
        return res.json({ enabled: false });
    }
    let deployer = null;
    try {
        deployer = await centerAddress();
    } catch (error) {
        // shown as unknown
    }
    res.json({ enabled: true, deployer, busy: DEPLOY.busy });
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

// Dry run through the proxy: every check, nothing signed
app.post("/api/deploy/check", deployJson, deployGuard, async (req, res) => {
    try {
        const r = await proxyAdmin("POST", "/admin/contracts/check", deployBodyForProxy(req.body));
        res.status(r.status).json(r.data);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Deploy through the proxy (signed by the contract account center, registered on chain). The address
// must still be the one the check showed (nothing changed in between).
app.post("/api/deploy/send", deployJson, deployGuard, async (req, res) => {
    if (DEPLOY.busy) {
        return res.status(409).json({ error: "another deployment is running: try again when it is done" });
    }
    DEPLOY.busy = true;
    try {
        const body = deployBodyForProxy(req.body);
        const check = await proxyAdmin("POST", "/admin/contracts/check", body);
        if (check.status !== 200) {
            return res.status(check.status).json(check.data);
        }
        if (!req.body.expectAddress || check.data.address.toLowerCase() !== String(req.body.expectAddress).toLowerCase()) {
            return res.status(409).json({ error: "the deployer's state changed since the check (address " + check.data.address + "): check again" });
        }
        console.log("deploy:", body.kind, JSON.stringify(body.name), "->", check.data.address, "from", req.socket.remoteAddress);
        const r = await proxyAdmin("POST", "/admin/contracts/deploy", body);
        if (r.status === 200) {
            chainRegistryScan().catch(() => {});
        }
        res.status(r.status).json({ ...r.data, saved: r.status === 200 });
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
    console.log(DEPLOY.enabled ? `Deploy page on: through the proxy ${SECTIONS.proxy}, from ${DEPLOY.allowed.join(" ")}` : "Deploy page off");
    loop();
});
