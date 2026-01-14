// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/**
 * @title CrossChainGovernanceL1
 * @notice L1 governance sender for Arbitrum (Nitro). Creates retryable tickets to a configured L2 target
 *         (e.g., UpgradeExecutor / Token / Timelock). Designed to be owned by a Timelock on L1.
 *
 * @dev Key features
 *  - Ownable2Step: safe ownership handoff to a Timelock (or other governance owner)
 *  - Configurable Inbox, L2 target, refund L2 address, and gas params
 *  - Quoting helper so off-chain scripts can ensure msg.value suffices
 *  - Convenience wrappers for common L2 admin ops (pause/unpause/setL1Governance)
 *
 * @dev Notes on Arbitrum retryables
 *  - L1 sends create retryable tickets through the Arbitrum Inbox contract.
 *  - The funded value is: l2CallValue + maxSubmissionCost + (gasLimit * maxFeePerGas).
 *  - Retryable execution on L2 is not immediate; it must be executed/redeemed on L2.
 */

/* -------------------------------------------------------------------------- */
/*                                   Interfaces                               */
/* -------------------------------------------------------------------------- */

/// @notice Minimal Arbitrum Inbox interface for retryable tickets.
interface IInbox {
    /// @notice Create a retryable ticket to an L2 destination.
    /// @param to L2 target address.
    /// @param l2CallValue ETH (wei) forwarded to the L2 target.
    /// @param maxSubmissionCost Submission fee cap (wei).
    /// @param excessFeeRefundAddress L2 address that receives excess fee refunds.
    /// @param callValueRefundAddress L2 address that receives callvalue refunds if retryable is cancelled/expired.
    /// @param gasLimit L2 execution gas limit.
    /// @param maxFeePerGas L2 max fee per gas (wei).
    /// @param data Calldata to call on L2.
    /// @return The retryable ticket id.
    function createRetryableTicket(
        address to,
        uint256 l2CallValue,
        uint256 maxSubmissionCost,
        address excessFeeRefundAddress,
        address callValueRefundAddress,
        uint256 gasLimit,
        uint256 maxFeePerGas,
        bytes calldata data
    ) external payable returns (uint256);

    /// @notice Calculate submission fee for a retryable.
    /// @param dataLength Calldata length in bytes.
    /// @param baseFee L1 base fee.
    /// @return Required submission fee.
    function calculateRetryableSubmissionFee(uint256 dataLength, uint256 baseFee)
        external
        view
        returns (uint256);
}

/// @notice Minimal ERC20 interface for rescue operations.
interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
}

/* -------------------------------------------------------------------------- */
/*                         Ownable2Step (lightweight, local)                  */
/* -------------------------------------------------------------------------- */

/// @title Ownable2Step
/// @notice Lightweight two-step ownership transfer.
/// @dev
///  - `transferOwnership(newOwner)` sets a pending owner.
///  - `acceptOwnership()` must be called by pending owner to finalize.
abstract contract Ownable2Step {
    address private _owner;
    address private _pendingOwner;

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error NotPendingOwner();
    error ZeroAddress();

    /// @param initialOwner_ Initial contract owner.
    constructor(address initialOwner_) {
        if (initialOwner_ == address(0)) revert ZeroAddress();
        _owner = initialOwner_;
        emit OwnershipTransferred(address(0), initialOwner_);
    }

    /// @notice Restrict function to owner.
    modifier onlyOwner() {
        if (msg.sender != _owner) revert NotOwner();
        _;
    }

    /// @notice Current owner.
    function owner() public view returns (address) {
        return _owner;
    }

    /// @notice Pending owner who can accept ownership.
    function pendingOwner() public view returns (address) {
        return _pendingOwner;
    }

    /// @notice Initiate ownership transfer (two-step).
    /// @param newOwner The address to become pending owner.
    function transferOwnership(address newOwner) public onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        _pendingOwner = newOwner;
        emit OwnershipTransferStarted(_owner, newOwner);
    }

    /// @notice Finalize ownership transfer.
    /// @dev Must be called by pending owner.
    function acceptOwnership() public {
        if (msg.sender != _pendingOwner) revert NotPendingOwner();
        address prev = _owner;
        _owner = _pendingOwner;
        _pendingOwner = address(0);
        emit OwnershipTransferred(prev, _owner);
    }
}

/* -------------------------------------------------------------------------- */
/*                              Main Contract                                 */
/* -------------------------------------------------------------------------- */

