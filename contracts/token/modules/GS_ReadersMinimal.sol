// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "../core/GemStepCore.sol";

/// @title GS_ReadersMinimal
/// @notice Minimal read-only surface required by off-token view helpers (GemStepViews).
/// @dev Keep this contract SMALL:
///  - Prefer bundled reads over single-field reads.
///  - Push computed/derived reads to the external GemStepViews helper.
///  - Avoid duplicating getters defined in other modules (name collisions force overrides).
abstract contract GS_ReadersMinimal is GemStepCore {
    /* ============================== Core Bundles ============================== */

    /// @notice Core token + verification parameters (packed).
    function getCoreParams()
        external
        view
        returns (uint256, uint256, uint256, uint256)
    {
        return (burnFee, rewardRate, stepLimit, signatureValidityPeriod);
    }

    /// @notice Emergency withdrawal status (packed).
    function getEmergencyStatus() external view returns (bool, uint256) {
        return (emergencyWithdrawEnabled, emergencyWithdrawUnlockTime);
    }

    /// @notice Current staking parameters (packed).
    function getStakeParams() external view returns (uint256, uint256, bool) {
        return (currentStakePerStep, lastStakeAdjustment, stakeParamsLocked);
    }

    /// @notice Minting/month/halving state (single bundle).
    /// @dev Replaces getDistribution() + getMonthInfo() + on-token getHalvingInfo().
    function getMintingState()
        external
        view
        returns (uint256, uint256, uint256, uint256, uint256, uint256, uint256)
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
    function getArbitrumConfig()
        external
        view
        returns (address, address, uint256, uint256, uint256, address)
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

    /// @notice Selected source configuration fields (excludes internal mapping).
    function getSourceConfigFields(string calldata source)
        external
        view
        returns (bool, bool, bytes32, uint256, uint256)
    {
        SourceConfig storage c = sourceConfigs[source];
        return (
            c.requiresProof,
            c.requiresAttestation,
            c.merkleRoot,
            c.maxStepsPerDay,
            c.minInterval
        );
    }

    /// @notice Per-(user,source) nonce used in verification schemes.
    function getUserSourceNonce(address user, string calldata source)
        external
        view
        returns (uint256)
    {
        return sourceConfigs[source].userNonce[user];
    }

    /// @notice Per-user/per-source anti-spam stats (packed).
    function getUserSourceStats(address user, string calldata source)
        external
        view
        returns (uint256, uint256, uint256)
    {
        return (
            lastSubmission[user][source],
            dailyStepTotal[user][source],
            dailyIndex[user][source]
        );
    }

    /// @notice Bundled user operational status (packed).
    function getUserCoreStatus(address user)
        external
        view
        returns (uint256, uint256, uint256, uint256, bool, uint256)
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
    function getUserBasics(address user)
        external
        view
        returns (uint256, string memory)
    {
        return (totalSteps[user], lastSource[user]);
    }

    /// @notice Trusted device flag (mapping is internal; expose minimal getter).
    function isTrustedDevice(address device) external view returns (bool) {
        return trustedDevices[device];
    }

    /* ============================== Version Policy ============================== */

    /// @notice Packed version policy for BOTH attestation + payload for a given hash key.
    /// @dev This replaces:
    ///  - getAttestationVersionInfo(bytes32)
    ///  - getPayloadVersionInfo(bytes32)
    /// Saving one selector and associated runtime code.
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
}
