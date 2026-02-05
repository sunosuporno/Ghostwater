// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {StringUtils} from "./utils/StringUtils.sol";
import {IL2Registry} from "./interfaces/IL2Registry.sol";

/// @title GhostwaterRegistrar
/// @notice Free, one-per-address, immutable ENS L2 subnames (via Durin). For Base mainnet.
/// @dev Subnodes are owned by this contract; resolution is set to the claimer's address and cannot be changed.
contract GhostwaterRegistrar {
    using StringUtils for string;

    /// @notice Emitted when a new subdomain is claimed
    event NameRegistered(string indexed label, address indexed owner);

    IL2Registry public immutable registry;
    uint256 public immutable chainId;
    /// @dev ENSIP-11 coinType for this chain (used for setAddr)
    uint256 public immutable coinType;

    /// @dev One subdomain per address. node (bytes32) for reverse lookup.
    mapping(address => bytes32) public addressToNode;
    /// @dev Claimed label per address (e.g. "alice" for alice.yourapp.eth)
    mapping(address => string) public addressToLabel;

    error AlreadyClaimed();
    error LabelUnavailable();
    error LabelTooShort();

    constructor(address _registry) {
        registry = IL2Registry(_registry);
        chainId = block.chainid;
        coinType = (0x80000000 | chainId) >> 0;
    }

    /// @notice Claim your free subdomain. Callable only by the recipient; one subdomain per address; cannot be changed.
    /// @param label The subdomain label (e.g. "alice" for alice.yourapp.eth). Min 3 chars; must be available.
    function register(string calldata label) external {
        if (addressToNode[msg.sender] != bytes32(0)) revert AlreadyClaimed();
        if (!available(label)) revert LabelUnavailable();
        if (label.strlen() < 3) revert LabelTooShort();

        bytes32 node = _labelToNode(label);
        bytes memory addrBytes = abi.encodePacked(msg.sender);

        // Subnode is owned by this contract so the user cannot transfer or change resolution.
        registry.createSubnode(registry.baseNode(), label, address(this), new bytes[](0));

        // Resolve the name to the claimer's address on this chain and mainnet ETH.
        registry.setAddr(node, coinType, addrBytes);
        registry.setAddr(node, 60, addrBytes);

        addressToNode[msg.sender] = node;
        addressToLabel[msg.sender] = label;

        emit NameRegistered(label, msg.sender);
    }

    /// @notice Returns true if the address has claimed a subdomain.
    function hasSubdomain(address account) external view returns (bool) {
        return addressToNode[account] != bytes32(0);
    }

    /// @notice Checks if a label is available for registration.
    function available(string calldata label) public view returns (bool) {
        bytes32 node = _labelToNode(label);
        uint256 tokenId = uint256(node);
        try registry.ownerOf(tokenId) {
            return false;
        } catch {
            return label.strlen() >= 3;
        }
    }

    function _labelToNode(string calldata label) private view returns (bytes32) {
        return registry.makeNode(registry.baseNode(), label);
    }
}
