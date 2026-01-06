// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "./GemStepToken.sol";

contract GemStepTokenV2Mock is GemStepToken {
    // New state
    uint256 public newVariable;
    mapping(address => uint256) public userRewardMultipliers;

    // Events used in tests
    event VersionUpgraded(uint256 version);
    event RewardMultiplierSet(address indexed user, uint256 multiplier);

    // Keep gap for future layout
    uint256[40] private __gap;

    // NOTE: no constructor, no initializer or reinitializer modifiers here
    function initializeV2() external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newVariable == 0, "Already initialized");
        newVariable = 42;
        emit VersionUpgraded(2);
    }

    function version() public pure returns (uint256) {
        return 2;
    }

    function newFunction() public pure returns (bool) {
        return true;
    }

    function setRewardMultiplier(address user, uint256 multiplier)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        require(user != address(0), "Invalid address");
        userRewardMultipliers[user] = multiplier;
        emit RewardMultiplierSet(user, multiplier);
    }

    function verifyStorage() public view returns (bool) {
        // sanity invariants carried from v1 init
        return burnFee == 1 && rewardRate == 1e18;
    }
}
