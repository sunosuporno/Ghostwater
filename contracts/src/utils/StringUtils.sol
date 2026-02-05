// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice String length utility for label checks. Uses byte length (labels are typically ASCII).
library StringUtils {
    function strlen(string memory s) internal pure returns (uint256) {
        return bytes(s).length;
    }
}
