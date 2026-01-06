// scripts/validate-upgrade-safety.js
/* eslint-disable no-console */
const { ethers, upgrades } = require("hardhat");

async function validateUpgradeSafety() {
  console.log("🔒 Validating Upgrade Safety...");

  // 0) Load proxy address
  const l2Deployment = require("../deployments/arbitrumSepolia-latest.json");
  const proxyAddress = l2Deployment?.contracts?.tokenProxy;
  if (!proxyAddress) throw new Error("Proxy address not found in deployments/arbitrumSepolia-latest.json");

  // 1) Storage layout validation (authoritative)
  const GemStepken = await ethers.getContractFactory("GemStepToken");
  console.log("1) Storage layout via hardhat-upgrades...");
  await upgrades.validateUpgrade(proxyAddress, GemStepToken, { kind: "transparent" });
  console.log("   ✅ Storage layout compatible");

  // 2) Inheritance / ABI shape sanity (no deploy)
  console.log("2) ABI/function presence sanity...");
  await verifyInterfaceShape(GemStepToken.interface);

  // 3) Optional: lightweight “purity” check (ABI presence of expected public views)
  console.log("3) Public view ABI presence...");
  await verifyPublicViews(GemStepToken.interface);

  console.log("🎉 All upgrade safety checks passed!");
}

async function verifyInterfaceShape(iface) {
  // Functions you expect after the refactor (no tx, pure ABI introspection)
  const expected = [
    "getL1Governance()",
    "getL1GovernanceStatus()",
    "l2SetPause(bool)",
    "emergencyPingL1(address,bytes)",
  ];

  for (const sig of expected) {
    try {
      iface.getFunction(sig);
      console.log(`   ✅ ${sig}`);
    } catch {
      throw new Error(`Missing expected function in ABI: ${sig}`);
    }
  }
}

async function verifyPublicViews(iface) {
  const expectedViews = [
    // keep these aligned with GS_Views + storage-exposed getters you rely on
    "getArbitrumConfig()",
    "getPublicConstants()",        // if you consolidated A/B/C -> one
    "getRolesAndPolicy()",         // if you consolidated roles/policy -> one
    "getUserTotalSteps(address)",
    "getUserSourceNonce(address,string)",
    "getPriceOracle()",
  ];

  for (const sig of expectedViews) {
    try {
      iface.getFunction(sig);
      console.log(`   ✅ ${sig}`);
    } catch {
      // Not fatal if you intentionally removed some to trim bytecode
      console.warn(`   ⚠️  Optional view missing (ok if intentional): ${sig}`);
    }
  }
}

// Export (so other scripts can import)
module.exports = { validateUpgradeSafety };

// Run directly (CLI)
if (require.main === module) {
  validateUpgradeSafety()
    .catch((err) => {
      console.error("❌ Upgrade safety validation failed:", err.message || err);
      process.exit(1);
    });
}
