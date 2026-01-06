require("dotenv").config();
const { ethers } = require("ethers");

async function main() {
  const L1_RPC = process.env.SEPOLIA_RPC_URL;
  const L1_GOV = process.env.L1_GOVERNANCE_ADDR;
  const L1_TIMELOCK = process.env.L1_TIMELOCK;
  const PK = process.env.L1_OWNER_PK;

  const l1 = new ethers.JsonRpcProvider(L1_RPC);
  const wallet = new ethers.Wallet(PK, l1);

  console.log("=== TRANSFER L1 GOVERNANCE OWNERSHIP ===");
  console.log("From Wallet:", await wallet.getAddress());
  console.log("Current Gov Owner:", await getCurrentOwner(L1_GOV, l1));
  console.log("New Owner (Timelock):", L1_TIMELOCK);

  const gov = new ethers.Contract(L1_GOV, [
    "function owner() view returns (address)",
    "function transferOwnership(address)",
    "function pendingOwner() view returns (address)"
  ], wallet);

  // Check current state
  const currentOwner = await gov.owner();
  if (currentOwner.toLowerCase() === L1_TIMELOCK.toLowerCase()) {
    console.log("✅ Ownership already transferred to Timelock");
    return;
  }

  console.log("⏳ Transferring ownership...");
  const tx = await gov.transferOwnership(L1_TIMELOCK);
  console.log("📝 Transfer Tx:", tx.hash);
  
  const receipt = await tx.wait();
  console.log("✅ Transfer confirmed in block:", receipt.blockNumber);

  // Verify
  const pendingOwner = await gov.pendingOwner();
  console.log("Pending Owner:", pendingOwner);
  
  if (pendingOwner.toLowerCase() === L1_TIMELOCK.toLowerCase()) {
    console.log("🎉 Ownership transfer initiated successfully!");
    console.log("The Timelock must now call acceptOwnership() to complete the transfer.");
  }
}

async function getCurrentOwner(govAddress, provider) {
  const gov = new ethers.Contract(govAddress, [
    "function owner() view returns (address)"
  ], provider);
  return await gov.owner();
}

main().catch(console.error);