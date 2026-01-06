// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "../core/GemStepCore.sol";

/// @dev Views split & packed to avoid stack-too-deep and keep bytecode small.
abstract contract GS_Views is GemStepCore {
    /*────────────────────────────── HALVING / MONTH ─────────────────────────────*/

    /// @notice Info about halving thresholds
    function getHalvingInfo()
        external
        view
        returns (uint256 currentHalvingCount, uint256 nextHalvingThreshold, uint256 remainingUntilHalving)
    {
        uint256 hc = halvingCount; // single sload
        uint256 c = MAX_SUPPLY;
        uint256 t = c - (c >> (hc + 1));
        currentHalvingCount   = hc;
        nextHalvingThreshold  = t;
        remainingUntilHalving = t > distributedTotal ? t - distributedTotal : 0;
    }

    /// @notice Info about the current minting month
    function getMonthInfo()
        external
        view
        returns (uint256 month, uint256 minted, uint256 limit, uint256 timestamp, uint256 halvingIdx)
    {
        return (currentMonth, currentMonthMinted, monthlyMintLimit, lastMonthUpdate, halvingCount);
    }

    /*────────────────────────────── REWARD / ESTIMATES ──────────────────────────*/

    /// @notice Reward estimation helper
    function estimateReward(uint256 steps) external view returns (uint256) {
        uint256 r = steps * rewardRate;
        return r >= MIN_REWARD_AMOUNT ? r : 0;
    }

    /*────────────────────────────── SOURCES / USERS ─────────────────────────────*/

    /// @notice Source config (struct has mapping, so return plain fields only)
    function getSourceConfig(string calldata source)
        external
        view
        returns (bool requiresProof, bool requiresAttestation, bytes32 merkleRoot, uint256 maxStepsPerDay, uint256 minInterval)
    {
        SourceConfig storage c = sourceConfigs[source];
        return (c.requiresProof, c.requiresAttestation, c.merkleRoot, c.maxStepsPerDay, c.minInterval);
    }

    /// @notice Per-user/per-source rolling stats
    function getUserSourceStats(address user, string calldata source)
        external
        view
        returns (uint256 lastTs, uint256 dailyTotal, uint256 dayIndex)
    {
        return (lastSubmission[user][source], dailyStepTotal[user][source], dailyIndex[user][source]);
    }

    /// @notice User core operational status (bundled)
    function getUserCoreStatus(address user)
        external
        view
        returns (
            uint256 stepAverageScaled, // EMA ×100
            uint256 flaggedCount,
            uint256 suspendedUntilTs,
            uint256 stakedWei,
            bool apiTrusted,
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

    /*────────────────────────────── VERSIONS ────────────────────────────────────*/

    /// @notice Attestation version info
    function getAttestationVersionInfo(bytes32 v)
        external
        view
        returns (bool supported, uint256 deprecatesAt, bool requiresNonce)
    {
        return (supportedAttestationVersions[v], attestationVersionDeprecatesAt[v], attestationRequiresNonce[v]);
    }

    /// @notice Payload version info
    function getPayloadVersionInfo(bytes32 v)
        external
        view
        returns (bool supported, uint256 deprecatesAt)
    {
        return (supportedPayloadVersions[v], payloadVersionDeprecatesAt[v]);
    }

    /*────────────────────────────── L2 / ARBITRUM ───────────────────────────────*/

    // L2 / Arbitrum config (trimmed: omit ethBridge to save bytes)
    function getArbitrumConfig()
        external
        view
        returns (address inbox, address l1Validator_, uint256 maxGas, uint256 gasPriceBid, uint256 maxSubmissionCost)
    {
        return (arbitrumInbox, l1Validator, arbMaxGas, arbGasPriceBid, arbMaxSubmissionCost);
    }

    /*────────────────────────────── CONSTANTS (PACKED) ──────────────────────────*/

    /// @notice Batched public constants as a fixed array to avoid huge tuples
    /// Layout (16 items):
    /// [0]=INITIAL_SUPPLY
    /// [1]=REWARD_RATE_BASE
    /// [2]=SECONDS_PER_MONTH
    /// [3]=MAX_REWARD_RATE
    /// [4]=PERCENTAGE_BASE
    /// [5]=DEFAULT_SIGNATURE_VALIDITY
    /// [6]=MAX_SIGNATURE_VALIDITY
    /// [7]=MIN_BURN_AMOUNT
    /// [8]=MIN_REWARD_AMOUNT
    /// [9]=ANOMALY_THRESHOLD
    /// [10]=MIN_AVERAGE_FOR_ANOMALY
    /// [11]=GRACE_PERIOD
    /// [12]=MAX_PROOF_LENGTH
    /// [13]=MAX_VERSION_LENGTH
    /// [14]=TARGET_STAKE_PERCENT
    /// [15]=RESERVED (or another constant if you have one)
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

        // keep slot for forward-compat or fill with another constant if you prefer
        out[15] = 0;
    }

    /// @notice Role IDs as a fixed array (kept separate from policy to shrink tuples)
    /// [0]=PAUSER_ROLE [1]=MINTER_ROLE [2]=SIGNER_ROLE [3]=PARAMETER_ADMIN_ROLE
    /// [4]=EMERGENCY_ADMIN_ROLE [5]=UPGRADER_ROLE [6]=API_SIGNER_ROLE
    function getRoleIdsPacked() external pure returns (bytes32[7] memory roles) {
        roles[0] = PAUSER_ROLE;
        roles[1] = MINTER_ROLE;
        roles[2] = SIGNER_ROLE;
        roles[3] = PARAMETER_ADMIN_ROLE;
        roles[4] = EMERGENCY_ADMIN_ROLE;
        roles[5] = UPGRADER_ROLE;
        roles[6] = API_SIGNER_ROLE;
    }

    /// @notice Policy constants as a fixed array
    /// [0]=PENALTY_PERCENT [1]=MAX_STEPS_PER_DAY [2]=MIN_SUBMISSION_INTERVAL [3]=SUSPENSION_DURATION
    function getPolicyConstantsPacked() external pure returns (uint256[4] memory policy) {
        policy[0] = PENALTY_PERCENT;
        policy[1] = MAX_STEPS_PER_DAY;
        policy[2] = MIN_SUBMISSION_INTERVAL;
        policy[3] = SUSPENSION_DURATION;
    }

    /*────────────────────────────── SIMPLE GETTERS ──────────────────────────────*/

    /// @notice Get user nonce for a specific source
    function getUserSourceNonce(address user, string calldata source) external view returns (uint256) {
        return sourceConfigs[source].userNonce[user];
    }

    /// @notice Get user's total steps
    function getUserTotalSteps(address user) external view returns (uint256) {
        return totalSteps[user];
    }

    /// @notice Trusted device check
    function isTrustedDevice(address device) external view returns (bool) {
        return trustedDevices[device];
    }

    /// @notice Get price oracle address
    function getPriceOracle() external view returns (address) {
        return priceOracle;
    }
}
