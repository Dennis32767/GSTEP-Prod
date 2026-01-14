// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "../core/GemStepCore.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";

/* -------------------------------------------------------------------------- */
/*                           Arbitrum helper primitives                        */
/* -------------------------------------------------------------------------- */

/// @title AddressAliasHelper
/// @notice Minimal Arbitrum Nitro L1->L2 address alias helper.
/// @dev
///  - On Arbitrum Nitro, retryable/L1->L2 messages appear to originate on L2
///    from an "aliased" L2 address derived from the L1 sender:
///      aliased = address(uint160(l1) + OFFSET)
///  - Use this to authenticate that an L2 call originated from a specific L1 address.
library AddressAliasHelper {
    /// @dev Nitro aliasing offset constant.
    uint160 internal constant OFFSET = uint160(0x1111000000000000000000000000000000001111);

    /// @notice Convert an L1 address into its L2 aliased address.
    /// @param l1 The L1 address (unaliased).
    /// @return The corresponding aliased L2 address.
    function applyL1ToL2Alias(address l1) internal pure returns (address) {
        return address(uint160(l1) + OFFSET);
    }
}

/// @title IArbSys
/// @notice Interface for Arbitrum ArbSys precompile (L2->L1 message sender).
/// @dev Deployed at address(0x64) on Arbitrum chains.
interface IArbSys {
    /// @notice Send an L2->L1 transaction request.
/// @param to L1 target address.
/// @param data Calldata to execute on L1 (when redeemed).
/// @return A unique message id.
    function sendTxToL1(address to, bytes calldata data) external payable returns (uint256);
}

/* -------------------------------------------------------------------------- */
/*                            GS_EmergencyAndL2                                 */
/* -------------------------------------------------------------------------- */

