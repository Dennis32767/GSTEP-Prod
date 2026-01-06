const { ethers, upgrades } = require("hardhat");

async function main() {
  const Token = await ethers.getContractFactory("GemStepToken");

  // Deploy implementation only (does NOT touch proxy)
  const newImpl = await upgrades.deployImplementation(Token, {
    kind: "transparent",
  });

  console.log("New Implementation:", newImpl);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
