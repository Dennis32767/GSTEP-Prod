// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "../core/GemStepCore.sol";

/// @title GS_Staking
/// @notice Stake (lock) GEMS to qualify for reduced burn/treasury cuts.
/// @dev
///  - Users lock GEMS by transferring into the token contract.
///  - Stake age is tracked via a weighted start timestamp so top-ups preserve duration.
///  - No extra tokens are minted here; staking only adjusts reward split BPS via hooks.
///
///  Storage expectations (GemStepStorage):
///  - mapping(address => uint256) internal stakeBalance;
///  - mapping(address => uint256) internal stakeStart;
///  - bool internal stakingPaused;
///
///  Policy constants are defined centrally in GemStepStorage:
///  - STAKE_MIN_AGE, STAKE_MAX_AGE, STAKE_TIER1/2/3, STAKE_D1/2/3, etc.
abstract contract GS_Staking is GemStepCore {
    /* =============================================================
                           STAKING-ONLY PAUSE
       ============================================================= */

    /// @dev Reverts if staking is paused (independent of OZ Pausable).
    modifier whenStakingNotPaused() {
        require(!stakingPaused, "GS: staking paused");
        _;
    }

    /// @notice Returns staking-only pause flag.
    function isStakingPaused() external view returns (bool) {
        return stakingPaused;
    }

    /* =============================================================
                                 User Actions
       ============================================================= */

    /// @notice Stake (lock) GEMS to qualify for reduced burn/treasury cuts.
    /// @param amount Amount of GEMS to stake.
    /// @dev
    ///  - Updates weighted {stakeStart[msg.sender]} so top-ups preserve earned duration.
    ///  - Transfers GEMS from user to this token contract.
    function stake(uint256 amount) external whenNotPaused whenStakingNotPaused {
        require(amount != 0, "0");

        address u = msg.sender;

        uint256 oldBal = stakeBalance[u];
        uint256 newBal;
        unchecked {
            newBal = oldBal + amount;
        }

        uint256 nowTs = block.timestamp;

        // Weighted start time:
        // newStart = (oldBal*oldStart + amount*now) / newBal
        // First stake => start = now.
        uint256 start = stakeStart[u];
        if (oldBal == 0) {
            stakeStart[u] = nowTs;
        } else {
            if (start == 0) start = nowTs;
            unchecked {
                stakeStart[u] = (oldBal * start + amount * nowTs) / newBal;
            }
        }

        stakeBalance[u] = newBal;

        unchecked {
            totalStaked += amount;
        }

        _transfer(u, address(this), amount);
        emit Staked(u, amount);
    }

    /// @notice Withdraw staked GEMS.
    /// @param amount Amount of GEMS to withdraw.
    /// @dev
    ///  - Reentrancy protected.
    ///  - If user fully exits, clears {stakeStart[user]}.
    function withdrawStake(uint256 amount)
        external
        nonReentrant
        whenNotPaused
        whenStakingNotPaused
    {
        require(amount != 0, "0");

        address u = msg.sender;
        uint256 bal = stakeBalance[u];
        require(bal >= amount, "BAL");

        uint256 newBal;
        unchecked {
            newBal = bal - amount;
            stakeBalance[u] = newBal;
        }

        unchecked {
            totalStaked -= amount;
        }

        if (newBal == 0) stakeStart[u] = 0;

        _transfer(address(this), u, amount);
        emit Withdrawn(u, amount);
        
        require(balanceOf(address(this)) >= totalStaked, "GS: staked invariant");
    }

    /* =============================================================
                                   Views
       ============================================================= */

    /// @notice Returns stake balance and weighted stake start timestamp for a user.
    function getStakeInfo(address user) external view returns (uint256 balance, uint256 startTs) {
        return (stakeBalance[user], stakeStart[user]);
    }

    /* =============================================================
                     Split Logic Hooks (consumed by minting)
       ============================================================= */

    /// @inheritdoc GemStepCore
    function _cutDiscountBps(address user)
        internal
        view
        virtual
        override
        returns (uint256 d)
    {
        uint256 bal = stakeBalance[user];
        if (bal == 0) return 0;

        uint256 base;
        if (bal >= STAKE_TIER3) base = STAKE_D3;
        else if (bal >= STAKE_TIER2) base = STAKE_D2;
        else if (bal >= STAKE_TIER1) base = STAKE_D1;
        else return 0;

        uint256 start = stakeStart[user];
        if (start == 0) return 0;

        uint256 age;
        unchecked {
            age = block.timestamp - start;
        }
        if (age < STAKE_MIN_AGE) return 0;
        if (age > STAKE_MAX_AGE) age = STAKE_MAX_AGE;

        // Duration bonus: up to +33% of base at STAKE_MAX_AGE.
        uint256 bonus;
        unchecked {
            bonus = (base * (age - STAKE_MIN_AGE)) / (STAKE_MAX_AGE - STAKE_MIN_AGE) / 3;
            d = base + bonus;
        }

        if (d > STAKE_MAX_CUT_DISCOUNT_BPS) d = STAKE_MAX_CUT_DISCOUNT_BPS;
    }

    /// @inheritdoc GemStepCore
    function _applyStakeDiscountToSplit(
        address user,
        uint256 userBps,
        uint256 burnBps,
        uint256 treasuryBps
    )
        internal
        view
        virtual
        override
        returns (uint256 u, uint256 b, uint256 t)
    {
        uint256 cut;
        unchecked {
            cut = burnBps + treasuryBps;
        }
        if (cut == 0) return (userBps, burnBps, treasuryBps);

        uint256 d = _cutDiscountBps(user);
        if (d == 0) return (userBps, burnBps, treasuryBps);

        // Enforce minimum remaining cut.
        uint256 maxD = cut > STAKE_MIN_CUT_BPS ? (cut - STAKE_MIN_CUT_BPS) : 0;
        if (d > maxD) d = maxD;

        // Pro-rate discount across burn & treasury.
        uint256 burnDec = (d * burnBps) / cut;
        unchecked {
            uint256 treasDec = d - burnDec;
            b = burnBps - burnDec;
            t = treasuryBps - treasDec;
            u = userBps + d;
        }
    }
}
