// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./BoundItems.sol";

/// @notice Avatar collection (version 4, docs/features/avatars.md): avatar images minted by the contract
/// account center, each bought once by a section's user account and bound to it (no resale); a sale
/// can be undone within the hold period by the section's consumption account (see BoundItems).
/// Every image is minted once: `tokenOf(image)` finds its token.
contract AvatarCollection is BoundItems {
    uint256 public constant version = 4;
    string public constant collectionType = "avatar";

    mapping(uint256 => string) public imageOf;
    mapping(uint256 => string) private uris;
    mapping(bytes32 => uint256) private byImage;

    constructor(string memory name_, string memory symbol_, address registry_, uint256 holdSeconds_)
        BoundItems(name_, symbol_, registry_, holdSeconds_) {}

    /// @notice Mint an avatar for sale at `price` (wei). `uri` is its metadata (the proxy builds a
    /// data:application/json URI with the image, description and attributes).
    function mint(string calldata image, string calldata uri, uint256 price) external onlyMinter returns (uint256 tokenId) {
        require(bytes(image).length > 0 && bytes(uri).length > 0, "image and uri are required");
        bytes32 key = keccak256(bytes(image));
        require(byImage[key] == 0, "this image is already minted");
        tokenId = _mint(price);
        byImage[key] = tokenId;
        imageOf[tokenId] = image;
        uris[tokenId] = uri;
    }

    /// @notice The token of `image` (0: not minted).
    function tokenOf(string calldata image) external view returns (uint256) {
        return byImage[keccak256(bytes(image))];
    }

    function tokenURI(uint256 tokenId) external view override returns (string memory) {
        ownerOf(tokenId);
        return uris[tokenId];
    }

    function _afterUndo(uint256) internal override {}
}
