// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "./token/core/GemStepCore.sol";
import "./token/modules/GS_Staking.sol";
import "./token/modules/GS_StepsAndVerification.sol";
import "./token/modules/GS_AnomalyAndFraud.sol";
import "./token/modules/GS_MintingAndSupply.sol";
import "./token/modules/GS_EmergencyAndL2.sol";
import "./token/modules/GS_Admin.sol";
import "./token/modules/GS_ReadersMinimal.sol";

/// @title GemStepToken
/// @notice Concrete GemStep token implementation composed from modular mixins.
/// @dev
///  - This contract intentionally contains no additional logic: all behavior is inherited from modules.
///  - Storage layout is defined in {GemStepStorage} (via {GemStepCore}) and must remain upgrade-safe.
///  - Function selectors are contributed by the modules; this composition preserves selectors and storage.
///  - Upgradeability: intended to be deployed behind a proxy (e.g., Transparent Proxy).
///
/// Module summary:
///  - {GemStepCore}: OZ upgradeable wiring, initializer, global overrides (pause transfer gate), halving/month helpers.
///  - {GS_Admin}: version/source/signers/oracle/treasury/admin wiring.
///  - {GS_StepsAndVerification}: step logging entrypoint + proof/attestation/signature verification + replay protection.
///  - {GS_Staking}: ETH staking, withdrawals, oracle-driven stake parameter adjustment.
///  - {GS_AnomalyAndFraud}: daily caps, min-interval enforcement, anomaly penalties/suspension, EMA tracking.
///  - {GS_MintingAndSupply}: net mint under global+monthly caps with reward split (user/treasury/burn).
///  - {GS_EmergencyAndL2}: emergency withdrawals and Arbitrum L1<->L2 governance utilities.
///  - {GS_Views}: packed view helpers and constant/role/policy getters.

contract GemStepToken is
    GS_Admin,
    GS_StepsAndVerification,
    GS_Staking,
    GS_AnomalyAndFraud,
    GS_MintingAndSupply,
    GS_EmergencyAndL2,
    GS_ReadersMinimal
{
    /// @dev Intentionally empty: all logic is inherited. Storage & selectors preserved.
}
