/* eslint-disable no-console */
const hre = require("hardhat");

async function main() {
  const { ethers } = hre;
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  // 1) Deploy V2 mock (no constructor args)
  const Mock = await ethers.getContractFactory("MockOracleV2", deployer);
  const mock = await Mock.deploy();
  await mock.waitForDeployment();
  console.log("MockOracleV2 deployed at:", mock.target);

  // 2) Seed price + freshness policy
  // Example: 1 GST = 0.005 ETH, confidence = 0 (ignored), staleness = 300s, minConfBps = 100 (±1%)
  const { timestamp } = await ethers.provider.getBlock("latest");
  await mock.set(ethers.parseEther("0.005"), timestamp, 0); // priceWei, updatedAt, confidenceBps
  await mock.setPolicy(300, 100);                           // maxStalenessSec, minConfidenceBps

  // 3) Sanity check
  const [priceWei, updatedAt, confBps] = await mock.latestTokenPriceWei();
  const stale = await mock.maxStaleness();
  const minConf = await mock.minConfidenceBps();
  console.log("latestTokenPriceWei():", priceWei.toString(), updatedAt.toString(), confBps.toString());
  console.log("maxStaleness():", stale.toString(), "minConfidenceBps():", minConf.toString());

  console.log("\nExport this as ENV for your next step:");
  console.log(`PRICE_ORACLE_ADDRESS=${mock.target}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
