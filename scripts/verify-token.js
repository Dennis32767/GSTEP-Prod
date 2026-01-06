const { ethers } = require("hardhat");
const fs = require("fs");

async function main() {
  console.log("🔍 Verifying token contract...");
  
  const deployment = JSON.parse(fs.readFileSync('./deployments/sepolia-latest.json'));
  
  // Try both addresses
  const addresses = {
    tokenProxy: deployment.contracts.tokenProxy,
    upgradeExecutor: deployment.contracts.upgradeExecutor
  };
  
  for (const [name, address] of Object.entries(addresses)) {
    console.log(`\n📋 Trying ${name}: ${address}`);
    
    const code = await ethers.provider.getCode(address);
    console.log("Contract exists:", code !== '0x');
    
    if (code === '0x') continue;
    
    // Try with token ABI
    const tokenABI = [
      "function name() view returns (string)",
      "function symbol() view returns (string)",
      "function totalSupply() view returns (uint256)",
      "function balanceOf(address) view returns (uint256)",
      "function decimals() view returns (uint8)"
    ];
    
    const contract = new ethers.Contract(address, tokenABI, ethers.provider);
    
    try {
      const nameResult = await contract.name();
      const symbol = await contract.symbol();
      const supply = await contract.totalSupply();
      console.log("✅ Token found!");
      console.log(`   Name: ${nameResult}`);
      console.log(`   Symbol: ${symbol}`);
      console.log(`   Total Supply: ${ethers.formatEther(supply)}`);
      console.log(`   ✅ This is your GSTEP token!`);
      return;
    } catch (e) {
      console.log(`   ❌ Not a token: ${e.message}`);
    }
  }
  
  console.log("\n🔍 Checking if contract needs initialization...");
  
  // Check if the proxy needs initialization
  const proxyAddress = deployment.contracts.tokenProxy;
  const proxy = new ethers.Contract(proxyAddress, [
    "function implementation() view returns (address)",
    "function admin() view returns (address)"
  ], ethers.provider);
  
  try {
    const impl = await proxy.implementation();
    console.log(`Implementation address: ${impl}`);
    console.log("Proxy is set up correctly");
  } catch (e) {
    console.log("Proxy error:", e.message);
  }
}

main().catch(console.error);