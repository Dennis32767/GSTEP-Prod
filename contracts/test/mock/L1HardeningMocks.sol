// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

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

/* Records the exact msg.value seen */
contract MockInbox_ValueRecorder is IInboxLike2 {
    uint256 public lastMsgValue;
    uint256 public counter;

    function createRetryableTicket(
        address, uint256, uint256, address, address, uint256, uint256, bytes calldata
    ) external payable override returns (uint256) {
        lastMsgValue = msg.value;
        counter++;
        return counter;
    }
}

/* Always reverts (to test bubbling) */
contract RevertingInbox is IInboxLike2 {
    function createRetryableTicket(
        address, uint256, uint256, address, address, uint256, uint256, bytes calldata
    ) external payable override returns (uint256) {
        revert("MOCK_INBOX_REVERT");
    }
}

/* Owner contract that can re-enter (via receive) or revert on receive */
interface IReenterTarget {
    function sendPauseToL2(bool, uint256, uint256, uint256) external payable returns (uint256);
}

contract RefundCatcher {
    address public target;
    bool public doReenter;
    bool public doRevertOnReceive;

    constructor(address _target) { target = _target; }

    function setModes(bool _reenter, bool _revert) external {
        doReenter = _reenter; doRevertOnReceive = _revert;
    }

    receive() external payable {
        if (doRevertOnReceive) revert("CATCHER_RECEIVE_REVERT");
        if (doReenter) {
            // Attempt re-enter the L1 helper while in refund
            IReenterTarget(target).sendPauseToL2{ value: 0 }(true, 0, 0, 0);
        }
    }
}
