// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "../core/GemStepCore.sol";

/// @title GS_Views
/// @notice Read-only view helpers split/packed to reduce bytecode and avoid stack-too-deep.
/// @dev
///  - This module is intentionally view-only and “tuple-light”:
///    - Returns simple scalars instead of full structs (SourceConfig contains a mapping).
///    - Uses fixed-size arrays for constants/roles/policy to keep ABI compact.
///  - Assumes minting uses the reward split constants (REWARD_USER_BPS / BPS_BASE).
abstract contract GS_Views is GemStepCore {
    /*────────────────────────────── HALVING / MONTH ─────────────────────────────*/

    /// @notice Get current halving index and next halving threshold information.
    /// @return currentHalvingCount The current halving counter.
    /// @return nextHalvingThreshold The distributedTotal threshold that triggers the next halving.
    /// @return remainingUntilHalving Remaining distributedTotal required to reach the next threshold (0 if already met).
    /// @dev Threshold formula mirrors GemStepCore:
    ///      threshold = MAX_SUPPLY - (MAX_SUPPLY >> (halvingCount + 1))
    function getHalvingInfo()
        external
        view
        returns (
            uint256 currentHalvingCount,
            uint256 nextHalvingThreshold,
            uint256 remainingUntilHalving
        )
    {
        uint256 hc = halvingCount; // single SLOAD
        uint256 c = MAX_SUPPLY;
        uint256 t = c - (c >> (hc + 1));

        currentHalvingCount = hc;
        nextHalvingThreshold = t;

        uint256 dt = distributedTotal;
        remainingUntilHalving = t > dt ? t - dt : 0;
    }

    /// @notice Get current month accounting for monthly mint cap logic.
    /// @return month Current month index (block.timestamp / SECONDS_PER_MONTH).
    /// @return minted Amount minted (net) this month.
    /// @return limit Base monthly mint limit (policy).
    /// @return timestamp Last month update timestamp.
    /// @return halvingIdx Current halving counter.
    function getMonthInfo()
        external
        view
        returns (uint256 month, uint256 minted, uint256 limit, uint256 timestamp, uint256 halvingIdx)
    {
        return (currentMonth, currentMonthMinted, monthlyMintLimit, lastMonthUpdate, halvingCount);
    }

    /*────────────────────────────── REWARD / ESTIMATES ──────────────────────────*/

    /// @notice Estimate beneficiary reward for a step count (beneficiary/user portion only).
    /// @param steps Step count.
    /// @return Estimated amount minted to the beneficiary (user portion).
    /// @dev
    ///  - Returns 0 if steps < MIN_STEPS.
    ///  - Assumes mint module splits rewards using REWARD_USER_BPS / BPS_BASE.
    function estimateReward(uint256 steps) external view returns (uint256) {
        if (steps < MIN_STEPS) return 0;

        uint256 gross = steps * rewardRate;
        return (gross * REWARD_USER_BPS) / BPS_BASE;
    }

    /*────────────────────────────── SOURCES / USERS ─────────────────────────────*/

    /// @notice Get source configuration fields (excluding mapping fields inside SourceConfig).
    /// @param source Source key.
    /// @return requiresProof Whether this source requires a merkle proof.
    /// @return requiresAttestation Whether this source requires a device attestation.
    /// @return merkleRoot Merkle root (if proof is required).
    /// @return maxStepsPerDay Daily step cap for this source.
    /// @return minInterval Minimum interval between submissions for this (user, source).
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

    /// @notice Get per-user/per-source rolling anti-spam stats.
    /// @param user User address.
    /// @param source Source key.
    /// @return lastTs Last submission timestamp for this (user, source).
    /// @return dailyTotal Steps accumulated today (UTC day index) for this (user, source).
    /// @return dayIndex Current stored day index for this (user, source).
    function getUserSourceStats(address user, string calldata source)
        external
        view
        returns (uint256 lastTs, uint256 dailyTotal, uint256 dayIndex)
    {
        return (lastSubmission[user][source], dailyStepTotal[user][source], dailyIndex[user][source]);
    }

    /// @notice Get core user operational status (bundled).
    /// @param user User address.
    /// @return stepAverageScaled EMA ×100 (scaled).
    /// @return flaggedCount Number of anomaly flags recorded.
    /// @return suspendedUntilTs Suspension timestamp (0 or past means not suspended).
    /// @return stakedWei User's staked ETH balance (wei).
    /// @return apiTrusted Whether the address is marked trusted as an API (for callers/relayers).
    /// @return firstSubmissionTs First submission timestamp recorded for this user (grace anchor).
    function getUserCoreStatus(address user)
        external
        view
        returns (
            uint256 stepAverageScaled,
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

    /// @notice Get attestation version policy flags.
    /// @param v Version hash (keccak256 of normalized version string).
    /// @return supported Whether version is allowlisted.
    /// @return deprecatesAt Timestamp when deprecated (0 if not scheduled).
    /// @return requiresNonce Whether nonce-binding is required for this attestation version.
    function getAttestationVersionInfo(bytes32 v)
        external
        view
        returns (bool supported, uint256 deprecatesAt, bool requiresNonce)
    {
        return (supportedAttestationVersions[v], attestationVersionDeprecatesAt[v], attestationRequiresNonce[v]);
    }

    /// @notice Get payload version policy flags.
    /// @param v Version hash (keccak256 of normalized version string).
    /// @return supported Whether version is allowlisted.
    /// @return deprecatesAt Timestamp when deprecated (0 if not scheduled).
    function getPayloadVersionInfo(bytes32 v)
        external
        view
        returns (bool supported, uint256 deprecatesAt)
    {
        return (supportedPayloadVersions[v], payloadVersionDeprecatesAt[v]);
    }

    /*────────────────────────────── L2 / ARBITRUM ───────────────────────────────*/

    /// @notice Get Arbitrum retryable configuration parameters used by bridging logic.
    /// @return inbox Arbitrum Inbox address.
    /// @return l1Validator_ L1 validator address.
    /// @return maxGas Max gas for retryables.
    /// @return gasPriceBid Gas price bid.
    /// @return maxSubmissionCost Max submission cost.
    /// @dev Intentionally omits ETH bridge address to keep tuple smaller.
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

    /*────────────────────────────── CONSTANTS (PACKED) ──────────────────────────*/

    /// @notice Batched public constants as a fixed array to avoid large tuples.
    /// @dev Layout (16 items):
    /// [0]=INITIAL_SUPPLY
    /// [1]=REWARD_RATE_BASE
    /// [2]=SECONDS_PER_MONTH
    /// [3]=MAX_REWARD_RATE
    /// [4]=PERCENTAGE_BASE
    /// [5]=DEFAULT_SIGNATURE_VALIDITY
    /// [6]=MAX_SIGNATURE_VALIDITY
    /// [7]=MIN_BURN_AMOUNT
    /// [8]=MIN_STEPS
    /// [9]=ANOMALY_THRESHOLD
    /// [10]=MIN_AVERAGE_FOR_ANOMALY
    /// [11]=GRACE_PERIOD
    /// [12]=MAX_PROOF_LENGTH
    /// [13]=MAX_VERSION_LENGTH
    /// [14]=TARGET_STAKE_PERCENT
    /// [15]=RESERVED (forward-compat)
    function getPublicConstantsPacked() external pure returns (uint256[16] memory out) {
        out[0]  = INITIAL_SUPPLY;
        out[1]  = REWARD_RATE_BASE;
        out[2]  = SECONDS_PER_MONTH;
        out[3]  = MAX_REWARD_RATE;
        out[4]  = PERCENTAGE_BASE;

        out[5]  = DEFAULT_SIGNATURE_VALIDITY;
        out[6]  = MAX_SIGNATURE_VALIDITY;
        out[7]  = MIN_BURN_AMOUNT;
        out[8]  = MIN_STEPS;

        out[9]  = ANOMALY_THRESHOLD;
        out[10] = MIN_AVERAGE_FOR_ANOMALY;
        out[11] = GRACE_PERIOD;
        out[12] = MAX_PROOF_LENGTH;
        out[13] = MAX_VERSION_LENGTH;
        out[14] = TARGET_STAKE_PERCENT;

        out[15] = 0;
    }

    /// @notice Get role identifiers as a fixed array (kept separate to shrink ABI tuples).
    /// @dev Layout (7 items):
    /// [0]=PAUSER_ROLE
    /// [1]=MINTER_ROLE
    /// [2]=SIGNER_ROLE
    /// [3]=PARAMETER_ADMIN_ROLE
    /// [4]=EMERGENCY_ADMIN_ROLE
    /// [5]=UPGRADER_ROLE
    /// [6]=API_SIGNER_ROLE
    function getRoleIdsPacked() external pure returns (bytes32[7] memory roles) {
        roles[0] = PAUSER_ROLE;
        roles[1] = MINTER_ROLE;
        roles[2] = SIGNER_ROLE;
        roles[3] = PARAMETER_ADMIN_ROLE;
        roles[4] = EMERGENCY_ADMIN_ROLE;
        roles[5] = UPGRADER_ROLE;
        roles[6] = API_SIGNER_ROLE;
    }

    /// @notice Get policy constants as a fixed array.
    /// @dev Layout (4 items):
    /// [0]=PENALTY_PERCENT
    /// [1]=MAX_STEPS_PER_DAY
    /// [2]=MIN_SUBMISSION_INTERVAL
    /// [3]=SUSPENSION_DURATION
    function getPolicyConstantsPacked() external pure returns (uint256[4] memory policy) {
        policy[0] = PENALTY_PERCENT;
        policy[1] = MAX_STEPS_PER_DAY;
        policy[2] = MIN_SUBMISSION_INTERVAL;
        policy[3] = SUSPENSION_DURATION;
    }

    /*────────────────────────────── SIMPLE GETTERS ──────────────────────────────*/

    /// @notice Get the per-user nonce used inside a specific source's merkle proof scheme.
    /// @param user User address.
    /// @param source Source key.
    /// @return The current per-source nonce for `user`.
    function getUserSourceNonce(address user, string calldata source) external view returns (uint256) {
        return sourceConfigs[source].userNonce[user];
    }

    /// @notice Get a user's total steps recorded on-chain.
    /// @param user User address.
    /// @return Total steps.
    function getUserTotalSteps(address user) external view returns (uint256) {
        return totalSteps[user];
    }

    /// @notice Check whether a device is trusted for attestations.
    /// @param device Device address.
    /// @return True if trusted.
    function isTrustedDevice(address device) external view returns (bool) {
        return trustedDevices[device];
    }

    /// @notice Get the configured price oracle address.
    /// @return Oracle address.
    function getPriceOracle() external view returns (address) {
        return priceOracle;
    }
}
