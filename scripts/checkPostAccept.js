// scripts/checkPostAccept.js
const { ethers } = require("hardhat");
async function main() {
  const EXEC = "0x5FC8d32690cc91D4c39d9d3abcBD16989F875707";
  const TL   = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
  const PA   = "0x856e4424f806D16E8CBC702B3c0F2ede5468eae5";
  const exec = await ethers.getContractAt("UpgradeExecutor", EXEC);
  const pa   = await ethers.getContractAt("LocalProxyAdmin", PA);
  console.log("Executor.owner():", await exec.owner()); // expect TL
  console.log("ProxyAdmin.owner():", await pa.owner()); // expect EXEC
}
main();
