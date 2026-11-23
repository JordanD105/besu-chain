// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IItemRegistry {
    function isConsumptionAccount(address account) external view returns (bool);
    function sectionOfAccount(address account) external view returns (uint256);
    function accountKind(address account) external view returns (uint8);
}

/// @notice The shared rules of the platform's items (avatars and nicknames, docs/features/avatars.md and
/// nicknames.md): ERC-721 tokens that
///   - only the minter (the contract account center) creates (`_mint`), held by it and for sale at a
///     price it can change until the token is sold (`setPrice`);
///   - a section's user account buys ONCE (`buy`): the price goes at once to the buyer's section's
///     consumption account; the token is then bound to the buyer (ERC-5192: no transfer, no resale);
///   - can be UNDONE within `holdSeconds` of the sale (`undo`): called by the account that was paid
///     (the consumption account), which sends the refund with the call; the buyer gets back everything
///     paid for the token (the sale and the later payments not undone yet), and the token goes back to
///     the minter, for sale again.
/// Every payment for a token is recorded (`paymentsOf`).
abstract contract BoundItems {
    uint8 internal constant ACCOUNT_USER = 1;
    uint8 internal constant PAYMENT_SALE = 0;
    uint8 internal constant PAYMENT_LEVEL = 1;
    bytes4 private constant IID_ERC165 = 0x01ffc9a7;
    bytes4 private constant IID_ERC721 = 0x80ac58cd;
    bytes4 private constant IID_METADATA = 0x5b5e139f;
    bytes4 private constant IID_ERC4906 = 0x49064906;
    bytes4 private constant IID_ERC5192 = 0xb45a3c0e;

    /// @notice One payment for a token: the sale, or (nicknames) a level upgrade.
    struct Payment {
        uint8 kind;        // 0 sale, 1 level upgrade
        uint8 fromLevel;   // level upgrade: the level before
        uint8 toLevel;     // level upgrade: the level after
        bool undone;
        uint64 paidAt;     // block time
        address payer;     // the user account that paid
        address paidTo;    // the consumption account that received it (and pays it back on undo)
        uint256 amount;    // wei
    }

    string public name;
    string public symbol;
    address public immutable minter;
    IItemRegistry public immutable registry;
    uint256 public immutable holdSeconds;  // how long a payment can be undone (7 days in production)
    uint256 public totalSupply;            // tokens minted (ids 1..totalSupply)

    mapping(uint256 => address) internal owners;
    mapping(uint256 => uint256) public priceOf;
    mapping(address => uint256[]) internal owned;
    mapping(uint256 => uint256) internal ownedIndex;  // tokenId -> position + 1 in owned[owner]
    mapping(uint256 => Payment[]) internal payments;
    mapping(uint256 => uint256) internal saleIndex;   // tokenId -> position + 1 of the current sale (0: unsold)

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event Locked(uint256 tokenId);                   // ERC-5192
    event MetadataUpdate(uint256 tokenId);           // ERC-4906
    event Minted(uint256 indexed tokenId, uint256 price);
    event PriceSet(uint256 indexed tokenId, uint256 price);
    event Sold(uint256 indexed tokenId, address indexed buyer, uint256 price, address paidTo);
    event Undone(uint256 indexed tokenId, address indexed buyer, uint256 refunded, address by);

    modifier onlyMinter() {
        require(msg.sender == minter, "not minter");
        _;
    }

    constructor(string memory name_, string memory symbol_, address registry_, uint256 holdSeconds_) {
        require(registry_ != address(0), "no registry");
        name = name_;
        symbol = symbol_;
        minter = msg.sender;
        registry = IItemRegistry(registry_);
        holdSeconds = holdSeconds_;
    }

    // ---------------------------------------------------------------- minting and selling

    /// @notice Change the price of a token not sold yet.
    function setPrice(uint256 tokenId, uint256 price) external onlyMinter {
        require(ownerOf(tokenId) == minter, "sold: the price can no longer change");
        priceOf[tokenId] = price;
        emit PriceSet(tokenId, price);
    }

    /// @notice Buy `tokenId` for exactly its price, paid at once to `payee`: the consumption account of
    /// the buyer's own section. The buyer must be a section's user account.
    function buy(uint256 tokenId, address payee) external payable {
        require(ownerOf(tokenId) == minter, "already sold");
        _checkBuyer(payee);
        require(msg.value == priceOf[tokenId], "wrong price");
        _move(minter, msg.sender, tokenId);
        payments[tokenId].push(Payment(PAYMENT_SALE, 0, 0, false, uint64(block.timestamp), msg.sender, payee, msg.value));
        saleIndex[tokenId] = payments[tokenId].length;
        _pay(payee, msg.value);
        emit Locked(tokenId);
        emit Sold(tokenId, msg.sender, msg.value, payee);
    }

    /// @notice Undo the sale of `tokenId` within `holdSeconds`: only the account that was paid, sending
    /// exactly the refund (the sale and every later payment for the token not undone yet). The buyer is
    /// refunded and the token goes back to the minter, for sale again.
    function undo(uint256 tokenId) external payable {
        uint256 s = saleIndex[tokenId];
        require(s != 0, "not sold");
        Payment[] storage p = payments[tokenId];
        Payment storage sale = p[s - 1];
        require(msg.sender == sale.paidTo, "only the account that was paid can undo");
        require(block.timestamp <= uint256(sale.paidAt) + holdSeconds, "the undo period is over");
        uint256 refund = sale.amount;
        for (uint256 i = s; i < p.length; i++) {
            if (!p[i].undone) {
                refund += p[i].amount;
                p[i].undone = true;
            }
        }
        require(msg.value == refund, "the refund must be exactly what was paid");
        sale.undone = true;
        saleIndex[tokenId] = 0;
        address buyer = owners[tokenId];
        _move(buyer, minter, tokenId);
        _afterUndo(tokenId);
        _pay(sale.payer, refund);
        emit Undone(tokenId, buyer, refund, msg.sender);
    }

    /// @notice Every payment for `tokenId`, oldest first (earlier sales that were undone included).
    function paymentsOf(uint256 tokenId) external view returns (Payment[] memory) {
        return payments[tokenId];
    }

    /// @notice The tokens `account` holds now (for the minter: the unsold ones).
    function tokensOf(address account) external view returns (uint256[] memory) {
        return owned[account];
    }

    // ---------------------------------------------------------------- ERC-721 (bound: no transfers)

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == IID_ERC165 || interfaceId == IID_ERC721 || interfaceId == IID_METADATA
            || interfaceId == IID_ERC4906 || interfaceId == IID_ERC5192;
    }

    function balanceOf(address owner) external view returns (uint256) {
        require(owner != address(0), "zero address");
        return owned[owner].length;
    }

    function ownerOf(uint256 tokenId) public view returns (address) {
        address owner = owners[tokenId];
        require(owner != address(0), "no such token");
        return owner;
    }

    /// @notice ERC-5192: items are never transferable (only bought and undone).
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
        revert("bound: items are only bought and undone, never transferred");
    }

    function setApprovalForAll(address, bool) external pure {
        revert("bound: items are only bought and undone, never transferred");
    }

    function transferFrom(address, address, uint256) external pure {
        revert("bound: items are only bought and undone, never transferred");
    }

    function safeTransferFrom(address, address, uint256) external pure {
        revert("bound: items are only bought and undone, never transferred");
    }

    function safeTransferFrom(address, address, uint256, bytes calldata) external pure {
        revert("bound: items are only bought and undone, never transferred");
    }

    function tokenURI(uint256 tokenId) external view virtual returns (string memory);

    // ---------------------------------------------------------------- internals

    function _mint(uint256 price) internal returns (uint256 tokenId) {
        tokenId = ++totalSupply;
        owners[tokenId] = minter;
        _addOwned(minter, tokenId);
        priceOf[tokenId] = price;
        emit Transfer(address(0), minter, tokenId);
        emit Minted(tokenId, price);
    }

    /// what the item type resets when a sale is undone (nicknames: the level)
    function _afterUndo(uint256 tokenId) internal virtual;

    /// the caller is a section's user account and `payee` its own section's consumption account
    function _checkBuyer(address payee) internal view {
        require(registry.accountKind(msg.sender) == ACCOUNT_USER, "buyer is not a section's user account");
        require(registry.isConsumptionAccount(payee) && registry.sectionOfAccount(payee) == registry.sectionOfAccount(msg.sender),
            "payee is not the buyer's section's consumption account");
    }

    function _move(address from, address to, uint256 tokenId) internal {
        _removeOwned(from, tokenId);
        owners[tokenId] = to;
        _addOwned(to, tokenId);
        emit Transfer(from, to, tokenId);
    }

    function _addOwned(address account, uint256 tokenId) private {
        owned[account].push(tokenId);
        ownedIndex[tokenId] = owned[account].length;
    }

    function _removeOwned(address account, uint256 tokenId) private {
        uint256[] storage list = owned[account];
        uint256 i = ownedIndex[tokenId] - 1;
        uint256 last = list[list.length - 1];
        list[i] = last;
        ownedIndex[last] = i + 1;
        list.pop();
        ownedIndex[tokenId] = 0;
    }

    function _pay(address to, uint256 amount) internal {
        if (amount > 0) {
            (bool ok, ) = to.call{value: amount}("");
            require(ok, "payment failed");
        }
    }
}
