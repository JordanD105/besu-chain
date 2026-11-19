// Builds the local compiler mirror for Remix: <out>/soljson-v<long version>.js for each solc version
// installed under /build/solc-<version> (npm package "solc", whose soljson.js is the official
// Emscripten build) and <out>/list.json in the format of binaries.soliditylang.org/bin/list.json.
//   node make-solc-bin.js <out> <version>...
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const [out, ...versions] = process.argv.slice(2);
if (!out || !versions.length) {
    console.error("usage: make-solc-bin.js <out> <version>...");
    process.exit(1);
}
fs.mkdirSync(out, { recursive: true });

const builds = [];
for (const v of versions) {
    const dir = path.join("/build", `solc-${v}`, "node_modules", "solc");
    const soljson = path.join(dir, "soljson.js");
    const solc = require(path.join(dir, "wrapper.js"))(require(soljson));
    const longVersion = solc.version().replace(".Emscripten.clang", ""); // 0.8.28+commit.7893614a
    const [version, build] = longVersion.split("+");
    if (version !== v) {
        throw new Error(`npm solc@${v} holds compiler ${longVersion}`);
    }
    const file = `soljson-v${longVersion}.js`;
    const data = fs.readFileSync(soljson);
    fs.writeFileSync(path.join(out, file), data);
    builds.push({
        path: file,
        version,
        build,
        longVersion,
        sha256: "0x" + crypto.createHash("sha256").update(data).digest("hex"),
        urls: []
    });
    console.log(`solc ${longVersion}: ${file}`);
}

const byVersion = (a, b) => {
    const pa = a.version.split(".").map(Number), pb = b.version.split(".").map(Number);
    return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
};
builds.sort(byVersion);
const releases = Object.fromEntries(builds.map((b) => [b.version, b.path]));
fs.writeFileSync(path.join(out, "list.json"), JSON.stringify({
    builds,
    releases,
    latestRelease: builds[builds.length - 1].version
}, null, 2));
