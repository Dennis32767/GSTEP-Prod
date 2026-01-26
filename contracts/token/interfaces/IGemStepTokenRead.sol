// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IGemStepTokenRead
/// @notice Minimal read interface implemented by GemStepToken via GS_ReadersMinimal.
/// @dev
///  This interface is intentionally tiny:
///  - It exposes only *bundled* getters to keep the token bytecode small.
///  - GemStepViews (external helper) depends on this interface.
///  - Do NOT add single-field getters unless absolutely necessary.
///  - If you add anything, prefer *bundles* to avoid selector/bytecode bloat.
interface IGemStepTokenRead {
    /* ============================== Core Bundles ============================== */

    function getCoreParams()
        external
        view
        returns (
            uint256 burnFee_,
            uint256 rewardRate_,
            uint256 stepLimit_,
            uint256 signatureValidityPeriod_
        );

    function getEmergencyStatus() external view returns (bool enabled, uint256 unlockTime);

    function getStakeParams()
        external
        view
        returns (uint256 stakePerStep, uint256 lastAdjustTs, bool locked);

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

    function getUserSourceNonce(address user, string calldata source) external view returns (uint256 nonce);

    function getUserSourceStats(address user, string calldata source)
        external
        view
        returns (uint256 lastTs, uint256 dailyTotal, uint256 dayIndex);

    function getUserCoreStatus(address user)
        external
        view
        returns (
            uint256 stepAverageScaled,
            uint256 flaggedCount,
            uint256 suspendedUntilTs,
            uint256 stakedAmount,
            bool apiTrusted,
            uint256 firstSubmissionTs
        );

    function getUserBasics(address user) external view returns (uint256 totalSteps_, string memory lastSource_);

    function isTrustedDevice(address device) external view returns (bool);

    /* ============================== Version Policy ============================== */

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

    /* ============================== Guards Bundle ============================== */

    function getGuardsBundle(
        bytes32 sigHash,
        address wallet,
        bytes32 digest,
        address recipient,
        bytes32 attestKey
    )
        external
        view
        returns (
            bool sigUsed,
            bool erc1271Trusted,
            bool recipientApproved,
            bool attUsed,
            bool digestUsed,
            uint256 anomalyThreshold_
        );

    /* ============================== Contract Staking State ============================== */

    function getContractStakingState()
        external
        view
        returns (uint256 contractBal, uint256 totalStaked_, uint256 freeBal);

    /* ============================== Policy Bundles ============================== */

    /// @notice Returns staking discount policy constants (UI convenience).
    /// @dev Pure bundle: compile-time constants only.
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
        );

}
