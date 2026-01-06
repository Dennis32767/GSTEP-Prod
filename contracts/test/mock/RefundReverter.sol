// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IL1Harness {
    function sendPauseToL2(bool pauseState, uint256 msc, uint256 gl, uint256 mfpg)
        external payable returns (uint256);
    function transferOwnership(address) external;
}

contract RefundReverter {
    // reverts on refund
    receive() external payable { revert("refund blocked"); }

    // helper so *this contract* (the owner) is the msg.sender
    function callSend(IL1Harness l1, uint256 value, bool pauseState, uint256 msc, uint256 gl, uint256 mfpg)
        external payable
    {
        require(msg.value == value, "bad value");
        l1.sendPauseToL2{value: value}(pauseState, msc, gl, mfpg);
    }
}
