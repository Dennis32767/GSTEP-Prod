// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "./token/modules/GS_Admin.sol";
import "./token/modules/GS_StepsAndVerification.sol";
import "./token/modules/GS_Staking.sol";
import "./token/modules/GS_AnomalyAndFraud.sol";
import "./token/modules/GS_MintingAndSupply.sol";
import "./token/modules/GS_EmergencyAndL2.sol";
import "./token/modules/GS_ReadersMinimal.sol";
import "./token/modules/GS_TestHooks.sol";

/// @title GemStepToken
/// @notice Concrete GemStep token implementation composed from modular mixins.
/// @dev
///  - This contract intentionally contains no additional *external* business logic: behavior is inherited from modules.
///  - Storage layout is defined in {GemStepStorage} (via {GemStepCore}) and must remain upgrade-safe.
///  - Function selectors are contributed by the modules; this composition preserves selectors and storage.
///  - Upgradeability: intended to be deployed behind a proxy (e.g., Transparent Proxy).
///
///  Module summary:
///  - {GemStepCore} (inherited by modules): OZ upgradeable wiring, initializer, pause transfer gate, halving/month helpers.
///  - {GS_Admin}: version/source/signers/oracle/treasury/admin wiring.
///  - {GS_StepsAndVerification}: step logging entrypoint + proof/attestation/signature verification + replay protection.
///  - {GS_Staking}: GSTEP token-staking (lock/unlock) + stake-based reward-split discount hooks.
///  - {GS_AnomalyAndFraud}: daily caps, min-interval enforcement, anomaly penalties/suspension, EMA tracking.
///  - {GS_MintingAndSupply}: net mint under global+monthly caps with reward split (user/treasury/burn).
///  - {GS_EmergencyAndL2}: emergency withdrawals and Arbitrum L1<->L2 governance utilities.
///  - {GS_ReadersMinimal}: packed view helpers / lightweight getters.
///
///  Notes on override resolution:
///  - If multiple modules implement the same internal hook, Solidity may require an explicit resolver here.
///  - We explicitly resolve the stake-split hooks to {GS_Staking} for clarity/future-proofing.
contract GemStepToken is
    GS_Admin,
    GS_StepsAndVerification,
    GS_Staking,
    GS_AnomalyAndFraud,
    GS_MintingAndSupply,
    GS_EmergencyAndL2,
    GS_ReadersMinimal,
    GS_TestHooks
{
    /* =============================================================
                          OVERRIDE RESOLUTION
       ============================================================= */

    /// @dev Resolve stake discount computation to {GS_Staking}.
    function _cutDiscountBps(address user)
        internal
        view
        override(GemStepCore, GS_Staking)
        returns (uint256)
    {
        return GS_Staking._cutDiscountBps(user);
    }

    /// @dev Resolve stake-adjusted split to {GS_Staking}.
    function _applyStakeDiscountToSplit(
        address user,
        uint256 userBps,
        uint256 burnBps,
        uint256 treasuryBps
    )
        internal
        view
        override(GemStepCore, GS_Staking)
        returns (uint256 u, uint256 b, uint256 t)
    {
        return GS_Staking._applyStakeDiscountToSplit(user, userBps, burnBps, treasuryBps);
    }

    /// @dev Optional explicit resolver for the mint hook (keeps inheritance deterministic if expanded later).
    function _mintWithCap(address account, uint256 amount)
        internal
        override(GemStepCore, GS_MintingAndSupply)
    {
        GS_MintingAndSupply._mintWithCap(account, amount);
    }

    /// @dev Intentionally minimal: all callable behavior is inherited from modules.
}
