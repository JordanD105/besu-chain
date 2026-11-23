// Transaction memos (docs/features/memos.md).
//
// Every transaction the proxy sends carries a memo at the END of its data:
//
//   [ call data ][ memo record (UTF-8 JSON) ][ length: 2 bytes ][ "MEMO" ][ version: 1 byte ]
//                                            └────────────── trailer (7 bytes) ──────────────┘
//
// A contract reads its call from the start of the data and ignores the extra bytes; a plain ETH
// transfer has no call data, only the memo. The record holds a memo TYPE and its values, not a
// sentence: each reader shows it in its own language from memo-types.json (en, ko, zh).
//
//   { "v": 1, "t": "avatar.buy", "s": [1, "Shop B"], "p": { "tokenId": "3", "amount": "0.1" },
//     "u": "the caller's own memo", "r": "request id" }
//
// The canonical copy is memo/ at the repository root; proxy/memo, chainlens/memo and gateway/memo
// are copies (memo/sync.sh; memo/test.js checks they match). No dependencies: Node.js only.
"use strict";

const CATALOGUE = require("./memo-types.json");

const MARKER = Buffer.from("MEMO", "ascii");
const VERSION = 1;
const TRAILER = 7;                 // length (2) + "MEMO" (4) + version (1)
const MAX_RECORD = 4096;           // bytes of the JSON record
const USER_LIMIT = 256;            // bytes of the caller's own memo (the old MEMO_LIMIT)
const VALUE_LIMIT = 120;           // bytes of each value in p (an image URL is clipped)
const LANGS = Object.keys(CATALOGUE.languages);

function toBuffer(data) {
    if (Buffer.isBuffer(data)) {
        return data;
    }
    if (data instanceof Uint8Array) {
        return Buffer.from(data);
    }
    const hex = String(data || "0x").replace(/^0x/i, "");
    return /^[0-9a-f]*$/i.test(hex) && hex.length % 2 === 0 ? Buffer.from(hex, "hex") : Buffer.alloc(0);
}

function clip(text, limit) {
    const s = String(text);
    const b = Buffer.from(s, "utf8");
    if (b.length <= limit) {
        return s;
    }
    let n = limit;
    while (n > 0 && (b[n] & 0xc0) === 0x80) {
        n -= 1;
    }
    return b.subarray(0, n).toString("utf8") + "…";
}

// The caller's memo: undefined/"" -> null; not a string or too long -> throws (400)
function userMemo(value) {
    if (value === undefined || value === null || value === "") {
        return null;
    }
    if (typeof value !== "string") {
        throw Object.assign(new Error("invalid memo: a string"), { statusCode: 400 });
    }
    if (Buffer.byteLength(value, "utf8") > USER_LIMIT) {
        throw Object.assign(new Error(`memo is too long (at most ${USER_LIMIT} bytes)`), { statusCode: 400 });
    }
    return value;
}

// Only simple values, each clipped; bigint and numbers as text
function cleanParams(p) {
    const out = {};
    for (const [k, v] of Object.entries(p || {})) {
        if (v === undefined || v === null || v === "") {
            continue;
        }
        if (typeof v === "boolean") {
            out[k] = v;
        } else if (typeof v === "bigint" || typeof v === "number" || typeof v === "string") {
            out[k] = clip(String(v), VALUE_LIMIT);
        }
    }
    return out;
}

// { t, s: section | [id, name], p, u, r } -> the stored record
function record({ t, s, p, u, r }) {
    const rec = { v: VERSION, t: String(t || "other") };
    if (s) {
        rec.s = Array.isArray(s) ? [Number(s[0]), String(s[1] || "")] : [Number(s.id), String(s.name || "")];
    }
    const params = cleanParams(p);
    if (Object.keys(params).length) {
        rec.p = params;
    }
    if (u) {
        rec.u = String(u);
    }
    if (r) {
        rec.r = String(r);
    }
    return rec;
}

// The record + trailer, as bytes
function encode(rec) {
    let json = Buffer.from(JSON.stringify(rec), "utf8");
    if (json.length > MAX_RECORD) {
        // values first: the type, section and the caller's memo are kept
        json = Buffer.from(JSON.stringify(Object.assign({}, rec, { p: undefined })), "utf8");
    }
    if (json.length > MAX_RECORD) {
        throw new Error("memo record too large");
    }
    const len = Buffer.alloc(2);
    len.writeUInt16BE(json.length);
    return Buffer.concat([json, len, MARKER, Buffer.from([VERSION])]);
}

// call data (hex, "0x" for a plain transfer) + the memo -> hex
function append(dataHex, rec) {
    return "0x" + Buffer.concat([toBuffer(dataHex), encode(rec)]).toString("hex");
}

// hex data -> { record, callData } when it ends with a memo trailer; else null
function decode(data) {
    const b = toBuffer(data);
    if (b.length < TRAILER + 2) {
        return null;
    }
    const end = b.length;
    if (b[end - 1] !== VERSION || !b.subarray(end - 5, end - 1).equals(MARKER)) {
        return null;
    }
    const len = b.readUInt16BE(end - TRAILER);
    const start = end - TRAILER - len;
    if (len < 2 || start < 0) {
        return null;
    }
    try {
        const rec = JSON.parse(b.subarray(start, end - TRAILER).toString("utf8"));
        if (!rec || typeof rec.t !== "string") {
            return null;
        }
        return { record: rec, callData: "0x" + b.subarray(0, start).toString("hex") };
    } catch (error) {
        return null;
    }
}

