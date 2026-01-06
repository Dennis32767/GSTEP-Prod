// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IL1Harness {
    function sendPauseToL2(bool pauseState, uint256 msc, uint256 gl, uint256 mfpg)
        external payable returns (uint256);
    function transferOwnership(address) external;
}

/// @dev A helper that calls the L1 harness and records how much ETH it receives in refunds.
contract RefundCatcher {
    uint256 public totalRefunded;
    receive() external payable { totalRefunded += msg.value; }

    function callSend(IL1Harness l1, uint256 value, bool pauseState, uint256 msc, uint256 gl, uint256 mfpg)
        external payable
    {
        require(msg.value == value, "bad value");
        l1.sendPauseToL2{value: value}(pauseState, msc, gl, mfpg);
    }
}
