const path = require("path");
const express = require("express");
const Redis = require("ioredis");
const { ethers } = require("ethers");
const nftArtifact = require("./nft-collection.json");

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
    NFT_BASE_URL: (process.env.NFT_BASE_URL || "").trim().replace(/\/$/, ""),
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
    await cache(() => redis.del(`nonce:${sender}`));
}

// Next nonce = max(cached counter, chain pending count). The chain value makes a missing,
// empty or stale (old snapshot) Redis harmless; the cached counter covers transactions the node
// has not reported as pending yet. Runs under withSenderLock for the sender.
async function nextNonce(address) {
    const sender = address.toLowerCase();
    const key = `nonce:${sender}`;
    const chainPending = parseInt(await rpc(
        CONFIG.BESU_RPC,
        "eth_getTransactionCount",
        [address, "pending"]
    ), 16);

    let cached = memNonce.get(sender);

    if (cached === undefined) {
        const stored = await cache(() => redis.get(key));
        cached = stored === null ? 0 : Number(stored);
    }

    const nonce = Math.max(cached, chainPending);
    memNonce.set(sender, nonce + 1);
    await cache(() => redis.set(key, nonce + 1));
    return nonce;
}

// Besu can briefly answer eth_getBalance with null (e.g. while importing a busy block);
// retry a few times instead of failing the request with "Cannot convert null to a BigInt".
async function getBalanceWei(address) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const result = await rpc(CONFIG.BESU_RPC, "eth_getBalance", [address, "latest"]);

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

async function signerOwns(address) {
    const accounts = await rpc(
        CONFIG.WEB3SIGNER_RPC,
        "eth_accounts"
    );

    return accounts.some(
        (item) => item.toLowerCase() === address.toLowerCase()
    );
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

async function reservedWei(address) {
    const sender = address.toLowerCase();
    const nonceHex = await rpc(
        CONFIG.BESU_RPC,
        "eth_getTransactionCount",
        [address, "latest"]
    );
    const chainNonce = parseInt(nonceHex, 16);
    const pending = await pendingFor(sender);
    const stale = [];
    let reserved = 0n;

    for (const [nonce, value] of pending) {
        if (Number(nonce) < chainNonce) {
            stale.push(nonce);
        } else {
            reserved += BigInt(value);
        }
    }

    if (stale.length > 0) {
        stale.forEach((nonce) => pending.delete(nonce));
        await cache(() => redis.hdel(pendingValueKey(sender), ...stale));
    }

    return reserved;
}

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
    const value = ethToWei(amount);
    const cost = value;
    const balance = await getBalanceWei(address);
    const reserved = await reservedWei(address);

    if (balance < reserved + cost) {
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
    await cache(() => redis.hset(pendingValueKey(sender), String(nonce), wei.toString()));
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

async function readPrivateKey(name) {
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
        throw new Error("sender not managed by Web3Signer or Vault");
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
async function createMpcAccount() {
    if (!CONFIG.MPC_ADMIN_TOKEN) {
        throw new Error("MPC_ADMIN_TOKEN is not configured");
    }

    const response = await fetch(`${CONFIG.MPC_ADMIN_URL}/admin/keys`, {
        method: "POST",
        headers: { Authorization: `Bearer ${CONFIG.MPC_ADMIN_TOKEN}` },
        signal: AbortSignal.timeout(120000)
    });

    if (!response.ok) {
        const detail = await response.text();
        throw new Error(`mpc key generation failed (${response.status}): ${detail.slice(0, 300)}`);
    }

    const key = await response.json();
    return ethers.getAddress(key.address);
}

async function createAccount(amount) {
    if (!await signerOwns(CONFIG.SENDER01)) {
        throw new Error("sender01 is not managed by the signer");
    }

    const useMpc = Boolean(CONFIG.MPC_ADMIN_URL);
    const wallet = useMpc ? null : ethers.Wallet.createRandom();

    if (useMpc) {
        await assertCanPay(CONFIG.SENDER01, amount);
    }

    const address = useMpc ? await createMpcAccount() : wallet.address;

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

        const result = await withAccountLock(() => createAccount(amountText));
        res.json(result);
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
        const ownedBySigner = await signerOwns(sender);

        if (!ownedBySigner && !await readPrivateKey(accountName(sender))) {
            return res.status(400).json({
                error: "sender not managed by Web3Signer or Vault"
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
        throw httpError(404, `no NFT collection named "${input.trim()}" (see GET /nft/collections)`);
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
    const balance = await getBalanceWei(address);
    const reserved = await reservedWei(address);

    if (balance < reserved + cost) {
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
// Start
// =======================

const LISTEN_HOST = process.env.LISTEN_HOST || BESU_IP;

app.listen(CONFIG.PORT, LISTEN_HOST, () => {
    console.log(`Server running ${LISTEN_HOST}:${CONFIG.PORT}`);
});
