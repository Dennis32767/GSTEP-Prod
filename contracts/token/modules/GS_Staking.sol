// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "../core/GemStepCore.sol";
import "../interfaces/IPriceOracleV2.sol";

abstract contract GS_Staking is GemStepCore {
    function stake() external payable {
        require(msg.value > 0, "No ETH sent");
        unchecked { stakeBalance[msg.sender] += msg.value; }
        emit Staked(msg.sender, msg.value);
    }

    function withdrawStake(uint256 amount)
    external
    nonReentrant
    whenNotPaused
{
    require(amount > 0, "Invalid amount");

    uint256 bal = stakeBalance[msg.sender];
    require(bal >= amount, "Insufficient balance");

    // Effects
    unchecked { stakeBalance[msg.sender] = bal - amount; }

    // Interaction
    (bool ok, ) = payable(msg.sender).call{value: amount}("");
    require(ok, "ETH send failed");

    emit Withdrawn(msg.sender, amount);
}

    function adjustStakeRequirements() external onlyRole(PARAMETER_ADMIN_ROLE) {
        require(!stakeParamsLocked, "Stake parameters locked");
        require(block.timestamp >= lastStakeAdjustment + STAKE_ADJUST_COOLDOWN, "Cooldown active");

        IPriceOracleV2 o = IPriceOracleV2(priceOracle);                 // <-- oracle still used
        (uint256 pxWei, uint256 updatedAt, uint256 confBps) = o.latestTokenPriceWei();

        uint256 stale = o.maxStaleness();
        if (block.timestamp - updatedAt > stale) {
            revert IPriceOracleV2.StalePrice(updatedAt, block.timestamp, stale);
        }

        if (confBps != 0) {
            uint256 minConf = o.minConfidenceBps();
            if (confBps > minConf) {
                revert IPriceOracleV2.ConfidenceTooLow(confBps, minConf);
            }
        }

        uint256 target = (pxWei * TARGET_STAKE_PERCENT) / 100;
        if (target < MIN_STAKE_PER_STEP) target = MIN_STAKE_PER_STEP;
        else if (target > MAX_STAKE_PER_STEP) target = MAX_STAKE_PER_STEP;

        lastStakeAdjustment = block.timestamp;
        currentStakePerStep = target;
        emit StakeParametersUpdated(target, lastStakeAdjustment);
    }

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

    function toggleStakeParamLock() external onlyRole(EMERGENCY_ADMIN_ROLE) {
        stakeParamsLocked = !stakeParamsLocked;
        emit StakeEmergencyLocked(stakeParamsLocked);
    }
}
