require("dotenv").config();
const { ethers } = require("ethers");

async function main() {
  const L1_RPC = process.env.SEPOLIA_RPC_URL;
  const L1_GOV = process.env.L1_GOVERNANCE_ADDR;
  const L1_TIMELOCK = process.env.L1_TIMELOCK;
  const PK = process.env.L1_OWNER_PK;

  const l1 = new ethers.JsonRpcProvider(L1_RPC);
  const wallet = new ethers.Wallet(PK, l1);

  console.log("=== PROPER TIMELOCK OWNERSHIP TRANSFER ===");
  console.log("Timelock:", L1_TIMELOCK);
  console.log("Governance:", L1_GOV);
  console.log("Executor:", await wallet.getAddress());

  // Check current state
  const gov = new ethers.Contract(L1_GOV, [
    "function owner() view returns (address)",
    "function pendingOwner() view returns (address)"
  ], l1);

  const currentOwner = await gov.owner();
  const pendingOwner = await gov.pendingOwner();

  console.log("\n📋 Current Status:");
  console.log("Current Owner:", currentOwner);
  console.log("Pending Owner:", pendingOwner);

  if (currentOwner.toLowerCase() === L1_TIMELOCK.toLowerCase()) {
    console.log("✅ Ownership already transferred to Timelock");
    return;
  }

  // Check Timelock configuration
  const timelock = new ethers.Contract(L1_TIMELOCK, [
    "function getMinDelay() view returns (uint256)",
    "function PROPOSER_ROLE() view returns (bytes32)",
    "function hasRole(bytes32 role, address account) view returns (bool)",
    "function schedule(address target, uint256 value, bytes calldata data, bytes32 predecessor, bytes32 salt, uint256 delay)",
    "function hashOperation(address target, uint256 value, bytes calldata data, bytes32 predecessor, bytes32 salt) view returns (bytes32)"
  ], wallet);

  const minDelay = await timelock.getMinDelay();
  const proposerRole = await timelock.PROPOSER_ROLE();
  const hasProposerRole = await timelock.hasRole(proposerRole, await wallet.getAddress());

  console.log("\n⏰ Timelock Configuration:");
  console.log("Min Delay:", minDelay.toString(), "seconds");
  console.log("Min Delay:", (minDelay / 3600n).toString(), "hours");
  console.log("Has PROPOSER_ROLE:", hasProposerRole);

  if (!hasProposerRole) {
    console.log("❌ You don't have PROPOSER_ROLE in the Timelock");
    console.log("💡 You need to grant yourself PROPOSER_ROLE first");
    return;
  }

  // Prepare the operation with proper delay
  const govInterface = new ethers.Interface([
    "function acceptOwnership()"
  ]);

  const callData = govInterface.encodeFunctionData("acceptOwnership");
  const predecessor = ethers.ZeroHash;
  const salt = ethers.id("ACCEPT_OWNERSHIP_" + Date.now());
  const operationId = await timelock.hashOperation(L1_GOV, 0, callData, predecessor, salt);

  console.log("\n🎯 Scheduling Ownership Acceptance:");
  console.log("Operation ID:", operationId);
  console.log("Delay:", minDelay.toString(), "seconds");
  console.log("Expected Execution Time: ~1 hours from now");

  // Schedule the operation
  console.log("\n⏳ Scheduling operation...");
  const scheduleTx = await timelock.schedule(
    L1_GOV, 
    0, 
    callData, 
    predecessor, 
    salt, 
    minDelay
  );
  console.log("📝 Schedule Tx:", scheduleTx.hash);
  await scheduleTx.wait();
  console.log("✅ Operation scheduled successfully!");

  console.log("\n📋 NEXT STEPS:");
  console.log("1. Wait 1 hours for the timelock delay");
  console.log("2. Then run: node scripts/timelock_execute_transfer.js");
  console.log("3. Or use this operation ID to execute:", operationId);
  
  console.log("\n💡 For testing, you might want to:");
  console.log("   - Redeploy Timelock with shorter delay (1 hour)");
  console.log("   - Continue testing emergency controls in the meantime");
  console.log("   - The governance transfer will complete in 1 hours");
}

main().catch(console.error);