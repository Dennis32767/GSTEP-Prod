// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/*
 Minimal harness that stands in for GemStepCore so we can unit-test GS_EmergencyAndL2
 without importing your full production core. It provides:
 - ERC20-ish accounting (_transfer, totalSupply)
 - AccessControl-style roles
 - Pausable
 - ReentrancyGuard
 - Storage layout/vars and events referenced in GS_EmergencyAndL2
*/

contract MinimalAccess {
    mapping(bytes32 => mapping(address => bool)) internal _roles;

    bytes32 public constant DEFAULT_ADMIN_ROLE   = keccak256("DEFAULT_ADMIN_ROLE");
    bytes32 public constant PARAMETER_ADMIN_ROLE = keccak256("PARAMETER_ADMIN_ROLE");
    bytes32 public constant EMERGENCY_ADMIN_ROLE = keccak256("EMERGENCY_ADMIN_ROLE");

    modifier onlyRole(bytes32 role) {
        if (!_roles[role][msg.sender]) {
            revert("ACCESS: missing role");
        }
        _;
    }

    function _grantRole(bytes32 role, address a) internal {
        _roles[role][a] = true;
    }

    function grantRole(bytes32 role, address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _grantRole(role, account);
    }

    function hasRole(bytes32 role, address account) external view returns (bool) {
        return _roles[role][account];
    }
}

contract MinimalPausable {
    bool public paused;

    event Paused(address indexed account);
    event Unpaused(address indexed account);

    modifier whenNotPaused() {
        if (paused) {
            revert("Pausable: paused");
        }
        _;
    }

    function _pause() internal {
        paused = true;
        emit Paused(msg.sender);
    }

    function _unpause() internal {
        paused = false;
        emit Unpaused(msg.sender);
    }
}

contract MinimalReentrancyGuard {
    uint256 private _guard = 1;
    modifier nonReentrant() {
        if (_guard != 1) {
            revert("REENTRANT");
        }
        _guard = 2;
        _;
        _guard = 1;
    }
}

interface IERC20Like {
    function transfer(address to, uint256 amount) external returns (bool);
}

library AddressAliasHelperHarness {
    uint160 internal constant OFFSET = uint160(0x1111000000000000000000000000000000001111);
    function applyL1ToL2Alias(address l1) internal pure returns (address) {
        return address(uint160(l1) + OFFSET);
    }
}

