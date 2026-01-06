// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/**
 * @title CrossChainGovernanceL1
 * @notice L1 governance sender for Arbitrum (Nitro). Creates retryable tickets to an L2 target
 *         (e.g., UpgradeExecutor / Token / Timelock). Designed to be owned by a Timelock on L1.
 *
 * Key features
 * - Ownable2Step: safe ownership handoff to Timelock
 * - Configurable Inbox, L2 target, refund L2 address, and gas params
 * - Robust quoting helper so off-chain scripts can ensure msg.value suffices
 * - Convenience wrappers for common L2 admin ops (pause/unpause/setL1Governance)
 */

interface IInbox {
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

    function calculateRetryableSubmissionFee(
        uint256 dataLength,
        uint256 baseFee
    ) external view returns (uint256);
}

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
}

/* ───────────────── Ownable2Step (lightweight, local) ───────────────── */
abstract contract Ownable2Step {
    address private _owner;
    address private _pendingOwner;

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error NotPendingOwner();
    error ZeroAddress();

    constructor(address initialOwner_) {
        if (initialOwner_ == address(0)) revert ZeroAddress();
        _owner = initialOwner_;
        emit OwnershipTransferred(address(0), initialOwner_);
    }

    modifier onlyOwner() {
        if (msg.sender != _owner) revert NotOwner();
        _;
    }

    function owner() public view returns (address) {
        return _owner;
    }

    function pendingOwner() public view returns (address) {
        return _pendingOwner;
    }

    function transferOwnership(address newOwner) public onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        _pendingOwner = newOwner;
        emit OwnershipTransferStarted(_owner, newOwner);
    }

    function acceptOwnership() public {
        if (msg.sender != _pendingOwner) revert NotPendingOwner();
        address prev = _owner;
        _owner = _pendingOwner;
        _pendingOwner = address(0);
        emit OwnershipTransferred(prev, _owner);
    }
}

/* ─────────────────────────── Main Contract ─────────────────────────── */
contract CrossChainGovernanceL1 is Ownable2Step {
    /*//////////////////////////////////////////////////////////////
                                Errors
    //////////////////////////////////////////////////////////////*/
    // NOTE: Do NOT re-declare ZeroAddress here (already in Ownable2Step)
    error InboxNotSet();
    error L2TargetNotSet();
    error RefundL2NotSet();
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
    IInbox public inbox;          // L1 Arbitrum Inbox
    address public l2Target;      // L2 executor / token / timelock target
    address public refundL2;      // L2 address to receive excess and callValue refunds

    struct GasConfig {
        uint256 maxSubmissionCost; // submission fee cap (wei)
        uint256 gasLimit;          // L2 execution gas
        uint256 maxFeePerGas;      // L2 max fee per gas (wei)
    }

    GasConfig public gasConfig;

    /*//////////////////////////////////////////////////////////////
                              Constructor
    //////////////////////////////////////////////////////////////*/
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
    function setInbox(address inbox_) external onlyOwner {
        _setInbox(inbox_);
    }

    function setL2Target(address target_) external onlyOwner {
        _setL2Target(target_);
    }

    function setRefundL2(address refundL2_) external onlyOwner {
        _setRefundL2(refundL2_);
    }

    function setGasConfig(
        uint256 maxSubmissionCost,
        uint256 gasLimit,
        uint256 maxFeePerGas
    ) external onlyOwner {
        _setGasConfig(maxSubmissionCost, gasLimit, maxFeePerGas);
    }

    function _setInbox(address inbox_) internal {
        if (inbox_ == address(0)) revert ZeroAddress();
        inbox = IInbox(inbox_);
        emit InboxUpdated(inbox_);
    }

    function _setL2Target(address target_) internal {
        if (target_ == address(0)) revert ZeroAddress();
        l2Target = target_;
        emit L2TargetUpdated(target_);
    }

    function _setRefundL2(address refundL2_) internal {
        if (refundL2_ == address(0)) revert ZeroAddress();
        refundL2 = refundL2_;
        emit RefundL2Updated(refundL2_);
    }

    function _setGasConfig(
        uint256 maxSubmissionCost,
        uint256 gasLimit,
        uint256 maxFeePerGas
    ) internal {
        gasConfig = GasConfig(maxSubmissionCost, gasLimit, maxFeePerGas);
        emit GasConfigUpdated(maxSubmissionCost, gasLimit, maxFeePerGas);
    }

    /*//////////////////////////////////////////////////////////////
                         Quoting helper (view)
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Quote total msg.value required for a retryable given current gasConfig.
     * @dev total = l2CallValue + submissionFee + (gasLimit * maxFeePerGas)
     *      We return `submissionFee` as the funded cap (maxSubmissionCost), which is what
     *      this contract will actually send to Inbox. Off-chain tooling can also call
     *      `calculateRetryableSubmissionFee` directly if they need the pure minimum.
     */
    function quoteRetryable(bytes calldata /* _data */, uint256 l2CallValue)
        external
        view
        returns (uint256 total, uint256 submissionFee, uint256 gasFee)
    {
        if (address(inbox) == address(0)) revert InboxNotSet();

        // read from storage directly (no GasConfig local)
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
     * @notice Create a retryable ticket to the configured L2 target with current gasConfig.
     * @param data        Calldata for the L2 target
     * @param l2CallValue ETH (wei) forwarded to L2 target (typically 0)
     * @return ticketId   Retryable ticket id
     *
     * NOTE: Accepts `bytes memory` so internal wrappers using `abi.encodeWithSignature`
     *       can pass data without memory→calldata mismatch.
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

    // single local
    uint256 required;
    unchecked {
        required = l2CallValue
            + gasConfig.maxSubmissionCost
            + (gasConfig.gasLimit * gasConfig.maxFeePerGas);
    }
    if (msg.value < required) revert MsgValueTooLow(required, msg.value);

    // pass storage reads directly; avoids extra stack slots
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
     * @notice Generic L2 call passthrough (no ETH), using current gasConfig.
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

    /// @notice Encodes and sends `pause()` to the L2 target.
    function sendPause() external payable onlyOwner returns (uint256 ticketId) {
        bytes memory data = abi.encodeWithSignature("pause()");
        ticketId = sendRetryable(data, 0);
    }

    /// @notice Encodes and sends `unpause()` to the L2 target.
    function sendUnpause() external payable onlyOwner returns (uint256 ticketId) {
        bytes memory data = abi.encodeWithSignature("unpause()");
        ticketId = sendRetryable(data, 0);
    }

    /// @notice Encodes and sends `setL1Governance(address)` to the L2 target.
    function sendSetL1Governance(address newGovL1) external payable onlyOwner returns (uint256 ticketId) {
        bytes memory data = abi.encodeWithSignature("setL1Governance(address)", newGovL1);
        ticketId = sendRetryable(data, 0);
    }

    /*//////////////////////////////////////////////////////////////
                         Rescue (L1) & housekeeping
    //////////////////////////////////////////////////////////////*/
    function rescueETH(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "ETH transfer failed");
    }

    function rescueERC20(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0) || token == address(0)) revert ZeroAddress();
        require(IERC20(token).transfer(to, amount), "ERC20 transfer failed");
    }

    receive() external payable {}
}
