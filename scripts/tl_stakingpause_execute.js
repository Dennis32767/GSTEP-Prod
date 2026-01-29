/* eslint-disable no-console */
require("dotenv").config();
const { ethers } = require("ethers");

async function main() {
  const argv = process.argv.slice(2);
  const opId  = argv[0];
  const salt  = argv[1];
  const wantOn  = argv.includes("--on");
  const wantOff = argv.includes("--off");

  if (!opId || !salt || (!wantOn && !wantOff)) {
    console.log("Usage:");
    console.log("  node scripts/tl_staking_pause_execute.js <operationId> <salt> --on");
    console.log("  node scripts/tl_staking_pause_execute.js <operationId> <salt> --off");
    process.exit(1);
  }
  const targetPaused = wantOn;

  const L1_RPC      = (process.env.SEPOLIA_RPC_URL || "").trim();
  const L2_RPC      = (process.env.ARBITRUM_SEPOLIA_RPC_URL || "").trim();
  const L1_GOV      = (process.env.L1_GOVERNANCE_ADDR || "").trim();
  const L1_TIMELOCK = (process.env.L1_TIMELOCK || "").trim();
  const L2_TOK      = (process.env.L2_TOKEN_PROXY || "").trim();
  const PK          = (process.env.L1_OWNER_PK || "").trim();
  const bumpPctEnv  = process.env.L1_MSGVALUE_BUMP_PCT || "15";

  if (!/^https?:\/\//.test(L1_RPC)) throw new Error("SEPOLIA_RPC_URL missing/invalid");
  if (!/^https?:\/\//.test(L2_RPC)) throw new Error("ARBITRUM_SEPOLIA_RPC_URL missing/invalid");
  if (!/^0x[a-fA-F0-9]{40}$/.test(L1_GOV)) throw new Error("L1_GOVERNANCE_ADDR invalid");
  if (!/^0x[a-fA-F0-9]{40}$/.test(L1_TIMELOCK)) throw new Error("L1_TIMELOCK invalid");
  if (!/^0x[a-fA-F0-9]{40}$/.test(L2_TOK)) throw new Error("L2_TOKEN_PROXY invalid");
  if (!/^0x[0-9a-fA-F]{64}$/.test(PK)) throw new Error("L1_OWNER_PK invalid");
  if (!/^0x[0-9a-fA-F]{64}$/.test(salt)) throw new Error("salt must be 0x + 32 bytes hex");

  const bumpPct = Number(bumpPctEnv);

  const l1 = new ethers.JsonRpcProvider(L1_RPC);
  const l2 = new ethers.JsonRpcProvider(L2_RPC);
  const wallet = new ethers.Wallet(PK, l1);

  console.log("=== EXECUTE L2", targetPaused ? "STAKING PAUSE" : "STAKING UNPAUSE", "(via Timelock) ===");
  console.log("Executor    :", await wallet.getAddress());
  console.log("Timelock    :", L1_TIMELOCK);
  console.log("Governor    :", L1_GOV);
  console.log("L2 Token    :", L2_TOK);
  console.log("operationId :", opId);
  console.log("salt        :", salt);
  console.log("target      :", targetPaused ? "STAKING PAUSE (true)" : "STAKING UNPAUSE (false)");

  const timelock = new ethers.Contract(
    L1_TIMELOCK,
    [
      "function execute(address target,uint256 value,bytes data,bytes32 predecessor,bytes32 salt) external payable returns (bytes32)",
      "function isOperationReady(bytes32 id) external view returns (bool)",
      "function isOperationDone(bytes32 id) external view returns (bool)",
      "function hashOperation(address target,uint256 value,bytes data,bytes32 predecessor,bytes32 salt) external pure returns (bytes32)"
    ],
    wallet
  );

  const gov = new ethers.Contract(
    L1_GOV,
    [
      "function quoteRetryable(bytes,uint256) view returns (uint256 total,uint256 submissionFee,uint256 gasFee)",
      "function callL2(bytes) payable returns (uint256)"
    ],
    wallet
  );

  // Rebuild calldata identically
  const l2Iface = new ethers.Interface(["function l2SetStakingPause(bool)"]);
  const l2CallData = l2Iface.encodeFunctionData("l2SetStakingPause", [targetPaused]);

  const govIface = new ethers.Interface(["function callL2(bytes) payable returns (uint256)"]);
  const govCallData = govIface.encodeFunctionData("callL2", [l2CallData]);

  // Recompute “configured funding” (caps) — must match schedule script
  const [total, submissionFee, gasFee] = await gov.quoteRetryable(l2CallData, 0n);
  const requiredValue = total + (total * BigInt(Math.round(bumpPct * 100))) / 10000n;

  console.log("\n💰 Recomputed ETH needed:");
  console.log("  submission fee:", ethers.formatEther(submissionFee), "ETH");
  console.log("  gas fee      :", ethers.formatEther(gasFee), "ETH");
  console.log(`  total + ${bumpPct}%:`, ethers.formatEther(requiredValue), "ETH");

  const predecessor = ethers.ZeroHash;

  console.log("\n🔍 Verifying operationId from reconstructed params...");
  const calculatedId = await timelock.hashOperation(
    L1_GOV,
    requiredValue,
    govCallData,
    predecessor,
    salt
  );
  console.log("  calculated:", calculatedId);
  console.log("  provided  :", opId);
  const match = calculatedId.toLowerCase() === opId.toLowerCase();
  console.log("  match     :", match);

  if (!match) {
    console.log("❌ OperationId mismatch. If gasConfig changed since scheduling, use the stored requiredValue from scheduling instead.");
    return;
  }

  const ready = await timelock.isOperationReady(opId);
  const done  = await timelock.isOperationDone(opId);
  console.log("\nStatus:");
  console.log("  ready:", ready);
  console.log("  done :", done);

  if (done) {
    console.log("✅ Operation already executed.");
    return;
  }
  if (!ready) {
    console.log("❌ Operation not ready yet (minDelay not elapsed).");
    return;
  }

  const bal = await l1.getBalance(wallet.address);
  console.log("\n💰 Wallet balance:", ethers.formatEther(bal), "ETH");
  console.log("💰 Required value:", ethers.formatEther(requiredValue), "ETH");
  if (bal < requiredValue) {
    throw new Error(`❌ Insufficient balance. Need ${ethers.formatEther(requiredValue)} ETH, have ${ethers.formatEther(bal)} ETH`);
  }

  console.log("\n🚀 Executing operation via Timelock.execute(...) …");
  const tx = await timelock.execute(
    L1_GOV,
    requiredValue,
    govCallData,
    predecessor,
    salt,
    { value: requiredValue, gasLimit: 500_000n }
  );
  console.log("📝 Execute tx:", tx.hash);
  const rc = await tx.wait();
  console.log("✅ Executed in block:", rc.blockNumber);

  console.log("\nℹ️ Staking pause is a token-internal flag; confirm via events (StakingPauseSet) on L2 or your views helper if you expose it.");
  console.log("🎉 Done.");
}

main().catch((e) => {
  console.error("❌ execute failed:", e.reason || e.shortMessage || e.message || e);
  process.exit(1);
});