abstract contract GemStepCoreHarness is MinimalAccess, MinimalPausable, MinimalReentrancyGuard {
    // --- Storage mirrored from your module expectations ---
    address public l1Governance;

    // Example params manipulated by l2UpdateParams
    uint256 public stepLimit;
    uint256 public rewardRate;

    // Emergency withdraw settings
    bool public emergencyWithdrawEnabled;
    uint256 public emergencyWithdrawUnlockTime;
    uint256 public constant EMERGENCY_DELAY = 3600; // 1 hour for tests

    // Arbitrum config
    address public arbitrumInbox;
    address public l1Validator;
    uint256 public arbMaxGas;
    uint256 public arbGasPriceBid;
    uint256 public arbMaxSubmissionCost;

    // Approved recipients for emergency pull
    mapping(address => bool) public approvedRecipients;

    // --- Minimal ERC20-like accounting so _transfer & totalSupply exist ---
    mapping(address => uint256) internal _balances;
    uint256 internal _totalSupply;
    
    // staking-only pause flag (mirrors GemStepStorage)
    bool public stakingPaused;

    // emitted by staking pause toggles (mirrors GemStepStorage)
    event StakingPauseSet(bool paused);

    function totalSupply() public view returns (uint256) { return _totalSupply; }
    function balanceOf(address a) public view returns (uint256) { return _balances[a]; }

    function mint(address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _balances[to] += amount;
        _totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function _transfer(address from, address to, uint256 amount) internal {
        if (to == address(0)) {
            revert("TRANSFER: zero to");
        }
        if (_balances[from] < amount) {
            revert("TRANSFER: balance");
        }
        unchecked {
            _balances[from] -= amount;
            _balances[to] += amount;
        }
        emit Transfer(from, to, amount);
    }

    // --- Events your module emits / expects (names/args match your code) ---
    event L1GovernanceSet(address indexed l1);
    event L2PausedByL1(bool paused);
    event ParameterUpdated(string key, uint256 oldVal, uint256 newVal);
    event L2ParamsUpdatedByL1(uint256 newStepLimit, uint256 newRewardRate);
    event L2ToL1Tx(uint256 indexed id, address indexed target, bytes data);

    event EmergencyWithdrawEnabledChanged(bool enabled, uint256 unlockTime);
    event RecipientApprovalChanged(address indexed recipient, bool approved);
    event EmergencyWithdraw(address indexed to, uint256 amount, uint256 newTotalSupply);
    event EmergencyWithdrawERC20(address indexed token, address indexed to, uint256 amount);
    event EmergencyWithdrawETH(address indexed to, uint256 amount);

    event Transfer(address indexed from, address indexed to, uint256 amount);
}

/* -------------------------------------------------------------------------- */
/*                     Drop-in copy of your GS_EmergencyAndL2                 */
/*        with `import "../core/GemStepCore.sol";` swapped for harness      */
/* -------------------------------------------------------------------------- */

interface IArbSysHarness {
    function sendTxToL1(address to, bytes calldata data) external payable returns (uint256);
}

// Mock ArbSys implementation for testing
contract MockArbSys {
    uint256 public txCounter = 0;
    
    function sendTxToL1(address /* to */, bytes calldata /* data */) external payable returns (uint256) {
        txCounter++;
        return txCounter; // Return the current counter as the tx ID
    }
}

abstract contract GS_EmergencyAndL2_H is GemStepCoreHarness {
    /* --------------------------- shared emergency gate --------------------------- */
    function _requireEmergencyUnlocked() internal view {
        if (!emergencyWithdrawEnabled) {
            revert("Emergency withdrawals disabled");
        }
        if (block.timestamp < emergencyWithdrawUnlockTime) {
            revert("Emergency delay not passed");
        }
    }

    /* ====================== CROSS-CHAIN GOVERNANCE (L1 -> L2) ===================== */

    function setL1Governance(address _l1) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_l1 == address(0)) {
            revert("GS: L1 governance zero address");
        }
        if (l1Governance != address(0)) {
            revert("GS: L1 governance already set");
        }
        l1Governance = _l1;
        emit L1GovernanceSet(_l1);
    }

    modifier onlyFromL1Governance() {
        if (msg.sender != AddressAliasHelperHarness.applyL1ToL2Alias(l1Governance)) {
            revert("GS: not L1 governance");
        }
        _;
    }

    function l2SetPause(bool p) external onlyFromL1Governance {
        if (p) _pause(); else _unpause();
        emit L2PausedByL1(p);
    }

    function l2UpdateParams(uint256 newStepLimit, uint256 newRewardRate)
        external
        onlyFromL1Governance
    {
        uint256 oldStepLimit = stepLimit;
        uint256 oldRewardRate = rewardRate;
        stepLimit = newStepLimit;
        rewardRate = newRewardRate;
        emit ParameterUpdated("stepLimit", oldStepLimit, newStepLimit);
        emit ParameterUpdated("rewardRate", oldRewardRate, newRewardRate);
        emit L2ParamsUpdatedByL1(newStepLimit, newRewardRate);
    }

    function getL1Governance() external view returns (address) { return l1Governance; }

    function getL1GovernanceStatus() external view returns (
        address configuredL1Governance,
        address aliasedL1Governance,
        bool isL1GovernanceCall
    ) {
        configuredL1Governance = l1Governance;
        aliasedL1Governance = l1Governance != address(0)
            ? AddressAliasHelperHarness.applyL1ToL2Alias(l1Governance)
            : address(0);
        isL1GovernanceCall = msg.sender == aliasedL1Governance;
    }

    IArbSysHarness public arbSys;

    function setArbSys(address _arbSys) external onlyRole(DEFAULT_ADMIN_ROLE) {
        arbSys = IArbSysHarness(_arbSys);
    }

    function emergencyPingL1(address l1Target, bytes calldata data)
        external
        onlyRole(EMERGENCY_ADMIN_ROLE)
        returns (uint256 id)
    {
        if (l1Target == address(0)) {
            revert("GS: bad L1 target");
        }
        id = arbSys.sendTxToL1(l1Target, data);
        emit L2ToL1Tx(id, l1Target, data);
    }

    function toggleEmergencyWithdraw(bool enabled) external onlyRole(EMERGENCY_ADMIN_ROLE) {
        emergencyWithdrawEnabled = enabled;
        if (enabled) {
            unchecked { emergencyWithdrawUnlockTime = block.timestamp + EMERGENCY_DELAY; }
        } else {
            emergencyWithdrawUnlockTime = 0;
        }
        emit EmergencyWithdrawEnabledChanged(enabled, emergencyWithdrawUnlockTime);
    }

    function initializeArbitrum(address inbox, address validator)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (inbox == address(0) || validator == address(0)) {
            revert("GS: bad Arbitrum params");
        }
        arbitrumInbox = inbox;
        l1Validator = validator;
    }

    function updateArbitrumGasParams(uint256 maxGas, uint256 gasPriceBid, uint256 maxSubmissionCost)
        external
        onlyRole(PARAMETER_ADMIN_ROLE)
    {
        arbMaxGas = maxGas;
        arbGasPriceBid = gasPriceBid;
        arbMaxSubmissionCost = maxSubmissionCost;
    }

    function approveRecipient(address recipient, bool approved)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (recipient == address(0) || recipient == address(this)) {
            revert("GS: invalid recipient");
        }
        approvedRecipients[recipient] = approved;
        emit RecipientApprovalChanged(recipient, approved);
    }

    function emergencyWithdraw(uint256 amount)
        external
        onlyRole(EMERGENCY_ADMIN_ROLE)
        nonReentrant
    {
        _requireEmergencyUnlocked();
        if (!approvedRecipients[msg.sender]) {
            revert("GS: unauthorized recipient");
        }
        _transfer(address(this), msg.sender, amount);
        emit EmergencyWithdraw(msg.sender, amount, totalSupply());
    }

    function emergencyWithdrawERC20(IERC20Like token, address to, uint256 amount)
        external
        onlyRole(EMERGENCY_ADMIN_ROLE)
        nonReentrant
    {
        _requireEmergencyUnlocked();
        if (to == address(0)) {
            revert("GS: invalid recipient");
        }
        (bool ok, bytes memory ret) =
            address(token).call(abi.encodeWithSelector(token.transfer.selector, to, amount));
        if (!ok || (ret.length > 0 && !abi.decode(ret, (bool)))) {
            revert("GS: ERC20 transfer failed");
        }
        emit EmergencyWithdrawERC20(address(token), to, amount);
    }

    function emergencyWithdrawETH(address payable to, uint256 amount)
        external
        onlyRole(EMERGENCY_ADMIN_ROLE)
        nonReentrant
    {
        _requireEmergencyUnlocked();
        if (to == address(0)) {
            revert("GS: invalid recipient");
        }
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) {
            revert("GS: ETH transfer failed");
        }
        emit EmergencyWithdrawETH(to, amount);
    }
}

contract GS_EmergencyAndL2_TestHarness is GS_EmergencyAndL2_H {
    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PARAMETER_ADMIN_ROLE, admin);
        _grantRole(EMERGENCY_ADMIN_ROLE, admin);

        // Seed contract with tokens so emergencyWithdraw can pull from address(this)
        _balances[address(this)] = 1_000_000 ether;
        _totalSupply = 1_000_000 ether;
    }

    // Test helper to simulate calls as the aliased L1 governance
    function exposedAlias(address l1) external pure returns (address) {
        return AddressAliasHelperHarness.applyL1ToL2Alias(l1);
    }
    /* =============================================================
                     WRAPPERS FOR STAKING-PAUSE TESTS
       ============================================================= */

    function isStakingPaused() external view returns (bool) {
        return stakingPaused;
    }

    function l2SetStakingPause(bool paused_) external onlyFromL1Governance {
        stakingPaused = paused_;
        emit StakingPauseSet(paused_);
    }

    function emergencySetStakingPaused(bool paused_) external onlyRole(EMERGENCY_ADMIN_ROLE) {
        stakingPaused = paused_;
        emit StakingPauseSet(paused_);
    }

    receive() external payable {}
    
}
