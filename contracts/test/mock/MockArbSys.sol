// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IArbSys {
    function sendTxToL1(address to, bytes calldata data) external payable returns (uint256);
}

contract MockArbSys is IArbSys {
    uint256 private _nextId = 1;

    uint256 public lastId;
    address public lastTo;
    bytes public lastData;
    uint256 public lastMsgValue;

    event Sent(uint256 indexed id, address indexed to, bytes data, uint256 msgValue);

    function sendTxToL1(address to, bytes calldata data) external payable override returns (uint256) {
        lastId = _nextId++;
        lastTo = to;
        lastData = data;
        lastMsgValue = msg.value;
        emit Sent(lastId, to, data, msg.value);
        return lastId;
    }
}
