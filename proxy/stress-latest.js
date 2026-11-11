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
    NFT_BASE_URL: (process.env.NFT_BASE_URL || "").trim().replace(/\/$/, ""),
    REDIS: {
        host: process.env.REDIS_IP || process.env.IP || BESU_IP,
        port: Number(process.env.REDIS_PORT) || 36379
    }
};

const redis = new Redis(CONFIG.REDIS);

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

async function nextNonce(address) {
    const key = `nonce:${address.toLowerCase()}`;
    const exists = await redis.exists(key);

    if (!exists) {
        const nonceHex = await rpc(
            CONFIG.BESU_RPC,
            "eth_getTransactionCount",
            [address, "pending"]
        );

        const nonce = parseInt(nonceHex, 16);
        await redis.set(key, nonce);
    }

    const nonce = await redis.incr(key);
    return nonce - 1;
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

async function reservedWei(address) {
    const nonceHex = await rpc(
        CONFIG.BESU_RPC,
        "eth_getTransactionCount",
        [address, "latest"]
    );
    const chainNonce = parseInt(nonceHex, 16);
    const pending = await redis.hgetall(pendingValueKey(address));
    const stale = [];
    let reserved = 0n;

    for (const [nonce, value] of Object.entries(pending)) {
        if (Number(nonce) < chainNonce) {
            stale.push(nonce);
        } else {
            reserved += BigInt(value);
        }
    }

    if (stale.length > 0) {
        await redis.hdel(pendingValueKey(address), ...stale);
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

function mintFailMemo(error) {
    const reason = String((error && error.message) || "unknown error")
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ")
        .replace(/\s+/g, " ")
        .trim() || "unknown error";

    return clipUtf8(`NFT mint failed: ${reason}`, MINT_MEMO_LIMIT);
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
    const balance = BigInt(await rpc(
        CONFIG.BESU_RPC,
        "eth_getBalance",
        [address, "latest"]
    ));
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
    await redis.hset(
        pendingValueKey(address),
        String(nonce),
        wei.toString()
    );
}

async function pay(sender, recipient, amount, ownedBySigner, memo = "") {
    const bytes = memoBytes(memo);
    const gas = transferGas(bytes);
    const data = bytes.length === 0 ? "0x" : ethers.hexlify(bytes);

    await assertCanPay(sender, amount);

    const nonce = await nextNonce(sender);
    const txHash = ownedBySigner
        ? await sendFromSigner(sender, recipient, amount, nonce, data, gas)
        : await sendFromVault(sender, recipient, amount, nonce, data, gas);

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

async function createAccount(amount) {
    if (!await signerOwns(CONFIG.SENDER01)) {
        throw new Error("sender01 is not managed by Web3Signer");
    }

    const wallet = ethers.Wallet.createRandom();
    const address = wallet.address;

    const payment = await withSenderLock(CONFIG.SENDER01, async () => {
        await assertCanPay(CONFIG.SENDER01, amount);
        await storePrivateKey(accountName(address), wallet.privateKey.slice(2));
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
const NEXT_TOKEN_SCRIPT = `
local current = tonumber(redis.call("GET", KEYS[1]) or "0")
local minted = tonumber(ARGV[1])
if current < minted then
    redis.call("SET", KEYS[1], ARGV[1])
end
return redis.call("INCR", KEYS[1])
`;
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

function nftMetaKey(tokenId) {
    return `nft:meta:${tokenId}`;
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

async function nftContractAddress() {
    const configured = (process.env.NFT_CONTRACT || "").trim();

    if (configured) {
        if (!isAddress(configured)) {
            throw httpError(500, "NFT_CONTRACT is not a valid address");
        }

        return ethers.getAddress(configured);
    }

    const stored = await redis.get("nft:contract");

    if (!stored) {
        return null;
    }

    if (!isAddress(stored)) {
        throw httpError(500, "stored NFT contract is not a valid address");
    }

    return ethers.getAddress(stored);
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

    const tokenId = await redis.eval(NEXT_TOKEN_SCRIPT, 1, "nft:nextId", minted.toString());
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
    const balance = BigInt(await rpc(
        CONFIG.BESU_RPC,
        "eth_getBalance",
        [address, "latest"]
    ));
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
    const txHash = ownedBySigner
        ? await sendDataFromSigner(from, to, data, nonce, gas, valueHex)
        : await sendDataFromVault(from, to, data, nonce, gas, valueHex);

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

async function readStoredNft(tokenId) {
    const raw = await redis.get(nftMetaKey(tokenId));

    if (!raw) {
        return null;
    }

    return JSON.parse(raw);
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
    const existing = await nftContractAddress();

    if (existing) {
        return {
            success: true,
            contract: existing,
            alreadyDeployed: true
        };
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

    await redis.set("nft:contract", contract);

    return {
        success: true,
        contract,
        txHash: sent.txHash,
        name,
        symbol,
        minter: CONFIG.SENDER01,
        nonce: sent.nonce
    };
}

async function mintNft(req) {
    const body = req.body || {};

    if (!body.to || body.name === undefined || body.image === undefined || body.amount === undefined || body.amount === null || body.amount === "") {
        throw httpError(400, "missing parameters");
    }

    const amount = String(body.amount).trim();

    if (!/^\d+(\.\d+)?$/.test(amount)) {
        throw httpError(400, "invalid amount");
    }

    if (!isAddress(body.to)) {
        throw httpError(400, "invalid address");
    }

    const metadata = buildMetadata(body);
    const tokenURI = onChainTokenUri(metadata);
    const contract = await requireNftContract();

    if (!await signerOwns(CONFIG.SENDER01)) {
        throw new Error("sender01 is not managed by Web3Signer");
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

    if (minter.toLowerCase() !== CONFIG.SENDER01.toLowerCase()) {
        throw httpError(400, "NFT minter is not sender01");
    }

    const to = ethers.getAddress(body.to);
    const value = ethToWei(amount);
    const ownedByBuyer = await signerOwns(to);
    const memo = value > 0n ? `New NFT Token mint: ${metadata.name} - ${metadata.image}` : "";

    if (memoBytes(memo).length > MINT_MEMO_LIMIT) {
        throw httpError(400, "mint memo is too long");
    }

    if (value > 0n) {
        if (!ownedByBuyer && !await readPrivateKey(accountName(to))) {
            throw httpError(400, "to address is not managed by Web3Signer or Vault");
        }

        const balance = BigInt(await rpc(
            CONFIG.BESU_RPC,
            "eth_getBalance",
            [to, "latest"]
        ));
        const reserved = await reservedWei(to);
        const available = balance > reserved ? balance - reserved : 0n;

        if (available < value) {
            throw httpError(400, "insufficient balance");
        }
    }

    const tokenId = await allocateTokenId(contract);
    const key = nftMetaKey(tokenId);
    const record = {
        metadata,
        tokenURI,
        to,
        amount
    };

    await redis.set(key, JSON.stringify(record));

    let sent;
    let payment = null;

    const data = nftInterface.encodeFunctionData("mint", [to, tokenId, tokenURI]);

    try {
        await assertMintFits(CONFIG.SENDER01, contract, data);

        if (value > 0n) {
            payment = await withSenderLock(to, () =>
                pay(to, CONFIG.SENDER01, amount, ownedByBuyer, memo)
            );
        }

        sent = await withSenderLock(CONFIG.SENDER01, () =>
            sendData(CONFIG.SENDER01, contract, data, true)
        );
    } catch (error) {
        await redis.del(key);

        if (payment) {
            try {
                await withSenderLock(CONFIG.SENDER01, () =>
                    pay(CONFIG.SENDER01, to, amount, true, mintFailMemo(error))
                );
            } catch (refundError) {
                error.message = `${error.message}; refund failed: ${refundError.message}`;
            }
        }

        throw error;
    }

    record.txHash = sent.txHash;
    await redis.set(key, JSON.stringify(record));

    return {
        success: true,
        tokenId,
        contract,
        to,
        amount,
        memo,
        paymentTxHash: payment ? payment.txHash : null,
        tokenURI,
        txHash: sent.txHash,
        nonce: sent.nonce
    };
}

async function transferNft(body) {
    const tokenId = parseTokenId(body.tokenId);

    if (!body.from || !body.to || !tokenId) {
        throw httpError(400, "missing parameters");
    }

    if (!isAddress(body.from) || !isAddress(body.to)) {
        throw httpError(400, "invalid address");
    }

    const contract = await requireNftContract();
    const from = ethers.getAddress(body.from);
    const to = ethers.getAddress(body.to);
    const owner = await readOwner(contract, tokenId);

    if (!owner) {
        throw httpError(404, "token not found");
    }

    if (owner.toLowerCase() !== from.toLowerCase()) {
        throw httpError(400, "sender is not the token owner");
    }

    const ownedBySigner = await signerOwns(from);

    if (!ownedBySigner && !await readPrivateKey(accountName(from))) {
        throw httpError(400, "sender not managed by Web3Signer or Vault");
    }

    const data = nftInterface.encodeFunctionData(
        "safeTransferFrom(address,address,uint256)",
        [from, to, tokenId]
    );
    const sent = await withSenderLock(from, () =>
        sendData(from, contract, data, ownedBySigner)
    );

    return {
        success: true,
        txHash: sent.txHash,
        from,
        to,
        tokenId,
        contract,
        nonce: sent.nonce
    };
}

async function listOwnedNfts(address) {
    const contract = await requireNftContract();
    const owner = ethers.getAddress(address);
    const minted = Number(await highestMintedTokenId(contract));
    const stored = Number(await redis.get("nft:nextId") || 0);
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

    return {
        success: true,
        contract,
        owner,
        tokenIds
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

app.get("/nft/owner/:address", async (req, res) => {
    try {
        if (!isAddress(req.params.address)) {
            return res.status(400).json({
                error: "invalid address"
            });
        }

        res.json(await listOwnedNfts(req.params.address));
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

        const stored = await readStoredNft(tokenId);

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

        const contract = await requireNftContract();
        const stored = await readStoredNft(tokenId);
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
