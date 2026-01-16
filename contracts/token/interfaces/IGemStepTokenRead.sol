// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IGemStepTokenRead
/// @notice Minimal read interface implemented by GemStepToken via GS_ReadersMinimal.
/// @dev
///  This interface is intentionally tiny:
///  - It exposes only *bundled* getters to keep the token bytecode small.
///  - GemStepViews (external helper) depends on this interface.
///  - Do NOT add single-field getters unless absolutely necessary.
interface IGemStepTokenRead {
    /* ============================== Core Bundles ============================== */

    /// @notice Core token + verification parameters (packed).
    /// @return burnFee_ Stored burnFee (kept for layout compatibility; may be unused).
    /// @return rewardRate_ Tokens-per-step reward rate.
    /// @return stepLimit_ Maximum steps allowed per submission.
    /// @return signatureValidityPeriod_ Max future deadline window.
    function getCoreParams()
        external
        view
        returns (
            uint256 burnFee_,
            uint256 rewardRate_,
            uint256 stepLimit_,
            uint256 signatureValidityPeriod_
        );

    /// @notice Emergency withdrawal status (packed).
    function getEmergencyStatus()
        external
        view
        returns (bool enabled, uint256 unlockTime);

    /// @notice Current staking parameters (packed).
    function getStakeParams()
        external
        view
        returns (uint256 stakePerStep, uint256 lastAdjustTs, bool locked);

    /// @notice Minting/month/halving state (single bundle).
    function getMintingState()
        external
        view
        returns (
            uint256 month,
            uint256 minted,
            uint256 limit,
            uint256 lastUpdate,
            uint256 distributedTotal_,
            uint256 currentMonthlyCap_,
            uint256 halvingIdx
        );

    /* ============================== L2 / Oracle ============================== */

    /// @notice Arbitrum retryable configuration PLUS oracle address (packed).
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
        );

    /* ============================== Sources / Users ============================== */

    /// @notice Selected source configuration fields (excluding internal mapping).
    function getSourceConfigFields(string calldata source)
        external
        view
        returns (
            bool requiresProof,
            bool requiresAttestation,
            bytes32 merkleRoot,
            uint256 maxStepsPerDay,
            uint256 minInterval
        );

    /// @notice Per-(user,source) nonce used in verification schemes.
    function getUserSourceNonce(address user, string calldata source)
        external
        view
        returns (uint256);

    /// @notice Per-user/per-source anti-spam stats (packed).
    function getUserSourceStats(address user, string calldata source)
        external
        view
        returns (uint256 lastTs, uint256 dailyTotal, uint256 dayIndex);

    /// @notice Bundled user operational status (packed).
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
        );

    /// @notice Basic user reads (packed).
    function getUserBasics(address user)
        external
        view
        returns (uint256 totalSteps_, string memory lastSource_);

    /// @notice Trusted device flag.
    function isTrustedDevice(address device) external view returns (bool);

    /* ============================== Version Policy ============================== */

    /// @notice Packed version policy (attestation + payload) for the same version hash key.
    function getVersionPolicy(bytes32 v)
        external
        view
        returns (
            bool attestSupported,
            uint256 attestDeprecatesAt,
            bool attestRequiresNonce_,
            bool payloadSupported,
            uint256 payloadDeprecatesAt
        );
}
