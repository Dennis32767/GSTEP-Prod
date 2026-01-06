// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

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
}

contract MockInbox is IInbox {
    uint256 private _nextId = 1;
    uint256 public lastMsgValue;
    address public lastTo;
    bytes public lastData;

    event RetryableCreated(uint256 indexed id, address indexed to, bytes data, uint256 msgValue);

    function createRetryableTicket(
        address to,
        uint256,
        uint256,
        address,
        address,
        uint256,
        uint256,
        bytes calldata data
    ) external payable override returns (uint256) {
        lastMsgValue = msg.value;
        lastTo = to;
        lastData = data;
        uint256 id = _nextId++;
        emit RetryableCreated(id, to, data, msg.value);
        return id;
    }
}
