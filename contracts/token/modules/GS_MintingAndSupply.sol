// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "../core/GemStepCore.sol";

/// @title GS_MintingAndSupply
/// @notice Minting logic with global cap + monthly cap, and reward-mint split:
///         80% to user, 10% to treasury, 10% burned.
/// @dev
///  - Implements the {_mintWithCap} hook from {GemStepCore}.
///  - Enforces caps on the *net* increase to totalSupply:
///      netMint = toUser + toTreasury
///    since the burn is executed in the same transaction (mint-to-self then burn),
///    making it net-zero supply change.
///  - Updates month/cap accounting *before* minting to keep invariants tight.
///  - Calls {_checkHalving} after accounting updates so halving reacts to the most
///    up-to-date distributed totals.
///  - Emits:
///      - {TokensMinted} for user and treasury mints
///      - {TokensBurned} for the burn leg
abstract contract GS_MintingAndSupply is GemStepCore {
    /* =============================================================
                              CORE MINT HOOK
       ============================================================= */

    /// @inheritdoc GemStepCore
    /// @dev Mints `amount` subject to global+monthly caps; splits into user/treasury/burn.
    function _mintWithCap(address account, uint256 amount) internal override {
        require(account != address(0), "ERC20: mint to the zero address");
        require(amount > 0, "Mint: zero amount");

        // Ensure month state is current before enforcing monthly caps.
        _syncMonth();

        /* ---------------- Reward split: 80 / 10 / 10 ----------------
           Compute split first so we can enforce caps on the net mint that
           actually increases totalSupply. */
        uint256 toUser = (amount * REWARD_USER_BPS) / BPS_BASE; // 80%
        uint256 toBurn = (amount * REWARD_BURN_BPS) / BPS_BASE; // 10%
        uint256 toTreasury = amount - toUser - toBurn;          // remainder (10%)

        // Net increase to totalSupply (burn is net-zero in the same tx)
        uint256 netMint = toUser + toTreasury;

        /* ------------------------- Global cap ------------------------- */
        require(totalSupply() + netMint <= MAX_SUPPLY, "ERC20Capped: cap exceeded");

        /* ------------------------- Monthly cap ------------------------ */
        uint256 minted = currentMonthMinted;
        require(minted + netMint <= currentMonthlyCap, "Monthly cap exceeded");

        /* ---------------------- Update accounting --------------------- */
        unchecked {
            currentMonthMinted = minted + netMint;
            distributedTotal += netMint;
        }

        /* ------------------------ Halving check ----------------------- */
        // Halving uses distributedTotal thresholds; run after accounting is updated.
        _checkHalving();

        /* -------------------------- Apply mints ------------------------ */
        if (toUser != 0) {
            _mint(account, toUser);
            emit TokensMinted(account, toUser, totalSupply());
        }

        if (toTreasury != 0) {
            address t = treasury;
            require(t != address(0), "Treasury not set");
            _mint(t, toTreasury);
            emit TokensMinted(t, toTreasury, totalSupply());
        }

        if (toBurn != 0) {
            // Make the burn explicit and auditable: mint to self then burn.
            _mint(address(this), toBurn);
            _burn(address(this), toBurn);
            emit TokensBurned(address(this), toBurn, totalSupply());
        }
    }
}
