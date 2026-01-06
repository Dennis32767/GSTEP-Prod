// contracts/GemStepTokenV3Mock.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "./GemStepToken.sol";

contract GemStepTokenV3Mock is GemStepToken {
    function version() external pure returns (string memory) {
        return "V3-MOCK";
    }
}
