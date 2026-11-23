// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Undo of a section transfer (docs/features/transfer-undo.md). An ETH transfer can't be reversed, so
// the proxy sends the money back through this contract: it records the original transaction's hash
// once, forwards the ETH and emits TransferUndone. A second undo of the same transfer fails here,
// whichever proxy sends it. Only accounts of a section (SectionRegistry) may call it; the proxy
// checks the rest (the transfer is that section's +x / -x, at most 7 days old, the full amount).

interface ISectionRegistryKinds {
    function accountKind(address account) external view returns (uint8);
}

contract TransferUndo {
    ISectionRegistryKinds public immutable registry;

    // original transaction hash -> block of its undo (0: not undone)
    mapping(bytes32 => uint256) public undoneAt;

    event TransferUndone(bytes32 indexed original, address indexed from, address indexed to, uint256 amount);

    constructor(address registry_) {
        registry = ISectionRegistryKinds(registry_);
    }

    function undo(bytes32 original, address payable to) external payable {
        require(msg.value > 0, "amount: more than 0");
        require(to != address(0), "to: an address");
        require(undoneAt[original] == 0, "already undone");
        require(registry.accountKind(msg.sender) != 0, "only accounts of a section");
        undoneAt[original] = block.number;
        (bool ok, ) = to.call{value: msg.value}("");
        require(ok, "payment failed");
        emit TransferUndone(original, msg.sender, to, msg.value);
    }
}
