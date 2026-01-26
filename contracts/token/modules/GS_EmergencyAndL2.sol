// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "../core/GemStepCore.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";

/* -------------------------------------------------------------------------- */
/*                           Arbitrum helper primitives                        */
/* -------------------------------------------------------------------------- */

/// @title AddressAliasHelper
/// @notice Minimal Arbitrum Nitro L1->L2 address alias helper.
library AddressAliasHelper {
    uint160 internal constant OFFSET = uint160(0x1111000000000000000000000000000000001111);

    function applyL1ToL2Alias(address l1) internal pure returns (address) {
        return address(uint160(l1) + OFFSET);
    }
}

/// @title IArbSys
/// @notice Interface for Arbitrum ArbSys precompile (L2->L1 message sender).
interface IArbSys {
    function sendTxToL1(address to, bytes calldata data) external payable returns (uint256);
}

/* -------------------------------------------------------------------------- */
/*                            GS_EmergencyAndL2                                */
/* -------------------------------------------------------------------------- */

/// @title GS_EmergencyAndL2
/// @notice Emergency withdrawal controls and Arbitrum L1<->L2 governance helpers.
/// @dev
///  Changes in this drop-in:
///   (1) Documented ops playbook: emergencyWithdraw requires NOT paused (since _transfer hits _update()).
///   (2) toggleEmergencyWithdraw(true) only sets unlock time on the transition false->true.
///   (3) emergencyWithdraw uses "graceful" free-balance computation (no hard revert if invariant breaks).
///   (4) emergencyWithdrawERC20 / emergencyWithdrawETH require approvedRecipients[to].
abstract contract GS_EmergencyAndL2 is GemStepCore {
    /* =============================================================
                         EMERGENCY WITHDRAW GATE
       ============================================================= */

    /// @notice Reverts unless emergency withdrawals are enabled and delay has elapsed.
    /// @dev Shared internal guard for all emergency withdraw functions.
    function _requireEmergencyUnlocked() internal view {
        require(emergencyWithdrawEnabled, "Emergency withdrawals disabled");
        require(block.timestamp >= emergencyWithdrawUnlockTime, "Emergency delay not passed");
    }

    /* =============================================================
                    CROSS-CHAIN GOVERNANCE (L1 -> L2)
       ============================================================= */

    function setL1Governance(address _l1) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_l1 != address(0), "GS: L1 governance zero address");
        require(l1Governance == address(0), "GS: L1 governance already set");
        l1Governance = _l1;
        emit L1GovernanceSet(_l1);
    }

    modifier onlyFromL1Governance() {
        require(l1Governance != address(0), "GS: L1 governance not set");
        require(msg.sender == AddressAliasHelper.applyL1ToL2Alias(l1Governance), "GS: not L1 governance");
        _;
    }

    function l2SetPause(bool paused_) external onlyFromL1Governance {
        if (paused_) _pause();
        else _unpause();
        emit L2PausedByL1(paused_);
    }

    function l2SetStakingPause(bool paused_) external onlyFromL1Governance {
        stakingPaused = paused_;
        emit StakingPauseSet(paused_);
    }

    function setStakingPaused(bool paused_) external onlyRole(EMERGENCY_ADMIN_ROLE) {
        stakingPaused = paused_;
        emit StakingPauseSet(paused_);
    }

    function l2UpdateParams(uint256 newStepLimit, uint256 newRewardRate) external onlyFromL1Governance {
        uint256 oldStepLimit = stepLimit;
        uint256 oldRewardRate = rewardRate;

        stepLimit = newStepLimit;
        rewardRate = newRewardRate;

        emit ParameterUpdated("stepLimit", oldStepLimit, newStepLimit);
        emit ParameterUpdated("rewardRate", oldRewardRate, newRewardRate);
        emit L2ParamsUpdatedByL1(newStepLimit, newRewardRate);
    }

    function getL1Governance() external view returns (address) {
        return l1Governance;
    }

    function getL1GovernanceStatus()
        external
        view
        returns (address configuredL1Governance, address aliasedL1Governance, bool isL1GovernanceCall)
    {
        configuredL1Governance = l1Governance;
        aliasedL1Governance =
            l1Governance != address(0) ? AddressAliasHelper.applyL1ToL2Alias(l1Governance) : address(0);
        isL1GovernanceCall = msg.sender == aliasedL1Governance;
    }

    /* =============================================================
                       L2 -> L1 OPTIONAL EMERGENCY PING
       ============================================================= */

    IArbSys internal constant ARBSYS = IArbSys(0x0000000000000000000000000000000000000064);

    function emergencyPingL1(address l1Target, bytes calldata data)
        external
        onlyRole(EMERGENCY_ADMIN_ROLE)
        returns (uint256 id)
    {
        require(l1Target != address(0), "GS: bad L1 target");
        id = ARBSYS.sendTxToL1(l1Target, data);
        emit L2ToL1Tx(id, l1Target, data);
    }

    /* =============================================================
                              EXISTING OPERATIONS
       ============================================================= */

    /// @notice Enable/disable emergency withdrawals with a delay when enabling.
    /// @param enabled True to enable; false to disable.
    /// @dev
    ///  - Requires {EMERGENCY_ADMIN_ROLE}.
    ///  - When enabling, sets unlock time = now + {EMERGENCY_DELAY} ONLY on the transition false->true.
    ///  - When disabling, clears unlock time.
    ///
    ///  OPS PLAYBOOK (IMPORTANT):
    ///  - emergencyWithdraw() uses _transfer(), which is blocked while the token is paused (core _update()).
    ///  - Therefore: **unpause → emergencyWithdraw → re-pause** (if you intend to pause during incident response).
    function toggleEmergencyWithdraw(bool enabled) external onlyRole(EMERGENCY_ADMIN_ROLE) {
        if (enabled) {
            // Only set unlock time the first time we enable (avoid "reset the clock" footgun).
            if (!emergencyWithdrawEnabled) {
                emergencyWithdrawEnabled = true;
                unchecked {
                    emergencyWithdrawUnlockTime = block.timestamp + EMERGENCY_DELAY;
                }
            }
        } else {
            emergencyWithdrawEnabled = false;
            emergencyWithdrawUnlockTime = 0;
        }

        emit EmergencyWithdrawEnabledChanged(emergencyWithdrawEnabled, emergencyWithdrawUnlockTime);
    }

    function initializeArbitrum(address inbox, address validator) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(inbox != address(0) && validator != address(0), "GS: bad Arbitrum params");
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

    function approveRecipient(address recipient, bool approved) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(recipient != address(0) && recipient != address(this), "GS: invalid recipient");
        approvedRecipients[recipient] = approved;
        emit RecipientApprovalChanged(recipient, approved);
    }

    /* =============================================================
                            EMERGENCY WITHDRAWALS
       ============================================================= */

    /// @notice Emergency withdraw GemStep tokens held by the contract to the caller.
    /// @param amount Amount of GemStep tokens to withdraw.
    /// @dev
    ///  - Requires {EMERGENCY_ADMIN_ROLE}.
    ///  - Requires emergency gate unlocked.
    ///  - Requires caller to be an approved recipient.
    ///  - Does not allow withdrawal of staked user funds; only free balance.
    ///
    ///  NOTE: This uses _transfer() and will revert if the token is paused.
    function emergencyWithdraw(uint256 amount) external onlyRole(EMERGENCY_ADMIN_ROLE) nonReentrant {
        _requireEmergencyUnlocked();
        require(approvedRecipients[msg.sender], "GS: unauthorized recipient");

        uint256 bal = balanceOf(address(this));

        // Graceful invariant handling (do not brick emergency ops if accounting breaks):
        uint256 free = bal > totalStaked ? (bal - totalStaked) : 0;
        require(amount <= free, "GS: exceeds free balance");

        _transfer(address(this), msg.sender, amount);
        emit EmergencyWithdraw(msg.sender, amount, totalSupply());
    }

    /// @notice Emergency withdraw any ERC20 token held by this contract.
    /// @param token ERC20 token interface.
    /// @param to Recipient address (MUST be approved).
    /// @param amount Amount to transfer.
    function emergencyWithdrawERC20(IERC20Upgradeable token, address to, uint256 amount)
        external
        onlyRole(EMERGENCY_ADMIN_ROLE)
        nonReentrant
    {
        _requireEmergencyUnlocked();
        require(to != address(0), "GS: invalid recipient");
        require(approvedRecipients[to], "GS: unauthorized recipient");

        (bool ok, bytes memory ret) =
            address(token).call(abi.encodeWithSelector(token.transfer.selector, to, amount));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "GS: ERC20 transfer failed");

        emit EmergencyWithdrawERC20(address(token), to, amount);
    }

    /// @notice Emergency withdraw ETH held by this contract.
    /// @param to Recipient address (MUST be approved).
    /// @param amount Amount of ETH to send.
    function emergencyWithdrawETH(address payable to, uint256 amount)
        external
        onlyRole(EMERGENCY_ADMIN_ROLE)
        nonReentrant
    {
        _requireEmergencyUnlocked();
        require(to != address(0), "GS: invalid recipient");
        require(approvedRecipients[to], "GS: unauthorized recipient");

        (bool ok, ) = to.call{value: amount}("");
        require(ok, "GS: ETH transfer failed");

        emit EmergencyWithdrawETH(to, amount);
    }
}
