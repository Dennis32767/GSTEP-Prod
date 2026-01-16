// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "../core/GemStepCore.sol";
import "../interfaces/IPriceOracleV2.sol";

/// @title GS_Staking
/// @notice ETH staking module used to back step submissions with an on-chain stake balance.
/// @dev
///  - Users stake native ETH via {stake}; balances tracked in {stakeBalance}.
///  - Users withdraw via {withdrawStake} (nonReentrant + whenNotPaused).
///  - Admin adjusts {currentStakePerStep} using the configured oracle with cooldown + oracle validity checks.
///  - Emergency admin can override stake requirements (bounded) and lock/unlock parameter changes.
abstract contract GS_Staking is GemStepCore {
    /* =============================================================
                                 USER ACTIONS
       ============================================================= */

    /// @notice Stake native ETH into the contract.
    /// @dev Increases {stakeBalance[msg.sender]} by `msg.value` and emits {Staked}.
    function stake() external payable {
        require(msg.value != 0, "0"); // No ETH sent
        unchecked {
            stakeBalance[msg.sender] += msg.value;
        }
        emit Staked(msg.sender, msg.value);
    }

    /// @notice Withdraw staked native ETH.
    /// @param amount Amount of ETH (wei) to withdraw.
    /// @dev
    ///  - Reentrancy protected.
    ///  - Blocked while paused.
    ///  - Uses {call} to forward gas; reverts if transfer fails.
    function withdrawStake(uint256 amount) external nonReentrant whenNotPaused {
        require(amount != 0, "0"); // Invalid amount

        uint256 bal = stakeBalance[msg.sender];
        require(bal >= amount, "BAL"); // Insufficient balance

        unchecked {
            stakeBalance[msg.sender] = bal - amount;
        }

        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "XFER"); // ETH send failed

        emit Withdrawn(msg.sender, amount);
    }

    /* =============================================================
                     PARAMETER ADMIN: ORACLE-DRIVEN ADJUSTMENT
       ============================================================= */

    /// @notice Adjust stake-per-step requirement using the oracle token price.
    /// @dev
    ///  - Requires {PARAMETER_ADMIN_ROLE}.
    ///  - Respects {stakeParamsLocked}.
    ///  - Respects {STAKE_ADJUST_COOLDOWN}.
    ///  - Validates oracle data using staleness and (if provided) confidence bounds.
    ///  - Updates {currentStakePerStep} and {lastStakeAdjustment}.
    function adjustStakeRequirements() external onlyRole(PARAMETER_ADMIN_ROLE) {
        require(!stakeParamsLocked, "LOCK");

        uint256 ts = block.timestamp;
        require(ts >= lastStakeAdjustment + STAKE_ADJUST_COOLDOWN, "CD");

        IPriceOracleV2 o = IPriceOracleV2(priceOracle);
        (uint256 pxWei, uint256 updatedAt, uint256 confBps) = o.latestTokenPriceWei();

        // Staleness check
        uint256 stale = o.maxStaleness();
        if (ts - updatedAt > stale) {
            revert IPriceOracleV2.StalePrice(updatedAt, ts, stale);
        }

        // Confidence check (optional: oracle may return 0 when not available)
        if (confBps != 0) {
            uint256 minConf = o.minConfidenceBps();
            // Preserves your semantics: revert if confBps > minConf
            if (confBps > minConf) revert IPriceOracleV2.ConfidenceTooLow(confBps, minConf);
        }

        // Target stake-per-step derived from price and policy.
        // NOTE: Assumes pxWei is token price in wei terms under your oracle definition.
        uint256 target = (pxWei * TARGET_STAKE_PERCENT) / 100;

        // Clamp to safety bounds.
        if (target < MIN_STAKE_PER_STEP) target = MIN_STAKE_PER_STEP;
        else if (target > MAX_STAKE_PER_STEP) target = MAX_STAKE_PER_STEP;

        _setStake(target, ts);
    }

    /* =============================================================
                     EMERGENCY ADMIN: MANUAL OVERRIDE / LOCK
       ============================================================= */

    /// @notice Manually override stake-per-step requirement within bounds.
    /// @param newStakePerStep New stake required per step (wei).
    /// @dev
    ///  - Requires {EMERGENCY_ADMIN_ROLE}.
    ///  - Respects {stakeParamsLocked}.
    ///  - Updates {currentStakePerStep} and {lastStakeAdjustment}.
    function manualOverrideStake(uint256 newStakePerStep) external onlyRole(EMERGENCY_ADMIN_ROLE) {
        require(!stakeParamsLocked, "LOCK");
        require(newStakePerStep >= MIN_STAKE_PER_STEP && newStakePerStep <= MAX_STAKE_PER_STEP, "BND");

        _setStake(newStakePerStep, block.timestamp);
    }

    /// @notice Toggle the emergency lock for stake parameter changes.
    /// @dev Requires {EMERGENCY_ADMIN_ROLE}. Emits {StakeEmergencyLocked}.
    function toggleStakeParamLock() external onlyRole(EMERGENCY_ADMIN_ROLE) {
        bool locked = !stakeParamsLocked;
        stakeParamsLocked = locked;
        emit StakeEmergencyLocked(locked);
    }

    /* =============================================================
                                 INTERNALS
       ============================================================= */

    /// @dev Shared setter to reduce repeated bytecode and keep event emission consistent.
    function _setStake(uint256 stakePerStep_, uint256 ts) internal {
        lastStakeAdjustment = ts;
        currentStakePerStep = stakePerStep_;
        emit StakeParametersUpdated(stakePerStep_, ts);
    }
}
