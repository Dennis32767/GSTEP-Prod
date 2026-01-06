// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/introspection/IERC165Upgradeable.sol";

import "../storage/GemStepStorage.sol";
import "../../token/interfaces/IPriceOracleV2.sol";

/// @notice Core contract wires OZ parents, init, and cross-cutting overrides.
/// IMPORTANT: declares abstract hooks implemented in modules to let initialize()
/// call into them without changing selectors or storage.
abstract contract GemStepCore is
    Initializable,
    ERC20Upgradeable,
    PausableUpgradeable,
    AccessControlUpgradeable,
    ReentrancyGuardUpgradeable,
    EIP712Upgradeable,
    GemStepStorage
{
    using SafeERC20Upgradeable for IERC20Upgradeable;
    using AddressUpgradeable for address payable;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    // ---- Abstract hooks implemented in modules ----
    function _configureSource(string memory source, bool requiresProof, bool requiresAttestation)
        internal virtual;

    // Exposed helper used by modules
    function _normalizeVersion(string memory v) internal pure virtual returns (string memory) {
        // Treat "1.0" as "1.0.0"
        if (keccak256(bytes(v)) == keccak256(bytes("1.0"))) {
            return "1.0.0";
        }
        return v;
    }

    // ====================== Initialization ====================== //
    function initialize(
        uint256 initialSupply,
        address admin,
        address _priceOracle
    ) public virtual initializer {
        require(admin != address(0), "Invalid admin address");
        require(initialSupply <= MAX_SUPPLY, "Initial supply exceeds max");
        require(_priceOracle != address(0), "Invalid price oracle");

        __ERC20_init("GemStep", "GST");
        __Pausable_init();
        __AccessControl_init();
        __ReentrancyGuard_init();
        __EIP712_init(DOMAIN_NAME, DOMAIN_VERSION);

        initialAdmin = admin;
        address deployer = msg.sender;
        arbEthBridge = payable(0x8315177aB297bA92A06054cE80a67Ed4DBd7ed3a);
        priceOracle = _priceOracle;

        // Dynamic staking defaults
        currentStakePerStep = MIN_STAKE_PER_STEP;
        stakeParamsLocked = false;
        uint256 ts = block.timestamp;
        lastStakeAdjustment = ts;

        // Roles
        _grantRole(DEFAULT_ADMIN_ROLE, deployer);
        _grantRole(PAUSER_ROLE, deployer);
        _grantRole(MINTER_ROLE, deployer);
        _grantRole(SIGNER_ROLE, deployer);
        _grantRole(EMERGENCY_ADMIN_ROLE, deployer);
        _grantRole(UPGRADER_ROLE, deployer);
        _grantRole(API_SIGNER_ROLE, deployer);

        burnFee = 1;
        rewardRate = REWARD_RATE_BASE;
        stepLimit = 5000;
        signatureValidityPeriod = DEFAULT_SIGNATURE_VALIDITY;

        currentMonth = ts / SECONDS_PER_MONTH;
        lastMonthUpdate = ts;
        monthlyMintLimit = MONTHLY_MINT_LIMIT;
        currentMonthlyCap = MONTHLY_MINT_LIMIT;
        _syncMonth();

        _mintWithHardCap(deployer, initialSupply);
        distributedTotal += initialSupply;

        // Default sources
        _configureSource("fitbit", true,  true);
        _configureSource("googlefit", true,  true);
        _configureSource("applehealth", false, false);

        // Version allowlists (normalized canonical)
        bytes32 pv = keccak256(bytes(DEFAULT_PAYLOAD_VERSION)); // "1.0.0"
        supportedPayloadVersions[pv] = true;
        emit PayloadVersionAdded(DEFAULT_PAYLOAD_VERSION);

        bytes32 av = keccak256(bytes(DEFAULT_PAYLOAD_VERSION)); // attestation "1.0.0"
        supportedAttestationVersions[av] = true;
        emit AttestationVersionAdded(DEFAULT_PAYLOAD_VERSION);

        // Enforce nonce-bound attestations for the current attestation version by default
        attestationRequiresNonce[av] = true;

        // Initialize tunable anomaly threshold
        anomalyThreshold = ANOMALY_THRESHOLD;
    }

    // === Supply schedule helpers (Core) ===
    function _checkHalving() internal {
        if (halvingCount < 63) {
            uint256 threshold = MAX_SUPPLY - (MAX_SUPPLY >> (halvingCount + 1));
            if (distributedTotal >= threshold) {
                unchecked { halvingCount++; }
                currentMonthlyCap = currentMonthlyCap / 2;
                emit MonthlyCapUpdated(currentMonthlyCap, halvingCount);
            }
        }
    }

    /// @notice Returns the maximum supply of tokens (from constant)
    function cap() public pure returns (uint256) {
        return MAX_SUPPLY;
    }

    function _syncMonth() internal {
        uint256 newMonth = block.timestamp / SECONDS_PER_MONTH;
        if (newMonth > currentMonth) {
            currentMonth = newMonth;
            currentMonthMinted = 0;
            lastMonthUpdate = block.timestamp;
            emit MonthAdvanced(newMonth);
            emit MonthRollover(newMonth, currentMonthlyCap);
        }
    }

    // ====================== ERC20 Overrides ====================== //
    function _update(address from, address to, uint256 value)
        internal
        virtual
        override(ERC20Upgradeable)
    {
        require(!paused(), "Token transfers paused");

        if (from != address(0) && to != address(0)) {
            uint256 fee = burnFee;
            if (fee > 0 && value > 0) {
                uint256 burnAmount = (value * fee) / PERCENTAGE_BASE;
                burnAmount = burnAmount == 0 ? 1 : burnAmount;
                require(burnAmount <= value, "Burn amount exceeds transfer value");
                super._update(from, address(0), burnAmount);
                unchecked { value -= burnAmount; }
            }
        }
        super._update(from, to, value);
    }

    // CUSTOM _mint FUNCTION to replace ERC20CappedUpgradeable:
    function _mintWithHardCap(address account, uint256 amount) internal {
        require(totalSupply() + amount <= MAX_SUPPLY, "ERC20Capped: cap exceeded");
        _mint(account, amount);
    }

    // BURN FUNCTION to replace ERC20BurnableUpgradeable
    function burn(uint256 amount) public virtual {
        _burn(_msgSender(), amount);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        virtual
        override(AccessControlUpgradeable)
        returns (bool)
    {
        return interfaceId == type(IERC165Upgradeable).interfaceId || super.supportsInterface(interfaceId);
    }

    // Hooks implemented by modules
    function _applyFraudPrevention(
        address user,
        uint256 steps,
        string calldata source
    ) internal view virtual;

    function _recordSubmissionAndAnomaly(
        address user,
        uint256 steps,
        string calldata source
    ) internal virtual;

    function _mintWithCap(address account, uint256 amount) internal virtual;

    // ====================== Pause & Receive ====================== //
    function pause() external virtual onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external virtual onlyRole(PAUSER_ROLE) { _unpause(); }

    receive() external payable virtual {
        require(msg.value > 0, "No zero value");
        emit ETHReceived(msg.sender, msg.value);
    }
    function isSourceValid(string calldata source) public view returns (bool) {
    return validSources[source];
}
}
