require("dotenv").config();
const { ethers } = require("ethers");

async function main() {
  const L1_RPC = process.env.SEPOLIA_RPC_URL;
  const L1_GOV = process.env.L1_GOVERNANCE_ADDR;
  const L1_TIMELOCK = process.env.L1_TIMELOCK;

  const l1 = new ethers.JsonRpcProvider(L1_RPC);

  // The transaction hash from your scheduling
  const SCHEDULE_TX_HASH = "0x401c4f9bb721fbd0c02373810056edbdade05429727ed0f2bcfd8c7cad3041b7";

  console.log("=== FINDING CORRECT SALT FROM SCHEDULING TX ===");
  
  try {
    // Get the transaction receipt
    const receipt = await l1.getTransactionReceipt(SCHEDULE_TX_HASH);
    console.log("Schedule Tx Block:", receipt.blockNumber);
    
    // Get the transaction data
    const tx = await l1.getTransaction(SCHEDULE_TX_HASH);
    
    // Decode the transaction data to find the salt
    const timelockInterface = new ethers.Interface([
      "function schedule(address target, uint256 value, bytes calldata data, bytes32 predecessor, bytes32 salt, uint256 delay)"
    ]);
    
    const decoded = timelockInterface.parseTransaction({ data: tx.data });
    console.log("\n📋 Decoded Schedule Parameters:");
    console.log("Target:", decoded.args.target);
    console.log("Value:", decoded.args.value.toString());
    console.log("Predecessor:", decoded.args.predecessor);
    console.log("Salt:", decoded.args.salt);
    console.log("Delay:", decoded.args.delay.toString());
    
    console.log("\n🎯 CORRECT SALT FOUND:", decoded.args.salt);
    console.log("\nUse this exact salt for execution!");
    
  } catch (error) {
    console.log("Error decoding transaction:", error.shortMessage || error.message);
    
    // Alternative: Try common salt patterns
    console.log("\n💡 Trying common salt patterns...");
    await tryCommonSalts(L1_GOV, L1_TIMELOCK, l1);
  }
}

async function tryCommonSalts(govAddr, timelockAddr, provider) {
  const timelock = new ethers.Contract(timelockAddr, [
    "function hashOperation(address target, uint256 value, bytes calldata data, bytes32 predecessor, bytes32 salt) pure returns (bytes32)",
    "function isOperationReady(bytes32 id) view returns (bool)"
  ], provider);

  const govInterface = new ethers.Interface(["function acceptOwnership()"]);
  const callData = govInterface.encodeFunctionData("acceptOwnership");
  const predecessor = ethers.ZeroHash;

  const commonSalts = [
    ethers.id("ACCEPT_OWNERSHIP"),
    ethers.ZeroHash,
    ethers.id(""),
    ethers.id("0"),
    ethers.id("1"),
    ethers.id("ownership"),
    ethers.id("transfer"),
    // Try with timestamp-based salts (common in deployment scripts)
    ethers.id("ACCEPT_OWNERSHIP_1700000000"), // Example timestamp
    ethers.id("ACCEPT_OWNERSHIP_" + Math.floor(Date.now() / 1000 - 86400)), // 24h ago
  ];

  console.log("\nTrying common salts...");
  for (const salt of commonSalts) {
    try {
      const operationId = await timelock.hashOperation.staticCall(
        govAddr, 0, callData, predecessor, salt
      );
      const isReady = await timelock.isOperationReady(operationId);
      
      if (isReady) {
        console.log(`✅ FOUND MATCHING SALT: ${salt}`);
        console.log(`Operation ID: ${operationId}`);
        return salt;
      }
    } catch (error) {
      // Continue to next salt
    }
  }
  
  console.log("❌ No matching salt found in common patterns");
  return null;
}

main().catch(console.error);