// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal interface for Durin L2Registry (Base). Only the functions our registrar needs.
interface IL2RegistryMinimal {
    function baseNode() external view returns (bytes32);

    function makeNode(bytes32 parentNode, string calldata label) external pure returns (bytes32);

    function ownerOf(uint256 tokenId) external view returns (address);

    function setAddr(bytes32 node, uint256 coinType, bytes calldata a) external;

    function createSubnode(
        bytes32 node,
        string calldata label,
        address owner,
        bytes[] calldata data
    ) external returns (bytes32);
}
