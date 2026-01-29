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
///  - GemStepViews reads token-exposed bundles and exposes derived read-only helpers.
///  - Post-launch parameter changes do not require view updates unless the semantic meaning or aggregation logic changes.
///
///  VERSIONED ADAPTER WARNING:
///  - This contract mirrors select policy constants for UI convenience.
///  - If GemStepStorage constants change in a new deployment, you MUST redeploy this helper.
///  - To prevent silent mismatches, this contract exposes VIEWS_CONFIG_HASH and viewsConfigHashBound().
contract GemStepViews {
    /// @notice The token instance this view helper reads from.
    IGemStepTokenRead public immutable token;

    /* ========================= Constants mirrored for UI =========================
       @dev These are duplicated here (not in the token) to avoid increasing token bytecode.
            Keep these aligned with GemStepStorage constants for *this deployment*.
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
    uint256 internal constant ANOMALY_THRESHOLD = 3;

    /// @dev Must match GemStepStorage.MIN_AVERAGE_FOR_ANOMALY (legacy/unused policy anchor)
    uint256 internal constant MIN_AVERAGE_FOR_ANOMALY = 500;

    /// @dev Must match GemStepStorage.GRACE_PERIOD (legacy/unused policy anchor)
    uint256 internal constant GRACE_PERIOD = 7 days;

    /// @dev Must match GemStepStorage.MAX_PROOF_LENGTH
    uint256 internal constant MAX_PROOF_LENGTH = 32;

    /// @dev Must match GemStepStorage.MAX_VERSION_LENGTH
    uint256 internal constant MAX_VERSION_LENGTH = 32;

    /// @dev Must match GemStepStorage.TARGET_STAKE_PERCENT (legacy/unused policy anchor)
    uint256 internal constant TARGET_STAKE_PERCENT = 10;

    /// @dev Must match GemStepStorage.MONTHLY_MINT_LIMIT
    uint256 internal constant MONTHLY_MINT_LIMIT = 2_000_000 * 10 ** DECIMALS;

    /// @dev Must match GemStepStorage.MIN_STAKE_PER_STEP / MAX_STAKE_PER_STEP / STAKE_ADJUST_COOLDOWN
    /// @dev IMPORTANT: these are GEMS token units (token-wei, 1e18), NOT ETH/wei.
    uint256 internal constant MIN_STAKE_PER_STEP = 1e16; // 0.01 GEMS/step
    uint256 internal constant MAX_STAKE_PER_STEP = 5e16; // 0.05 GEMS/step
    uint256 internal constant STAKE_ADJUST_COOLDOWN = 1 days;

    /* ========================= Policy Bundles =========================
       @dev Staking/split policy constants are exposed by the token via getStakePolicy().
            Do NOT mirror them here (reduces drift risk).
    */

    /*──────────────────────── CONFIG FINGERPRINT (VERSIONED ADAPTER) ──────────────────────*/
/// @dev v2 because we changed how the hash is computed (chunked to avoid stack-too-deep under coverage).
bytes32 internal constant VIEWS_SCHEMA = keccak256("GemStepViews:v2");

/// @notice Fingerprint of this Views build’s mirrored constants.
/// @dev Coverage-safe: chunk the encoding to avoid stack-too-deep (coverage disables viaIR).
function viewsConfigHash() public pure returns (bytes32) {
    bytes32 h1 = keccak256(
        abi.encode(
            uint256(DECIMALS),
            MAX_SUPPLY,
            BPS_BASE,
            REWARD_USER_BPS,
            MIN_STEPS,
            SECONDS_PER_MONTH,
            INITIAL_SUPPLY,
            REWARD_RATE_BASE,
            MAX_REWARD_RATE,
            PERCENTAGE_BASE,
            DEFAULT_SIGNATURE_VALIDITY
        )
    );

    bytes32 h2 = keccak256(
        abi.encode(
            MAX_SIGNATURE_VALIDITY,
            MIN_BURN_AMOUNT,
            ANOMALY_THRESHOLD,
            MIN_AVERAGE_FOR_ANOMALY,
            GRACE_PERIOD,
            MAX_PROOF_LENGTH,
            MAX_VERSION_LENGTH,
            TARGET_STAKE_PERCENT,
            MONTHLY_MINT_LIMIT,
            MIN_STAKE_PER_STEP,
            MAX_STAKE_PER_STEP,
            STAKE_ADJUST_COOLDOWN
        )
    );

    return keccak256(abi.encode(VIEWS_SCHEMA, h1, h2));
}

/// @notice Strong pairing hash that binds this views instance to a specific token address.
function viewsConfigHashBound() external view returns (bytes32) {
    return keccak256(abi.encode(VIEWS_SCHEMA, address(token), viewsConfigHash()));
}

/// @notice Create a new read helper pointed at an already-deployed token.
/// @param token_ Deployed GemStepToken proxy address.
constructor(address token_) {
    require(token_ != address(0), "Token addr=0");
    token = IGemStepTokenRead(token_);
}


    /*────────────────────────────── HALVING / MONTH ─────────────────────────────*/

    function getHalvingInfo()
        external
        view
        returns (uint256 currentHalvingCount, uint256 nextHalvingThreshold, uint256 remainingUntilHalving)
    {
        (, , , , uint256 distributedTotal_, , uint256 halvingIdx) = token.getMintingState();

        uint256 t = MAX_SUPPLY - (MAX_SUPPLY >> (halvingIdx + 1));

        currentHalvingCount = halvingIdx;
        nextHalvingThreshold = t;
        remainingUntilHalving = t > distributedTotal_ ? t - distributedTotal_ : 0;
    }

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

    function estimateReward(uint256 steps) external view returns (uint256 amount) {
        if (steps < MIN_STEPS) return 0;
        (, uint256 rewardRate_, , ) = token.getCoreParams();
        uint256 gross = steps * rewardRate_;
        return (gross * REWARD_USER_BPS) / BPS_BASE;
    }

    /*────────────────────────────── SOURCES / USERS ─────────────────────────────*/

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
        return token.getSourceConfigFields(source);
    }

    function getUserSourceStats(address user, string calldata source)
        external
        view
        returns (uint256 lastTs, uint256 dailyTotal, uint256 dayIndex)
    {
        return token.getUserSourceStats(user, source);
    }

    function getUserSourceNonce(address user, string calldata source) external view returns (uint256) {
        return token.getUserSourceNonce(user, source);
    }

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
        )
    {
        return token.getUserCoreStatus(user);
    }

    function getUserBasics(address user) external view returns (uint256 totalSteps_, string memory lastSource_) {
        return token.getUserBasics(user);
    }

    function isTrustedDevice(address device) external view returns (bool) {
        return token.isTrustedDevice(device);
    }

    /*────────────────────────────── VERSIONS ────────────────────────────────────*/

    function getAttestationVersionInfo(bytes32 v)
        external
        view
        returns (bool supported, uint256 deprecatesAt, bool requiresNonce)
    {
        (supported, deprecatesAt, requiresNonce, , ) = token.getVersionPolicy(v);
    }

    function getPayloadVersionInfo(bytes32 v) external view returns (bool supported, uint256 deprecatesAt) {
        (, , , supported, deprecatesAt) = token.getVersionPolicy(v);
    }

    /*────────────────────────────── L2 / ARBITRUM ───────────────────────────────*/

    function getArbitrumConfig()
        external
        view
        returns (address inbox, address l1Validator_, uint256 maxGas, uint256 gasPriceBid, uint256 maxSubmissionCost)
    {
        (inbox, l1Validator_, maxGas, gasPriceBid, maxSubmissionCost, ) = token.getArbitrumConfig();
    }

    /*────────────────────────────── CORE (PASSTHROUGH) ──────────────────────────*/

    function getCoreParams()
        external
        view
        returns (uint256 burnFee_, uint256 rewardRate_, uint256 stepLimit_, uint256 signatureValidityPeriod_)
    {
        return token.getCoreParams();
    }

    function getEmergencyStatus() external view returns (bool enabled, uint256 unlockTime) {
        return token.getEmergencyStatus();
    }

    function getStakeParams() external view returns (uint256 stakePerStep, uint256 lastAdjustTs, bool locked) {
        return token.getStakeParams();
    }

    function getStakeConstants()
        external
        pure
        returns (uint256 minStakePerStep, uint256 maxStakePerStep, uint256 adjustCooldown)
    {
        return (MIN_STAKE_PER_STEP, MAX_STAKE_PER_STEP, STAKE_ADJUST_COOLDOWN);
    }

    /* ============================== Policy Bundles ============================== */

    /// @notice Returns staking discount policy constants (UI convenience).
    /// @dev Calls the token’s bundled read (pure bundle in GS_ReadersMinimal).
    function getStakePolicy()
        external
        view
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
        return token.getStakePolicy();
    }

    /*────────────────────────────── STAKING (CONTRACT-LEVEL) ────────────────────*/

    /// @notice Returns contract-level staking totals used for emergency-withdraw safety.
    /// @dev Views cannot read token internal storage (e.g., totalStaked) directly, so this uses the token bundle.
    function getContractStakingState()
        external
        view
        returns (uint256 contractBal, uint256 totalStaked_, uint256 freeBal)
    {
        return token.getContractStakingState();
    }

    /*────────────────────────────── CONSTANTS (PACKED) ──────────────────────────*/

    function getPublicConstantsPacked() external pure returns (uint256[16] memory out) {
        out[0] = INITIAL_SUPPLY;
        out[1] = REWARD_RATE_BASE;
        out[2] = SECONDS_PER_MONTH;
        out[3] = MAX_REWARD_RATE;
        out[4] = PERCENTAGE_BASE;

        out[5] = DEFAULT_SIGNATURE_VALIDITY;
        out[6] = MAX_SIGNATURE_VALIDITY;
        out[7] = MIN_BURN_AMOUNT;
        out[8] = MIN_STEPS;

        out[9] = ANOMALY_THRESHOLD;
        out[10] = MIN_AVERAGE_FOR_ANOMALY;
        out[11] = GRACE_PERIOD;
        out[12] = MAX_PROOF_LENGTH;
        out[13] = MAX_VERSION_LENGTH;
        out[14] = TARGET_STAKE_PERCENT;

        out[15] = MONTHLY_MINT_LIMIT;
    }
}
