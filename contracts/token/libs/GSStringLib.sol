// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title GSStringLib
/// @notice Pure helpers for version normalization and ASCII checks.
/// @dev All functions are pure and usable statically from contracts or via `using for`.
library GSStringLib {
    /// @notice Normalize minor variant "1.0" -> "1.0.0" (extend if you add more rules).
    function normalizeVersion(string memory v) internal pure returns (string memory) {
        // Compare by hash to avoid expensive string ops
        if (keccak256(bytes(v)) == keccak256(bytes("1.0"))) {
            return "1.0.0";
        }
        return v;
    }

    /// @notice Returns true if the string contains only [0-9A-Za-z].
    function isAsciiAlphaNum(string memory s) internal pure returns (bool) {
        bytes memory b = bytes(s);
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            bool ok =
                (c >= 0x30 && c <= 0x39) || // 0-9
                (c >= 0x41 && c <= 0x5A) || // A-Z
                (c >= 0x61 && c <= 0x7A);   // a-z
            if (!ok) return false;
        }
        return true;
    }

    /// @notice Source validation wrapper (alias for isAsciiAlphaNum).
    function isValidSourceString(string memory source) internal pure returns (bool) {
        return isAsciiAlphaNum(source);
    }
}
