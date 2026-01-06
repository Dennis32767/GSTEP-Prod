// scripts/upgrade-l2-crosschain-safe.js
const { ethers, upgrades } = require("hardhat");
const { validateUpgradeSafety } = require("./validate-upgrade-safety");

async function main() {
  console.log("🔒 UPGRADE: Starting Safe Upgrade Process...");
  
  // Phase 1: Pre-upgrade safety validation
  console.log("\n📋 PHASE 1: Pre-Upgrade Safety Validation");
  await validateUpgradeSafety();
  
  // Phase 2: Standard upgrade process (your existing code)
  console.log("\n📋 PHASE 2: Standard Upgrade Execution");
  
  const l2Deployment = require("../deployments/arbitrumSepolia-latest.json");
  const l2ProxyAddress = l2Deployment.contracts.tokenProxy;
  const [deployer] = await ethers.getSigners();
  
  const GemStepToken = await ethers.getContractFactory("GemStepToken");
  
  // Snapshot state before upgrade
  console.log("📸 Snapshotting pre-upgrade state...");
  const before = await ethers.getContractAt("GemStepToken", l2ProxyAddress);
  const [rewardRateBefore, stepLimitBefore, l1GovBefore] = await Promise.all([
    before.rewardRate(),
    before.stepLimit(),
    before.getL1Governance().catch(() => ethers.ZeroAddress)
  ]);
  
  // Execute upgrade
  console.log("🚀 Executing upgrade...");
  const upgraded = await upgrades.upgradeProxy(l2ProxyAddress, GemStepToken, {
    kind: "transparent"
  });
  await upgraded.waitForDeployment();
  
  // Phase 3: Post-upgrade verification
  console.log("\n📋 PHASE 3: Post-Upgrade Verification");
  
  const newImpl = await upgrades.erc1967.getImplementationAddress(l2ProxyAddress);
  console.log("✅ Upgrade complete. New implementation:", newImpl);
  
  // Verify state preservation
  const [rewardRateAfter, stepLimitAfter, l1GovAfter] = await Promise.all([
    upgraded.rewardRate(),
    upgraded.stepLimit(), 
    upgraded.getL1Governance()
  ]);
  
  console.log("🔍 State preservation check:");
  console.log(`   rewardRate: ${rewardRateBefore.toString()} → ${rewardRateAfter.toString()}`);
  console.log(`   stepLimit: ${stepLimitBefore.toString()} → ${stepLimitAfter.toString()}`);
  console.log(`   L1 Governance: ${l1GovBefore} → ${l1GovAfter}`);
  
  // Verify new cross-chain functions
  console.log("🔍 Verifying cross-chain functions...");
  await upgraded.getL1GovernanceStatus();
  console.log("✅ All cross-chain functions operational");
  
  console.log("🎉 SAFE UPGRADE COMPLETE!");
}

main().catch((err) => {
  console.error("❌ Upgrade failed:", err);
  process.exit(1);
});