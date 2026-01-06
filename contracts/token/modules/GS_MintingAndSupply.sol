// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "../core/GemStepCore.sol";

abstract contract GS_MintingAndSupply is GemStepCore {
    function _mintWithCap(address account, uint256 amount) internal override {
        _syncMonth();

        // Global cap
        require(totalSupply() + amount <= MAX_SUPPLY, "ERC20Capped: cap exceeded");

        // Monthly cap (use one SLOAD of currentMonthMinted)
        uint256 minted = currentMonthMinted;
        require(minted + amount <= currentMonthlyCap, "Monthly cap exceeded");

        // Update counters first; bounds are already enforced
        unchecked {
            currentMonthMinted = minted + amount;
            distributedTotal += amount;
        }

        _checkHalving();            // uses distributedTotal
        _mint(account, amount);     // ERC20 mint
    }
}
