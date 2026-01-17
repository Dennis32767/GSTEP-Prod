// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/* ===================== OpenZeppelin Upgradeable ===================== */
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/introspection/IERC165Upgradeable.sol";

/* ===================== Project Imports ===================== */
import "../storage/GemStepStorage.sol";
import "../../token/interfaces/IPriceOracleV2.sol";

/// @title GemStepCore
/// @notice Core contract wiring OpenZeppelin upgradeable parents, initializer, and cross-cutting overrides.
/// @dev
///  - This core is intentionally `abstract` and declares internal hook functions implemented by modules
///    (e.g. GS_StepsAndVerification, GS_AnomalyAndFraud, GS_MintingAndSupply, GS_Staking, etc.).
///  - Storage is inherited from {GemStepStorage}. Keep inherited base order stable for audit parity.
///  - Uses a custom hard cap check via {_mintWithHardCap} instead of ERC20CappedUpgradeable to save bytecode.
abstract contract GemStepCore is
    Initializable,
    ERC20Upgradeable,
    PausableUpgradeable,
    AccessControlUpgradeable,
    ReentrancyGuardUpgradeable,
    EIP712Upgradeable,
    GemStepStorage
{
    /* =============================================================
                                CONSTRUCTOR
       ============================================================= */

    /// @custom:oz-upgrades-unsafe-allow constructor
    /// @dev Disable initializers on the implementation contract (proxy safety).
    constructor() {
        _disableInitializers();
    }

    /* =============================================================
                         ABSTRACT HOOKS (MODULES)
       ============================================================= */

    /// @notice Configure an activity source (e.g., fitbit/googlefit/applehealth).
    /// @param source Source key (lowercase recommended).
    /// @param requiresProof Whether proof is required for this source.
    /// @param requiresAttestation Whether attestation is required for this source.
    /// @dev Implemented in a module; must update source configuration storage.
    function _configureSource(
        string memory source,
        bool requiresProof,
        bool requiresAttestation
    ) internal virtual;

    /// @notice Apply fraud/anomaly prevention rules before accepting steps.
    /// @param user User address submitting steps.
    /// @param steps Steps submitted.
    /// @param source Source key.
    /// @dev Implemented in a module; should revert if submission violates rules.
    function _applyFraudPrevention(
        address user,
        uint256 steps,
        string calldata source
    ) internal view virtual;

    /// @notice Record a submission and any anomaly metadata.
    /// @param user User address.
    /// @param steps Steps submitted.
    /// @param source Source key.
    /// @dev Implemented in a module; should write to submission/anomaly storage and emit events.
    function _recordSubmissionAndAnomaly(
        address user,
        uint256 steps,
        string calldata source
    ) internal virtual;

    /// @notice Mint with monthly cap logic (and any split/burn logic) implemented in module.
    /// @param account Recipient (beneficiary).
    /// @param amount Total “gross” reward amount before split (18 decimals).
    /// @dev Implemented in a module; expected to call {_checkHalving} and/or {_syncMonth} as needed.
    function _mintWithCap(address account, uint256 amount) internal virtual;

    /* =============================================================
                      STAKING SPLIT HOOKS (MODULES)
       ============================================================= */

    /// @notice Apply stake discount to a base split and return final (user,burn,treasury) bps.
    /// @param user Beneficiary whose stake affects the split.
    /// @param userBps Base user portion bps.
    /// @param burnBps Base burn portion bps.
    /// @param treasuryBps Base treasury portion bps.
    /// @return u Final user bps.
    /// @return b Final burn bps.
    /// @return t Final treasury bps.
    /// @dev Implemented by staking module (e.g. {GS_Staking}); sum MUST equal {BPS_BASE}.
    function _applyStakeDiscountToSplit(
        address user,
        uint256 userBps,
        uint256 burnBps,
        uint256 treasuryBps
    ) internal view virtual returns (uint256 u, uint256 b, uint256 t);

    /// @notice Return discount bps applied to combined (burn+treasury) cut for a user.
    /// @param user Beneficiary whose stake affects the discount.
    /// @return Discount in bps applied to (burn+treasury) combined.
    /// @dev Implemented by staking module (e.g. {GS_Staking}).
    function _cutDiscountBps(address user) internal view virtual returns (uint256);

    /* =============================================================
                               INTERNAL HELPERS
       ============================================================= */

    /// @notice Normalizes semantic versions used in allowlists.
    /// @dev Treats "1.0" as "1.0.0" to prevent accidental allowlist mismatches.
    function _normalizeVersion(string memory v) internal pure virtual returns (string memory) {
        if (keccak256(bytes(v)) == keccak256(bytes("1.0"))) return "1.0.0";
        return v;
    }

    /* =============================================================
                               INITIALIZATION
       ============================================================= */

    /// @notice Initialize core state for the proxy deployment.
    /// @param initialSupply Must equal {INITIAL_SUPPLY}.
    /// @param admin Primary governance/admin address to receive roles.
    /// @param _priceOracle Price oracle contract address.
    /// @param _treasury Treasury address to receive the initial mint.
    /// @dev
    ///  - Must be called exactly once via proxy.
    ///  - Grants roles to `admin`, and optionally to deployer for scripted bootstrap.
    ///  - Sets token name/symbol, EIP-712 domain, oracle, treasury, defaults, and allowlists.
    function initialize(
        uint256 initialSupply,
        address admin,
        address _priceOracle,
        address _treasury
    ) public virtual initializer {
        require(admin != address(0), "Invalid admin address");
        require(_priceOracle != address(0), "Invalid price oracle");
        require(_treasury != address(0), "Treasury not set");

        // Enforce tokenomics constants at deploy-time.
        require(initialSupply == INITIAL_SUPPLY, "initialSupply != INITIAL_SUPPLY");
        require(INITIAL_SUPPLY <= MAX_SUPPLY, "Initial supply exceeds max");

        /* ------------------------- OZ initializers ------------------------- */
        __ERC20_init("GemStep", "GSTEP");
        __Pausable_init();
        __AccessControl_init();
        __ReentrancyGuard_init();
        __EIP712_init(DOMAIN_NAME, DOMAIN_VERSION);

        /* ------------------------- Core configuration ---------------------- */
        initialAdmin = admin;

        // Arbitrum ETH bridge (can be made configurable via a setter if desired).
        arbEthBridge = payable(0x8315177aB297bA92A06054cE80a67Ed4DBd7ed3a);

        // Oracle & Treasury (stored as addresses; modules can cast to IPriceOracleV2 where needed).
        priceOracle = _priceOracle;
        treasury = _treasury;

        /* ------------------- Dynamic staking defaults ---------------------- */
        currentStakePerStep = MIN_STAKE_PER_STEP;
        stakeParamsLocked = false;
        uint256 ts = block.timestamp;
        lastStakeAdjustment = ts;

        /* ------------------------------ Roles ------------------------------ */
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
        _grantRole(SIGNER_ROLE, admin);
        _grantRole(EMERGENCY_ADMIN_ROLE, admin);
        _grantRole(UPGRADER_ROLE, admin);
        _grantRole(API_SIGNER_ROLE, admin);
        _grantRole(PARAMETER_ADMIN_ROLE, admin);

        // Optional bootstrap for scripted setup (revoke later if desired).
        address deployer = _msgSender();
        if (deployer != admin) {
            _grantRole(DEFAULT_ADMIN_ROLE, deployer);
            _grantRole(PAUSER_ROLE, deployer);
            _grantRole(MINTER_ROLE, deployer);
            _grantRole(SIGNER_ROLE, deployer);
            _grantRole(EMERGENCY_ADMIN_ROLE, deployer);
            _grantRole(UPGRADER_ROLE, deployer);
            _grantRole(API_SIGNER_ROLE, deployer);
            _grantRole(PARAMETER_ADMIN_ROLE, deployer);
        }

        /* ------------------------- Tokenomics defaults --------------------- */
        burnFee = 0; // fee-on-transfer removed; splits occur in minting module
        rewardRate = REWARD_RATE_BASE;
        stepLimit = 5000;
        signatureValidityPeriod = DEFAULT_SIGNATURE_VALIDITY;

        /* ----------------------- Month / cap tracking ---------------------- */
        currentMonth = ts / SECONDS_PER_MONTH;
        lastMonthUpdate = ts;
        monthlyMintLimit = MONTHLY_MINT_LIMIT;
        currentMonthlyCap = MONTHLY_MINT_LIMIT;

        // Ensure month state is coherent at initialization time.
        _syncMonth();

        /* -------------------------- Initial mint --------------------------- */
        // Mint initial supply to Treasury (NOT deployer).
        _mintWithHardCap(treasury, initialSupply);
        unchecked {
            distributedTotal += initialSupply;
        }

        /* -------------------------- Default sources ------------------------ */
        _configureSource("fitbit", true, true);
        _configureSource("googlefit", true, true);
        _configureSource("applehealth", false, false);

        /* ------------------------- Version allowlists ---------------------- */
        // Payload version allowlist.
        bytes32 pv = keccak256(bytes(DEFAULT_PAYLOAD_VERSION)); // "1.0.0"
        supportedPayloadVersions[pv] = true;
        emit PayloadVersionAdded(DEFAULT_PAYLOAD_VERSION);

        // Attestation version allowlist.
        bytes32 av = keccak256(bytes(DEFAULT_PAYLOAD_VERSION)); // "1.0.0"
        supportedAttestationVersions[av] = true;
        emit AttestationVersionAdded(DEFAULT_PAYLOAD_VERSION);

        // Enforce nonce-bound attestations for the current attestation version by default.
        attestationRequiresNonce[av] = true;

        /* ----------------------- Anomaly configuration --------------------- */
        anomalyThreshold = ANOMALY_THRESHOLD;
    }

    /* =============================================================
                     SUPPLY SCHEDULE HELPERS (CORE)
       ============================================================= */

    /// @notice Checks whether a halving threshold has been reached and applies the next halving step.
    /// @dev
    ///  - Threshold uses the geometric series form:
    ///    threshold(h) = MAX_SUPPLY - (MAX_SUPPLY >> (h + 1))
    ///  - On each halving:
    ///      - monthly cap doubles
    ///      - reward rate halves
    ///  - Guards cap overflow defensively.
    function _checkHalving() internal virtual {
        if (halvingCount >= 63) return;

        uint256 threshold = MAX_SUPPLY - (MAX_SUPPLY >> (halvingCount + 1));
        if (distributedTotal < threshold) return;

        unchecked {
            halvingCount++;
        }

        uint256 oldCap = currentMonthlyCap;
        uint256 oldRate = rewardRate;

        // Cap doubles (defensive overflow guard).
        require(oldCap <= type(uint256).max / 2, "Monthly cap overflow");
        currentMonthlyCap = oldCap * 2;

        // Rate halves (dust floor).
        uint256 newRate = oldRate / 2;
        if (newRate == 0) newRate = 1;
        rewardRate = newRate;

        emit MonthlyCapUpdated(currentMonthlyCap, halvingCount);
        emit ParameterUpdated("rewardRate", oldRate, rewardRate);
    }

    /// @notice Returns the hard maximum supply (cap).
    function cap() public pure returns (uint256) {
        return MAX_SUPPLY;
    }

    /// @notice Synchronize month tracking (rollover if block timestamp enters a new month window).
    /// @dev Resets {currentMonthMinted} when month advances and emits rollover events.
    function _syncMonth() internal virtual {
        uint256 newMonth = block.timestamp / SECONDS_PER_MONTH;
        if (newMonth > currentMonth) {
            currentMonth = newMonth;
            currentMonthMinted = 0;
            lastMonthUpdate = block.timestamp;
            emit MonthAdvanced(newMonth);
            emit MonthRollover(newMonth, currentMonthlyCap);
        }
    }

    /* =============================================================
                           ERC20 OVERRIDES / HELPERS
       ============================================================= */

    /// @dev Enforce pause on all transfers/mints/burns via ERC20 {_update}.
    /// @notice This token does not implement fee-on-transfer; pausing blocks transfers.
    function _update(address from, address to, uint256 value)
        internal
        virtual
        override(ERC20Upgradeable)
    {
        require(!paused(), "Token transfers paused");
        super._update(from, to, value);
    }

    /// @dev Custom cap check to replace ERC20CappedUpgradeable (bytecode savings).
    /// @param account Recipient.
    /// @param amount Amount to mint.
    function _mintWithHardCap(address account, uint256 amount) internal virtual {
        require(totalSupply() + amount <= MAX_SUPPLY, "ERC20Capped: cap exceeded");
        _mint(account, amount);
    }

    /// @notice Burn tokens from the caller.
    /// @param amount Amount to burn.
    function burn(uint256 amount) public virtual {
        _burn(_msgSender(), amount);
    }

    /// @notice ERC165 interface support.
    function supportsInterface(bytes4 interfaceId)
        public
        view
        virtual
        override(AccessControlUpgradeable)
        returns (bool)
    {
        return
            interfaceId == type(IERC165Upgradeable).interfaceId ||
            super.supportsInterface(interfaceId);
    }

    /* =============================================================
                              PAUSE CONTROLS
       ============================================================= */

    /// @notice Pause token transfers and any functions guarded by {whenNotPaused}.
    /// @dev Requires {PAUSER_ROLE}.
    function pause() external virtual onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Unpause token transfers and any functions guarded by {whenNotPaused}.
    /// @dev Requires {PAUSER_ROLE}.
    function unpause() external virtual onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /* =============================================================
                             ETH RECEIVE / HELPERS
       ============================================================= */

    /// @notice Accept ETH transfers (e.g., for L2 retryables / refunds if used elsewhere).
    /// @dev Emits {ETHReceived}. Rejects zero-value transfers to reduce accidental noise.
    receive() external payable virtual {
        require(msg.value > 0, "No zero value");
        emit ETHReceived(msg.sender, msg.value);
    }

    /// @notice Checks whether a given source is configured as valid.
    /// @param source Source key.
    /// @return True if the source is enabled/valid.
    function isSourceValid(string calldata source) public view returns (bool) {
        return validSources[source];
    }

    /* =============================================================
                              OPTIONAL GETTERS
       ============================================================= */

    /// @notice Returns the configured price oracle as an interface.
    /// @dev Convenience helper; does not change storage layout.
    function _oracle() internal view returns (IPriceOracleV2) {
        return IPriceOracleV2(priceOracle);
    }
}
