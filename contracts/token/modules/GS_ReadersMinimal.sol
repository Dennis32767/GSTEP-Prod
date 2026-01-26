// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "../core/GemStepCore.sol";
import "../interfaces/IGemStepTokenRead.sol";

/// @title GS_ReadersMinimal
/// @notice Minimal read-only surface required by external view helpers (e.g., GemStepViews).
/// @dev Keep this contract SMALL:
///  - Prefer bundled reads over single-field reads.
///  - Push computed/derived reads to external view helper contracts.
///  - Avoid duplicating getters defined in other modules (name collisions force overrides).
///  - Add new reads only as *bundles* to avoid selector explosion.
///
///  IMPORTANT:
///  - This contract intentionally provides the external read surface that {IGemStepTokenRead}
///    expects. Keep function signatures EXACTLY aligned with the interface.
///  - Do NOT expose internal mappings as public; prefer `getGuardsBundle(...)`.
abstract contract GS_ReadersMinimal is GemStepCore, IGemStepTokenRead {
    /* ============================== Core Bundles ============================== */

    /// @inheritdoc IGemStepTokenRead
    function getCoreParams()
        external
        view
        override
        returns (
            uint256 burnFee_,
            uint256 rewardRate_,
            uint256 stepLimit_,
            uint256 signatureValidityPeriod_
        )
    {
        return (burnFee, rewardRate, stepLimit, signatureValidityPeriod);
    }

    /// @inheritdoc IGemStepTokenRead
    function getEmergencyStatus()
        external
        view
        override
        returns (bool enabled, uint256 unlockTime)
    {
        return (emergencyWithdrawEnabled, emergencyWithdrawUnlockTime);
    }

    /// @inheritdoc IGemStepTokenRead
    function getStakeParams()
        external
        view
        override
        returns (uint256 stakePerStep, uint256 lastAdjustTs, bool locked)
    {
        return (currentStakePerStep, lastStakeAdjustment, stakeParamsLocked);
    }

    /// @inheritdoc IGemStepTokenRead
    function getMintingState()
        external
        view
        override
        returns (
            uint256 month,
            uint256 minted,
            uint256 limit,
            uint256 lastUpdate,
            uint256 distributedTotal_,
            uint256 currentMonthlyCap_,
            uint256 halvingIdx
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

    /// @inheritdoc IGemStepTokenRead
    function getArbitrumConfig()
        external
        view
        override
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

    /// @inheritdoc IGemStepTokenRead
    function getSourceConfigFields(string calldata source)
        external
        view
        override
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

    /// @inheritdoc IGemStepTokenRead
    function getUserSourceNonce(address user, string calldata source)
        external
        view
        override
        returns (uint256 nonce)
    {
        return sourceConfigs[source].userNonce[user];
    }

    /// @inheritdoc IGemStepTokenRead
    function getUserSourceStats(address user, string calldata source)
        external
        view
        override
        returns (uint256 lastTs, uint256 dailyTotal, uint256 dayIndex)
    {
        return (lastSubmission[user][source], dailyStepTotal[user][source], dailyIndex[user][source]);
    }

    /// @inheritdoc IGemStepTokenRead
    /// @dev NOTE:
    ///  - `apiTrusted` here means `isTrustedAPI[user]` (i.e., whether *this address* is flagged as a trusted API caller).
    ///  - This is NOT a reliable way to answer “is the relayer trusted?” for an arbitrary call, because writes key on msg.sender.
    ///  - Preferred long-term: add a separate read `isTrustedApiCaller(address caller)` and have clients pass the relayer.
    function getUserCoreStatus(address user)
        external
        view
        override
        returns (
            uint256 stepAverageScaled,
            uint256 flaggedCount,
            uint256 suspendedUntilTs,
            uint256 stakedTokens,
            bool apiTrusted,
            uint256 firstSubmissionTs
        )
    {
        return (
            userStepAverage[user],
            flaggedSubmissions[user],
            suspendedUntil[user],
            stakeBalance[user],     // token units (18 decimals)
            isTrustedAPI[user],     // address-flag only; see note above
            userFirstSubmission[user]
        );
    }

    /// @inheritdoc IGemStepTokenRead
    function getUserBasics(address user)
        external
        view
        override
        returns (uint256 totalSteps_, string memory lastSource_)
    {
        return (totalSteps[user], lastSource[user]);
    }

    /// @inheritdoc IGemStepTokenRead
    function isTrustedDevice(address device) external view override returns (bool) {
        return trustedDevices[device];
    }

    /* ============================== Version Policy ============================== */

    /// @inheritdoc IGemStepTokenRead
    /// @dev V2-only attestation note:
    ///  - `attestRequiresNonce_` is returned as `true` (nonce-binding is mandatory in V2-only flow).
    ///  - `attestationRequiresNonce[v]` may still exist in storage for layout compatibility, but is not used here.
    function getVersionPolicy(bytes32 v)
        external
        view
        override
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
            true, // V2-only: always nonce-bound
            supportedPayloadVersions[v],
            payloadVersionDeprecatesAt[v]
        );
    }

    /* ============================== Guards Bundle ============================== */

    /// @inheritdoc IGemStepTokenRead
    /// @dev V2-only attestation note:
    ///  - `attUsed` is legacy-only (usedAttestations) and returns false here to avoid misleading consumers.
    ///  - `attestKey` is still accepted to preserve interface compatibility.
    function getGuardsBundle(
        bytes32 sigHash,
        address wallet,
        bytes32 digest,
        address recipient,
        bytes32 /* attestKey */
    )
        external
        view
        override
        returns (
            bool sigUsed,
            bool erc1271Trusted,
            bool recipientApproved,
            bool attUsed,
            bool digestUsed,
            uint256 anomalyThreshold_
        )
    {
        sigUsed = usedSignatures[sigHash];
        erc1271Trusted = trustedERC1271Contracts[wallet];
        recipientApproved = approvedRecipients[recipient];

        attUsed = false; // V2-only: legacy replay guard not used
        digestUsed = used1271Digests[wallet][digest];
        anomalyThreshold_ = anomalyThreshold;
    }

    /* ============================== Contract Staking State ============================== */

    /// @notice Returns contract-level staking totals used for emergency-withdraw safety.
    /// @dev All values are in GEMS token units (18 decimals).
    /// - `contractBal`   = balanceOf(address(this))
    /// - `totalStaked_`  = sum of all user stake balances tracked by the staking module
    /// - `freeBal`       = tokens not reserved for staking (withdrawable via emergency withdraw)
    ///
    /// This function is UI/ops-friendly: if an invariant is ever broken (contractBal < totalStaked),
    /// it returns freeBal = 0 instead of reverting.
    function getContractStakingState()
        external
        override
        view
        returns (uint256 contractBal, uint256 totalStaked_, uint256 freeBal)
    {
        contractBal = balanceOf(address(this));
        totalStaked_ = totalStaked;
        freeBal = contractBal > totalStaked_ ? (contractBal - totalStaked_) : 0;
    }
     /*────────────────────────────── OPTIONAL POLICY BUNDLE ──────────────────────*/

    /// @notice Returns staking discount policy constants (UI convenience).
    /// @dev Pure function: does not read token storage. Safe to expose here because it’s pure and returns compile-time constants.
    function getStakePolicy()
        external
        pure
        override
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
