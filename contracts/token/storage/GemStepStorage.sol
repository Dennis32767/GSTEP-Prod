// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title GemStepStorage
/// @notice Pure storage + constants + events + structs for GemStep.
/// @dev
///  IMPORTANT STORAGE-LAYOUT RULES (Upgradeable):
///  - Do not reorder state variables, structs, or mappings.
///  - Do not change visibility/types of existing state variables.
///  - New variables must be appended only (or consumed from `__gap` if managed carefully).
///  - Constants/events/struct definitions do not consume storage slots, but keep ordering stable
///    to reduce upgrade review risk and maintain audit parity.
///
///  This contract is intended to be inherited by core/modules. It contains:
///  - Role identifiers and EIP-712 typehash constants
///  - Tokenomics and policy constants
///  - State variables and mappings
///  - Events and shared data structures
abstract contract GemStepStorage {
    /* =============================================================
                                   ROLES
       ============================================================= */

    /// @notice Role allowing pause/unpause.
    /// @dev Tests/tooling should use the same keccak256 literals or read via the external views helper
    bytes32 internal constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @notice Role allowing privileged mint operations (where exposed).
    bytes32 internal constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @notice Role for off-chain signature authorizers (general).
    bytes32 internal constant SIGNER_ROLE = keccak256("SIGNER_ROLE");

    /// @notice Role for updating parameters and allowlists.
    bytes32 internal constant PARAMETER_ADMIN_ROLE = keccak256("PARAMETER_ADMIN_ROLE");

    /// @notice Role for emergency controls (withdrawals, overrides).
    bytes32 internal constant EMERGENCY_ADMIN_ROLE = keccak256("EMERGENCY_ADMIN_ROLE");

    /// @notice Role for upgrade authorization (proxy admin / upgrade executor).
    bytes32 internal constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    /// @notice Role for API-side signing keys used by trusted relayers.
    bytes32 internal constant API_SIGNER_ROLE = keccak256("API_SIGNER_ROLE");

    /* =============================================================
                        EIP-712 TYPEHASHES
    ============================================================= */

    /// @dev EIP-712 StepLog typehash.
    bytes32 internal constant STEPLOG_TYPEHASH = keccak256(
        "StepLog(address user,address beneficiary,uint256 steps,uint256 nonce,uint256 deadline,uint256 chainId,string source,string version)"
    );

    /// @dev Nonce-bound attestation typehash (V2 only; bytes32 versionHash).
    bytes32 internal constant ATTESTATION_V2_TYPEHASH = keccak256(
        "AttestationV2(address user,uint256 steps,uint256 timestamp,bytes32 versionHash,uint256 userNonce)"
    );

    /* =============================================================
                     DOMAIN / PAYLOAD VERSION CONSTANTS
       ============================================================= */

    /// @notice EIP-712 domain name.
    string public constant DOMAIN_NAME = "GemStep";

    /// @notice EIP-712 domain version (bump only to intentionally invalidate old signatures).
    string public constant DOMAIN_VERSION = "1.0.0";

    /// @notice Default payload schema/version used by clients.
    string public constant DEFAULT_PAYLOAD_VERSION = "1.0.0";

    /* =============================================================
                         TOKENOMICS / POLICY CONSTANTS
       ============================================================= */

    /// @notice Token decimals (ERC20).
    uint8 public constant DECIMALS = 18;

    /// @dev Initial supply (minted during initialize).
    uint256 internal constant INITIAL_SUPPLY = 400_000_000 * 10 ** DECIMALS;

    /// @dev Maximum supply (hard cap).
    uint256 internal constant MAX_SUPPLY = 1_000_000_000 * 10 ** DECIMALS;

    /// @dev Default reward rate (tokens per step, 18 decimals). Example: 0.001 GSTEP/step.
    uint256 internal constant REWARD_RATE_BASE = 1e15;

    /// @dev Maximum allowed reward rate by governance policy. Example: 0.01 GSTEP/step.
    uint256 internal constant MAX_REWARD_RATE = 1e16;

    /// @dev Percent helper base (100%).
    uint256 internal constant PERCENTAGE_BASE = 100;

    /// @dev Basis points helper base (10,000 bps).
    uint256 internal constant BPS_BASE = 10_000;

    /// @dev Reward split (basis points): 80% user / 10% burn / 10% treasury.
    uint256 internal constant REWARD_USER_BPS = 8000;
    uint256 internal constant REWARD_BURN_BPS = 1000;
    uint256 internal constant REWARD_TREASURY_BPS = 1000;

    /// @dev Default signature validity window.
    uint256 internal constant DEFAULT_SIGNATURE_VALIDITY = 1 hours;

    /// @dev Maximum allowed signature validity window.
    uint256 internal constant MAX_SIGNATURE_VALIDITY = 7 days;

    /// @dev Min/Max source string lengths.
    uint256 internal constant MIN_SOURCE_LENGTH = 3;
    uint256 internal constant MAX_SOURCE_LENGTH = 20;

    /// @notice Delay applied when enabling emergency withdrawals.
    uint256 internal constant EMERGENCY_DELAY = 2 days;

    /// @dev Minimum burn amount (generic minimum). Kept as policy anchor.
    uint256 internal constant MIN_BURN_AMOUNT = 1 * 10 ** DECIMALS;

    /// @dev Minimum steps allowed per submission.
    uint256 internal constant MIN_STEPS = 1;

    /// @notice Base monthly mint cap (policy). Current cap may change with halving schedule.
    uint256 internal constant MONTHLY_MINT_LIMIT = 2_000_000 * 10 ** DECIMALS;

    /// @dev Batch bounds.
    uint256 internal constant MAX_BATCH_SIGNERS = 20;
    uint256 internal constant MAX_SIGNATURE_CLEARANCE = 50;
    uint256 internal constant MAX_BATCH_SOURCES = 10;

    /// @notice Month length used for cap rollover (fixed 30 days).
    uint256 internal constant SECONDS_PER_MONTH = 30 days;

    /// @dev Legacy anomaly/suspension state retained for layout compatibility (currently unused).
    uint256 internal constant PENALTY_PERCENT = 30;

    /// @notice Maximum steps per day (per-source default).
    uint256 internal constant MAX_STEPS_PER_DAY = 10_000;

    /// @notice Minimum submission interval (per-source default).
    uint256 internal constant MIN_SUBMISSION_INTERVAL = 1 hours;

    /// @dev Legacy anomaly/suspension state retained for layout compatibility (currently unused).
    uint256 internal constant SUSPENSION_DURATION = 30 days;

    /// @notice Onboarding cap: number of successful non-API submissions allowed per user.
    uint256 internal constant ANOMALY_THRESHOLD = 3;

    /// @dev Legacy anomaly/suspension state retained for layout compatibility (currently unused).
    uint256 internal constant MIN_AVERAGE_FOR_ANOMALY = 500;

    /// @dev Legacy anomaly/suspension state retained for layout compatibility (currently unused).
    uint256 internal constant GRACE_PERIOD = 7 days;

    /// @dev Upper bounds for calldata sizes (defensive; protects gas / DoS).
    uint256 internal constant MAX_PROOF_LENGTH = 32;
    uint256 internal constant MAX_VERSION_LENGTH = 32;

    /// @notice Minimum stake-per-step in GSTEP (token-wei, 1e18).
    uint256 internal constant MIN_STAKE_PER_STEP = 1e16; // example: 0.01 GSTEP/step

    /// @notice Maximum stake-per-step in GSTEP (token-wei, 1e18).
    uint256 internal constant MAX_STAKE_PER_STEP = 5e16; // or higher if you want headroom

    /// @notice Cooldown between oracle-driven stake requirement adjustments.
    uint256 internal constant STAKE_ADJUST_COOLDOWN = 1 days;

    /// @dev Target stake policy percent (derived from oracle price, in ETH terms).
    uint256 internal constant TARGET_STAKE_PERCENT = 10;

    /// @dev Count of successful non-trusted (user-path) submissions per user.
    mapping(address => uint256) internal nonApiSubmissionCount;

    /// @notice Total amount of GSTEP currently locked in staking.
    /// @dev
    ///  - Denominated in GSTEP token units (18 decimals).
    ///  - Must equal the sum of all {stakeBalance[user]} across users.
    ///  - Used to protect staked user funds from being withdrawn via emergency withdrawals.
    ///  - Only "free" contract balance may be withdrawn:
    ///  - Invariant target: sum(stakeBalance[all users]) == totalStaked.
    ///  - Emergency withdrawals must only withdraw:
    ///      free = balanceOf(address(this)) - totalStaked

    uint256 internal totalStaked;

    /* =============================================================
                    STAKING / SPLIT POLICY CONSTANTS
    ============================================================= */

    /// @dev Minimum time considered for any duration boost.
    uint256 internal constant STAKE_MIN_AGE = 7 days;

    /// @dev Duration cap used for discount scaling (anything older is treated as this age).
    uint256 internal constant STAKE_MAX_AGE = 180 days;

    /// @dev Absolute maximum reduction applied to (burn+treasury) combined.
    uint256 internal constant STAKE_MAX_CUT_DISCOUNT_BPS = 1_200;

    /// @dev Floor for (burn+treasury) combined after discount (keep some cut always).
    uint256 internal constant STAKE_MIN_CUT_BPS = 800;

    /// @dev Stake “power” thresholds (tune to tokenomics).
    uint256 internal constant STAKE_TIER1 = 10_000 * 1e18;
    uint256 internal constant STAKE_TIER2 = 50_000 * 1e18;
    uint256 internal constant STAKE_TIER3 = 200_000 * 1e18;

    /// @dev Base discount from amount alone (before duration bonus).
    uint256 internal constant STAKE_D1 = 200; // 2.00%
    uint256 internal constant STAKE_D2 = 500; // 5.00%
    uint256 internal constant STAKE_D3 = 900; // 9.00%

    /* =============================================================
                                   STATE
       ============================================================= */

    /// @notice Retained for storage compatibility (fee-on-transfer removed elsewhere).
    uint256 internal burnFee;

    /// @notice Current reward rate (tokens per step).
    uint256 internal rewardRate;

    /// @notice Maximum steps per submission.
    uint256 internal stepLimit;

    /// @notice Max acceptable deadline distance into the future.
    uint256 internal signatureValidityPeriod;

    /// @notice Emergency withdrawals enabled flag.
    bool internal emergencyWithdrawEnabled;

    /// @notice Earliest time emergency withdrawals can be executed after enabling.
    uint256 internal emergencyWithdrawUnlockTime;

    /// @dev Base monthly limit (internal policy anchor).
    uint256 internal monthlyMintLimit;

    /// @notice Amount minted (net) in current month window.
    uint256 internal currentMonthMinted;

    /// @dev Current month index (timestamp / SECONDS_PER_MONTH).
    uint256 internal currentMonth;

    /// @dev Timestamp of last month rollover update.
    uint256 internal lastMonthUpdate;

    /// @notice Cumulative distributed total used for halving threshold tracking.
    uint256 internal distributedTotal;

    /// @notice Current monthly cap (may change via halving schedule).
    uint256 internal currentMonthlyCap;

    /// @notice Halving counter.
    uint256 internal halvingCount;

    /// @dev Initial admin captured at initialize for one-time role migration.
    address internal initialAdmin;

    /// @dev One-time admin role transfer guard.
    bool internal adminRoleTransferred;

    /// @dev Multisig governance sink (optional).
    address internal multisig;

    /// @notice Treasury address used by reward split mints.
    address public treasury;

    /// @dev Arbitrum retryable config and L1 validation wiring.
    address internal arbitrumInbox;
    uint256 internal arbMaxGas;
    uint256 internal arbGasPriceBid;
    uint256 internal arbMaxSubmissionCost;
    address internal l1Validator;
    address payable internal arbEthBridge;

    /// @dev Retained for future policy changes (oracle logic currently unused).
    address internal priceOracle;

    /// @notice Current stake required per step (GSTEP token-wei, 1e18).
    uint256 internal currentStakePerStep;

    /// @notice Timestamp of last stake parameter adjustment.
    uint256 internal lastStakeAdjustment;

    /// @notice Emergency lock on stake parameter changes.
    bool internal stakeParamsLocked;

    /// @dev Staking-only pause (independent of OZ Pausable).
    bool internal stakingPaused;

    /* =============================================================
                                  MAPPINGS
       ============================================================= */

    /// @dev Source validity registry.
    mapping(string => bool) internal validSources;

    /// @dev Replay protection for EIP-712 signatures (sigHash => used).
    mapping(bytes32 => bool) internal usedSignatures;

    /// @dev Optional expiry for signature hashes to support batch cleanup.
    mapping(bytes32 => uint256) internal signatureExpiry;

    /// @dev Timelocks for parameter changes (if used by other modules).
    mapping(string => uint256) internal changeTimelocks;

    /// @notice User submission nonces (for payload nonce sequencing).
    mapping(address => uint256) public nonces;

    /// @dev Total steps recorded per user.
    mapping(address => uint256) internal totalSteps;

    /// @dev Last source used per user.
    mapping(address => string) internal lastSource;

    /// @notice Trusted ERC-1271 contract wallets.
    mapping(address => bool) internal trustedERC1271Contracts;

    /// @notice Approved recipients for emergency withdrawals.
    mapping(address => bool) internal approvedRecipients;

    /// @dev Used merkle leaves (leaf => used).
    mapping(bytes32 => bool) internal usedLeaves;

    /// @notice Source configuration struct (contains a per-user nonce mapping).
    struct SourceConfig {
        bool requiresProof;
        bool requiresAttestation;
        bytes32 merkleRoot;
        uint256 maxStepsPerDay;
        uint256 minInterval;
        mapping(address => uint256) userNonce;
    }

    /// @dev Source key => SourceConfig
    mapping(string => SourceConfig) internal sourceConfigs;

    /// @dev Trusted attestation device registry.
    mapping(address => bool) internal trustedDevices;

    /// @dev Per-(user,source) submission timestamp (min-interval enforcement).
    mapping(address => mapping(string => uint256)) internal lastSubmission;

    /// @dev Per-(user,source) daily step totals (daily cap enforcement).
    mapping(address => mapping(string => uint256)) internal dailyStepTotal;

    /// @dev Per-(user,source) stored day index to detect UTC rollover.
    mapping(address => mapping(string => uint256)) internal dailyIndex;

    /// @dev User EMA average (scaled ×100).
    mapping(address => uint256) internal userStepAverage;

    /// @dev Legacy anomaly/suspension state retained for layout compatibility (currently unused).
    mapping(address => uint256) internal flaggedSubmissions;

    /// @dev Legacy anomaly/suspension state retained for layout compatibility (currently unused).
    mapping(address => uint256) internal suspendedUntil;

    /// @dev Staked GSTEP balance per user (token-staking module).
    mapping(address => uint256) internal stakeBalance;

    /// @dev Weighted stake start timestamp per user (used for stake duration).
    mapping(address => uint256) internal stakeStart;

    /// @dev Trusted API caller registry.
    mapping(address => bool) internal isTrustedAPI;

    /// @dev Timestamp of first submission per user (grace-period anchor).
    mapping(address => uint256) internal userFirstSubmission;

    /// @notice Tunable onboarding cap for non-API submissions (count).
    /// @dev Stored in legacy slot name {anomalyThreshold} for layout compatibility.
    uint256 internal anomalyThreshold;

    /* =============================================================
                              VERSION CONTROLS
       ============================================================= */

    /// @dev Supported attestation versions (hash of normalized string => allowed).
    mapping(bytes32 => bool) internal supportedAttestationVersions;

    /// @dev Attestation version deprecation time (hash => unix time; 0 = not scheduled).
    mapping(bytes32 => uint256) internal attestationVersionDeprecatesAt;

    /// @dev Supported payload versions (hash of normalized string => allowed).
    mapping(bytes32 => bool) internal supportedPayloadVersions;

    /// @dev Payload version deprecation time (hash => unix time; 0 = not scheduled).
    mapping(bytes32 => uint256) internal payloadVersionDeprecatesAt;

    /// @notice ERC-1271 digest replay guard: wallet => digest => used.
    mapping(address => mapping(bytes32 => bool)) internal used1271Digests;

    /* =============================================================
                                   EVENTS
       ============================================================= */

    event TokensMinted(address indexed to, uint256 amount, uint256 newTotalSupply);
    event TokensBurned(address indexed from, uint256 amount, uint256 newTotalSupply);

    event RewardClaimed(
        address indexed user,
        address indexed beneficiary,
        uint256 steps,
        uint256 rewardAmount,
        uint256 timestamp,
        string source,
        string version
    );

    event EmergencyWithdraw(address indexed admin, uint256 amount, uint256 newTotalSupply);
    event EmergencyWithdrawERC20(address indexed token, address indexed to, uint256 amount);
    event EmergencyWithdrawETH(address indexed to, uint256 amount);

    event SignerAdded(address indexed signer);
    event SignerRemoved(address indexed signer);

    event ParameterUpdated(string indexed parameter, uint256 oldValue, uint256 newValue);
    event SourceAdded(string indexed source);
    event SourceRemoved(string indexed source);
    event TimelockSet(string indexed parameter, uint256 unlockTime);
    event EmergencyWithdrawEnabledChanged(bool enabled, uint256 unlockTime);
    event ETHReceived(address indexed sender, uint256 amount);
    event ERC1271ContractAdded(address indexed contractAddress);
    event ERC1271ContractRemoved(address indexed contractAddress);
    event SignatureCleared(bytes32 indexed signatureHash);
    event MonthRollover(uint256 newStart, uint256 currentCap);
    event UpgradeScheduled(address indexed newImplementation, uint256 scheduledTime);
    event UpgradeCancelled(address indexed cancelledImplementation);
    event Upgraded(uint256 version, address indexed newImplementation);
    event MonthlyCapUpdated(uint256 newCap, uint256 halvingCount);
    event AdminRolesTransferred(address indexed newAdmin);
    event RecipientApprovalChanged(address indexed recipient, bool approved);
    event MonthAdvanced(uint256 newMonth);
    event SourcesInitialized();
    event UserSuspended(address indexed user, uint256 until);
    event Staked(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event PenaltyApplied(address indexed user, uint256 amount);
    event SourceConfigured(string source, bool requiresProof, bool requiresAttestation);
    event TrustedDeviceAdded(address indexed device);
    event TrustedAPISet(address indexed api, bool trusted);
    event VersionAdded(string version); // backward compatibility (attestation)
    event StakeParametersUpdated(uint256 newStakePerStep, uint256 timestamp);
    event StakeEmergencyLocked(bool locked);
    event OracleUpdated(address indexed newOracle);
    event MultisigSet(address multisig);
    event Trusted1271Set(address indexed contractAddr, bool trusted);

    event TreasurySet(address indexed treasury);

    event PayloadVersionAdded(string version);
    event PayloadVersionDeprecated(string version, uint256 deprecatesAt);
    event AttestationVersionAdded(string version);
    event AttestationVersionDeprecated(string version, uint256 deprecatesAt);

    event SourceMerkleRootSet(string source, bytes32 root);

    /* ====================== CROSS-CHAIN GOVERNANCE EVENTS ====================== */
    event L1GovernanceSet(address indexed l1);
    event L2PausedByL1(bool paused);
    event L2ParamsUpdatedByL1(uint256 stepLimit, uint256 rewardRate);
    event L2ToL1Tx(uint256 indexed id, address to, bytes data);
    
    /// @notice Emitted when staking-only pause is toggled.
    event StakingPauseSet(bool paused);

    /* =============================================================
                               DATA STRUCTURES
       ============================================================= */

    /// @notice Step submission payload used by {GS_StepsAndVerification.logSteps}.
    struct StepSubmission {
        address user;
        address beneficiary;
        uint256 steps;
        uint256 nonce;
        uint256 deadline;
        string source;
        string version; // client/schema tag (normalized & allowlisted)
    }

    struct VerificationData {
        /// @notice EIP-712 signature for the step digest.
        bytes signature;

        /// @notice Optional merkle proof (source-dependent).
        bytes32[] proof;

        /// @notice Optional device attestation blob (V2 only).
        /// @dev abi.encode(address device, uint256 timestamp, bytes32 versionHash, bytes sig)
        ///      - Always nonce-bound (binds to data.nonce)
        bytes attestation;
    }

    /* =============================================================
                     CROSS-CHAIN GOVERNANCE (STATE)
       ============================================================= */

    /// @dev L1 governance controller address (unaliased; aliasing applied on L2).
    /// Placed here for maximum storage layout stability.
    address internal l1Governance;

    /* =============================================================
                                 STORAGE GAP
       ============================================================= */

    /// @dev Reserved storage slots for future upgrades.
    uint256[40] private __gap;
}
