// contracts/token/core/GemStepStorage.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Pure storage + constants + events + structs for GemStep.
/// IMPORTANT: Order preserved to keep storage layout identical across upgrades.
abstract contract GemStepStorage {
    // ====================== Roles ====================== //
    // Keep these public: tests/tooling often read them directly.
    bytes32 public constant PAUSER_ROLE           = keccak256("PAUSER_ROLE");
    bytes32 public constant MINTER_ROLE           = keccak256("MINTER_ROLE");
    bytes32 public constant SIGNER_ROLE           = keccak256("SIGNER_ROLE");
    bytes32 public constant PARAMETER_ADMIN_ROLE  = keccak256("PARAMETER_ADMIN");
    bytes32 public constant EMERGENCY_ADMIN_ROLE  = keccak256("EMERGENCY_ADMIN");
    bytes32 public constant UPGRADER_ROLE         = keccak256("UPGRADER_ROLE");
    bytes32 public constant API_SIGNER_ROLE       = keccak256("API_SIGNER_ROLE");

    // ====================== EIP-712 Types =============== //
    bytes32 internal constant STEPLOG_TYPEHASH = keccak256(
        "StepLog(address user,address beneficiary,uint256 steps,uint256 nonce,uint256 deadline,uint256 chainId,string source,string version)"
    );
    // Legacy attestation (no nonce)
    bytes32 internal constant ATTESTATION_TYPEHASH =
        keccak256("Attestation(address user,uint256 steps,uint256 timestamp,string version)");
    // NEW: Nonce-bound attestation
    bytes32 internal constant ATTESTATION_V2_TYPEHASH =
        keccak256("Attestation(address user,uint256 steps,uint256 timestamp,bytes32 vHash,uint256 userNonce)");

    // ====================== Centralized Domain/Payload Constants ====================== //
    string  public constant DOMAIN_NAME             = "GemStep";
    string  public constant DOMAIN_VERSION          = "1.0.0"; // bump only to intentionally break old signatures
    string  public constant DEFAULT_PAYLOAD_VERSION = "1.0.0";

    // ====================== Token & Policy Constants ====================== //
    uint8    public constant DECIMALS = 18;
    uint256  internal constant INITIAL_SUPPLY = 40_000_000 * 10 ** DECIMALS;
    uint256  internal constant MAX_SUPPLY     = 100_000_000 * 10 ** DECIMALS;

    uint256  internal constant MAX_REWARD_RATE = 10 * 10 ** DECIMALS;
    uint256  internal constant PERCENTAGE_BASE = 100;

    uint256  internal constant DEFAULT_SIGNATURE_VALIDITY = 1 hours;
    uint256  internal constant MAX_SIGNATURE_VALIDITY     = 7 days;

    uint256  internal constant MIN_SOURCE_LENGTH = 3;
    uint256  internal constant MAX_SOURCE_LENGTH = 20;

    uint256  public constant EMERGENCY_DELAY = 2 days;

    uint256  internal constant MIN_BURN_AMOUNT   = 1 * 10 ** DECIMALS;
    uint256  internal constant MIN_REWARD_AMOUNT = 1 * 10 ** DECIMALS;

    uint256  public constant MONTHLY_MINT_LIMIT = 200_000 * 10 ** DECIMALS;

    uint256  internal constant MAX_BATCH_SIGNERS        = 20;
    uint256  internal constant MAX_SIGNATURE_CLEARANCE  = 50;
    uint256  internal constant MAX_BATCH_SOURCES        = 10;

    uint256  internal constant REWARD_RATE_BASE    = 1 * 10 ** DECIMALS;
    uint256  public constant SECONDS_PER_MONTH   = 30 days;

    uint256  public constant PENALTY_PERCENT         = 30;       // %
    uint256  public constant MAX_STEPS_PER_DAY       = 10_000;
    uint256  public constant MIN_SUBMISSION_INTERVAL = 1 hours;
    uint256  public constant SUSPENSION_DURATION     = 30 days;

    uint256  public constant ANOMALY_THRESHOLD        = 5;       // 5x average (default)
    uint256  internal constant MIN_AVERAGE_FOR_ANOMALY  = 500;     // scaled avg ≥500 (~5 steps if ×100 scaling)
    uint256  public constant GRACE_PERIOD             = 7 days;  // grace period for new users
    uint256  internal constant MAX_PROOF_LENGTH         = 32;
    uint256  internal constant MAX_VERSION_LENGTH       = 32;

    uint256  public constant MIN_STAKE_PER_STEP     = 0.0000001 ether;
    uint256  public constant MAX_STAKE_PER_STEP     = 0.001 ether;
    uint256  public constant STAKE_ADJUST_COOLDOWN  = 1 days;
    uint256  internal constant TARGET_STAKE_PERCENT   = 10; // 10% of token value (in ETH)

    // ====================== State ====================== //
    uint256 public burnFee;
    uint256 public rewardRate;
    uint256 public stepLimit;
    uint256 public signatureValidityPeriod;

    bool     public emergencyWithdrawEnabled;
    uint256  public emergencyWithdrawUnlockTime;

    uint256 internal monthlyMintLimit;
    uint256 public currentMonthMinted;
    uint256 internal currentMonth;
    uint256 internal lastMonthUpdate;
    uint256 public distributedTotal;
    uint256 public currentMonthlyCap;
    uint256 public halvingCount;

    address internal initialAdmin;
    bool    internal adminRoleTransferred;
    address internal multisig;

    address internal arbitrumInbox;
    uint256 internal arbMaxGas;
    uint256 internal arbGasPriceBid;
    uint256 internal arbMaxSubmissionCost;
    address internal l1Validator;
    address payable internal arbEthBridge;

    // Make internal; you already expose via GS_Views.getPriceOracle()
    address internal priceOracle; // store address only; cast where used

    uint256 public currentStakePerStep;
    uint256 public lastStakeAdjustment;
    bool    public stakeParamsLocked;

    // Mappings
    mapping(string => bool) internal validSources;
    mapping(bytes32 => bool) internal usedSignatures;
    mapping(bytes32 => uint256) internal signatureExpiry;
    mapping(string => uint256) internal changeTimelocks;
    mapping(address => uint256) public nonces;
    mapping(address => uint256) internal totalSteps;
    mapping(address => string)  internal lastSource;
    mapping(address => bool)    public trustedERC1271Contracts;
    mapping(address => bool)    public approvedRecipients;
    mapping(bytes32 => bool)    internal usedLeaves;

    struct SourceConfig {
        bool requiresProof;
        bool requiresAttestation;
        bytes32 merkleRoot;
        uint256 maxStepsPerDay;
        uint256 minInterval;
        mapping(address => uint256) userNonce;
    }
    mapping(string => SourceConfig) internal sourceConfigs;

    mapping(address => bool) internal trustedDevices;

    // per-(user,source) timing & daily caps
    mapping(address => mapping(string => uint256)) internal lastSubmission;
    mapping(address => mapping(string => uint256)) internal dailyStepTotal;
    // (C) NEW: track day index to reset dailyStepTotal at UTC day rollover
    mapping(address => mapping(string => uint256)) internal dailyIndex;

    // anomaly tracking (EMA scaled ×100)
    mapping(address => uint256) internal userStepAverage;
    mapping(address => uint256) internal flaggedSubmissions;
    mapping(address => uint256) internal suspendedUntil;
    mapping(address => uint256) internal stakeBalance;
    mapping(address => bool)    internal isTrustedAPI;
    mapping(address => uint256) internal userFirstSubmission; // track first submission

    /// @notice Pure storage + constants + events + structs for GemStep.
    /// IMPORTANT: Order preserved to keep storage layout identical across upgrades.
    uint256 public anomalyThreshold;

    // Version controls
    mapping(bytes32 => bool) internal supportedAttestationVersions;        // normalized hash -> allowed
    mapping(bytes32 => uint256) internal attestationVersionDeprecatesAt;   // hash -> unix time (0 = not scheduled)
    mapping(bytes32 => bool) internal supportedPayloadVersions;            // normalized hash -> allowed
    mapping(bytes32 => uint256) internal payloadVersionDeprecatesAt;       // hash -> unix time (0 = not scheduled)

    // NEW: Attestation/1271 replay guards + per-version nonce requirement
    mapping(bytes32 => bool) public usedAttestations;                    // device+attestHash (legacy)
    mapping(address => mapping(bytes32 => bool)) public used1271Digests; // ERC1271 wallet -> digest used
    mapping(bytes32 => bool) internal attestationRequiresNonce;          // attestation version hash -> nonce required

    // ====================== Events ====================== //
    event TokensMinted(address indexed to, uint256 amount, uint256 newTotalSupply);
    event TokensBurned(address indexed from, uint256 amount, uint256 newTotalSupply);

    event RewardClaimed(
        address indexed user,
        address indexed beneficiary,
        uint256 steps,
        uint256 rewardAmount,
        uint256 timestamp,
        string  source,
        string  version
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
    event VersionAdded(string version); // kept for backward compatibility (attestation)
    event StakeParametersUpdated(uint256 newStakePerStep, uint256 timestamp);
    event StakeEmergencyLocked(bool locked);
    event OracleUpdated(address indexed newOracle);
    event MultisigSet(address multisig);
    event Trusted1271Set(address indexed contractAddr, bool trusted);
    event AttestationNonceRequirementSet(string normVersion, bool required);


    // New explicit version events
    event PayloadVersionAdded(string version);
    event PayloadVersionDeprecated(string version, uint256 deprecatesAt);
    event AttestationVersionAdded(string version);
    event AttestationVersionDeprecated(string version, uint256 deprecatesAt);

    // ====================== CROSS-CHAIN GOVERNANCE EVENTS ======================
    event L1GovernanceSet(address indexed l1);
    event L2PausedByL1(bool paused);
    event L2ParamsUpdatedByL1(uint256 stepLimit, uint256 rewardRate);
    event L2ToL1Tx(uint256 indexed id, address to, bytes data);

    // ====================== Data Structures ====================== //
    struct StepSubmission {
        address user;
        address beneficiary;
        uint256 steps;
        uint256 nonce;
        uint256 deadline;
        string  source;
        string  version; // client/schema tag (normalized & allowlisted)
    }

    struct VerificationData {
        bytes signature;
        bytes32[] proof;
        // For attestation v2 (nonce-bound): abi.encode(address device, uint256 timestamp, string attestationVersion, bytes sig)
        // (Legacy v1 also uses the same tuple but signs the legacy typehash without userNonce)
        bytes attestation;
    }

    // ====================== CROSS-CHAIN GOVERNANCE STATE ======================
    // NEW: L1 governance controller for cross-chain control
    // Placed here for maximum storage layout stability
    address internal l1Governance;

    // Storage gap for future upgrades (reduced by 1 to account for new var: l1Governance)
    uint256[40] private __gap;
}