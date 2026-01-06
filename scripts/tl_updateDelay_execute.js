// scripts/tl_updateDelay_execute.js
// Executes TimelockController.updateDelay(3600) that was previously scheduled.

require("dotenv").config();
const { ethers } = require("ethers");

async function main() {
  const RPC = process.env.SEPOLIA_RPC_URL;
  const TL  = process.env.L1_TIMELOCK;
  const PK  = process.env.L1_OWNER_PK; // same proposer EOA (or any EXECUTOR)

  const operationId = process.argv[2];
  const salt        = process.argv[3];

  if (!RPC || !TL || !PK) {
    throw new Error("Missing SEPOLIA_RPC_URL, L1_TIMELOCK or L1_OWNER_PK in .env");
  }

  if (!operationId || !salt) {
    console.log("Usage:");
    console.log("  node scripts/tl_updateDelay_execute.js <operationId> <salt>");
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet   = new ethers.Wallet(PK, provider);

  console.log("=== EXECUTE Timelock.updateDelay(3600) ===");
  console.log("Timelock    :", TL);
  console.log("Executor    :", await wallet.getAddress());
  console.log("operationId :", operationId);
  console.log("salt        :", salt);

  const timelock = new ethers.Contract(
    TL,
    [
      "function execute(address target,uint256 value,bytes data,bytes32 predecessor,bytes32 salt) external payable",
      "function isOperationReady(bytes32 id) external view returns (bool)",
      "function isOperationDone(bytes32 id) external view returns (bool)",
      "function hashOperation(address target,uint256 value,bytes data,bytes32 predecessor,bytes32 salt) external view returns (bytes32)",
      "function getMinDelay() view returns (uint256)"
    ],
    wallet
  );

  const NEW_DELAY = 3600n;
  const predecessor = ethers.ZeroHash;
  const value       = 0n;
  const target      = TL;

  // Rebuild the calldata exactly as in schedule script
  const iface = new ethers.Interface([
    "function updateDelay(uint256 newDelay)"
  ]);
  const data = iface.encodeFunctionData("updateDelay", [NEW_DELAY]);

  // Sanity: recompute opId and compare
  const calcId = await timelock.hashOperation(
    target,
    value,
    data,
    predecessor,
    salt
  );

  console.log("\nCalculated operationId:", calcId);
  console.log("Provided   operationId:", operationId);
  if (calcId.toLowerCase() !== operationId.toLowerCase()) {
    console.log("❌ Mismatch between provided operationId and calculated one.");
    console.log("   Check that you passed the correct salt & opId.");
    process.exit(1);
  }

  // Check status
  const ready = await timelock.isOperationReady(operationId);
  const done  = await timelock.isOperationDone(operationId);

  console.log("\nStatus:");
  console.log("  ready:", ready);
  console.log("  done :", done);

  if (done) {
    console.log("✅ Operation already executed.");
    const newDelay = await timelock.getMinDelay();
    console.log("Current minDelay:", newDelay.toString(), "seconds");
    return;
  }

  if (!ready) {
    console.log("❌ Operation is not ready yet (minDelay not elapsed).");
    return;
  }

  // Execute
  console.log("\n🚀 Executing updateDelay(3600) via Timelock...");
  const tx = await timelock.execute(
    target,
    value,
    data,
    predecessor,
    salt,
    { gasLimit: 250000 }
  );
  console.log("📝 Execute tx:", tx.hash);
  const receipt = await tx.wait();
  console.log("✅ Executed in block:", receipt.blockNumber);

  const finalDelay = await timelock.getMinDelay();
  console.log("\n🎉 Timelock minDelay updated!");
  console.log("New minDelay:", finalDelay.toString(), "seconds");
}

main().catch((err) => {
  console.error("❌ Error executing updateDelay:", err);
  process.exit(1);
});
