// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "../core/GemStepCore.sol";

/// @title GS_MintingAndSupply
/// @notice Minting logic with global cap + monthly cap, and stake-adjusted reward split.
/// @dev
///  Overview:
///  - This module implements {_mintWithCap} (declared in {GemStepCore}) used by step-reward flows.
///  - Base split is (user,burn,treasury) expressed in basis points (bps).
///  - A staking discount may reduce the combined (burn+treasury) cut and shift those bps to the user.
///
///  Cap model:
///  - Global cap and monthly cap are enforced on *net supply increase*:
///      netMint = toUser + toTreasury
///    The burn leg is net-zero (mint-to-self then burn).
///
///  Accounting order:
///  - {_syncMonth} is called before cap checks to roll over month windows.
///  - Month minted + distributed totals are updated before {_checkHalving}.
///
///  Integration requirements:
///  - {_applyStakeDiscountToSplit} must be implemented by another module (e.g. {GS_Staking})
///    or the most-derived token contract must resolve the override.
abstract contract GS_MintingAndSupply is GemStepCore {
    /* =============================================================
                              Core Mint Hook
       ============================================================= */

    /// @notice Mint rewards with global + monthly cap enforcement and stake-adjusted split.
    /// @dev
    ///  - Reverts on zero address or zero amount.
    ///  - Uses {_applyStakeDiscountToSplit} to compute (u,b,t) bps (sum must equal {BPS_BASE}).
    ///  - Enforces:
    ///      - MAX_SUPPLY on netMint (user + treasury)
    ///      - currentMonthlyCap on netMint (user + treasury)
    ///  - Updates:
    ///      - currentMonthMinted += netMint
    ///      - distributedTotal   += netMint
    ///  - Performs mint/burn legs:
    ///      - user:     mint to account
    ///      - treasury: mint to treasury
    ///      - burn:     mint to this contract then burn (net-zero supply change)
    ///  - On month rollover, {currentMonthlyCap} is reset to {monthlyMintLimit}
    ///    (which may be updated by halving/admin policy); unused capacity never carries forward.
    ///
    /// @param account Reward recipient (user / beneficiary).
    /// @param amount  Total “gross” reward amount before split (18 decimals).
    function _mintWithCap(address account, uint256 amount) internal virtual override {
        require(account != address(0), "Z");
        require(amount != 0, "0");

        // Ensure month window is current before enforcing monthly caps.
        _syncMonth();

        // Apply stake discount (if any) to the base split.
        (uint256 uBps, uint256 bBps, uint256 tBps) =
            _applyStakeDiscountToSplit(account, REWARD_USER_BPS, REWARD_BURN_BPS, REWARD_TREASURY_BPS);

        // Compute split amounts.
        uint256 toUser = (amount * uBps) / BPS_BASE;
        uint256 toBurn = (amount * bBps) / BPS_BASE;
        uint256 toTreasury = (amount * tBps) / BPS_BASE;

        // Caps are enforced on net supply increase only.
        uint256 netMint;
        unchecked {
            netMint = toUser + toTreasury;
        }

        // Global hard cap.
        require(totalSupply() + netMint <= MAX_SUPPLY, "CAP");

        // Monthly cap (net minted in month).
        uint256 minted = currentMonthMinted;
        require(minted + netMint <= currentMonthlyCap, "MCAP");

        // Update month/distribution totals before halving check.
        unchecked {
            currentMonthMinted = minted + netMint;
            distributedTotal += netMint;
        }

        // Halving schedule reacts to distributedTotal changes.
        _checkHalving();

        // Mint legs
        if (toUser != 0) {
            _mint(account, toUser);
            emit TokensMinted(account, toUser, totalSupply());
        }

        if (toTreasury != 0) {
            address tr = treasury;
            require(tr != address(0), "TR");
            _mint(tr, toTreasury);
            emit TokensMinted(tr, toTreasury, totalSupply());
        }

        // Burn leg (net-zero supply change)
        if (toBurn != 0) {
            _mint(address(this), toBurn);
            _burn(address(this), toBurn);
            emit TokensBurned(address(this), toBurn, totalSupply());
        }
    }
}
