/* eslint-disable no-console */
const { ethers, upgrades } = require("hardhat");

async function main() {
  // proxy address (the one your frontend uses)
  const PROXY = process.env.PROXY_ADDRESS;
  if (!PROXY) throw new Error("Set PROXY_ADDRESS");

  // New implementation factory
  const New = await ethers.getContractFactory("GemStepToken"); // or your V2/VNext name

  // This checks storage layout compatibility against the current implementation behind the proxy
  // and fails if you reordered/changed types/removed vars, etc.
  await upgrades.validateUpgrade(PROXY, New, { kind: "transparent" });

  console.log("✅ Storage layout validation PASSED for upgrade.");
}

main().catch((e) => {
  console.error("❌ Storage layout validation FAILED:", e);
  process.exit(1);
});
