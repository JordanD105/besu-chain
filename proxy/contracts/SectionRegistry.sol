// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title SectionRegistry (version 2)
/// @notice The on-chain record of the sections (docs/sections.md), read by both proxies and chainlens.
/// Each section has three MPC accounts:
///   - upfront:     pays out (funds new accounts, /transfer -x); topped up manually from SENDER01
///   - consumption: receives (/transfer +x, first NFT sales); swept to payment
///   - payment:     collects the swept money; can pay it back to SENDER01
/// and an API key, stored only as its keccak256 hash. Everything about a section can change later
/// without a new contract: its name, any of its accounts, free-form info fields; a section can be
/// archived (its name and key are freed, its history stays).
/// The registry also records the user accounts of each section and the registered contracts (the
/// ABI travels in the ContractRegistered event). Only the admin (an MPC account the proxy sends
/// from) writes.
contract SectionRegistry {
    uint256 public constant VERSION = 2;

    // kinds of the accounts known to the registry
    uint8 public constant ACCOUNT_USER = 1;
    uint8 public constant ACCOUNT_UPFRONT = 2;
    uint8 public constant ACCOUNT_CONSUMPTION = 3;
    uint8 public constant ACCOUNT_PAYMENT = 4;
    uint8 public constant ACCOUNT_RETIRED = 5; // a replaced section account: still the section's, no role

    uint256 public constant MAX_INFO_KEYS = 32;

    struct Section {
        string name;
        address upfront;
        address consumption;
        address payment;
        bytes32 keyHash;
        bool active;
        bool archived;
        uint64 createdAt;
    }

    address public admin;
    uint256 public sectionCount; // section ids are 1..sectionCount
    mapping(uint256 => Section) private sections;
    mapping(bytes32 => uint256) public sectionByName; // keccak256 of the name as given (the proxy normalizes it)
    mapping(bytes32 => uint256) public sectionByKey; // API-key hash -> section
    mapping(address => uint256) public sectionOfAccount; // section, retired and user accounts -> section
    mapping(address => uint8) public accountKind;

    // free-form info fields per section (description, contact, limits, ...)
    mapping(uint256 => string[]) private infoKeys;
    mapping(uint256 => mapping(string => string)) private infoValues;
    mapping(uint256 => mapping(string => uint256)) private infoIndex; // position + 1 in infoKeys

    // contracts registered by the proxy (deployed by the contract account center)
    mapping(address => uint8) public contractKind; // 1 = common, 2 = NFT collection
    address[] public contracts;

    event AdminChanged(address indexed previous, address indexed admin);
    event SectionCreated(uint256 indexed id, string name, address upfront, address consumption, address payment);
    event SectionRenamed(uint256 indexed id, string name);
    event SectionKeyChanged(uint256 indexed id, bytes32 keyHash);
    event SectionActiveChanged(uint256 indexed id, bool active);
    event SectionAccountReplaced(uint256 indexed id, uint8 role, address previous, address account);
    event SectionInfoChanged(uint256 indexed id, string key, string value);
    event SectionArchived(uint256 indexed id);
    event AccountAdded(uint256 indexed id, address indexed account);
    event ContractRegistered(address indexed contractAddress, uint8 kind, string name, string abiJson);

    modifier onlyAdmin() {
        require(msg.sender == admin, "not admin");
        _;
    }

    modifier live(uint256 id) {
        require(id >= 1 && id <= sectionCount, "no such section");
        require(!sections[id].archived, "section archived");
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

    function createSection(string calldata name, address upfront, address consumption, address payment, bytes32 keyHash)
        external
        onlyAdmin
        returns (uint256 id)
    {
        require(upfront != address(0) && consumption != address(0) && payment != address(0), "zero account");
        require(upfront != consumption && upfront != payment && consumption != payment, "accounts must differ");
        require(accountKind[upfront] == 0 && accountKind[consumption] == 0 && accountKind[payment] == 0, "account already registered");
        require(keyHash != bytes32(0) && sectionByKey[keyHash] == 0, "key hash");

        id = ++sectionCount;
        _setName(id, name);
        Section storage s = sections[id];
        s.upfront = upfront;
        s.consumption = consumption;
        s.payment = payment;
        s.keyHash = keyHash;
        s.active = true;
        s.createdAt = uint64(block.timestamp);
        sectionByKey[keyHash] = id;
        _account(id, upfront, ACCOUNT_UPFRONT);
        _account(id, consumption, ACCOUNT_CONSUMPTION);
        _account(id, payment, ACCOUNT_PAYMENT);

        emit SectionCreated(id, name, upfront, consumption, payment);
        emit SectionKeyChanged(id, keyHash);
        emit SectionActiveChanged(id, true);
    }

    function setName(uint256 id, string calldata name) external onlyAdmin live(id) {
        delete sectionByName[keccak256(bytes(sections[id].name))];
        _setName(id, name);
        emit SectionRenamed(id, name);
    }

    function setKey(uint256 id, bytes32 keyHash) external onlyAdmin live(id) {
        require(keyHash != bytes32(0) && sectionByKey[keyHash] == 0, "key hash");
        delete sectionByKey[sections[id].keyHash];
        sections[id].keyHash = keyHash;
        sectionByKey[keyHash] = id;
        emit SectionKeyChanged(id, keyHash);
    }

    function setActive(uint256 id, bool active) external onlyAdmin live(id) {
        sections[id].active = active;
        emit SectionActiveChanged(id, active);
    }

    /// @notice A new account for a role (2 upfront, 3 consumption, 4 payment). The previous account
    /// stays the section's (kind RETIRED): its money is moved by the proxy, never by others.
    function replaceAccount(uint256 id, uint8 role, address account) external onlyAdmin live(id) {
        require(account != address(0), "zero account");
        require(accountKind[account] == 0, "account already registered");
        Section storage s = sections[id];
        address previous;
        if (role == ACCOUNT_UPFRONT) {
            previous = s.upfront;
            s.upfront = account;
        } else if (role == ACCOUNT_CONSUMPTION) {
            previous = s.consumption;
            s.consumption = account;
        } else if (role == ACCOUNT_PAYMENT) {
            previous = s.payment;
            s.payment = account;
        } else {
            revert("role: 2 upfront, 3 consumption, 4 payment");
        }
        accountKind[previous] = ACCOUNT_RETIRED;
        _account(id, account, role);
        emit SectionAccountReplaced(id, role, previous, account);
    }

    /// @notice Sets an info field; an empty value removes it
    function setInfo(uint256 id, string calldata key, string calldata value) external onlyAdmin live(id) {
        require(bytes(key).length > 0 && bytes(key).length <= 32, "key: 1 to 32 bytes");
        require(bytes(value).length <= 512, "value: up to 512 bytes");
        uint256 pos = infoIndex[id][key];
        if (bytes(value).length == 0) {
            if (pos != 0) {
                string[] storage keys = infoKeys[id];
                string memory last = keys[keys.length - 1];
                keys[pos - 1] = last;
                infoIndex[id][last] = pos;
                keys.pop();
                delete infoIndex[id][key];
                delete infoValues[id][key];
            }
        } else {
            if (pos == 0) {
                require(infoKeys[id].length < MAX_INFO_KEYS, "too many info fields");
                infoKeys[id].push(key);
                infoIndex[id][key] = infoKeys[id].length;
            }
            infoValues[id][key] = value;
        }
        emit SectionInfoChanged(id, key, value);
    }

    /// @notice Archives a section: disabled for good, its name and key freed; its accounts stay its
    /// own (no one else can use them) and its history stays on chain. The proxy moves its money first.
    function archive(uint256 id) external onlyAdmin live(id) {
        Section storage s = sections[id];
        delete sectionByName[keccak256(bytes(s.name))];
        delete sectionByKey[s.keyHash];
        s.keyHash = bytes32(0);
        s.active = false;
        s.archived = true;
        emit SectionActiveChanged(id, false);
        emit SectionArchived(id);
    }

    /// @notice A user account created for a section (/createaccount)
    function addAccount(uint256 id, address account) external onlyAdmin live(id) {
        require(account != address(0), "zero account");
        require(accountKind[account] == 0, "account already registered");
        _account(id, account, ACCOUNT_USER);
        emit AccountAdded(id, account);
    }

    /// @notice Several user accounts at once (migration from an earlier registry)
    function addAccounts(uint256 id, address[] calldata accounts) external onlyAdmin live(id) {
        for (uint256 i = 0; i < accounts.length; i++) {
            if (accounts[i] != address(0) && accountKind[accounts[i]] == 0) {
                _account(id, accounts[i], ACCOUNT_USER);
                emit AccountAdded(id, accounts[i]);
            }
        }
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

    function getSection(uint256 id) external view returns (Section memory) {
        require(id >= 1 && id <= sectionCount, "no such section");
        return sections[id];
    }

    function getInfo(uint256 id) external view returns (string[] memory keys, string[] memory values) {
        keys = infoKeys[id];
        values = new string[](keys.length);
        for (uint256 i = 0; i < keys.length; i++) {
            values[i] = infoValues[id][keys[i]];
        }
    }

    function contractCount() external view returns (uint256) {
        return contracts.length;
    }

    /// @notice Used by NftCollection v3: a first sale may only pay a live section's consumption account
    function isConsumptionAccount(address account) external view returns (bool) {
        Section storage s = sections[sectionOfAccount[account]];
        return accountKind[account] == ACCOUNT_CONSUMPTION && s.active && !s.archived;
    }

    function _setName(uint256 id, string calldata name) private {
        bytes32 nameHash = keccak256(bytes(name));
        require(bytes(name).length > 0 && bytes(name).length <= 64, "name: 1 to 64 bytes");
        require(sectionByName[nameHash] == 0, "name taken");
        sections[id].name = name;
        sectionByName[nameHash] = id;
    }

    function _account(uint256 id, address account, uint8 kind) private {
        sectionOfAccount[account] = id;
        accountKind[account] = kind;
    }
}
