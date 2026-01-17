// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "../core/GemStepCore.sol";

/// @title GS_ReadersMinimal
/// @notice Minimal read-only surface required by external view helpers (e.g., GemStepViews).
/// @dev Keep this contract SMALL:
///  - Prefer bundled reads over single-field reads.
///  - Push computed/derived reads to external view helper contracts.
///  - Avoid duplicating getters defined in other modules (name collisions force overrides).
abstract contract GS_ReadersMinimal is GemStepCore {
    /* ============================== Core Bundles ============================== */

    /// @notice Core token + verification parameters (packed).
    /// @return burnFee_ Current burn fee placeholder (retained for compatibility).
    /// @return rewardRate_ Current reward rate (tokens per step, 18 decimals).
    /// @return stepLimit_ Max steps per submission.
    /// @return signatureValidityPeriod_ Max acceptable deadline distance into the future.
    function getCoreParams()
        external
        view
        returns (uint256 burnFee_, uint256 rewardRate_, uint256 stepLimit_, uint256 signatureValidityPeriod_)
    {
        return (burnFee, rewardRate, stepLimit, signatureValidityPeriod);
    }

    /// @notice Emergency withdrawal status (packed).
    /// @return enabled True if emergency withdrawals are enabled.
    /// @return unlockTime Earliest time emergency withdrawals can be executed.
    function getEmergencyStatus() external view returns (bool enabled, uint256 unlockTime) {
        return (emergencyWithdrawEnabled, emergencyWithdrawUnlockTime);
    }

    /// @notice Current staking parameters (packed).
    /// @return stakePerStep Current required stake-per-step (wei).
    /// @return lastAdjust Timestamp of last stake adjustment.
    /// @return locked True if stake parameters are emergency-locked.
    function getStakeParams() external view returns (uint256 stakePerStep, uint256 lastAdjust, bool locked) {
        return (currentStakePerStep, lastStakeAdjustment, stakeParamsLocked);
    }

    /// @notice Minting/month/halving state (single bundle).
    /// @dev Replaces multiple single-purpose getters to reduce selector count and bytecode.
    /// @return month Current month index (timestamp / SECONDS_PER_MONTH).
    /// @return monthMinted Net minted this month (user+treasury).
    /// @return monthlyLimit Base monthly policy limit (internal anchor).
    /// @return lastUpdate Timestamp of last month rollover update.
    /// @return distributed Cumulative distributed total (net).
    /// @return currentCap Current monthly cap (may change via halving).
    /// @return halvings Current halving count.
    function getMintingState()
        external
        view
        returns (
            uint256 month,
            uint256 monthMinted,
            uint256 monthlyLimit,
            uint256 lastUpdate,
            uint256 distributed,
            uint256 currentCap,
            uint256 halvings
        )
    {
        return (
            currentMonth,
            currentMonthMinted,
            monthlyMintLimit,
            lastMonthUpdate,
            distributedTotal,
            currentMonthlyCap,
            halvingCount
        );
    }

    /* ============================== L2 / Oracle ============================== */

    /// @notice Arbitrum retryable configuration PLUS oracle address (packed).
    /// @dev Folding oracle into this bundle removes the need for a separate getPriceOracle().
    /// @return inbox Arbitrum Inbox address.
    /// @return l1Validator_ L1 validator/controller address used for L2 governance checks.
    /// @return maxGas Retryable ticket max gas.
    /// @return gasPriceBid Retryable ticket gas price bid.
    /// @return maxSubmissionCost Retryable ticket max submission cost.
    /// @return oracle Price oracle address (stored as address; cast in modules where needed).
    function getArbitrumConfig()
        external
        view
        returns (
            address inbox,
            address l1Validator_,
            uint256 maxGas,
            uint256 gasPriceBid,
            uint256 maxSubmissionCost,
            address oracle
        )
    {
        return (
            arbitrumInbox,
            l1Validator,
            arbMaxGas,
            arbGasPriceBid,
            arbMaxSubmissionCost,
            priceOracle
        );
    }

    /* ============================== Sources / Users ============================== */

    /// @notice Selected source configuration fields (excludes internal per-user nonce mapping).
    /// @param source Source key.
    /// @return requiresProof True if merkle proof is required.
    /// @return requiresAttestation True if device attestation is required.
    /// @return merkleRoot Merkle root for the source (if enabled).
    /// @return maxStepsPerDay Source-specific daily cap.
    /// @return minInterval Source-specific minimum submission interval (seconds).
    function getSourceConfigFields(string calldata source)
        external
        view
        returns (bool requiresProof, bool requiresAttestation, bytes32 merkleRoot, uint256 maxStepsPerDay, uint256 minInterval)
    {
        SourceConfig storage c = sourceConfigs[source];
        return (c.requiresProof, c.requiresAttestation, c.merkleRoot, c.maxStepsPerDay, c.minInterval);
    }

    /// @notice Per-(user,source) nonce used in source verification schemes.
    /// @param user User address.
    /// @param source Source key.
    /// @return nonce Current per-user nonce for the source.
    function getUserSourceNonce(address user, string calldata source) external view returns (uint256 nonce) {
        return sourceConfigs[source].userNonce[user];
    }

    /// @notice Per-(user,source) anti-spam stats (packed).
    /// @param user User address.
    /// @param source Source key.
    /// @return lastTs Last submission timestamp for this user+source.
    /// @return dailyTotal Steps accumulated for this user+source in current UTC day.
    /// @return dayIndex Stored day index used to detect rollover.
    function getUserSourceStats(address user, string calldata source)
        external
        view
        returns (uint256 lastTs, uint256 dailyTotal, uint256 dayIndex)
    {
        return (lastSubmission[user][source], dailyStepTotal[user][source], dailyIndex[user][source]);
    }

    /// @notice Bundled user operational status (packed).
    /// @param user User address.
    /// @return emaScaled User EMA average (scaled ×100).
    /// @return flags Number of anomaly flags.
    /// @return suspendedUntil_ Suspension timestamp (0 if not suspended).
    /// @return stakedBalance User staked GSTEP balance (token staking).
    /// @return trustedApi True if user is marked trusted API.
    /// @return firstSubmissionTs Timestamp of first submission (grace-period anchor).
    function getUserCoreStatus(address user)
        external
        view
        returns (
            uint256 emaScaled,
            uint256 flags,
            uint256 suspendedUntil_,
            uint256 stakedBalance,
            bool trustedApi,
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

    /// @notice Basic user reads (packed) — replaces getUserTotalSteps + getLastSource.
    /// @param user User address.
    /// @return steps Total steps recorded for user.
    /// @return lastSource_ Last source string used by user.
    function getUserBasics(address user) external view returns (uint256 steps, string memory lastSource_) {
        return (totalSteps[user], lastSource[user]);
    }

    /// @notice Trusted device flag (mapping is internal; expose minimal getter).
    /// @param device Device address.
    /// @return True if device is trusted.
    function isTrustedDevice(address device) external view returns (bool) {
        return trustedDevices[device];
    }

    /* ============================== Version Policy ============================== */

    /// @notice Packed version policy for BOTH attestation + payload for a given hash key.
    /// @dev Replaces separate per-domain getters to save selectors and runtime code.
    /// @param v Hash of normalized version string (e.g., keccak256(bytes("1.0.0"))).
    /// @return attestSupported True if attestation version is supported.
    /// @return attestDeprecatesAt Unix time when attestation version deprecates (0 if not scheduled).
    /// @return attestRequiresNonce_ True if this attestation version requires nonce-binding.
    /// @return payloadSupported True if payload version is supported.
    /// @return payloadDeprecatesAt Unix time when payload version deprecates (0 if not scheduled).
    function getVersionPolicy(bytes32 v)
        external
        view
        returns (
            bool attestSupported,
            uint256 attestDeprecatesAt,
            bool attestRequiresNonce_,
            bool payloadSupported,
            uint256 payloadDeprecatesAt
        )
    {
        return (
            supportedAttestationVersions[v],
            attestationVersionDeprecatesAt[v],
            attestationRequiresNonce[v],
            supportedPayloadVersions[v],
            payloadVersionDeprecatesAt[v]
        );
    }

    /* ============================== Policy Bundles (Optional) ============================== */
    /// @notice Staking discount policy constants (packed).
    /// @dev Kept here (pure) so frontends can fetch without many selectors.
    ///      These are compile-time constants stored in {GemStepStorage}.
    function getStakePolicy()
        external
        pure
        returns (
            uint256 minAge,
            uint256 maxAge,
            uint256 maxDiscountBps,
            uint256 minCutBps,
            uint256 tier1,
            uint256 tier2,
            uint256 tier3,
            uint256 d1,
            uint256 d2,
            uint256 d3
        )
    {
        return (
            STAKE_MIN_AGE,
            STAKE_MAX_AGE,
            STAKE_MAX_CUT_DISCOUNT_BPS,
            STAKE_MIN_CUT_BPS,
            STAKE_TIER1,
            STAKE_TIER2,
            STAKE_TIER3,
            STAKE_D1,
            STAKE_D2,
            STAKE_D3
        );
    }
}
