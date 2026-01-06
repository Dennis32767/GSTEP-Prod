// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IGemStep {
    function stake() external payable;
    function withdrawStake(uint256 amount) external;
}

contract ReentrantAttacker {
    IGemStep public immutable gem;
    bool public reentered;

    constructor(address _gem) {
        gem = IGemStep(_gem);
    }

    function prime() external payable {
        gem.stake{value: msg.value}();
    }

    function attack(uint256 amt) external {
        reentered = false;
        gem.withdrawStake(amt);
    }

    receive() external payable {
        if (!reentered) {
            reentered = true;
            // Try to reenter - this should fail due to nonReentrant modifier
            try gem.withdrawStake(1) {
                // If this succeeds, we have a problem
            } catch {
                // Expected to fail
            }
        }
    }

    // Helper to check contract ETH balance
    function getBalance() external view returns (uint256) {
        return address(this).balance;
    }
}