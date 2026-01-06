// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "../core/GemStepCore.sol";

/// @notice Test helpers (safe-gated) to drive internals during unit tests.
/// @dev Keep in prod build if you want; it's admin-gated.
abstract contract GS_TestHooks is GemStepCore {
    /// @notice Triggers month rollover logic after you advance time in tests.
    function forceMonthUpdate() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _syncMonth();
    }
}