/// @title CrossChainGovernanceL1
/// @notice Creates Arbitrum retryable tickets to a configured L2 target under L1 ownership/governance.
/// @dev Intended owner: an L1 Timelock or DAO executor.
contract CrossChainGovernanceL1 is Ownable2Step {
    /*//////////////////////////////////////////////////////////////
                                Errors
    //////////////////////////////////////////////////////////////*/

    /// @dev Inbox must be configured before sending.
    error InboxNotSet();

    /// @dev L2 target must be configured before sending.
    error L2TargetNotSet();

    /// @dev Refund L2 address must be configured before sending.
    error RefundL2NotSet();

    /// @dev msg.value insufficient for retryable funding.
    error MsgValueTooLow(uint256 needed, uint256 provided);

    /*//////////////////////////////////////////////////////////////
                                Events
    //////////////////////////////////////////////////////////////*/

    event InboxUpdated(address indexed inbox);
    event L2TargetUpdated(address indexed target);
    event RefundL2Updated(address indexed refundL2);
    event GasConfigUpdated(uint256 maxSubmissionCost, uint256 gasLimit, uint256 maxFeePerGas);

    event RetryableSent(
        uint256 indexed ticketId,
        address indexed to,
        uint256 l2CallValue,
        uint256 maxSubmissionCost,
        uint256 gasLimit,
        uint256 maxFeePerGas,
        bytes data
    );

    /*//////////////////////////////////////////////////////////////
                                Storage
    //////////////////////////////////////////////////////////////*/

    /// @notice L1 Arbitrum Inbox.
    IInbox public inbox;

    /// @notice L2 destination (executor/token/timelock).
    address public l2Target;

    /// @notice L2 refund address for excess fees and callvalue refunds.
    address public refundL2;

    /// @notice Gas configuration used for retryables.
    struct GasConfig {
        /// @dev Submission fee cap (wei).
        uint256 maxSubmissionCost;
        /// @dev L2 execution gas.
        uint256 gasLimit;
        /// @dev L2 max fee per gas (wei).
        uint256 maxFeePerGas;
    }

    /// @notice Current gas configuration.
    GasConfig public gasConfig;

    /*//////////////////////////////////////////////////////////////
                              Constructor
    //////////////////////////////////////////////////////////////*/

    /// @param initialOwner Initial owner (ideally an L1 Timelock).
    /// @param inbox_ L1 Arbitrum Inbox address.
    /// @param l2Target_ L2 destination contract.
    /// @param refundL2_ L2 refund address.
    /// @param cfg Initial gas configuration.
    constructor(
        address initialOwner,
        address inbox_,
        address l2Target_,
        address refundL2_,
        GasConfig memory cfg
    ) Ownable2Step(initialOwner) {
        _setInbox(inbox_);
        _setL2Target(l2Target_);
        _setRefundL2(refundL2_);
        _setGasConfig(cfg.maxSubmissionCost, cfg.gasLimit, cfg.maxFeePerGas);
    }

    /*//////////////////////////////////////////////////////////////
                           Admin configuration
    //////////////////////////////////////////////////////////////*/

    /// @notice Set the Arbitrum Inbox address.
    /// @param inbox_ New inbox address.
    function setInbox(address inbox_) external onlyOwner {
        _setInbox(inbox_);
    }

    /// @notice Set the L2 target destination.
    /// @param target_ New L2 target.
    function setL2Target(address target_) external onlyOwner {
        _setL2Target(target_);
    }

    /// @notice Set the refund L2 address.
    /// @param refundL2_ New refund L2 address.
    function setRefundL2(address refundL2_) external onlyOwner {
        _setRefundL2(refundL2_);
    }

    /// @notice Set gas configuration for retryables.
    /// @param maxSubmissionCost Submission fee cap.
    /// @param gasLimit L2 execution gas limit.
    /// @param maxFeePerGas L2 max fee per gas.
    function setGasConfig(uint256 maxSubmissionCost, uint256 gasLimit, uint256 maxFeePerGas)
        external
        onlyOwner
    {
        _setGasConfig(maxSubmissionCost, gasLimit, maxFeePerGas);
    }

    /// @dev Internal setter with zero address protection.
    function _setInbox(address inbox_) internal {
        if (inbox_ == address(0)) revert ZeroAddress();
        inbox = IInbox(inbox_);
        emit InboxUpdated(inbox_);
    }

    /// @dev Internal setter with zero address protection.
    function _setL2Target(address target_) internal {
        if (target_ == address(0)) revert ZeroAddress();
        l2Target = target_;
        emit L2TargetUpdated(target_);
    }

    /// @dev Internal setter with zero address protection.
    function _setRefundL2(address refundL2_) internal {
        if (refundL2_ == address(0)) revert ZeroAddress();
        refundL2 = refundL2_;
        emit RefundL2Updated(refundL2_);
    }

    /// @dev Internal setter for gas config.
    function _setGasConfig(uint256 maxSubmissionCost, uint256 gasLimit, uint256 maxFeePerGas) internal {
        gasConfig = GasConfig(maxSubmissionCost, gasLimit, maxFeePerGas);
        emit GasConfigUpdated(maxSubmissionCost, gasLimit, maxFeePerGas);
    }

    /*//////////////////////////////////////////////////////////////
                         Quoting helper (view)
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Quote total msg.value required for a retryable given current gasConfig.
     * @param l2CallValue ETH (wei) forwarded to L2 target (typically 0).
     * @return total Total amount required: l2CallValue + maxSubmissionCost + gasLimit*maxFeePerGas.
     * @return submissionFee The funded submission fee cap (maxSubmissionCost).
     * @return gasFee The funded L2 execution gas fee (gasLimit*maxFeePerGas).
     *
     * @dev
     *  - This uses the stored `gasConfig.maxSubmissionCost` as the funded submission fee cap.
     *  - Off-chain tooling that wants the *minimum* submission fee can call
     *    {IInbox.calculateRetryableSubmissionFee} directly using data length and L1 baseFee.
     */
    function quoteRetryable(bytes calldata /* data */, uint256 l2CallValue)
        external
        view
        returns (uint256 total, uint256 submissionFee, uint256 gasFee)
    {
        if (address(inbox) == address(0)) revert InboxNotSet();

        submissionFee = gasConfig.maxSubmissionCost;
        unchecked {
            gasFee = gasConfig.gasLimit * gasConfig.maxFeePerGas;
            total = l2CallValue + submissionFee + gasFee;
        }
    }

    /*//////////////////////////////////////////////////////////////
                        Core: create retryable
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Create a retryable ticket to the configured L2 target using current gasConfig.
     * @param data Calldata for the L2 target.
     * @param l2CallValue ETH (wei) forwarded to the L2 target (typically 0).
     * @return ticketId Retryable ticket id.
     *
     * @dev
     *  - Accepts `bytes memory` so internal wrappers can pass `abi.encodeWithSignature(...)`
     *    without calldata/memory friction.
     *  - Requires msg.value >= l2CallValue + maxSubmissionCost + gasLimit*maxFeePerGas.
     */
    function sendRetryable(bytes memory data, uint256 l2CallValue)
        public
        payable
        onlyOwner
        returns (uint256 ticketId)
    {
        if (address(inbox) == address(0)) revert InboxNotSet();
        if (l2Target == address(0)) revert L2TargetNotSet();
        if (refundL2 == address(0)) revert RefundL2NotSet();

        uint256 required;
        unchecked {
            required =
                l2CallValue +
                gasConfig.maxSubmissionCost +
                (gasConfig.gasLimit * gasConfig.maxFeePerGas);
        }
        if (msg.value < required) revert MsgValueTooLow(required, msg.value);

        ticketId = inbox.createRetryableTicket{value: msg.value}(
            l2Target,
            l2CallValue,
            gasConfig.maxSubmissionCost,
            refundL2,
            refundL2,
            gasConfig.gasLimit,
            gasConfig.maxFeePerGas,
            data
        );

        emit RetryableSent(
            ticketId,
            l2Target,
            l2CallValue,
            gasConfig.maxSubmissionCost,
            gasConfig.gasLimit,
            gasConfig.maxFeePerGas,
            data
        );
    }

    /**
     * @notice Generic L2 call passthrough (no ETH forwarded to target).
     * @param targetCalldata Calldata to call on L2 target.
     * @return ticketId Retryable ticket id.
     */
    function callL2(bytes memory targetCalldata)
        external
        payable
        onlyOwner
        returns (uint256 ticketId)
    {
        ticketId = sendRetryable(targetCalldata, 0);
    }

    /*//////////////////////////////////////////////////////////////
                        Convenience L2 wrappers
    //////////////////////////////////////////////////////////////*/

    /// @notice Encode and send `pause()` to L2 target.
    function sendPause() external payable onlyOwner returns (uint256 ticketId) {
        bytes memory data = abi.encodeWithSignature("pause()");
        ticketId = sendRetryable(data, 0);
    }

    /// @notice Encode and send `unpause()` to L2 target.
    function sendUnpause() external payable onlyOwner returns (uint256 ticketId) {
        bytes memory data = abi.encodeWithSignature("unpause()");
        ticketId = sendRetryable(data, 0);
    }

    /// @notice Encode and send `setL1Governance(address)` to L2 target.
    /// @param newGovL1 New L1 governance address to set on L2.
    function sendSetL1Governance(address newGovL1)
        external
        payable
        onlyOwner
        returns (uint256 ticketId)
    {
        bytes memory data = abi.encodeWithSignature("setL1Governance(address)", newGovL1);
        ticketId = sendRetryable(data, 0);
    }

    /*//////////////////////////////////////////////////////////////
                         Rescue (L1) & housekeeping
    //////////////////////////////////////////////////////////////*/

    /// @notice Rescue ETH accidentally held by this contract.
    /// @param to Recipient.
    /// @param amount Amount (wei).
    function rescueETH(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "ETH transfer failed");
    }

    /// @notice Rescue ERC20 tokens accidentally held by this contract.
    /// @param token ERC20 token address.
    /// @param to Recipient.
    /// @param amount Amount.
    function rescueERC20(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0) || token == address(0)) revert ZeroAddress();
        require(IERC20(token).transfer(to, amount), "ERC20 transfer failed");
    }

    /// @notice Accept ETH deposits (optional convenience).
    receive() external payable {}
}
