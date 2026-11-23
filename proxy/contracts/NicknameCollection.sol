// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface INicknameRegistry {
    function isConsumptionAccount(address account) external view returns (bool);
    function sectionOfAccount(address account) external view returns (uint256);
    function accountKind(address account) external view returns (uint8);
}

/// @notice Nickname tokens (version 5, docs/features/nicknames.md): one ERC-721 token per nickname,
/// bound to its buyer (ERC-5192, never transferable), one per account, with an EDGE LEVEL (a number),
/// raised by paying more and never lowered. The token holds only its nickname and level: how a level
/// looks is up to the applications.
///   - `buyNickname`: a user account of a section buys a free nickname at `nicknamePrice`, edge 0;
///   - `upgradeEdge`: its owner pays the step prices up to a higher edge level.
/// In both, the ETH goes in the same transaction to the buyer's section's consumption account.
/// The edge levels (step price, for sale or not) are set by the minter, the contract account center.
/// `tokenURI` is JSON: the nickname and its edge level (no picture).
/// Nicknames compare without case for A-Z ("Alice" = "alice"); the proxy trims and NFC-normalizes.
contract NicknameCollection {
    uint256 public constant version = 5;
    string public constant collectionType = "nickname";
    uint256 public constant MAX_NAME_BYTES = 1024;  // 256 characters of up to 4 bytes (the proxy counts characters)
    uint256 public constant MAX_EDGES = 32;

    uint8 private constant ACCOUNT_USER = 1;
    bytes4 private constant IID_ERC165 = 0x01ffc9a7;
    bytes4 private constant IID_ERC721 = 0x80ac58cd;
    bytes4 private constant IID_METADATA = 0x5b5e139f;
    bytes4 private constant IID_ERC4906 = 0x49064906;
    bytes4 private constant IID_ERC5192 = 0xb45a3c0e;

    /// @notice What an edge level costs. Nothing else is stored about a level.
    struct Edge {
        uint256 stepPrice;  // wei, to reach this level from the one below (level 0: 0)
        bool forSale;       // can be bought; tokens already at the level keep it
    }

    string public name;
    string public symbol;
    address public immutable minter;
    INicknameRegistry public immutable registry;

    uint256 public nicknamePrice;  // wei, a new nickname at edge 0
    uint256 public totalSupply;
    Edge[] private edges;

    mapping(uint256 => address) private owners;
    mapping(address => uint256) public nicknameOf;  // account -> tokenId (0: none)
    mapping(uint256 => string) private displayNames;
    mapping(uint256 => uint8) public edgeOf;
    mapping(uint256 => bool) public reserved;        // tokenId of a reserved nickname

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event Locked(uint256 tokenId);                   // ERC-5192
    event MetadataUpdate(uint256 tokenId);           // ERC-4906
    event NicknameBought(uint256 indexed tokenId, address indexed buyer, string nickname, uint256 price, address paidTo);
    event EdgeUpgraded(uint256 indexed tokenId, address indexed owner, uint8 fromLevel, uint8 toLevel, uint256 price, address paidTo);
    event EdgeSet(uint8 indexed level, uint256 stepPrice, bool forSale);
    event NicknamePriceSet(uint256 price);
    event Reserved(uint256 indexed tokenId, string nickname, bool reserved);

    modifier onlyMinter() {
        require(msg.sender == minter, "not minter");
        _;
    }

    constructor(string memory name_, string memory symbol_, address registry_, uint256 nicknamePrice_) {
        require(registry_ != address(0), "no registry");
        name = name_;
        symbol = symbol_;
        minter = msg.sender;
        registry = INicknameRegistry(registry_);
        nicknamePrice = nicknamePrice_;
        edges.push(Edge(0, true));
        emit EdgeSet(0, 0, true);
        emit NicknamePriceSet(nicknamePrice_);
    }

    // ---------------------------------------------------------------- buying and upgrading

    /// @notice Buy `nickname` (edge 0) for exactly `nicknamePrice`, paid to `payee`: the consumption
    /// account of the buyer's own section. The buyer must be a section's user account with no nickname.
    function buyNickname(string calldata nickname, address payee) external payable returns (uint256 tokenId) {
        require(nicknameOf[msg.sender] == 0, "already has a nickname");
        _checkPayee(payee);
        require(msg.value == nicknamePrice, "wrong price");
        tokenId = idOf(nickname);
        require(owners[tokenId] == address(0), "nickname taken");
        require(!reserved[tokenId], "nickname reserved");

        owners[tokenId] = msg.sender;
        nicknameOf[msg.sender] = tokenId;
        displayNames[tokenId] = nickname;
        totalSupply += 1;
        emit Transfer(address(0), msg.sender, tokenId);
        emit Locked(tokenId);
        _pay(payee);
        emit NicknameBought(tokenId, msg.sender, nickname, msg.value, payee);
    }

    /// @notice Raise the edge of the caller's nickname to `toLevel`, paying the step prices of every
    /// level above the current one up to `toLevel` (each must be for sale) to `payee` (as above).
    function upgradeEdge(uint8 toLevel, address payee) external payable {
        uint256 tokenId = nicknameOf[msg.sender];
        require(tokenId != 0, "no nickname");
        _checkPayee(payee);
        uint8 fromLevel = edgeOf[tokenId];
        require(msg.value == _priceUp(fromLevel, toLevel), "wrong price");
        edgeOf[tokenId] = toLevel;
        _pay(payee);
        emit EdgeUpgraded(tokenId, msg.sender, fromLevel, toLevel, msg.value, payee);
        emit MetadataUpdate(tokenId);
    }

    /// @notice Price for `account` to reach `toLevel` now (reverts if not possible).
    function quote(address account, uint8 toLevel) external view returns (uint256) {
        uint256 tokenId = nicknameOf[account];
        require(tokenId != 0, "no nickname");
        return _priceUp(edgeOf[tokenId], toLevel);
    }

    /// @notice True when `nickname` is valid, not taken and not reserved.
    function isAvailable(string calldata nickname) external view returns (bool) {
        if (!_valid(bytes(nickname))) {
            return false;
        }
        uint256 tokenId = uint256(keccak256(_lower(bytes(nickname))));
        return owners[tokenId] == address(0) && !reserved[tokenId];
    }

    /// @notice The token id of `nickname` (whether bought or not): keccak256 of its lowercase (A-Z) bytes.
    function idOf(string calldata nickname) public pure returns (uint256) {
        require(_valid(bytes(nickname)), "nickname: 1-1024 bytes, no control characters, no < > & \" ' \\");
        return uint256(keccak256(_lower(bytes(nickname))));
    }

    function nicknameById(uint256 tokenId) external view returns (string memory) {
        return displayNames[tokenId];
    }

    // ---------------------------------------------------------------- edge levels (the center)

    function edgeCount() external view returns (uint256) {
        return edges.length;
    }

    function edgeInfo(uint8 level) external view returns (Edge memory) {
        require(level < edges.length, "no such edge level");
        return edges[level];
    }

    function setNicknamePrice(uint256 price) external onlyMinter {
        nicknamePrice = price;
        emit NicknamePriceSet(price);
    }

    /// @notice Add the next edge level, for sale at `stepPrice`.
    function addEdge(uint256 stepPrice) external onlyMinter returns (uint8 level) {
        require(edges.length < MAX_EDGES, "too many edge levels");
        level = uint8(edges.length);
        edges.push(Edge(stepPrice, true));
        emit EdgeSet(level, stepPrice, true);
    }

    /// @notice Change a level's step price or sale state. Levels are never removed. Level 0 stays for
    /// sale and costs nothing.
    function setEdge(uint8 level, uint256 stepPrice, bool forSale) external onlyMinter {
        require(level < edges.length, "no such edge level");
        require(level > 0 || (stepPrice == 0 && forSale), "level 0: price 0, always for sale");
        edges[level] = Edge(stepPrice, forSale);
        emit EdgeSet(level, stepPrice, forSale);
    }

    /// @notice Reserve (or release) nicknames nobody may buy; a nickname already bought is not affected.
    function reserve(string[] calldata nicknames, bool isReserved) external onlyMinter {
        for (uint256 i = 0; i < nicknames.length; i++) {
            uint256 tokenId = idOf(nicknames[i]);
            reserved[tokenId] = isReserved;
            emit Reserved(tokenId, nicknames[i], isReserved);
        }
    }

    // ---------------------------------------------------------------- ERC-721 (bound: no transfers)

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == IID_ERC165 || interfaceId == IID_ERC721 || interfaceId == IID_METADATA
            || interfaceId == IID_ERC4906 || interfaceId == IID_ERC5192;  // ERC-4906: MetadataUpdate on an upgrade
    }

    function balanceOf(address owner) external view returns (uint256) {
        require(owner != address(0), "zero address");
        return nicknameOf[owner] == 0 ? 0 : 1;
    }

    function ownerOf(uint256 tokenId) public view returns (address) {
        address owner = owners[tokenId];
        require(owner != address(0), "no such token");
        return owner;
    }

    /// @notice ERC-5192: every nickname is bound to its buyer.
    function locked(uint256 tokenId) external view returns (bool) {
        ownerOf(tokenId);
        return true;
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        ownerOf(tokenId);
        return address(0);
    }

    function isApprovedForAll(address, address) external pure returns (bool) {
        return false;
    }

    function approve(address, uint256) external pure {
        revert("nickname is bound to its buyer");
    }

    function setApprovalForAll(address, bool) external pure {
        revert("nickname is bound to its buyer");
    }

    function transferFrom(address, address, uint256) external pure {
        revert("nickname is bound to its buyer");
    }

    function safeTransferFrom(address, address, uint256) external pure {
        revert("nickname is bound to its buyer");
    }

    function safeTransferFrom(address, address, uint256, bytes calldata) external pure {
        revert("nickname is bound to its buyer");
    }

    /// @notice data:application/json (base64): the nickname and its edge level. No picture.
    function tokenURI(uint256 tokenId) external view returns (string memory) {
        ownerOf(tokenId);
        bytes memory json = abi.encodePacked(
            '{"name":"', displayNames[tokenId], '","description":"Nickname","attributes":[{"trait_type":"edge level","display_type":"number","value":',
            _str(edgeOf[tokenId]), '}]}'
        );
        return string(abi.encodePacked("data:application/json;base64,", _base64(json)));
    }

    // ---------------------------------------------------------------- internals

    function _checkPayee(address payee) private view {
        require(registry.accountKind(msg.sender) == ACCOUNT_USER, "buyer is not a section's user account");
        require(registry.isConsumptionAccount(payee) && registry.sectionOfAccount(payee) == registry.sectionOfAccount(msg.sender),
            "payee is not the buyer's section's consumption account");
    }

    function _priceUp(uint8 fromLevel, uint8 toLevel) private view returns (uint256 total) {
        require(toLevel > fromLevel, "edge can only go up");
        require(toLevel < edges.length, "no such edge level");
        for (uint256 l = uint256(fromLevel) + 1; l <= toLevel; l++) {
            require(edges[l].forSale, "edge level not for sale");
            total += edges[l].stepPrice;
        }
    }

    function _pay(address payee) private {
        if (msg.value > 0) {
            (bool ok, ) = payee.call{value: msg.value}("");
            require(ok, "payment failed");
        }
    }

    /// 1-1024 bytes, no control characters and none of < > & " ' \ (the JSON stays safe)
    function _valid(bytes memory b) private pure returns (bool) {
        if (b.length == 0 || b.length > MAX_NAME_BYTES) {
            return false;
        }
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            if (c < 0x20 || c == 0x7f || c == "<" || c == ">" || c == "&" || c == '"' || c == "'" || c == "\\") {
                return false;
            }
        }
        return true;
    }

    function _lower(bytes memory b) private pure returns (bytes memory out) {
        out = new bytes(b.length);
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            out[i] = (c >= "A" && c <= "Z") ? bytes1(uint8(c) + 32) : c;
        }
    }

    function _str(uint256 v) private pure returns (bytes memory) {
        if (v == 0) {
            return "0";
        }
        uint256 len;
        for (uint256 t = v; t != 0; t /= 10) {
            len++;
        }
        bytes memory out = new bytes(len);
        for (; v != 0; v /= 10) {
            out[--len] = bytes1(uint8(48 + v % 10));
        }
        return out;
    }

    function _base64(bytes memory data) private pure returns (bytes memory out) {
        if (data.length == 0) {
            return "";
        }
        bytes memory table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        out = new bytes(4 * ((data.length + 2) / 3));
        uint256 j = 0;
        for (uint256 i = 0; i < data.length; i += 3) {
            uint256 a = uint8(data[i]);
            uint256 b = i + 1 < data.length ? uint8(data[i + 1]) : 0;
            uint256 c = i + 2 < data.length ? uint8(data[i + 2]) : 0;
            uint256 n = (a << 16) | (b << 8) | c;
            out[j++] = table[(n >> 18) & 63];
            out[j++] = table[(n >> 12) & 63];
            out[j++] = i + 1 < data.length ? table[(n >> 6) & 63] : bytes1("=");
            out[j++] = i + 2 < data.length ? table[n & 63] : bytes1("=");
        }
    }
}
