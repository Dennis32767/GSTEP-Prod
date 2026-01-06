// contracts/token/modules/GS_EmergencyAndL2.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "../core/GemStepCore.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";

/* -------------------------------------------------------------------------- */
/*                           Arbitrum helper primitives                        */
/* -------------------------------------------------------------------------- */

/**
 * @dev Minimal AddressAliasHelper (Nitro).
 * L1 -> L2 messages appear on L2 from the "aliased" address:
 * aliased = address(uint160(l1) + OFFSET).
 */
library AddressAliasHelper {
    uint160 internal constant OFFSET = uint160(0x1111000000000000000000000000000000001111);

    function applyL1ToL2Alias(address l1) internal pure returns (address) {
        return address(uint160(l1) + OFFSET);
    }
}

/**
 * @dev ArbSys precompile interface for L2 -> L1 sends.
 * Address: 0x0000000000000000000000000000000000000064 on Arbitrum.
 */
interface IArbSys {
    function sendTxToL1(address to, bytes calldata data) external payable returns (uint256);
}

/* -------------------------------------------------------------------------- */
/*                            GS_EmergencyAndL2 (merged)                       */
/* -------------------------------------------------------------------------- */

abstract contract GS_EmergencyAndL2 is GemStepCore {
    /* --------------------------- shared emergency gate --------------------------- */
    function _requireEmergencyUnlocked() internal view {
        require(emergencyWithdrawEnabled, "Emergency withdrawals disabled");
        require(block.timestamp >= emergencyWithdrawUnlockTime, "Emergency delay not passed");
    }

    /* ====================== CROSS-CHAIN GOVERNANCE (L1 -> L2) ===================== */

    /**
     * @notice Configure the L1 governance address. Call once post-deploy/upgrade.
     * @dev l1Governance storage is now in GemStepStorage for maximum stability
     */
    function setL1Governance(address _l1) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_l1 != address(0), "GS: L1 governance zero address");
        require(l1Governance == address(0), "GS: L1 governance already set");
        l1Governance = _l1;
        emit L1GovernanceSet(_l1);
    }

    /**
     * @dev Restrict to calls that originated from the configured L1 governance,
     * verified via Arbitrum L1->L2 aliasing rule.
     */
    modifier onlyFromL1Governance() {
        require(
            msg.sender == AddressAliasHelper.applyL1ToL2Alias(l1Governance),
            "GS: not L1 governance"
        );
        _;
    }

    /**
     * @notice L1-driven pause switch (does not override your role-based pause()).
     */
    function l2SetPause(bool paused) external onlyFromL1Governance {
        if (paused) _pause(); 
        else _unpause();
        emit L2PausedByL1(paused);
    }

    /**
     * @notice L1-driven critical parameter updates (example).
     */
    function l2UpdateParams(uint256 newStepLimit, uint256 newRewardRate)
        external
        onlyFromL1Governance
    {
        // Capture old values for event
        uint256 oldStepLimit = stepLimit;
        uint256 oldRewardRate = rewardRate;
        
        stepLimit = newStepLimit;
        rewardRate = newRewardRate;

        emit ParameterUpdated("stepLimit", oldStepLimit, newStepLimit);
        emit ParameterUpdated("rewardRate", oldRewardRate, newRewardRate);
        emit L2ParamsUpdatedByL1(newStepLimit, newRewardRate);
    }

    /**
     * @notice View helper for off-chain tooling.
     */
    function getL1Governance() external view returns (address) {
        return l1Governance;
    }

    /**
     * @notice Get detailed L1 governance status for debugging and monitoring.
     */
    function getL1GovernanceStatus() external view returns (
        address configuredL1Governance,
        address aliasedL1Governance,
        bool isL1GovernanceCall
    ) {
        configuredL1Governance = l1Governance;
        aliasedL1Governance = l1Governance != address(0) 
            ? AddressAliasHelper.applyL1ToL2Alias(l1Governance) 
            : address(0);
        isL1GovernanceCall = msg.sender == aliasedL1Governance;
    }

    /* =========================== L2 -> L1 EMERGENCY PING ========================== */

    IArbSys internal constant ARBSYS =
        IArbSys(0x0000000000000000000000000000000000000064);

    /**
     * @notice (Optional) Send an L2->L1 message, e.g. to notify/ping an L1 guardian.
     * @dev This does NOT execute on L1 immediately. It must be proven/executed later on L1.
     * Keep usage minimal; governance flow should primarily be L1->L2.
     */
    function emergencyPingL1(address l1Target, bytes calldata data)
        external
        onlyRole(EMERGENCY_ADMIN_ROLE)
        returns (uint256 id)
    {
        require(l1Target != address(0), "GS: bad L1 target");
        id = ARBSYS.sendTxToL1(l1Target, data);
        emit L2ToL1Tx(id, l1Target, data);
    }

    /* ================================ EXISTING OPS ================================ */

    /* --------------------------------- admin ops -------------------------------- */
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

    function approveRecipient(address recipient, bool approved)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        require(recipient != address(0) && recipient != address(this), "GS: invalid recipient");
        approvedRecipients[recipient] = approved;
        emit RecipientApprovalChanged(recipient, approved);
    }

    /* ------------------------------ emergency pulls ----------------------------- */
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

    function emergencyWithdrawERC20(IERC20Upgradeable token, address to, uint256 amount)
        external
        onlyRole(EMERGENCY_ADMIN_ROLE)
        nonReentrant
    {
        _requireEmergencyUnlocked();
        require(to != address(0), "GS: invalid recipient");
        // Minimal safeTransfer (handles non-standard ERC20s that return no bool)
        (bool ok, bytes memory ret) =
            address(token).call(abi.encodeWithSelector(token.transfer.selector, to, amount));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "GS: ERC20 transfer failed");
        emit EmergencyWithdrawERC20(address(token), to, amount);
    }

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