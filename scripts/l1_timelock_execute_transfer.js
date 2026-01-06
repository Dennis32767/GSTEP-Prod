require("dotenv").config();
const { ethers } = require("ethers");

async function main() {
  const L1_RPC = process.env.SEPOLIA_RPC_URL;
  const L1_GOV = process.env.L1_GOVERNANCE_ADDR;
  const L1_TIMELOCK = process.env.L1_TIMELOCK;
  const PK = process.env.L1_OWNER_PK;

  const l1 = new ethers.JsonRpcProvider(L1_RPC);
  const wallet = new ethers.Wallet(PK, l1);

  console.log("=== FINAL TIMELOCK OWNERSHIP TRANSFER ===");
  console.log("Timelock:", L1_TIMELOCK);
  console.log("Governance:", L1_GOV);
  console.log("Executor:", await wallet.getAddress());

  const timelock = new ethers.Contract(L1_TIMELOCK, [
    "function execute(address target, uint256 value, bytes calldata data, bytes32 predecessor, bytes32 salt) payable returns (bytes32)",
    "function isOperationReady(bytes32 id) view returns (bool)",
    "function isOperationDone(bytes32 id) view returns (bool)"
  ], wallet);

  // Exact parameters from scheduling
  const operationId = "0xaafef8c788db4d6d17bfca087b9e31bceab489f3207b64d640b49b6c8cedb6fa";
  const CORRECT_SALT = "0x7ad7377d3c2af9b988e051f518957065da879df01791d391ff89cbe9100dc8d2";
  const predecessor = ethers.ZeroHash;

  const govInterface = new ethers.Interface(["function acceptOwnership()"]);
  const callData = govInterface.encodeFunctionData("acceptOwnership");

  console.log("📋 Execution Parameters:");
  console.log("Operation ID:", operationId);
  console.log("Salt:", CORRECT_SALT);
  console.log("Predecessor:", predecessor);

  // Verify operation status
  console.log("\n🔍 Verifying operation status...");
  const isReady = await timelock.isOperationReady(operationId);
  const isDone = await timelock.isOperationDone(operationId);

  if (isDone) {
    console.log("✅ Operation already executed!");
    return;
  }

  if (!isReady) {
    console.log("❌ Operation not ready (unexpected after 1+ hours)");
    return;
  }

  console.log("✅ Operation ready! Executing transfer...");

  try {
    // Execute with proper gas settings
    const tx = await timelock.execute(L1_GOV, 0, callData, predecessor, CORRECT_SALT, {
      gasLimit: 250000,
      maxFeePerGas: ethers.parseUnits("30", "gwei"),
      maxPriorityFeePerGas: ethers.parseUnits("2", "gwei")
    });
    
    console.log("📝 Execute Tx:", tx.hash);
    console.log("⏳ Waiting for confirmation...");
    
    const receipt = await tx.wait();
    console.log("✅ Execute confirmed in block:", receipt.blockNumber);
    console.log("✅ Gas used:", receipt.gasUsed.toString());

    // Verify the transfer completed
    console.log("\n🔍 Verifying ownership transfer...");
    await verifyOwnershipTransfer(L1_GOV, L1_TIMELOCK, l1);

  } catch (error) {
    console.log("❌ Execution failed:", error.shortMessage || error.message);
    if (error.info && error.info.error) {
      console.log("Revert reason:", error.info.error.message);
    }
  }
}

async function verifyOwnershipTransfer(govAddr, timelockAddr, provider) {
  const gov = new ethers.Contract(govAddr, [
    "function owner() view returns (address)",
    "function pendingOwner() view returns (address)"
  ], provider);

  // Check multiple times as it might take a moment
  for (let i = 0; i < 3; i++) {
    const currentOwner = await gov.owner();
    const pendingOwner = await gov.pendingOwner();
    
    console.log(`\nVerification attempt ${i + 1}:`);
    console.log("Current Owner:", currentOwner);
    console.log("Pending Owner:", pendingOwner);
    console.log("Expected Owner:", timelockAddr);
    
    if (currentOwner.toLowerCase() === timelockAddr.toLowerCase()) {
      console.log("🎉 OWNERSHIP TRANSFER COMPLETE!");
      console.log("L1 Governor is now owned by L1 Timelock 🚀");
      return true;
    }
    
    if (i < 2) {
      console.log("⏳ Waiting for state update...");
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
  
  console.log("🔄 Ownership transfer may need more time to finalize");
  return false;
}

main().catch(console.error);