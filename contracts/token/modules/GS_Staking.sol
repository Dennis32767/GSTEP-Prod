// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "../core/GemStepCore.sol";
import "../interfaces/IPriceOracleV2.sol";

/// @title GS_Staking
/// @notice ETH staking module used to back step submissions with an on-chain stake balance.
/// @dev
///  - Users stake native ETH via {stake}; balance is tracked in {stakeBalance}.
///  - Users can withdraw via {withdrawStake} (nonReentrant, paused-guarded).
///  - Admin can adjust {currentStakePerStep} dynamically using the configured price oracle:
///      - Enforced cooldown via {STAKE_ADJUST_COOLDOWN}
///      - Enforced staleness via {IPriceOracleV2.maxStaleness}
///      - Optional confidence check via {IPriceOracleV2.minConfidenceBps}
///  - Emergency admin can manually override stake requirements and lock/unlock parameter changes.
abstract contract GS_Staking is GemStepCore {
    /* =============================================================
                                 USER ACTIONS
       ============================================================= */

    /// @notice Stake native ETH into the contract.
    /// @dev Increases {stakeBalance[msg.sender]} by msg.value and emits {Staked}.
    function stake() external payable {
        require(msg.value > 0, "No ETH sent");
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
    ///  - Uses call() to forward gas; reverts if transfer fails.
    function withdrawStake(uint256 amount)
        external
        nonReentrant
        whenNotPaused
    {
        require(amount > 0, "Invalid amount");

        uint256 bal = stakeBalance[msg.sender];
        require(bal >= amount, "Insufficient balance");

        // Effects
        unchecked {
            stakeBalance[msg.sender] = bal - amount;
        }

        // Interaction
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "ETH send failed");

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
        require(!stakeParamsLocked, "Stake parameters locked");
        require(
            block.timestamp >= lastStakeAdjustment + STAKE_ADJUST_COOLDOWN,
            "Cooldown active"
        );

        IPriceOracleV2 o = IPriceOracleV2(priceOracle);
        (uint256 pxWei, uint256 updatedAt, uint256 confBps) = o.latestTokenPriceWei();

        // Staleness check
        uint256 stale = o.maxStaleness();
        if (block.timestamp - updatedAt > stale) {
            revert IPriceOracleV2.StalePrice(updatedAt, block.timestamp, stale);
        }

        // Confidence check (optional: oracle may return 0 when not available)
        if (confBps != 0) {
            uint256 minConf = o.minConfidenceBps();
            if (confBps > minConf) {
                revert IPriceOracleV2.ConfidenceTooLow(confBps, minConf);
            }
        }

        // Target stake-per-step derived from price and policy.
        // NOTE: This assumes pxWei is the token price in wei terms under your oracle's definition.
        uint256 target = (pxWei * TARGET_STAKE_PERCENT) / 100;

        // Clamp to safety bounds.
        if (target < MIN_STAKE_PER_STEP) target = MIN_STAKE_PER_STEP;
        else if (target > MAX_STAKE_PER_STEP) target = MAX_STAKE_PER_STEP;

        lastStakeAdjustment = block.timestamp;
        currentStakePerStep = target;

        emit StakeParametersUpdated(target, lastStakeAdjustment);
    }

    /* =============================================================
                     EMERGENCY ADMIN: MANUAL OVERRIDE / LOCK
       ============================================================= */

    /// @notice Manually override stake-per-step requirement within bounds.
    /// @param newStakePerStep New stake required per step.
    /// @dev
    ///  - Requires {EMERGENCY_ADMIN_ROLE}.
    ///  - Respects {stakeParamsLocked}.
    ///  - Updates {currentStakePerStep} and {lastStakeAdjustment}.
    function manualOverrideStake(uint256 newStakePerStep)
        external
        onlyRole(EMERGENCY_ADMIN_ROLE)
    {
        require(!stakeParamsLocked, "Stake parameters locked");
        require(
            newStakePerStep >= MIN_STAKE_PER_STEP && newStakePerStep <= MAX_STAKE_PER_STEP,
            "Stake out of bounds"
        );

        lastStakeAdjustment = block.timestamp;
        currentStakePerStep = newStakePerStep;

        emit StakeParametersUpdated(newStakePerStep, lastStakeAdjustment);
    }

    /// @notice Toggle the emergency lock for stake parameter changes.
    /// @dev Requires {EMERGENCY_ADMIN_ROLE}. Emits {StakeEmergencyLocked}.
    function toggleStakeParamLock() external onlyRole(EMERGENCY_ADMIN_ROLE) {
        stakeParamsLocked = !stakeParamsLocked;
        emit StakeEmergencyLocked(stakeParamsLocked);
    }
}
