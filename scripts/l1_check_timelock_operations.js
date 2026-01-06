require("dotenv").config();
const { ethers } = require("ethers");

async function main() {
  const L1_RPC = process.env.SEPOLIA_RPC_URL;
  const L1_GOV = process.env.L1_GOVERNANCE_ADDR;
  const L1_TIMELOCK = process.env.L1_TIMELOCK;

  const l1 = new ethers.JsonRpcProvider(L1_RPC);

  const timelock = new ethers.Contract(L1_TIMELOCK, [
    "function isOperation(bytes32 id) view returns (bool)",
    "function isOperationReady(bytes32 id) view returns (bool)",
    "function isOperationDone(bytes32 id) view returns (bool)",
    "function isOperationPending(bytes32 id) view returns (bool)",
    "function getMinDelay() view returns (uint256)"
  ], l1);

  // Use the operation ID from your scheduling
  const operationId = "0xaafef8c788db4d6d17bfca087b9e31bceab489f3207b64d640b49b6c8cedb6fa";
  
  console.log("=== OPERATION STATUS CHECK ===");
  console.log("Operation ID:", operationId);
  console.log("Scheduled: 24+ hours ago");
  
  try {
    const exists = await timelock.isOperation(operationId);
    const ready = await timelock.isOperationReady(operationId);
    const done = await timelock.isOperationDone(operationId);
    const pending = await timelock.isOperationPending(operationId);
    const minDelay = await timelock.getMinDelay();
    
    console.log("\n📊 Operation Status:");
    console.log(`Exists: ${exists ? '✅ YES' : '❌ NO'}`);
    console.log(`Ready: ${ready ? '✅ READY TO EXECUTE' : '❌ NOT READY'}`);
    console.log(`Done: ${done ? '✅ ALREADY EXECUTED' : '❌ NOT EXECUTED'}`);
    console.log(`Pending: ${pending ? '⏳ PENDING' : '✅ NOT PENDING'}`);
    console.log(`Min Delay: ${minDelay.toString()} seconds`);
    
    if (exists && ready && !done) {
      console.log("\n🎉 OPERATION IS READY FOR EXECUTION!");
      console.log("Run: node scripts/execute_timelock_transfer.js");
    } else if (done) {
      console.log("\n✅ OPERATION ALREADY COMPLETED!");
    } else if (!ready) {
      console.log("\n⏳ Operation not ready yet (should be ready after 24 hours)");
    }
    
  } catch (error) {
    console.log("Error checking operation:", error.shortMessage || error.message);
  }

  // Check current governance ownership
  console.log("\n=== CURRENT GOVERNANCE OWNERSHIP ===");
  const gov = new ethers.Contract(L1_GOV, [
    "function owner() view returns (address)",
    "function pendingOwner() view returns (address)"
  ], l1);

  try {
    const currentOwner = await gov.owner();
    const pendingOwner = await gov.pendingOwner();
    
    console.log("Current Owner:", currentOwner);
    console.log("Pending Owner:", pendingOwner);
    console.log("Timelock Address:", L1_TIMELOCK);
    console.log("Transfer Complete:", currentOwner === L1_TIMELOCK ? "✅ YES" : "❌ NO");
    
    if (currentOwner === L1_TIMELOCK) {
      console.log("\n🎉 GOVERNANCE TRANSFER ALREADY COMPLETE!");
    } else if (pendingOwner === L1_TIMELOCK) {
      console.log("\n🔄 Transfer pending - Timelock needs to accept ownership");
    }
  } catch (error) {
    console.log("Error checking governance:", error.shortMessage || error.message);
  }
}

main().catch(console.error);