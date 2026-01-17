// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "../interfaces/IGemStepTokenRead.sol";

/// @title GemStepViews
/// @notice Off-token read helper that exposes a rich “views” API without inflating GemStepToken bytecode.
/// @dev
///  Design goals:
///  - Keep GemStepToken small: token exposes only bundled getters via `GS_ReadersMinimal`.
///  - Put all computed / convenience reads here (halving thresholds, estimates, packing).
///  - This contract is read-only and holds no privileges.
///  - Deploy 1x per token address and point your UI to this helper.
///
contract GemStepViews {
    /// @notice The token instance this view helper reads from.
    IGemStepTokenRead public immutable token;

    /* ========================= Constants mirrored for UI =========================
       @dev These are duplicated here (not in the token) to avoid increasing token bytecode.
            Keep these aligned with GemStepStorage constants.
    */

    /// @dev Must match GemStepStorage.DECIMALS
    uint8 internal constant DECIMALS = 18;

    /// @dev Must match GemStepStorage.MAX_SUPPLY (1,000,000,000 * 1e18)
    uint256 internal constant MAX_SUPPLY = 1_000_000_000 * 10 ** DECIMALS;

    /// @dev Must match GemStepStorage.BPS_BASE
    uint256 internal constant BPS_BASE = 10_000;

    /// @dev Must match GemStepStorage.REWARD_USER_BPS
    uint256 internal constant REWARD_USER_BPS = 8000;

    /// @dev Must match GemStepStorage.MIN_STEPS
    uint256 internal constant MIN_STEPS = 1;

    /// @dev Must match GemStepStorage.SECONDS_PER_MONTH
    uint256 internal constant SECONDS_PER_MONTH = 30 days;

    /// @dev Must match GemStepStorage.INITIAL_SUPPLY
    uint256 internal constant INITIAL_SUPPLY = 400_000_000 * 10 ** DECIMALS;

    /// @dev Must match GemStepStorage.REWARD_RATE_BASE
    uint256 internal constant REWARD_RATE_BASE = 1e15;

    /// @dev Must match GemStepStorage.MAX_REWARD_RATE
    uint256 internal constant MAX_REWARD_RATE = 1e16;

    /// @dev Must match GemStepStorage.PERCENTAGE_BASE
    uint256 internal constant PERCENTAGE_BASE = 100;

    /// @dev Must match GemStepStorage.DEFAULT_SIGNATURE_VALIDITY
    uint256 internal constant DEFAULT_SIGNATURE_VALIDITY = 1 hours;

    /// @dev Must match GemStepStorage.MAX_SIGNATURE_VALIDITY
    uint256 internal constant MAX_SIGNATURE_VALIDITY = 7 days;

    /// @dev Must match GemStepStorage.MIN_BURN_AMOUNT
    uint256 internal constant MIN_BURN_AMOUNT = 1 * 10 ** DECIMALS;

    /// @dev Must match GemStepStorage.ANOMALY_THRESHOLD
    uint256 internal constant ANOMALY_THRESHOLD = 5;

    /// @dev Must match GemStepStorage.MIN_AVERAGE_FOR_ANOMALY
    uint256 internal constant MIN_AVERAGE_FOR_ANOMALY = 500;

    /// @dev Must match GemStepStorage.GRACE_PERIOD
    uint256 internal constant GRACE_PERIOD = 7 days;

    /// @dev Must match GemStepStorage.MAX_PROOF_LENGTH
    uint256 internal constant MAX_PROOF_LENGTH = 32;

    /// @dev Must match GemStepStorage.MAX_VERSION_LENGTH
    uint256 internal constant MAX_VERSION_LENGTH = 32;

    /// @dev Must match GemStepStorage.TARGET_STAKE_PERCENT
    uint256 internal constant TARGET_STAKE_PERCENT = 10;

    /// @dev Must match GemStepStorage.MONTHLY_MINT_LIMIT
    uint256 internal constant MONTHLY_MINT_LIMIT = 2_000_000 * 10 ** DECIMALS;

    /// @dev Must match GemStepStorage.MIN_STAKE_PER_STEP / MAX_STAKE_PER_STEP / STAKE_ADJUST_COOLDOWN
    uint256 internal constant MIN_STAKE_PER_STEP = 0.0000001 ether;
    uint256 internal constant MAX_STAKE_PER_STEP = 0.001 ether;
    uint256 internal constant STAKE_ADJUST_COOLDOWN = 1 days;

    /// @notice Create a new read helper pointed at an already-deployed token.
    /// @param token_ Deployed GemStepToken proxy address.
    constructor(address token_) {
        require(token_ != address(0), "Token addr=0");
        token = IGemStepTokenRead(token_);
    }

    /*────────────────────────────── HALVING / MONTH ─────────────────────────────*/

    /// @notice Get current halving index and next halving threshold information.
    /// @return currentHalvingCount The current halving counter.
    /// @return nextHalvingThreshold The distributedTotal threshold that triggers the next halving.
    /// @return remainingUntilHalving Remaining distributedTotal required to reach the next threshold (0 if already met).
    /// @dev threshold = MAX_SUPPLY - (MAX_SUPPLY >> (halvingCount + 1))
    function getHalvingInfo()
        external
        view
        returns (uint256 currentHalvingCount, uint256 nextHalvingThreshold, uint256 remainingUntilHalving)
    {
        (
            ,
            ,
            ,
            ,
            uint256 distributedTotal_,
            ,
            uint256 halvingIdx
        ) = token.getMintingState();

        uint256 t = MAX_SUPPLY - (MAX_SUPPLY >> (halvingIdx + 1));

        currentHalvingCount = halvingIdx;
        nextHalvingThreshold = t;
        remainingUntilHalving = t > distributedTotal_ ? t - distributedTotal_ : 0;
    }

    /// @notice Get current month accounting for monthly mint cap logic (straight passthrough bundle).
    /// @return month Current month index (block.timestamp / SECONDS_PER_MONTH).
    /// @return minted Amount minted (net) this month.
    /// @return limit Base monthly mint limit (policy).
    /// @return timestamp Last month update timestamp.
    /// @return distributedTotal_ Lifetime distributed total.
    /// @return currentMonthlyCap_ Current monthly cap (post-halving policy).
    /// @return halvingIdx Current halving counter.
    function getMonthInfo()
        external
        view
        returns (
            uint256 month,
            uint256 minted,
            uint256 limit,
            uint256 timestamp,
            uint256 distributedTotal_,
            uint256 currentMonthlyCap_,
            uint256 halvingIdx
        )
    {
        return token.getMintingState();
    }

    /*────────────────────────────── REWARD / ESTIMATES ──────────────────────────*/

    /// @notice Estimate beneficiary reward for a step count (beneficiary/user portion only).
    /// @param steps Step count.
    /// @return amount Estimated amount minted to the beneficiary (user portion).
    function estimateReward(uint256 steps) external view returns (uint256 amount) {
        if (steps < MIN_STEPS) return 0;
        (, uint256 rewardRate_, , ) = token.getCoreParams();
        uint256 gross = steps * rewardRate_;
        return (gross * REWARD_USER_BPS) / BPS_BASE;
    }

    /*────────────────────────────── SOURCES / USERS ─────────────────────────────*/

    /// @notice Get source configuration fields (excluding mapping fields inside SourceConfig).
    function getSourceConfig(string calldata source)
        external
        view
        returns (bool requiresProof, bool requiresAttestation, bytes32 merkleRoot, uint256 maxStepsPerDay, uint256 minInterval)
    {
        return token.getSourceConfigFields(source);
    }

    /// @notice Get per-user/per-source rolling anti-spam stats.
    function getUserSourceStats(address user, string calldata source)
        external
        view
        returns (uint256 lastTs, uint256 dailyTotal, uint256 dayIndex)
    {
        return token.getUserSourceStats(user, source);
    }

    /// @notice Get per-(user,source) nonce used in verification schemes.
    function getUserSourceNonce(address user, string calldata source) external view returns (uint256) {
        return token.getUserSourceNonce(user, source);
    }

    /// @notice Get core user operational status (bundled).
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
        return token.getUserCoreStatus(user);
    }

    /// @notice Basic user reads (packed).
    function getUserBasics(address user) external view returns (uint256 totalSteps_, string memory lastSource_) {
        return token.getUserBasics(user);
    }

    /// @notice Returns whether a device is trusted for attestations.
    function isTrustedDevice(address device) external view returns (bool) {
        return token.isTrustedDevice(device);
    }

    /*────────────────────────────── VERSIONS ────────────────────────────────────*/

    /// @notice Returns attestation version policy information.
    /// @param v Version hash (normalized string hash) used by the token.
    function getAttestationVersionInfo(bytes32 v)
        external
        view
        returns (bool supported, uint256 deprecatesAt, bool requiresNonce)
    {
        (supported, deprecatesAt, requiresNonce, , ) = token.getVersionPolicy(v);
    }

    /// @notice Returns payload version policy information.
    /// @param v Version hash (normalized string hash) used by the token.
    function getPayloadVersionInfo(bytes32 v)
        external
        view
        returns (bool supported, uint256 deprecatesAt)
    {
        (, , , supported, deprecatesAt) = token.getVersionPolicy(v);
    }

    /*────────────────────────────── L2 / ARBITRUM ───────────────────────────────*/

    /// @notice Returns Arbitrum retryable configuration (passthrough).
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
        (inbox, l1Validator_, maxGas, gasPriceBid, maxSubmissionCost, ) = token.getArbitrumConfig();
    }

    /// @notice Returns the configured price oracle address (passthrough).
    function getPriceOracle() external view returns (address oracle) {
        ( , , , , , oracle) = token.getArbitrumConfig();
    }

    /*────────────────────────────── CORE (PASSTHROUGH) ──────────────────────────*/

    /// @notice Returns core token and verification parameters (passthrough).
    function getCoreParams()
        external
        view
        returns (uint256 burnFee_, uint256 rewardRate_, uint256 stepLimit_, uint256 signatureValidityPeriod_)
    {
        return token.getCoreParams();
    }

    /// @notice Returns emergency withdrawal status (passthrough).
    function getEmergencyStatus() external view returns (bool enabled, uint256 unlockTime) {
        return token.getEmergencyStatus();
    }

    /// @notice Returns staking parameters (passthrough).
    function getStakeParams() external view returns (uint256 stakePerStep, uint256 lastAdjustTs, bool locked) {
        return token.getStakeParams();
    }

    /// @notice Returns immutable stake constants (UI convenience).
    function getStakeConstants()
        external
        pure
        returns (uint256 minStakePerStep, uint256 maxStakePerStep, uint256 adjustCooldown)
    {
        return (MIN_STAKE_PER_STEP, MAX_STAKE_PER_STEP, STAKE_ADJUST_COOLDOWN);
    }

    /*────────────────────────────── CONSTANTS (PACKED) ──────────────────────────*/

    /// @notice Returns UI constants in a single packed array to reduce RPC round trips.
    /// @dev Pure function: values are compile-time constants.
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

        out[15] = MONTHLY_MINT_LIMIT;
    }
}
