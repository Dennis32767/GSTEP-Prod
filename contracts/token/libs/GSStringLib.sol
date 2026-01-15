// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title GSStringLib
/// @notice Pure string utility helpers used by GemStep for version handling and
///         ASCII validation.
/// @dev
///  - All functions are `pure` and side-effect free.
///  - Designed to be inlined by the compiler (no storage, no external calls).
///  - Safe to use from any module without affecting storage layout.
///  - Optimized for gas by preferring hash comparisons over full string ops
///    where possible.
///
/// Typical usage:
///  - Normalize client-supplied version strings before hashing / allow-listing.
///  - Validate `source` identifiers to ensure they are ASCII alphanumeric only.
library GSStringLib {
    /* =============================================================
                            VERSION NORMALIZATION
       ============================================================= */

    /// @notice Normalize known shorthand semantic versions.
    /// @dev Currently normalizes `"1.0"` → `"1.0.0"`.
    ///      Extend this function carefully if additional normalization
    ///      rules are introduced in future protocol versions.
    ///
    /// Rationale:
    ///  - Keeps EIP-712 payloads canonical.
    ///  - Prevents accidental signature mismatches caused by minor
    ///    client formatting differences.
    ///
    /// @param v Raw version string supplied by client/device.
    /// @return normalized Canonicalized version string.
    function normalizeVersion(string memory v) internal pure returns (string memory normalized) {
        // Hash comparison avoids expensive per-byte string comparison.
        if (keccak256(bytes(v)) == keccak256(bytes("1.0"))) {
            return "1.0.0";
        }
        return v;
    }

    /* =============================================================
                          ASCII VALIDATION HELPERS
       ============================================================= */

    /// @notice Returns true if `s` contains only ASCII alphanumeric characters.
    /// @dev Allowed character set:
    ///  - 0-9  (0x30–0x39)
    ///  - A-Z  (0x41–0x5A)
    ///  - a-z  (0x61–0x7A)
    ///
    /// This is intentionally strict:
    ///  - No whitespace
    ///  - No punctuation
    ///  - No UTF-8 multibyte characters
    ///
    /// @param s Input string to validate.
    /// @return ok True if string is strictly ASCII alphanumeric.
    function isAsciiAlphaNum(string memory s) internal pure returns (bool ok) {
        bytes memory b = bytes(s);
        uint256 len = b.length;

        for (uint256 i = 0; i < len; ) {
            bytes1 c = b[i];
            bool valid =
                (c >= 0x30 && c <= 0x39) || // 0-9
                (c >= 0x41 && c <= 0x5A) || // A-Z
                (c >= 0x61 && c <= 0x7A);   // a-z

            if (!valid) return false;
            unchecked { ++i; }
        }
        return true;
    }

    /* =============================================================
                         DOMAIN-SPECIFIC WRAPPERS
       ============================================================= */

    /// @notice Validate a source identifier string.
    /// @dev Alias for {isAsciiAlphaNum}. Kept as a semantic wrapper so
    ///      additional source-specific rules can be introduced later
    ///      without touching call sites.
    ///
    /// @param source Source identifier (e.g. "fitbit", "googlefit").
    /// @return valid True if source identifier is valid.
    function isValidSourceString(string memory source) internal pure returns (bool valid) {
        return isAsciiAlphaNum(source);
    }
}
