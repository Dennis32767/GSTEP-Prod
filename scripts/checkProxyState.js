// scripts/checkProxyState.js
const { ethers } = require("hardhat");

// from your JSON:
const PROXY = "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9";
const EXPECT_IMPL  = "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9";
const EXPECT_ADMIN = "0x856e4424f806D16E8CBC702B3c0F2ede5468eae5";

const IMPL_SLOT  = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

async function main() {
  const toAddr = (raw) => ethers.getAddress("0x" + raw.slice(26));
  const implRaw  = await ethers.provider.getStorage(PROXY, IMPL_SLOT);
  const adminRaw = await ethers.provider.getStorage(PROXY, ADMIN_SLOT);
  const impl  = toAddr(implRaw);
  const admin = toAddr(adminRaw);
  console.log("Proxy impl :", impl,  "| expected:", EXPECT_IMPL);
  console.log("Proxy admin:", admin, "| expected:", EXPECT_ADMIN);
}
main().catch(e=>{ console.error(e); process.exit(1); });
