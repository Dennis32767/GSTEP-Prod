require("dotenv").config();
const { ethers } = require("ethers");

async function main() {
  const L1_RPC = process.env.SEPOLIA_RPC_URL;
  const L1_GOV = process.env.L1_GOVERNANCE_ADDR;
  const L1_TIMELOCK = process.env.L1_TIMELOCK;

  const provider = new ethers.JsonRpcProvider(L1_RPC);

  console.log("=== VERIFYING OWNERSHIP STRUCTURE ===");
  console.log("L1 Governance:", L1_GOV);
  console.log("L1 Timelock:  ", L1_TIMELOCK);

  // Check if the governance contract is owned by the timelock
  const gov = new ethers.Contract(L1_GOV, [
    "function owner() view returns (address)",
    "function pendingOwner() view returns (address)"
  ], provider);

  const govOwner = await gov.owner();
  const govPendingOwner = await gov.pendingOwner();

  console.log("\n📋 Governance Contract Ownership:");
  console.log("Current Owner:  ", govOwner);
  console.log("Pending Owner:  ", govPendingOwner);
  console.log("Timelock Addr:  ", L1_TIMELOCK);
  console.log("Owned by Timelock:", govOwner.toLowerCase() === L1_TIMELOCK.toLowerCase());

  // Check if timelock is a multisig (has multiple owners/roles)
  const timelock = new ethers.Contract(L1_TIMELOCK, [
    "function hasRole(bytes32 role, address account) view returns (bool)",
    "function getRoleAdmin(bytes32 role) view returns (bytes32)",
    "function getRoleMemberCount(bytes32 role) view returns (uint256)",
    "function PROPOSER_ROLE() view returns (bytes32)",
    "function EXECUTOR_ROLE() view returns (bytes32)",
    "function CANCELLER_ROLE() view returns (bytes32)",
    "function TIMELOCK_ADMIN_ROLE() view returns (bytes32)"
  ], provider);

  try {
    // Check for OpenZeppelin TimelockController roles
    const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
    const EXECUTOR_ROLE = await timelock.EXECUTOR_ROLE();
    const CANCELLER_ROLE = await timelock.CANCELLER_ROLE();
    const TIMELOCK_ADMIN_ROLE = await timelock.TIMELOCK_ADMIN_ROLE();

    console.log("\n🔐 Timelock Roles Structure:");

    // Check proposers (who can schedule operations)
    const proposerCount = await timelock.getRoleMemberCount(PROPOSER_ROLE);
    console.log("Proposers Count:", proposerCount.toString());

    for (let i = 0; i < Number(proposerCount); i++) {
      const proposer = await timelock.getRoleMember(PROPOSER_ROLE, i);
      console.log(`  Proposer ${i}: ${proposer}`);
    }

    // Check executors (who can execute operations)
    const executorCount = await timelock.getRoleMemberCount(EXECUTOR_ROLE);
    console.log("Executors Count:", executorCount.toString());

    for (let i = 0; i < Number(executorCount); i++) {
      const executor = await timelock.getRoleMember(EXECUTOR_ROLE, i);
      console.log(`  Executor ${i}: ${executor}`);
    }

    // Check cancellers (who can cancel operations)
    const cancellerCount = await timelock.getRoleMemberCount(CANCELLER_ROLE);
    console.log("Cancellers Count:", cancellerCount.toString());

    for (let i = 0; i < Number(cancellerCount); i++) {
      const canceller = await timelock.getRoleMember(CANCELLER_ROLE, i);
      console.log(`  Canceller ${i}: ${canceller}`);
    }

    // Check admins (who can manage roles)
    const adminCount = await timelock.getRoleMemberCount(TIMELOCK_ADMIN_ROLE);
    console.log("Admins Count:", adminCount.toString());

    for (let i = 0; i < Number(adminCount); i++) {
      const admin = await timelock.getRoleMember(TIMELOCK_ADMIN_ROLE, i);
      console.log(`  Admin ${i}: ${admin}`);
    }

    // Determine if this is a multisig setup
    const isMultisig = Number(proposerCount) > 1 || Number(executorCount) > 1 || Number(adminCount) > 1;
    console.log("\n🎯 Multisig Analysis:");
    console.log("Is Multisig Setup:", isMultisig ? "✅ YES" : "❌ NO");

    if (isMultisig) {
      console.log("This timelock is configured for multi-signature control.");
    } else {
      console.log("This timelock appears to be single-owner controlled.");
    }

  } catch (error) {
    console.log("\n⚠️  Could not read timelock roles (might be a different timelock implementation)");
    console.log("Error:", error.message);
    
    // Try alternative timelock ABI
    const simpleTimelock = new ethers.Contract(L1_TIMELOCK, [
      "function admin() view returns (address)",
      "function pendingAdmin() view returns (address)"
    ], provider);

    try {
      const admin = await simpleTimelock.admin();
      const pendingAdmin = await simpleTimelock.pendingAdmin();
      
      console.log("\n📋 Simple Timelock Structure:");
      console.log("Admin:        ", admin);
      console.log("Pending Admin:", pendingAdmin);
      console.log("Is Multisig:  ❌ NO (Single admin)");
    } catch (e) {
      console.log("Also couldn't read as simple timelock:", e.message);
    }
  }

  // Check original deployment parameters
  console.log("\n🔍 Checking Original Deployment:");
  
  // Get the deployment transaction to see initial owner
  const govContract = new ethers.Contract(L1_GOV, [
    "function owner() view returns (address)"
  ], provider);

  const currentOwner = await govContract.owner();
  console.log("Current Governance Owner:", currentOwner);

  // Check if this matches your expected multisig address
  const expectedMultisig = process.env.NEW_L1_OWNER || process.env.DEPLOYER_EOA;
  if (expectedMultisig) {
    console.log("Expected Owner (from .env):", expectedMultisig);
    console.log("Matches Expected:", currentOwner.toLowerCase() === expectedMultisig.toLowerCase());
  }

  console.log("\n💡 Summary:");
  if (govOwner.toLowerCase() === L1_TIMELOCK.toLowerCase()) {
    console.log("✅ Governance is owned by Timelock (correct setup)");
    console.log("✅ All governance actions must go through timelock process");
  } else {
    console.log("❌ Governance is NOT owned by Timelock");
    console.log("💡 You may need to transfer ownership to the timelock");
  }
}

main().catch(console.error);