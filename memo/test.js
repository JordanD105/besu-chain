// node memo/test.js : the memo format, the catalogue, and the copies in proxy/, chainlens/, gateway/
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const M = require("./memo.js");

// round trip on a contract call and on a plain transfer
const call = "0xd96a094a" + "0".repeat(63) + "3";            // buy(3)
const rec = M.record({ t: "avatar.buy", s: { id: 1, name: "Shop B" }, p: { tokenId: 3n, amount: "0.1" }, u: "gift", r: "ab12" });
const data = M.append(call, rec);
const d = M.decode(data);
assert.equal(d.callData, call);
assert.deepEqual(d.record, { v: 1, t: "avatar.buy", s: [1, "Shop B"], p: { tokenId: "3", amount: "0.1" }, u: "gift", r: "ab12" });
assert.equal(M.stripMemo(data), call);
assert.equal(M.stripMemo(call), call);
assert.equal(M.decode(call), null);
const plain = M.append("0x", M.record({ t: "transfer.in", s: [1, "Shop B"], p: { amount: "0.5" } }));
assert.equal(M.decode(plain).callData, "0x");

// texts in three languages; the caller's memo wins in text(), not in describe()
assert.equal(M.describe(d.record, "en"), "Shop B: Avatar #3 bought for 0.1 ETH");
assert.equal(M.describe(d.record, "ko-KR,ko;q=0.9"), "Shop B: 아바타 #3 0.1 ETH에 구매");
assert.equal(M.describe(d.record, "zh-CN"), "Shop B：以 0.1 ETH 购买头像 #3");
assert.equal(M.text(d.record, "ko"), "gift");
assert.equal(M.describe(M.record({ t: "avatar.buy" }), "en"), "Avatar bought");          // fewer values: shorter variant
assert.equal(M.describe(M.record({ t: "account.replace", s: [2, "Cafe"], p: { role: "consumption" } }), "ko"), "Cafe: 소비 계정 교체");
assert.equal(M.describe({ v: 1, t: "future.type" }, "en"), "future.type");                // a newer type: its key
assert.equal(M.lang("fr-FR,fr"), "en");

// every type has en, ko, zh
for (const [t, e] of Object.entries(M.CATALOGUE.types)) {
    for (const l of M.LANGS) {
        assert.ok(e[l], `${t}: no ${l}`);
    }
}

// older memos
const old = (s) => "0x" + Buffer.from(s, "utf8").toString("hex");
assert.deepEqual(M.fromTransaction({ input: old("section 4 sweep"), value: "0xde0b6b3a7640000", to: "0x1" }),
    { v: 0, legacy: true, t: "section.sweep", s: ["4", ""], p: { amount: "1" } });
assert.equal(M.fromTransaction({ input: old("coffee"), value: "0x0", to: "0x1" }).u, "coffee");
assert.equal(M.fromTransaction({ input: "0x", value: "0x1", to: "0x1" }), null);
assert.equal(M.fromTransaction({ input: call, to: "0x1" }), null);           // an old contract call: no memo

// limits
assert.throws(() => M.userMemo("x".repeat(257)), /too long/);
assert.throws(() => M.userMemo(5), /invalid memo/);
assert.equal(M.userMemo(""), null);
assert.ok(M.decode(M.append("0x", M.record({ t: "avatar.mint", p: { image: "data:" + "a".repeat(9000) } }))).record.p.image.length < 130);

// the copies are identical to memo/
for (const app of ["proxy", "chainlens", "gateway"]) {
    for (const f of ["memo.js", "memo-types.json"]) {
        const copy = path.join(__dirname, "..", app, "memo", f);
        assert.ok(fs.existsSync(copy), `${copy} missing: run memo/sync.sh`);
        assert.equal(fs.readFileSync(copy, "utf8"), fs.readFileSync(path.join(__dirname, f), "utf8"), `${copy} differs: run memo/sync.sh`);
    }
}
console.log("memo: all checks passed");
