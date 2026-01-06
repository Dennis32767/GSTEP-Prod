// scripts/tl_updateDelay_schedule.js
// Schedules TimelockController.updateDelay(3600) using the current 24h minDelay.

require("dotenv").config();
const { ethers } = require("ethers");

async function main() {
  const RPC = process.env.SEPOLIA_RPC_URL;
  const TL  = process.env.L1_TIMELOCK;
  const PK  = process.env.L1_OWNER_PK; // EOA that has PROPOSER_ROLE on TL

  if (!RPC || !TL || !PK) {
    throw new Error("Missing SEPOLIA_RPC_URL, L1_TIMELOCK or L1_OWNER_PK in .env");
  }

  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet   = new ethers.Wallet(PK, provider);

  console.log("=== SCHEDULE Timelock.updateDelay(3600) ===");
  console.log("Timelock:", TL);
  console.log("Proposer wallet:", await wallet.getAddress());

  const timelock = new ethers.Contract(
    TL,
    [
      "function getMinDelay() view returns (uint256)",
      "function schedule(address target,uint256 value,bytes data,bytes32 predecessor,bytes32 salt,uint256 delay)",
      "function hashOperation(address target,uint256 value,bytes data,bytes32 predecessor,bytes32 salt) view returns (bytes32)"
    ],
    wallet
  );

  // 1) Inspect current delay
  const currentDelay = await timelock.getMinDelay();
  console.log("\nCurrent minDelay:", currentDelay.toString(), "seconds");

  // Safety: we expect 86400 (24h), but we just trust whatever is on-chain
  const NEW_DELAY = 3600n; // 1 hour in seconds

  console.log("\nTarget new minDelay:", NEW_DELAY.toString(), "seconds (1 hour)");

  // 2) Build calldata for updateDelay(uint256)
  const iface = new ethers.Interface([
    "function updateDelay(uint256 newDelay)"
  ]);
  const data = iface.encodeFunctionData("updateDelay", [NEW_DELAY]);

  const target      = TL;                 // timelock calls itself
  const value       = 0n;
  const predecessor = ethers.ZeroHash;
  const salt        = ethers.hexlify(ethers.randomBytes(32));
  const delay       = currentDelay;       // must be >= existing minDelay

  console.log("\nScheduling parameters:");
  console.log("  target      :", target);
  console.log("  value       :", value.toString());
  console.log("  predecessor :", predecessor);
  console.log("  salt        :", salt);
  console.log("  delay       :", delay.toString(), "seconds");

  // 3) Schedule operation
  console.log("\n⏰ Scheduling updateDelay operation via Timelock...");
  const tx = await timelock.schedule(
    target,
    value,
    data,
    predecessor,
    salt,
    delay
  );
  console.log("📝 Schedule tx:", tx.hash);
  const receipt = await tx.wait();
  console.log("✅ Scheduled in block:", receipt.blockNumber);

  // 4) Compute operationId for future reference
  const opId = await timelock.hashOperation(
    target,
    value,
    data,
    predecessor,
    salt
  );

  const readyTimeMs = Date.now() + Number(delay) * 1000;
  const readyTime   = new Date(readyTimeMs);

  console.log("\n🎯 OPERATION DETAILS");
  console.log("  operationId :", opId);
  console.log("  salt        :", salt);
  console.log("  newDelay    :", NEW_DELAY.toString(), "seconds");
  console.log("  ready at    :", readyTime.toISOString());
  console.log("  local time  :", readyTime.toLocaleString());

  console.log("\n📋 NEXT STEP (after delay elapses):");
  console.log("  node scripts/tl_updateDelay_execute.js", opId, salt);
}

main().catch((err) => {
  console.error("❌ Error scheduling updateDelay:", err);
  process.exit(1);
});
