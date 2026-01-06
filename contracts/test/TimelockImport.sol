// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

// Pull the *non-upgradeable* TimelockController so the artifact name matches tests
import "@openzeppelin/contracts/governance/TimelockController.sol";

// Empty contract - existence forces Hardhat to compile OZ Timelock and write its artifact
contract _TimelockImport {}
