// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface INicknameRegistry {
    function isConsumptionAccount(address account) external view returns (bool);
    function sectionOfAccount(address account) external view returns (uint256);
    function accountKind(address account) external view returns (uint8);
}

/// @notice Nickname tokens (version 4, docs/features/nicknames.md): one ERC-721 token per nickname,
/// bound to its buyer (ERC-5192, never transferable), one per account, with an EDGE: the border drawn
/// around the nickname, upgraded by paying more and never lowered.
///   - `buyNickname`: a user account of a section buys a free nickname at `nicknamePrice`, edge 0;
///   - `upgradeEdge`: its owner pays the step prices up to a higher edge level.
/// In both, the ETH goes in the same transaction to the buyer's section's consumption account.
/// The edge levels (name, step price, style, for sale or not) are set by the minter, the contract
/// account center; `tokenURI` draws the nickname in its edge on chain (SVG), from the CURRENT style.
/// Nicknames compare without case for A-Z ("Alice" = "alice"); the proxy trims and NFC-normalizes.
contract NicknameCollection {
    uint256 public constant version = 4;
    string public constant collectionType = "nickname";
    uint256 public constant MAX_NAME_BYTES = 1024;  // 256 characters of up to 4 bytes (the proxy counts characters)
    uint256 public constant MAX_EDGES = 32;

    uint8 private constant ACCOUNT_USER = 1;
    bytes4 private constant IID_ERC165 = 0x01ffc9a7;
    bytes4 private constant IID_ERC721 = 0x80ac58cd;
    bytes4 private constant IID_METADATA = 0x5b5e139f;
    bytes4 private constant IID_ERC4906 = 0x49064906;
    bytes4 private constant IID_ERC5192 = 0xb45a3c0e;

    /// @notice How an edge level looks and costs. pattern: 0 solid, 1 double, 2 dashed, 3 gradient, 4 glow.
    struct Edge {
        string name;
        uint256 stepPrice;  // wei, to reach this level from the one below (level 0: unused)
        bool enabled;       // can be bought; a disabled level still draws for the tokens that have it
        bytes3 color;
        bytes3 color2;      // second color (gradient, glow, double)
        uint8 width;        // 1-20
        uint8 radius;       // 0-40
        uint8 pattern;      // 0-4
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
    event BatchMetadataUpdate(uint256 fromTokenId, uint256 toTokenId);
    event NicknameBought(uint256 indexed tokenId, address indexed buyer, string nickname, uint256 price, address paidTo);
    event EdgeUpgraded(uint256 indexed tokenId, address indexed owner, uint8 fromLevel, uint8 toLevel, uint256 price, address paidTo);
    event EdgeSet(uint8 indexed level, string name, uint256 stepPrice, bool enabled);
    event NicknamePriceSet(uint256 price);
    event Reserved(uint256 indexed tokenId, string nickname, bool reserved);

    modifier onlyMinter() {
        require(msg.sender == minter, "not minter");
        _;
    }

    /// @param edge0 name of the default edge (level 0), e.g. "Simple"
    constructor(string memory name_, string memory symbol_, address registry_, uint256 nicknamePrice_, string memory edge0) {
        require(registry_ != address(0), "no registry");
        name = name_;
        symbol = symbol_;
        minter = msg.sender;
        registry = INicknameRegistry(registry_);
        nicknamePrice = nicknamePrice_;
        _checkLabel(edge0);
        edges.push(Edge(edge0, 0, true, 0x94a3b8, 0x94a3b8, 2, 12, 0));
        emit EdgeSet(0, edge0, 0, true);
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

    function addEdge(string calldata name_, uint256 stepPrice, bytes3 color, bytes3 color2, uint8 width, uint8 radius, uint8 pattern)
        external onlyMinter returns (uint8 level)
    {
        require(edges.length < MAX_EDGES, "too many edge levels");
        level = uint8(edges.length);
        edges.push();
        _setEdge(level, name_, stepPrice, true, color, color2, width, radius, pattern);
    }

    /// @notice Change a level's name, step price, sale state or style. Levels are never removed;
    /// a style change redraws every nickname at that level. Level 0 stays for sale and costs nothing.
    function setEdge(uint8 level, string calldata name_, uint256 stepPrice, bool enabled, bytes3 color, bytes3 color2,
        uint8 width, uint8 radius, uint8 pattern) external onlyMinter
    {
        require(level < edges.length, "no such edge level");
        require(level > 0 || (stepPrice == 0 && enabled), "level 0: price 0, always enabled");
        _setEdge(level, name_, stepPrice, enabled, color, color2, width, radius, pattern);
        emit BatchMetadataUpdate(0, type(uint256).max);
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
            || interfaceId == IID_ERC4906 || interfaceId == IID_ERC5192;
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

    /// @notice data:application/json (base64): name, description, the edge as attributes, and the
    /// picture: the nickname drawn in its edge (SVG, base64), from the level's current style.
    function tokenURI(uint256 tokenId) external view returns (string memory) {
        ownerOf(tokenId);
        uint8 level = edgeOf[tokenId];
        Edge storage e = edges[level];
        string memory nick = displayNames[tokenId];
        bytes memory json = abi.encodePacked(
            '{"name":"', nick, '","description":"Nickname, edge ', e.name,
            '","attributes":[{"trait_type":"edge","value":"', e.name, '"},{"trait_type":"edge level","display_type":"number","value":',
            _str(level), '}],"image":"data:image/svg+xml;base64,', _base64(_svg(nick, e)), '"}'
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
            require(edges[l].enabled, "edge level not for sale");
            total += edges[l].stepPrice;
        }
    }

    function _pay(address payee) private {
        if (msg.value > 0) {
            (bool ok, ) = payee.call{value: msg.value}("");
            require(ok, "payment failed");
        }
    }

    function _setEdge(uint8 level, string calldata name_, uint256 stepPrice, bool enabled, bytes3 color, bytes3 color2,
        uint8 width, uint8 radius, uint8 pattern) private
    {
        _checkLabel(name_);
        require(width >= 1 && width <= 20, "width: 1-20");
        require(radius <= 40, "radius: 0-40");
        require(pattern <= 4, "pattern: 0 solid, 1 double, 2 dashed, 3 gradient, 4 glow");
        edges[level] = Edge(name_, stepPrice, enabled, color, color2, width, radius, pattern);
        emit EdgeSet(level, name_, stepPrice, enabled);
    }

    function _checkLabel(string memory label) private pure {
        require(bytes(label).length >= 1 && bytes(label).length <= 32 && _valid(bytes(label)), "edge name: 1-32 bytes, plain text");
    }

    /// 1-1024 bytes, no control characters and none of < > & " ' \ (the picture and JSON stay safe)
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

    // ---- the picture: the nickname inside its edge. Widths are counted in half-units: a 1- or 2-byte
    // UTF-8 character (Latin, Cyrillic, …) is 1, a 3- or 4-byte one (Korean, Chinese, Japanese, emoji) 2.
    // A line holds 520 px: about 16 half-units at 56 px, 26 at 36 px, 33 at 28 px.

    function _svg(string memory nick, Edge storage e) private view returns (bytes memory) {
        (bytes memory text, uint256 height) = _textBlock(bytes(nick));
        return abi.encodePacked(_head(e, height), _frame(e, height, 16 + uint256(e.width)), text, "</svg>");
    }

    function _head(Edge storage e, uint256 height) private view returns (bytes memory) {
        return abi.encodePacked(
            "<svg xmlns='http://www.w3.org/2000/svg' width='600' height='", _str(height), "' viewBox='0 0 600 ", _str(height), "'>",
            "<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='", _hex(e.color),
            "'/><stop offset='1' stop-color='", _hex(e.color2), "'/></linearGradient></defs>",
            "<rect width='600' height='", _str(height), "' fill='#0f172a'/>"
        );
    }

    /// the <text> with its lines, and the picture's height
    function _textBlock(bytes memory b) private pure returns (bytes memory text, uint256 height) {
        uint256 units = 0;
        for (uint256 i = 0; i < b.length; i++) {
            units += _unitsAt(b, i);
        }
        (uint256 size, uint256 perLine) = units <= 16 ? (uint256(56), uint256(16)) : (units <= 26 ? (uint256(36), uint256(26)) : (uint256(28), uint256(33)));
        uint256 lineHeight = size * 5 / 4;
        (bytes memory tspans, uint256 lines) = _lines(b, perLine, lineHeight);
        height = 120 + lines * lineHeight;
        text = abi.encodePacked(
            "<text x='300' y='", _str(60 + size + (lineHeight - size) / 2), "' font-family='sans-serif' font-size='", _str(size),
            "' font-weight='600' fill='#f8fafc' text-anchor='middle'>", tspans, "</text>"
        );
    }

    function _frame(Edge storage e, uint256 height, uint256 pad) private view returns (bytes memory) {
        uint256 w = e.width;
        bytes memory box = abi.encodePacked(
            "x='", _str(pad), "' y='", _str(pad), "' width='", _str(600 - 2 * pad), "' height='", _str(height - 2 * pad),
            "' rx='", _str(e.radius), "' fill='none' stroke-width='", _str(w), "'"
        );
        if (e.pattern == 1) {  // double
            uint256 inner = pad + 2 * w + 2;
            return abi.encodePacked("<rect ", box, " stroke='", _hex(e.color), "'/><rect x='", _str(inner), "' y='", _str(inner),
                "' width='", _str(600 - 2 * inner), "' height='", _str(height - 2 * inner), "' rx='", _str(e.radius),
                "' fill='none' stroke-width='", _str(w), "' stroke='", _hex(e.color2), "'/>");
        }
        if (e.pattern == 2) {  // dashed
            return abi.encodePacked("<rect ", box, " stroke='", _hex(e.color), "' stroke-dasharray='", _str(w * 4), " ", _str(w * 2), "'/>");
        }
        if (e.pattern == 3) {  // gradient
            return abi.encodePacked("<rect ", box, " stroke='url(#g)'/>");
        }
        if (e.pattern == 4) {  // glow: a wide soft border in the second color under the main one
            return abi.encodePacked("<rect x='", _str(pad), "' y='", _str(pad), "' width='", _str(600 - 2 * pad), "' height='",
                _str(height - 2 * pad), "' rx='", _str(e.radius), "' fill='none' stroke-width='", _str(w * 3), "' stroke='",
                _hex(e.color2), "' stroke-opacity='0.35'/><rect ", box, " stroke='", _hex(e.color), "'/>");
        }
        return abi.encodePacked("<rect ", box, " stroke='", _hex(e.color), "'/>");  // solid
    }

    /// width in half-units of the character starting at b[i] (0 for a continuation byte)
    function _unitsAt(bytes memory b, uint256 i) private pure returns (uint256) {
        uint8 c = uint8(b[i]);
        if (c & 0xc0 == 0x80) {
            return 0;
        }
        return c >= 0xe0 ? 2 : 1;
    }

    /// one <tspan> per line of at most `perLine` half-units, broken after the last space of the line
    /// when there is one (otherwise inside the word), always on a UTF-8 character boundary
    function _lines(bytes memory b, uint256 perLine, uint256 lineHeight) private pure returns (bytes memory out, uint256 count) {
        uint256 start = 0;
        uint256 width = 0;
        uint256 space = 0;       // index of the last space in the current line (0: none)
        uint256 afterSpace = 0;  // width of the line up to and including that space
        for (uint256 i = 0; i <= b.length; i++) {
            uint256 u = i < b.length ? _unitsAt(b, i) : 0;
            if (i == b.length || (u > 0 && width + u > perLine)) {
                uint256 end = (i < b.length && space > start) ? space : i;
                out = abi.encodePacked(out, "<tspan x='300' dy='", count == 0 ? bytes("0") : _str(lineHeight), "'>", _slice(b, start, end), "</tspan>");
                count++;
                if (end != i) {
                    start = end + 1;            // the rest of the word moves to the next line
                    width = width - afterSpace;
                } else {
                    start = i;
                    width = 0;
                }
                space = 0;
            }
            if (i < b.length && b[i] == 0x20 && i > start) {
                space = i;
                afterSpace = width + 1;
            }
            width += u;
        }
    }

    function _slice(bytes memory b, uint256 from, uint256 to) private pure returns (bytes memory part) {
        part = new bytes(to - from);
        for (uint256 j = from; j < to; j++) {
            part[j - from] = b[j];
        }
    }

    function _hex(bytes3 c) private pure returns (bytes memory out) {
        bytes16 digits = "0123456789abcdef";
        out = new bytes(7);
        out[0] = "#";
        for (uint256 i = 0; i < 3; i++) {
            out[1 + 2 * i] = digits[uint8(c[i]) >> 4];
            out[2 + 2 * i] = digits[uint8(c[i]) & 0x0f];
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