/// @title GS_EmergencyAndL2
/// @notice Emergency withdrawal controls and Arbitrum L1<->L2 governance helpers.
/// @dev
///  Emergency:
///   - Emergency withdrawals are gated by {emergencyWithdrawEnabled} AND a time delay
///     {emergencyWithdrawUnlockTime} set when enabling.
///   - Withdrawals are restricted to approved recipients to reduce blast radius.
///
///  Cross-chain governance (L1 -> L2):
///   - L2 can accept privileged calls only if msg.sender equals the aliased address
///     of the configured {l1Governance}.
///
///  L2 -> L1 ping:
///   - Optional: emits an L2->L1 message via ArbSys (does not execute immediately on L1).
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

    /// @notice Configure the L1 governance address.
    /// @param _l1 The L1 governance address (unaliased).
    /// @dev
    ///  - One-time set: reverts if already set.
    ///  - Requires {DEFAULT_ADMIN_ROLE}.
    ///  - {l1Governance} is stored in {GemStepStorage} for upgrade stability.
    function setL1Governance(address _l1) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_l1 != address(0), "GS: L1 governance zero address");
        require(l1Governance == address(0), "GS: L1 governance already set");
        l1Governance = _l1;
        emit L1GovernanceSet(_l1);
    }

    /// @notice Restricts execution to calls that originated from configured L1 governance.
    /// @dev Authenticates via Arbitrum L1->L2 aliasing rule (Nitro).
    modifier onlyFromL1Governance() {
        require(l1Governance != address(0), "GS: L1 governance not set");
        require(
            msg.sender == AddressAliasHelper.applyL1ToL2Alias(l1Governance),
            "GS: not L1 governance"
        );
        _;
    }

    /// @notice L1-driven pause toggle on L2.
    /// @param paused_ True to pause; false to unpause.
    /// @dev
    ///  - Restricted by {onlyFromL1Governance}.
    ///  - Uses OZ Pausable state (same as role-based pause/unpause).
    ///  - Emits {L2PausedByL1}.
    function l2SetPause(bool paused_) external onlyFromL1Governance {
        if (paused_) _pause();
        else _unpause();
        emit L2PausedByL1(paused_);
    }

    /// @notice L1-driven critical parameter updates (example).
    /// @param newStepLimit New step limit.
    /// @param newRewardRate New reward rate.
    /// @dev
    ///  - Restricted by {onlyFromL1Governance}.
    ///  - Emits standard {ParameterUpdated} events plus {L2ParamsUpdatedByL1}.
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

    /// @notice Get configured L1 governance address.
    function getL1Governance() external view returns (address) {
        return l1Governance;
    }

    /// @notice Detailed L1 governance status helper for monitoring/debugging.
    /// @return configuredL1Governance The configured L1 governance address (unaliased).
    /// @return aliasedL1Governance The aliased L2 address derived from configured L1 governance.
    /// @return isL1GovernanceCall Whether msg.sender equals the aliased governance address.
    function getL1GovernanceStatus()
        external
        view
        returns (address configuredL1Governance, address aliasedL1Governance, bool isL1GovernanceCall)
    {
        configuredL1Governance = l1Governance;
        aliasedL1Governance = l1Governance != address(0)
            ? AddressAliasHelper.applyL1ToL2Alias(l1Governance)
            : address(0);
        isL1GovernanceCall = msg.sender == aliasedL1Governance;
    }

    /* =============================================================
                       L2 -> L1 OPTIONAL EMERGENCY PING
       ============================================================= */

    /// @dev ArbSys precompile (Arbitrum) for L2->L1 messaging.
    IArbSys internal constant ARBSYS =
        IArbSys(0x0000000000000000000000000000000000000064);

    /// @notice Send an L2->L1 message (ping) to an L1 target.
    /// @param l1Target The L1 target address.
    /// @param data Calldata to be executed on L1 upon redemption.
    /// @return id ArbSys message id.
    /// @dev
    ///  - Requires {EMERGENCY_ADMIN_ROLE}.
    ///  - This does not execute immediately on L1; it must be proven and redeemed later.
    ///  - Governance flows should primarily be L1->L2; keep this for alerts/pings.
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
    ///  - When enabling, sets unlock time = now + {EMERGENCY_DELAY}.
    ///  - When disabling, clears unlock time.
    function toggleEmergencyWithdraw(bool enabled) external onlyRole(EMERGENCY_ADMIN_ROLE) {
        emergencyWithdrawEnabled = enabled;

        if (enabled) {
            unchecked {
                emergencyWithdrawUnlockTime = block.timestamp + EMERGENCY_DELAY;
            }
        } else {
            emergencyWithdrawUnlockTime = 0;
        }

        emit EmergencyWithdrawEnabledChanged(enabled, emergencyWithdrawUnlockTime);
    }

    /// @notice Initialize Arbitrum-related parameters used by other modules (e.g., bridging).
    /// @param inbox Arbitrum Inbox address.
    /// @param validator L1 validator address.
    /// @dev Requires {DEFAULT_ADMIN_ROLE}.
    function initializeArbitrum(address inbox, address validator)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        require(inbox != address(0) && validator != address(0), "GS: bad Arbitrum params");
        arbitrumInbox = inbox;
        l1Validator = validator;
    }

    /// @notice Update gas parameters used for Arbitrum retryables (if applicable).
    /// @param maxGas Max gas.
    /// @param gasPriceBid Gas price bid.
    /// @param maxSubmissionCost Submission cost.
    /// @dev Requires {PARAMETER_ADMIN_ROLE}.
    function updateArbitrumGasParams(uint256 maxGas, uint256 gasPriceBid, uint256 maxSubmissionCost)
        external
        onlyRole(PARAMETER_ADMIN_ROLE)
    {
        arbMaxGas = maxGas;
        arbGasPriceBid = gasPriceBid;
        arbMaxSubmissionCost = maxSubmissionCost;
    }

    /// @notice Approve or revoke an emergency withdrawal recipient.
    /// @param recipient Recipient address.
    /// @param approved True to approve; false to revoke.
    /// @dev Requires {DEFAULT_ADMIN_ROLE}. Recipient cannot be zero or the token contract itself.
    function approveRecipient(address recipient, bool approved)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        require(recipient != address(0) && recipient != address(this), "GS: invalid recipient");
        approvedRecipients[recipient] = approved;
        emit RecipientApprovalChanged(recipient, approved);
    }

    /* =============================================================
                            EMERGENCY WITHDRAWALS
       ============================================================= */

    /// @notice Emergency withdraw GemStep tokens held by the contract to the caller (recipient must be approved).
    /// @param amount Amount of GemStep tokens to withdraw.
    /// @dev
    ///  - Requires {EMERGENCY_ADMIN_ROLE}.
    ///  - Requires emergency gate unlocked.
    ///  - Requires caller to be an approved recipient.
    function emergencyWithdraw(uint256 amount)
        external
        onlyRole(EMERGENCY_ADMIN_ROLE)
        nonReentrant
    {
        _requireEmergencyUnlocked();
        require(approvedRecipients[msg.sender], "GS: unauthorized recipient");

        _transfer(address(this), msg.sender, amount);
        emit EmergencyWithdraw(msg.sender, amount, totalSupply());
    }

    /// @notice Emergency withdraw any ERC20 token held by this contract.
    /// @param token ERC20 token interface.
    /// @param to Recipient address.
    /// @param amount Amount to transfer.
    /// @dev
    ///  - Requires {EMERGENCY_ADMIN_ROLE}.
    ///  - Requires emergency gate unlocked.
    ///  - Uses a minimal "safeTransfer" pattern to support non-standard ERC20s
    ///    that do not return a boolean.
    function emergencyWithdrawERC20(IERC20Upgradeable token, address to, uint256 amount)
        external
        onlyRole(EMERGENCY_ADMIN_ROLE)
        nonReentrant
    {
        _requireEmergencyUnlocked();
        require(to != address(0), "GS: invalid recipient");

        (bool ok, bytes memory ret) =
            address(token).call(abi.encodeWithSelector(token.transfer.selector, to, amount));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "GS: ERC20 transfer failed");

        emit EmergencyWithdrawERC20(address(token), to, amount);
    }

    /// @notice Emergency withdraw ETH held by this contract.
    /// @param to Recipient address.
    /// @param amount Amount of ETH to send.
    /// @dev
    ///  - Requires {EMERGENCY_ADMIN_ROLE}.
    ///  - Requires emergency gate unlocked.
    function emergencyWithdrawETH(address payable to, uint256 amount)
        external
        onlyRole(EMERGENCY_ADMIN_ROLE)
        nonReentrant
    {
        _requireEmergencyUnlocked();
        require(to != address(0), "GS: invalid recipient");

        (bool ok, ) = to.call{value: amount}("");
        require(ok, "GS: ETH transfer failed");

        emit EmergencyWithdrawETH(to, amount);
    }
}
