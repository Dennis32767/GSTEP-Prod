// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract InboxMock {
    struct Last {
        address to;
        uint256 l2CallValue;
        uint256 maxSubmissionCost;
        address excessFeeRefundAddress;
        address callValueRefundAddress;
        uint256 gasLimit;
        uint256 maxFeePerGas;
        bytes data;
        uint256 msgValue;
    }

    Last public last;
    uint256 public nextId = 1;

    function createRetryableTicket(
        address to,
        uint256 l2CallValue,
        uint256 maxSubmissionCost,
        address excessFeeRefundAddress,
        address callValueRefundAddress,
        uint256 gasLimit,
        uint256 maxFeePerGas,
        bytes calldata data
    ) external payable returns (uint256) {
        last = Last({
            to: to,
            l2CallValue: l2CallValue,
            maxSubmissionCost: maxSubmissionCost,
            excessFeeRefundAddress: excessFeeRefundAddress,
            callValueRefundAddress: callValueRefundAddress,
            gasLimit: gasLimit,
            maxFeePerGas: maxFeePerGas,
            data: data,
            msgValue: msg.value
        });
        return nextId++;
    }

    function calculateRetryableSubmissionFee(uint256, uint256) external pure returns (uint256) {
        return 0;
    }
}
