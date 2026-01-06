// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "../core/GemStepCore.sol";

/// @notice Read-only view helpers to keep core bytecode smaller.
abstract contract GS_Views is GemStepCore {
    /* ========================= Halving / Month ========================= */

    function getHalvingInfo()
        external
        view
        returns (
            uint256 currentHalvingCount,
            uint256 nextHalvingThreshold,
            uint256 remainingUntilHalving
        )
    {
        uint256 hc = halvingCount;
        uint256 dt = distributedTotal;
        uint256 t;
        unchecked {
            t = MAX_SUPPLY - (MAX_SUPPLY >> (hc + 1));
        }
        currentHalvingCount   = hc;
        nextHalvingThreshold  = t;
        remainingUntilHalving = t > dt ? t - dt : 0;
    }

    function getMonthInfo()
        external
        view
        returns (
            uint256 month,
            uint256 minted,
            uint256 limit,
            uint256 timestamp,
            uint256 halvingIdx
        )
    {
        return (currentMonth, currentMonthMinted, monthlyMintLimit, lastMonthUpdate, halvingCount);
    }

    /* ========================= Reward / Estimates ====================== */

    function estimateReward(uint256 steps) external view returns (uint256) {
        uint256 r = steps * rewardRate;
        return r >= MIN_REWARD_AMOUNT ? r : 0;
    }

    /* ========================= Sources / Users ========================= */

    function getSourceConfig(string calldata source)
        external
        view
        returns (
            bool requiresProof,
            bool requiresAttestation,
            bytes32 merkleRoot,
            uint256 maxStepsPerDay,
            uint256 minInterval
        )
    {
        SourceConfig storage c = sourceConfigs[source];
        return (c.requiresProof, c.requiresAttestation, c.merkleRoot, c.maxStepsPerDay, c.minInterval);
    }

    function getUserSourceStats(address user, string calldata source)
        external
        view
        returns (
            uint256 lastTs,
            uint256 dailyTotal,
            uint256 dayIndex
        )
    {
        return (lastSubmission[user][source], dailyStepTotal[user][source], dailyIndex[user][source]);
    }

    function getUserCoreStatus(address user)
        external
        view
        returns (
            uint256 stepAverageScaled,
            uint256 flaggedCount,
            uint256 suspendedUntilTs,
            uint256 stakedWei,
            bool    apiTrusted,
            uint256 firstSubmissionTs
        )
    {
        return (
            userStepAverage[user],
            flaggedSubmissions[user],
            suspendedUntil[user],
            stakeBalance[user],
            isTrustedAPI[user],
            userFirstSubmission[user]
        );
    }

    /* ============================== Versions ========================== */

    function getAttestationVersionInfo(bytes32 v)
        external
        view
        returns (
            bool supported,
            uint256 deprecatesAt,
            bool requiresNonce
        )
    {
        return (supportedAttestationVersions[v], attestationVersionDeprecatesAt[v], attestationRequiresNonce[v]);
    }

    function getPayloadVersionInfo(bytes32 v)
        external
        view
        returns (
            bool supported,
            uint256 deprecatesAt
        )
    {
        return (supportedPayloadVersions[v], payloadVersionDeprecatesAt[v]);
    }

    /* ============================ L2 / Arbitrum ======================== */

    function getArbitrumConfig()
        external
        view
        returns (
            address inbox,
            address l1Validator_,
            uint256 maxGas,
            uint256 gasPriceBid,
            uint256 maxSubmissionCost
        )
    {
        return (arbitrumInbox, l1Validator, arbMaxGas, arbGasPriceBid, arbMaxSubmissionCost);
    }

    /* ======================= Constants (packed) ======================== */

    /// Fixed layout (16 items):
    /// 0 INITIAL_SUPPLY, 1 REWARD_RATE_BASE, 2 SECONDS_PER_MONTH, 3 MAX_REWARD_RATE,
    /// 4 PERCENTAGE_BASE, 5 DEFAULT_SIGNATURE_VALIDITY, 6 MAX_SIGNATURE_VALIDITY,
    /// 7 MIN_BURN_AMOUNT, 8 MIN_REWARD_AMOUNT, 9 ANOMALY_THRESHOLD,
    /// 10 MIN_AVERAGE_FOR_ANOMALY, 11 GRACE_PERIOD, 12 MAX_PROOF_LENGTH,
    /// 13 MAX_VERSION_LENGTH, 14 TARGET_STAKE_PERCENT, 15 MONTHLY_MINT_LIMIT
    function getPublicConstantsPacked() external pure returns (uint256[16] memory out) {
        out[0]  = INITIAL_SUPPLY;
        out[1]  = REWARD_RATE_BASE;
        out[2]  = SECONDS_PER_MONTH;
        out[3]  = MAX_REWARD_RATE;
        out[4]  = PERCENTAGE_BASE;
        out[5]  = DEFAULT_SIGNATURE_VALIDITY;
        out[6]  = MAX_SIGNATURE_VALIDITY;
        out[7]  = MIN_BURN_AMOUNT;
        out[8]  = MIN_REWARD_AMOUNT;
        out[9]  = ANOMALY_THRESHOLD;
        out[10] = MIN_AVERAGE_FOR_ANOMALY;
        out[11] = GRACE_PERIOD;
        out[12] = MAX_PROOF_LENGTH;
        out[13] = MAX_VERSION_LENGTH;
        out[14] = TARGET_STAKE_PERCENT;
        out[15] = MONTHLY_MINT_LIMIT;
    }

    function getStakeConstants()
        external
        pure
        returns (uint256 minStakePerStep, uint256 maxStakePerStep, uint256 adjustCooldown)
    {
        return (MIN_STAKE_PER_STEP, MAX_STAKE_PER_STEP, STAKE_ADJUST_COOLDOWN);
    }

    function getRoleIds()
        external
        pure
        returns (bytes32[7] memory r)
    {
        r[0] = PAUSER_ROLE;
        r[1] = MINTER_ROLE;
        r[2] = SIGNER_ROLE;
        r[3] = PARAMETER_ADMIN_ROLE;
        r[4] = EMERGENCY_ADMIN_ROLE;
        r[5] = UPGRADER_ROLE;
        r[6] = API_SIGNER_ROLE;
    }

    /* ============================ Simple Getters ======================= */

    function getUserSourceNonce(address user, string calldata source) external view returns (uint256) {
        return sourceConfigs[source].userNonce[user];
    }

    function getUserTotalSteps(address user) external view returns (uint256) {
        return totalSteps[user];
    }

    function isTrustedDevice(address device) external view returns (bool) {
        return trustedDevices[device];
    }

    /* ============================== Core Params ======================== */

    function getCoreParams()
        external
        view
        returns (
            uint256 _burnFee,
            uint256 _rewardRate,
            uint256 _stepLimit,
            uint256 _signatureValidityPeriod
        )
    {
        return (burnFee, rewardRate, stepLimit, signatureValidityPeriod);
    }

    function getEmergencyStatus()
        external
        view
        returns (bool enabled, uint256 unlockTime)
    {
        return (emergencyWithdrawEnabled, emergencyWithdrawUnlockTime);
    }

    function getDistribution()
        external
        view
        returns (uint256 _distributedTotal, uint256 _currentMonthlyCap)
    {
        return (distributedTotal, currentMonthlyCap);
    }

    function getStakeParams()
        external
        view
        returns (uint256 stakePerStep, uint256 lastAdjustTs, bool locked)
    {
        return (currentStakePerStep, lastStakeAdjustment, stakeParamsLocked);
    }
}
