// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IInboxLike2 {
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
}

contract CrossChainGovernanceL1_TestHarness {
    // Minimal copy of your L1 helper interface/logic used by JS tests
    address public owner;
    address public inbox;
    address public l2Token;
    address public refundL2;
    bool    public paused;

    event RetryableCreated(uint256 indexed ticketId, bytes data, address indexed to);
    event OwnerTransferred(address indexed oldOwner, address indexed newOwner);
    event InboxSet(address indexed inbox);
    event L2TokenSet(address indexed l2Token);
    event RefundL2Set(address indexed refundL2);
    event ContractPaused(bool paused);
    event Swept(address indexed to, uint256 amount);

    error NotOwner();
    error ZeroAddress();
    error ContractPausedErr();
    error InsufficientMsgValue(uint256 required, uint256 provided);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address _owner, address _inbox, address _l2Token, address _refundL2) {
        if (
            _owner == address(0) ||
            _inbox == address(0) ||
            _l2Token == address(0) ||
            _refundL2 == address(0)
        ) {
            revert ZeroAddress();
        }
        owner    = _owner;
        inbox    = _inbox;
        l2Token  = _l2Token;
        refundL2 = _refundL2;

        emit OwnerTransferred(address(0), _owner);
        emit InboxSet(_inbox);
        emit L2TokenSet(_l2Token);
        emit RefundL2Set(_refundL2);
    }

    /* --------------------------- admin ops --------------------------- */

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnerTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setL2Token(address newL2Token) external onlyOwner {
        if (newL2Token == address(0)) revert ZeroAddress();
        l2Token = newL2Token;
        emit L2TokenSet(newL2Token);
    }

    function setInbox(address newInbox) external onlyOwner {
        if (newInbox == address(0)) revert ZeroAddress();
        inbox = newInbox;
        emit InboxSet(newInbox);
    }

    function setRefundL2(address newRefundL2) external onlyOwner {
        if (newRefundL2 == address(0)) revert ZeroAddress();
        refundL2 = newRefundL2;
        emit RefundL2Set(newRefundL2);
    }

    function emergencyPause() external onlyOwner {
        paused = true;
        emit ContractPaused(true);
    }

    function resume() external onlyOwner {
        paused = false;
        emit ContractPaused(false);
    }

    function sweep(address payable to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 amt = address(this).balance;
        (bool ok, ) = to.call{value: amt}("");
        require(ok, "sweep failed");
        emit Swept(to, amt);
    }

    /* ------------------------------ views ---------------------------- */

    function getConfig()
        external
        view
        returns (address, address, address, address, bool)
    {
        return (owner, inbox, l2Token, refundL2, paused);
    }

    function calculateRequiredValue(
        uint256 maxSubmissionCost,
        uint256 gasLimit,
        uint256 maxFeePerGas
    ) public pure returns (uint256) {
        unchecked {
            return maxSubmissionCost + (gasLimit * maxFeePerGas);
        }
    }

    /* --------------------------- core messaging -------------------------- */

    function sendCall(
        bytes memory data,
        uint256 maxSubmissionCost,
        uint256 gasLimit,
        uint256 maxFeePerGas
    ) public payable onlyOwner returns (uint256 ticketId) {
        // Use the same logic as main contract for unpause detection
        bool allowUnpauseThrough = paused && _isUnpausePayload(data);
        if (!allowUnpauseThrough && paused) revert ContractPausedErr();

        uint256 requiredValue = calculateRequiredValue(maxSubmissionCost, gasLimit, maxFeePerGas);
        if (msg.value < requiredValue) revert InsufficientMsgValue(requiredValue, msg.value);

        // Create a struct to reduce stack depth
        RetryableParams memory params = RetryableParams({
            to: l2Token,
            l2CallValue: 0,
            maxSubmissionCost: maxSubmissionCost,
            excessFeeRefundAddress: refundL2,
            callValueRefundAddress: refundL2,
            gasLimit: gasLimit,
            maxFeePerGas: maxFeePerGas,
            data: data
        });

        ticketId = _createRetryableTicket(params, requiredValue);

        emit RetryableCreated(ticketId, data, l2Token);

        // refund any excess
        uint256 excess = msg.value - requiredValue;
        if (excess > 0) {
            (bool ok, ) = msg.sender.call{value: excess}("");
            require(ok, "refund failed");
        }
    }

    function sendPauseToL2(
        bool pauseState,
        uint256 msc,
        uint256 gl,
        uint256 mfpg
    ) external payable onlyOwner returns (uint256) {
        bytes memory data = abi.encodeWithSignature("l2SetPause(bool)", pauseState);
        return sendCall(data, msc, gl, mfpg);
    }

    function sendUpdateParamsToL2(
        uint256 newStepLimit,
        uint256 newRewardRate,
        uint256 msc,
        uint256 gl,
        uint256 mfpg
    ) external payable onlyOwner returns (uint256) {
        bytes memory data = abi.encodeWithSignature(
            "l2UpdateParams(uint256,uint256)",
            newStepLimit,
            newRewardRate
        );
        return sendCall(data, msc, gl, mfpg);
    }

    /* --------------------------- helper functions ------------------------ */

    struct RetryableParams {
        address to;
        uint256 l2CallValue;
        uint256 maxSubmissionCost;
        address excessFeeRefundAddress;
        address callValueRefundAddress;
        uint256 gasLimit;
        uint256 maxFeePerGas;
        bytes data;
    }

    function _createRetryableTicket(RetryableParams memory params, uint256 value) 
        internal 
        returns (uint256) 
    {
        return IInboxLike2(inbox).createRetryableTicket{ value: value }(
            params.to,
            params.l2CallValue,
            params.maxSubmissionCost,
            params.excessFeeRefundAddress,
            params.callValueRefundAddress,
            params.gasLimit,
            params.maxFeePerGas,
            params.data
        );
    }

    function _isUnpausePayload(bytes memory data) private pure returns (bool) {
        // function selector of l2SetPause(bool) with argument "false"
        // We only check the first 4 bytes (selector) and decode bool when length == 36 (4 + 32)
        if (data.length != 36) return false;
        bytes4 sel;
        assembly { sel := mload(add(data, 32)) }
        if (sel != bytes4(keccak256("l2SetPause(bool)"))) return false;

        // decode the bool arg (last 32 bytes)
        bool arg;
        assembly { arg := eq(mload(add(data, 36)), 1) } // bool is 1 or 0
        return !arg;
    }

    /* ------------------------------ receive ----------------------------- */

    receive() external payable {}
}