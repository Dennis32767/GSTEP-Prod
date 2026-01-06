// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title GSTimeLib
/// @notice Pure helpers for day/month index math used in supply rolling windows and daily caps.
library GSTimeLib {
    /// @notice Returns the UTC "month index" given GemStep's fixed-month convention (30 days).
    function monthIndex(uint256 ts) external pure returns (uint256) {
        return ts / 30 days;
    }

    /// @notice Returns the UTC day index (unixTime / 1 day).
    function dayIndex(uint256 ts) external pure returns (uint256) {
        return ts / 1 days;
    }

    /// @notice True if both timestamps fall on the same UTC day.
    function isSameUtcDay(uint256 a, uint256 b) external pure returns (bool) {
        return (a / 1 days) == (b / 1 days);
    }

    /// @notice Start timestamp (unix) of the next month boundary using the 30-day month convention.
    function nextMonthBoundary(uint256 ts) external pure returns (uint256) {
        uint256 idx = ts / 30 days;
        return (idx + 1) * 30 days;
    }
}
