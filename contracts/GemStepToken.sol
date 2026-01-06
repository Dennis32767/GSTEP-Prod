// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "./token/core/GemStepCore.sol";
import "./token/modules/GS_Staking.sol";
import "./token/modules/GS_StepsAndVerification.sol";
import "./token/modules/GS_AnomalyAndFraud.sol";
import "./token/modules/GS_MintingAndSupply.sol";
import "./token/modules/GS_EmergencyAndL2.sol";
import "./token/modules/GS_Admin.sol";
import "./token/modules/GS_Views.sol";

contract GemStepToken is
    GS_Admin,
    GS_StepsAndVerification,
    GS_Staking,
    GS_AnomalyAndFraud,
    GS_MintingAndSupply,
    GS_EmergencyAndL2,
    GS_Views
{
    // Intentionally empty: all logic inherited. Storage & selectors preserved.
}
