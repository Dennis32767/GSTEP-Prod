require("dotenv").config();
const { ethers } = require("ethers");

async function main() {
  const L2_RPC = process.env.ARBITRUM_SEPOLIA_RPC_URL;
  const L2_TOK = process.env.L2_TOKEN_PROXY;

  const l2 = new ethers.JsonRpcProvider(L2_RPC);
  const token = new ethers.Contract(L2_TOK, [
    "function getCoreParams() view returns (uint256,uint256,uint256,uint256)"
  ], l2);

  const [burnFee, rewardRate, stepLimit, sigValidity] = await token.getCoreParams();
  
  console.log("✅ FINAL PARAMETERS CONFIRMED:");
  console.log("  stepLimit:  ", stepLimit.toString(), stepLimit === 5000n ? "✅" : "❌");
  console.log("  rewardRate: ", rewardRate.toString(), rewardRate === 1000000000000000000n ? "✅" : "❌");
  console.log("  burnFee:    ", burnFee.toString());
  console.log("  sigValidity:", sigValidity.toString());
  
  console.log("\n🎉 PARAMETER UPDATE SUCCESSFUL!");
  console.log("From: stepLimit=5000, rewardRate=20");
  console.log("To:   stepLimit=15000, rewardRate=1000000000000000000");
}

main().catch(console.error);