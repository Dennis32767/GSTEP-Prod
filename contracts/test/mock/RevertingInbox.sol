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

/// @dev Always reverts to simulate L1 inbox failure.
contract RevertingInbox is IInboxLike2 {
    function createRetryableTicket(
        address,
        uint256,
        uint256,
        address,
        address,
        uint256,
        uint256,
        bytes calldata
    ) external payable override returns (uint256) {
        revert("inbox: forced revert");
    }
}
