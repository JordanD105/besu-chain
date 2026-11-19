// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title SectionRegistry
/// @notice The on-chain record of the sections (docs/sections.md), read by both proxies and chainlens.
/// Each section has three MPC accounts:
///   - upfront:     pays out (funds new accounts, /transfer -x); topped up manually from SENDER01
///   - consumption: receives (/transfer +x, first NFT sales); swept to payment
///   - payment:     collects the swept money; can pay it back to SENDER01
/// and an API key, stored only as its keccak256 hash, plus the source IPs allowed to use it.
/// The registry also records the user accounts of each section and the registered contracts (the
/// ABI travels in the ContractRegistered event, so it is on chain without costly storage).
/// Only the admin (an MPC account the proxy sends from) writes.
contract SectionRegistry {
    uint256 public constant VERSION = 1;

    // kinds of the accounts known to the registry
    uint8 public constant ACCOUNT_USER = 1;
    uint8 public constant ACCOUNT_UPFRONT = 2;
    uint8 public constant ACCOUNT_CONSUMPTION = 3;
    uint8 public constant ACCOUNT_PAYMENT = 4;

    struct Section {
        string name;
        address upfront;
        address consumption;
        address payment;
        bytes32 keyHash;
        string allowedIps; // space-separated IPv4 addresses / networks
        bool active;
        uint64 createdAt;
    }

    address public admin;
    uint256 public sectionCount; // section ids are 1..sectionCount
    mapping(uint256 => Section) private sections;
    mapping(bytes32 => uint256) public sectionByName; // keccak256 of the name as given (the proxy normalizes it)
    mapping(bytes32 => uint256) public sectionByKey; // API-key hash -> section
    mapping(address => uint256) public sectionOfAccount; // section and user accounts -> section
    mapping(address => uint8) public accountKind;

    // contracts registered by the proxy (deployed by the contract account center)
    mapping(address => uint8) public contractKind; // 1 = common, 2 = NFT collection
    address[] public contracts;

    event AdminChanged(address indexed previous, address indexed admin);
    event SectionCreated(uint256 indexed id, string name, address upfront, address consumption, address payment);
    event SectionKeyChanged(uint256 indexed id, bytes32 keyHash);
    event SectionIpsChanged(uint256 indexed id, string allowedIps);
    event SectionActiveChanged(uint256 indexed id, bool active);
    event AccountAdded(uint256 indexed id, address indexed account);
    event ContractRegistered(address indexed contractAddress, uint8 kind, string name, string abiJson);

    modifier onlyAdmin() {
        require(msg.sender == admin, "not admin");
        _;
    }

    modifier exists(uint256 id) {
        require(id >= 1 && id <= sectionCount, "no such section");
        _;
    }

    constructor() {
        admin = msg.sender;
        emit AdminChanged(address(0), msg.sender);
    }

    function setAdmin(address next) external onlyAdmin {
        require(next != address(0), "zero admin");
        emit AdminChanged(admin, next);
        admin = next;
    }

    function createSection(
        string calldata name,
        address upfront,
        address consumption,
        address payment,
        bytes32 keyHash,
        string calldata allowedIps
    ) external onlyAdmin returns (uint256 id) {
        bytes32 nameHash = keccak256(bytes(name));
        require(bytes(name).length > 0 && bytes(name).length <= 64, "name: 1 to 64 bytes");
        require(sectionByName[nameHash] == 0, "name taken");
        require(upfront != address(0) && consumption != address(0) && payment != address(0), "zero account");
        require(upfront != consumption && upfront != payment && consumption != payment, "accounts must differ");
        require(accountKind[upfront] == 0 && accountKind[consumption] == 0 && accountKind[payment] == 0, "account already registered");
        require(keyHash != bytes32(0) && sectionByKey[keyHash] == 0, "key hash");
        require(bytes(allowedIps).length <= 1024, "allowedIps too long");

        id = ++sectionCount;
        sections[id] = Section(name, upfront, consumption, payment, keyHash, allowedIps, true, uint64(block.timestamp));
        sectionByName[nameHash] = id;
        sectionByKey[keyHash] = id;
        _account(id, upfront, ACCOUNT_UPFRONT);
        _account(id, consumption, ACCOUNT_CONSUMPTION);
        _account(id, payment, ACCOUNT_PAYMENT);

        emit SectionCreated(id, name, upfront, consumption, payment);
        emit SectionKeyChanged(id, keyHash);
        emit SectionIpsChanged(id, allowedIps);
        emit SectionActiveChanged(id, true);
    }

    function setKey(uint256 id, bytes32 keyHash) external onlyAdmin exists(id) {
        require(keyHash != bytes32(0) && sectionByKey[keyHash] == 0, "key hash");
        delete sectionByKey[sections[id].keyHash];
        sections[id].keyHash = keyHash;
        sectionByKey[keyHash] = id;
        emit SectionKeyChanged(id, keyHash);
    }

    function setAllowedIps(uint256 id, string calldata allowedIps) external onlyAdmin exists(id) {
        require(bytes(allowedIps).length <= 1024, "allowedIps too long");
        sections[id].allowedIps = allowedIps;
        emit SectionIpsChanged(id, allowedIps);
    }

    function setActive(uint256 id, bool active) external onlyAdmin exists(id) {
        sections[id].active = active;
        emit SectionActiveChanged(id, active);
    }

    /// @notice A user account created for a section (/createaccount)
    function addAccount(uint256 id, address account) external onlyAdmin exists(id) {
        require(account != address(0), "zero account");
        require(accountKind[account] == 0, "account already registered");
        _account(id, account, ACCOUNT_USER);
        emit AccountAdded(id, account);
    }

    /// @notice A contract deployed by the contract account center; the ABI is kept in the event
    function registerContract(address contractAddress, uint8 kind, string calldata name, string calldata abiJson) external onlyAdmin {
        require(contractAddress.code.length > 0, "no contract at address");
        require(kind == 1 || kind == 2, "kind: 1 common, 2 NFT");
        require(contractKind[contractAddress] == 0, "already registered");
        contractKind[contractAddress] = kind;
        contracts.push(contractAddress);
        emit ContractRegistered(contractAddress, kind, name, abiJson);
    }

    function getSection(uint256 id) external view exists(id) returns (Section memory) {
        return sections[id];
    }

    function contractCount() external view returns (uint256) {
        return contracts.length;
    }

    /// @notice Used by NftCollection v3: a first sale may only pay a section's consumption account
    function isConsumptionAccount(address account) external view returns (bool) {
        return accountKind[account] == ACCOUNT_CONSUMPTION && sections[sectionOfAccount[account]].active;
    }

    function _account(uint256 id, address account, uint8 kind) private {
        sectionOfAccount[account] = id;
        accountKind[account] = kind;
    }
}