// The call data without a memo trailer (what a contract decoder should read)
function stripMemo(data) {
    const d = decode(data);
    return d ? d.callData : (typeof data === "string" ? data : "0x" + toBuffer(data).toString("hex"));
}

// Older memos (before the trailer): plain UTF-8 text in a plain transfer
const LEGACY = [
    [/^section (\d+) top-up$/, (m) => ({ t: "section.topup", s: [m[1], ""] })],
    [/^section (\d+) sweep$/, (m) => ({ t: "section.sweep", s: [m[1], ""] })],
    [/^section (\d+) pay back$/, (m) => ({ t: "section.payback", s: [m[1], ""] })],
    [/^section (\d+) (upfront|consumption|payment) account replaced$/, (m) => ({ t: "account.move", s: [m[1], ""], p: { role: m[2] } })],
    [/^section (\d+) archived: (upfront|consumption|payment) returned$/, (m) => ({ t: "section.return", s: [m[1], ""], p: { role: m[2] } })],
    [/^New NFT Token mint: ([\s\S]*) - (https?:\/\/\S+)$/, (m) => ({ t: "avatar.mint", p: { name: m[1] } })]
];

function legacyText(data) {
    const b = toBuffer(data);
    if (!b.length || b.length > 4096 || b.includes(0)) {
        return null;
    }
    const text = b.toString("utf8");
    return Buffer.from(text, "utf8").equals(b) ? text : null;
}

function fromLegacy(text) {
    for (const [re, make] of LEGACY) {
        const m = String(text).match(re);
        if (m) {
            return Object.assign({ v: 0, legacy: true }, make(m));
        }
    }
    return { v: 0, t: "other", u: text, legacy: true };
}

// A transaction -> its memo record, or null. tx: { input|data, value (hex wei), to }.
// The amount of a plain transfer comes from the transaction's value when the memo has none.
function fromTransaction(tx) {
    const data = tx.input || tx.data || "0x";
    let rec = null;
    const d = decode(data);
    if (d) {
        rec = d.record;
    } else if (tx.to && toBuffer(data).length && legacyText(data) !== null) {
        rec = fromLegacy(legacyText(data));
    }
    if (rec && tx.value !== undefined && (!rec.p || rec.p.amount === undefined)) {
        const wei = BigInt(tx.value || 0);
        if (wei > 0n) {
            rec.p = Object.assign({}, rec.p, { amount: weiToEth(wei) });
        }
    }
    return rec;
}

function weiToEth(wei) {
    const w = BigInt(wei);
    const whole = w / 10n ** 18n;
    const frac = (w % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
    return frac ? `${whole}.${frac}` : String(whole);
}

// "ko-KR,ko;q=0.9,en;q=0.8" / "zh-CN" / "ko" -> one of the catalogue's languages
function lang(...wanted) {
    for (const w of wanted) {
        for (const part of String(w || "").split(",")) {
            const code = part.trim().split(";")[0].toLowerCase().split("-")[0];
            if (LANGS.includes(code)) {
                return code;
            }
        }
    }
    return CATALOGUE.default || "en";
}

function fill(template, values) {
    return template.replace(/\{(\w+)\}/g, (_, k) => (values[k] === undefined ? "" : String(values[k])));
}

// The default text of a record in a language (the caller's own memo is NOT used here)
function describe(rec, language) {
    if (!rec) {
        return "";
    }
    const L = lang(language);
    const words = Object.assign({}, CATALOGUE.words.en, CATALOGUE.words[L]);
    const values = {};
    for (const [k, v] of Object.entries(rec.p || {})) {
        values[k] = CATALOGUE.translate.includes(k) && words[v] ? words[v] : v;
    }
    const entry = CATALOGUE.types[rec.t];
    let text;
    if (!entry) {
        text = rec.t === "other" ? (words.transaction || "Transaction") : rec.t;
    } else {
        const variants = entry[L] || entry.en;
        const list = Array.isArray(variants) ? variants : [variants];
        const usable = list.find((tpl) => (tpl.match(/\{(\w+)\}/g) || []).every((ph) => values[ph.slice(1, -1)] !== undefined));
        text = fill(usable || list[list.length - 1], values);
    }
    if (rec.s && (rec.s[1] || rec.s[0])) {
        const name = rec.s[1] || `#${rec.s[0]}`;
        text = fill((CATALOGUE.prefix[L] || CATALOGUE.prefix.en), { section: name, text });
    }
    return text;
}

// What to show: the caller's own memo when given, else the default text
function text(rec, language) {
    if (!rec) {
        return "";
    }
    return rec.u ? rec.u : describe(rec, language);
}

// The memo fields of an API answer
function answer(rec, language) {
    if (!rec) {
        return { memo: "" };
    }
    return {
        memo: text(rec, language),
        memoType: rec.t,
        memoText: describe(rec, language),
        memoParams: rec.p || {},
        userMemo: rec.u || null,
        memoRequest: rec.r || null
    };
}

module.exports = {
    VERSION, TRAILER, USER_LIMIT, LANGS, CATALOGUE,
    userMemo, record, encode, append, decode, stripMemo, legacyText, fromLegacy, fromTransaction,
    lang, describe, text, answer, weiToEth
};
