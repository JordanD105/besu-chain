// Compiles one contract of proxy/contracts/ into an artifact next to stress-latest.js
// (ABI, creation and runtime bytecode), with the settings this chain needs (EVM cancun):
//   npm install solc@0.8.28
//   node scripts/compile-contract.js contracts/SectionRegistry.sol SectionRegistry section-registry.json
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const [sourceArg, name, outArg] = process.argv.slice(2);
if (!sourceArg || !name || !outArg) {
    console.error("usage: compile-contract.js <contracts/X.sol> <ContractName> <out.json>");
    process.exit(1);
}

const root = path.join(__dirname, "..");
const sourceFile = path.basename(sourceArg);
const input = {
    language: "Solidity",
    sources: { [sourceFile]: { content: fs.readFileSync(path.join(root, sourceArg), "utf8") } },
    settings: {
        optimizer: { enabled: true, runs: 200 },
        evmVersion: "cancun",
        outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "evm.deployedBytecode.immutableReferences"] } }
    }
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));
for (const error of output.errors || []) {
    console.error(error.formattedMessage || error.message);
}
if ((output.errors || []).some((error) => error.severity === "error")) {
    process.exit(1);
}

const contract = output.contracts[sourceFile][name];
const artifact = {
    contractName: name,
    compiler: `solc ${solc.version()}`,
    evmVersion: "cancun",
    abi: contract.abi,
    bytecode: "0x" + contract.evm.bytecode.object,
    deployedBytecode: "0x" + contract.evm.deployedBytecode.object,
    immutableReferences: contract.evm.deployedBytecode.immutableReferences || {}
};
const outPath = path.join(root, outArg);
fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + "\n");
console.log(`wrote ${outPath} (${(artifact.bytecode.length - 2) / 2} bytes of creation code)`);
