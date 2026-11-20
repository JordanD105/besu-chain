// Rebuilds nft-collection.json, the LEGACY version-2 collection (contracts/NftCollectionV2.sol: minted by
// SENDER01, sales paid to the minter). New collections are version 3 (contracts/NftCollection.sol,
// compiled with: node scripts/compile-contract.js contracts/NftCollection.sol NftCollection nft-collection-v3.json).
//   npm install solc@0.8.28
//   node scripts/compile-nft.js
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const sourcePath = path.join(__dirname, "..", "contracts", "NftCollectionV2.sol");
const source = fs.readFileSync(sourcePath, "utf8");

const input = {
    language: "Solidity",
    sources: {
        "NftCollectionV2.sol": { content: source }
    },
    settings: {
        optimizer: { enabled: true, runs: 200 },
        evmVersion: "shanghai",
        outputSelection: {
            "*": {
                "*": ["abi", "evm.bytecode.object"]
            }
        }
    }
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));

if (output.errors) {
    const fatal = output.errors.filter((error) => error.severity === "error");

    for (const error of output.errors) {
        console.error(error.formattedMessage || error.message);
    }

    if (fatal.length > 0) {
        process.exit(1);
    }
}

const contract = output.contracts["NftCollectionV2.sol"].NftCollectionV2;
const artifact = {
    contractName: "NftCollection",
    abi: contract.abi,
    bytecode: "0x" + contract.evm.bytecode.object
};

const outPath = path.join(__dirname, "..", "nft-collection.json");
fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));
console.log(`wrote ${outPath} (${artifact.bytecode.length} bytecode chars)`);
