// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./BoundItems.sol";

/// @notice Nickname collection (version 6, docs/features/nicknames.md): nicknames minted by the contract
/// account center, each bought once by a section's user account and bound to it (no resale; an
/// account may hold many). A nickname has a USER LEVEL, raised by its owner by paying the step prices
/// (`upgradeLevel`), never lowered except by an undo:
///   - `undo` (BoundItems): the sale, within the hold period: everything paid is refunded, the level
///     goes back to 0 and the nickname back to the minter, for sale again;
///   - `undoLevel`: the newest level upgrade, within the hold period of that upgrade: the level goes
///     back to the one before and only that upgrade's price is refunded.
/// Both are called by the account that was paid (the section's consumption account), which sends the
/// refund. Names are unique without regard to A-Z case; `tokenOf(nickname)` finds a name's token.
/// `tokenURI` is JSON: the nickname and its user level (no picture).
contract NicknameCollection is BoundItems {
    uint256 public constant version = 6;
    string public constant collectionType = "nickname";
    uint256 public constant MAX_NAME_BYTES = 1024;  // 256 characters of up to 4 bytes (the proxy counts characters)
    uint256 public constant MAX_LEVELS = 32;

    /// @notice What a user level costs: the step from the level below. Nothing else is stored.
    struct Level {
        uint256 stepPrice;  // wei (level 0: 0)
        bool forSale;       // can be bought; nicknames already at the level keep it
    }

    Level[] private levels;
    mapping(uint256 => string) public nicknameOf;   // tokenId -> nickname
    mapping(uint256 => uint8) public levelOf;       // tokenId -> user level
    mapping(bytes32 => uint256) private byName;     // keccak256(lowercase nickname) -> tokenId

    event LevelSet(uint8 indexed level, uint256 stepPrice, bool forSale);
    event LevelUpgraded(uint256 indexed tokenId, address indexed owner, uint8 fromLevel, uint8 toLevel, uint256 price, address paidTo);
    event LevelUndone(uint256 indexed tokenId, address indexed owner, uint8 fromLevel, uint8 toLevel, uint256 refunded, address by);

    constructor(string memory name_, string memory symbol_, address registry_, uint256 holdSeconds_)
        BoundItems(name_, symbol_, registry_, holdSeconds_)
    {
        levels.push(Level(0, true));
        emit LevelSet(0, 0, true);
    }

    // ---------------------------------------------------------------- the center

    /// @notice Mint `nickname` for sale at `price` (wei). Names are unique (A-Z case does not count).
    function mint(string calldata nickname, uint256 price) external onlyMinter returns (uint256 tokenId) {
        require(_valid(bytes(nickname)), "nickname: 1-1024 bytes, no control characters, no < > & \" ' \\");
        bytes32 key = keccak256(_lower(bytes(nickname)));
        require(byName[key] == 0, "this nickname is already minted");
        tokenId = _mint(price);
        byName[key] = tokenId;
        nicknameOf[tokenId] = nickname;
    }

    /// @notice Add the next user level, for sale at `stepPrice`.
    function addLevel(uint256 stepPrice) external onlyMinter returns (uint8 level) {
        require(levels.length < MAX_LEVELS, "too many levels");
        level = uint8(levels.length);
        levels.push(Level(stepPrice, true));
        emit LevelSet(level, stepPrice, true);
    }

    /// @notice Change a level's step price or sale state. Levels are never removed; level 0 stays free
    /// and for sale.
    function setLevel(uint8 level, uint256 stepPrice, bool forSale) external onlyMinter {
        require(level < levels.length, "no such level");
        require(level > 0 || (stepPrice == 0 && forSale), "level 0: price 0, always for sale");
        levels[level] = Level(stepPrice, forSale);
        emit LevelSet(level, stepPrice, forSale);
    }

    // ---------------------------------------------------------------- the owner and the section

    /// @notice Raise the user level of `tokenId` (the caller's) to `toLevel`, paying every step price
    /// above the current level, at once to `payee` (the owner's section's consumption account).
    function upgradeLevel(uint256 tokenId, uint8 toLevel, address payee) external payable {
        require(ownerOf(tokenId) == msg.sender && msg.sender != minter, "not the owner");
        _checkBuyer(payee);
        uint8 fromLevel = levelOf[tokenId];
        require(msg.value == _priceUp(fromLevel, toLevel), "wrong price");
        levelOf[tokenId] = toLevel;
        payments[tokenId].push(Payment(PAYMENT_LEVEL, fromLevel, toLevel, false, uint64(block.timestamp), msg.sender, payee, msg.value));
        _pay(payee, msg.value);
        emit LevelUpgraded(tokenId, msg.sender, fromLevel, toLevel, msg.value, payee);
        emit MetadataUpdate(tokenId);
    }

    /// @notice Undo the newest level upgrade of `tokenId` within the hold period of that upgrade: only
    /// the account that was paid, sending exactly that upgrade's price. The level goes back to the one
    /// before; earlier upgrades and the sale stay.
    function undoLevel(uint256 tokenId) external payable {
        uint256 s = saleIndex[tokenId];
        require(s != 0, "not sold");
        Payment[] storage p = payments[tokenId];
        uint256 i = p.length;
        while (i > s && p[i - 1].undone) {
            i--;
        }
        require(i > s, "no level upgrade to undo");
        Payment storage last = p[i - 1];
        require(msg.sender == last.paidTo, "only the account that was paid can undo");
        require(block.timestamp <= uint256(last.paidAt) + holdSeconds, "the undo period is over");
        require(msg.value == last.amount, "the refund must be exactly what was paid");
        last.undone = true;
        levelOf[tokenId] = last.fromLevel;
        _pay(last.payer, last.amount);
        emit LevelUndone(tokenId, owners[tokenId], last.toLevel, last.fromLevel, last.amount, msg.sender);
        emit MetadataUpdate(tokenId);
    }

    // ---------------------------------------------------------------- reads

    /// @notice The token of `nickname` (0: not minted).
    function tokenOf(string calldata nickname) external view returns (uint256) {
        if (!_valid(bytes(nickname))) {
            return 0;
        }
        return byName[keccak256(_lower(bytes(nickname)))];
    }

    function levelCount() external view returns (uint256) {
        return levels.length;
    }

    function levelInfo(uint8 level) external view returns (Level memory) {
        require(level < levels.length, "no such level");
        return levels[level];
    }

    /// @notice Price to raise `tokenId` to `toLevel` now (reverts if not possible).
    function quote(uint256 tokenId, uint8 toLevel) external view returns (uint256) {
        require(ownerOf(tokenId) != minter, "not sold");
        return _priceUp(levelOf[tokenId], toLevel);
    }

    /// @notice data:application/json (base64): the nickname and its user level. No picture.
    function tokenURI(uint256 tokenId) external view override returns (string memory) {
        ownerOf(tokenId);
        bytes memory json = abi.encodePacked(
            '{"name":"', nicknameOf[tokenId], '","description":"Nickname","attributes":[{"trait_type":"user level","display_type":"number","value":',
            _str(levelOf[tokenId]), '}]}'
        );
        return string(abi.encodePacked("data:application/json;base64,", _base64(json)));
    }

    // ---------------------------------------------------------------- internals

    function _afterUndo(uint256 tokenId) internal override {
        levelOf[tokenId] = 0;
        emit MetadataUpdate(tokenId);
    }

    function _priceUp(uint8 fromLevel, uint8 toLevel) private view returns (uint256 total) {
        require(toLevel > fromLevel, "the level can only go up");
        require(toLevel < levels.length, "no such level");
        for (uint256 l = uint256(fromLevel) + 1; l <= toLevel; l++) {
            require(levels[l].forSale, "level not for sale");
            total += levels[l].stepPrice;
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
