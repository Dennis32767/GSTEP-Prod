// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "../../GemStepToken.sol";

/// @notice TEST-ONLY harness to directly set internal mint/halving state.
/// @dev Do NOT deploy to production.
contract GemStepTokenHalvingHarness is GemStepToken {
    function __setDistributedTotal(uint256 v) external {
        distributedTotal = v;
    }

    function __setHalvingCount(uint256 v) external {
        halvingCount = v;
    }

    function __setCurrentMonthlyCap(uint256 v) external {
        currentMonthlyCap = v;
    }

    function __setCurrentMonthMinted(uint256 v) external {
        currentMonthMinted = v;
    }

    function __checkHalving() external {
        _checkHalving();
    }
}
