// npx hardhat run scripts/executeAccept.node.js --network localhost
const { ethers } = require("hardhat");

const TL   = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const EXEC = "0x5FC8d32690cc91D4c39d9d3abcBD16989F875707";
const SALT = "0x4bb5faeb5c17fc272d90a0e16c01bb3a49785ad9410115d48775a4bf7fdb51a3";

async function main() {
  const [deployer, multisig] = await ethers.getSigners(); // multisig is #2 on HH
  const tl   = await ethers.getContractAt("TimelockController", TL, multisig);
  const exec = await ethers.getContractAt("UpgradeExecutor",   EXEC);

  const target      = EXEC;
  const value       = 0;
  const data        = exec.interface.encodeFunctionData("acceptOwnership", []);
  const predecessor = ethers.ZeroHash;

  // satisfy the TL delay (60s)
  await ethers.provider.send("evm_increaseTime", [61]);
  await ethers.provider.send("evm_mine", []);

  const tx = await tl.execute(target, value, data, predecessor, SALT);
  console.log("Executed acceptOwnership:", tx.hash);
}
main().catch(e => { console.error(e); process.exit(1); });
