// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice ERC-721 collection (version 2). Only the deployer (the proxy minter) can mint.
/// Every token has a price set at mint. `buy` sells a token in ONE atomic transaction: the
/// buyer sends exactly the price, receives the token, and the ETH goes to the minter. If any
/// step fails the whole sale reverts and no ETH moves.
contract NftCollectionV2 {
    /// @notice Contract version; the proxy only uses collections with version 2.
    uint256 public constant version = 2;

    bytes4 private constant ERC721_RECEIVED = 0x150b7a02;

    string public name;
    string public symbol;
    address public immutable minter;

    mapping(uint256 => address) private owners;
    mapping(address => uint256) private balances;
    mapping(uint256 => string) private tokenUris;
    mapping(uint256 => address) private tokenApprovals;
    mapping(address => mapping(address => bool)) private operatorApprovals;

    /// @notice Sale price of each token in wei, set at mint.
    mapping(uint256 => uint256) public priceOf;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event Sold(uint256 indexed tokenId, address indexed seller, address indexed buyer, uint256 price);

    constructor(string memory name_, string memory symbol_) {
        name = name_;
        symbol = symbol_;
        minter = msg.sender;
    }

    function supportsInterface(bytes4 interfaceId) public pure returns (bool) {
        return interfaceId == 0x01ffc9a7
            || interfaceId == 0x80ac58cd
            || interfaceId == 0x5b5e139f;
    }

    function balanceOf(address owner) public view returns (uint256) {
        require(owner != address(0), "zero address");
        return balances[owner];
    }

    function ownerOf(uint256 tokenId) public view returns (address) {
        address owner = owners[tokenId];
        require(owner != address(0), "not minted");
        return owner;
    }

    function tokenURI(uint256 tokenId) public view returns (string memory) {
        require(owners[tokenId] != address(0), "not minted");
        return tokenUris[tokenId];
    }

    function approve(address to, uint256 tokenId) public {
        address owner = ownerOf(tokenId);
        require(to != owner, "approve to owner");
        require(msg.sender == owner || isApprovedForAll(owner, msg.sender), "not approved");
        tokenApprovals[tokenId] = to;
        emit Approval(owner, to, tokenId);
    }

    function getApproved(uint256 tokenId) public view returns (address) {
        require(owners[tokenId] != address(0), "not minted");
        return tokenApprovals[tokenId];
    }

    function setApprovalForAll(address operator, bool approved) public {
        require(operator != msg.sender, "approve to caller");
        operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function isApprovedForAll(address owner, address operator) public view returns (bool) {
        return operatorApprovals[owner][operator];
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        require(isApprovedOrOwner(msg.sender, tokenId), "not owner nor approved");
        transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) public {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        require(isApprovedOrOwner(msg.sender, tokenId), "not owner nor approved");
        transfer(from, to, tokenId);
        require(checkOnERC721Received(msg.sender, from, to, tokenId, data), "non receiver");
    }

    /// @notice Mint `tokenId` to `to` with its metadata URI and sale price (wei).
    function mint(address to, uint256 tokenId, string memory uri, uint256 price) public {
        require(msg.sender == minter, "not minter");
        require(to != address(0), "mint to zero");
        require(owners[tokenId] == address(0), "already minted");

        balances[to] += 1;
        owners[tokenId] = to;
        tokenUris[tokenId] = uri;
        priceOf[tokenId] = price;

        emit Transfer(address(0), to, tokenId);
        require(checkOnERC721Received(msg.sender, address(0), to, tokenId, ""), "non receiver");
    }

    /// @notice Buy `tokenId` for exactly its price. The token moves to the caller and the ETH
    /// goes to the minter, in one transaction. Tokens held by the minter are always for sale;
    /// any other owner must first approve this contract for the token (or for all tokens).
    function buy(uint256 tokenId) external payable {
        address seller = ownerOf(tokenId);
        require(msg.sender != seller, "already owner");
        require(msg.value == priceOf[tokenId], "wrong price");
        require(
            seller == minter
                || tokenApprovals[tokenId] == address(this)
                || operatorApprovals[seller][address(this)],
            "not for sale"
        );

        transfer(seller, msg.sender, tokenId);
        require(checkOnERC721Received(msg.sender, seller, msg.sender, tokenId, ""), "non receiver");

        if (msg.value > 0) {
            (bool ok, ) = minter.call{value: msg.value}("");
            require(ok, "payment failed");
        }

        emit Sold(tokenId, seller, msg.sender, msg.value);
    }

    function isApprovedOrOwner(address spender, uint256 tokenId) private view returns (bool) {
        address owner = ownerOf(tokenId);
        return spender == owner
            || tokenApprovals[tokenId] == spender
            || operatorApprovals[owner][spender];
    }

    function transfer(address from, address to, uint256 tokenId) private {
        require(ownerOf(tokenId) == from, "wrong owner");
        require(to != address(0), "transfer to zero");

        delete tokenApprovals[tokenId];
        balances[from] -= 1;
        balances[to] += 1;
        owners[tokenId] = to;

        emit Transfer(from, to, tokenId);
    }

    function checkOnERC721Received(
        address operator,
        address from,
        address to,
        uint256 tokenId,
        bytes memory data
    ) private returns (bool) {
        if (to.code.length == 0) {
            return true;
        }

        (bool success, bytes memory returndata) = to.call(
            abi.encodeWithSelector(ERC721_RECEIVED, operator, from, tokenId, data)
        );

        if (!success || returndata.length < 32) {
            return false;
        }

        return abi.decode(returndata, (bytes4)) == ERC721_RECEIVED;
    }
}
