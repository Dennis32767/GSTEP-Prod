// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title GSTimeLib
/// @notice Pure, deterministic time helpers for GemStep supply windows,
///         daily caps, and rolling-month logic.
/// @dev
///  - Uses a **fixed 30-day month convention** by design (NOT calendar months).
///  - All functions are `pure` and arithmetic-only (no block reads).
///  - Safe for use in EVM replay, simulation, and cross-chain contexts.
///  - Chosen specifically to avoid edge cases with variable-length calendar months.
///
/// ⚠️ IMPORTANT:
/// This library intentionally does **not** follow Gregorian calendar months.
/// Any off-chain tooling (indexers, dashboards, analytics) MUST mirror the
/// same 30-day convention to remain consistent with on-chain logic.
library GSTimeLib {
    /* =============================================================
                           CONSTANTS
       ============================================================= */

    /// @dev Length of one GemStep "month" in seconds.
    uint256 internal constant SECONDS_PER_MONTH = 30 days;

    /// @dev Length of one UTC day in seconds.
    uint256 internal constant SECONDS_PER_DAY = 1 days;

    /* =============================================================
                           MONTH HELPERS
       ============================================================= */

    /// @notice Returns the GemStep month index for a given timestamp.
    /// @dev
    ///  - Month index is defined as `timestamp / 30 days`.
    ///  - Month 0 starts at unix time 0.
    ///
    /// Example:
    ///  - ts = 0              → monthIndex = 0
    ///  - ts = 30 days        → monthIndex = 1
    ///  - ts = 59 days        → monthIndex = 1
    ///
    /// @param ts Unix timestamp (seconds).
    /// @return index Zero-based fixed-month index.
    function monthIndex(uint256 ts) internal pure returns (uint256 index) {
        return ts / SECONDS_PER_MONTH;
    }

    /// @notice Returns the unix timestamp of the next month boundary.
    /// @dev
    ///  - Uses the same fixed 30-day month convention.
    ///  - Safe for rollover logic (monthly caps, halving windows).
    ///
    /// Example:
    ///  - ts = 10 days  → returns 30 days
    ///  - ts = 35 days  → returns 60 days
    ///
    /// @param ts Unix timestamp (seconds).
    /// @return boundary Unix timestamp of next month boundary.
    function nextMonthBoundary(uint256 ts) internal pure returns (uint256 boundary) {
        uint256 idx = ts / SECONDS_PER_MONTH;
        unchecked {
            return (idx + 1) * SECONDS_PER_MONTH;
        }
    }

    /* =============================================================
                           DAY HELPERS
       ============================================================= */

    /// @notice Returns the UTC day index for a given timestamp.
    /// @dev
    ///  - Day index is defined as `timestamp / 1 day`.
    ///  - Used for daily step caps and per-day resets.
    ///
    /// @param ts Unix timestamp (seconds).
    /// @return index Zero-based UTC day index.
    function dayIndex(uint256 ts) internal pure returns (uint256 index) {
        return ts / SECONDS_PER_DAY;
    }

    /// @notice Returns true if two timestamps fall within the same UTC day.
    /// @dev
    ///  - Pure arithmetic comparison.
    ///  - Ignores leap seconds (consistent with EVM time semantics).
    ///
    /// @param a First unix timestamp.
    /// @param b Second unix timestamp.
    /// @return sameDay True if both timestamps are on the same UTC day.
    function isSameUtcDay(uint256 a, uint256 b) internal pure returns (bool sameDay) {
        return (a / SECONDS_PER_DAY) == (b / SECONDS_PER_DAY);
    }
}
