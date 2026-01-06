/* eslint-disable no-console */
require("dotenv").config();
const { ethers } = require("ethers");

async function main() {
  const argv = process.argv.slice(2);
  const wantOn = argv.includes("--on");
  const wantOff = argv.includes("--off");

  if (!wantOn && !wantOff) {
    console.log("Usage:");
    console.log("  node scripts/tl_pause_schedule.js --on   # schedule L2 pause");
    console.log("  node scripts/tl_pause_schedule.js --off  # schedule L2 unpause");
    process.exit(1);
  }
  const targetPaused = wantOn; // true = pause, false = unpause

  const L1_RPC       = (process.env.SEPOLIA_RPC_URL || "").trim();
  const L2_RPC       = (process.env.ARBITRUM_SEPOLIA_RPC_URL || "").trim();
  const L1_GOV       = (process.env.L1_GOVERNANCE_ADDR || "").trim();
  const L1_TIMELOCK  = (process.env.L1_TIMELOCK || "").trim();
  const L2_TOK       = (process.env.L2_TOKEN_PROXY || "").trim();
  const PK           = (process.env.L1_OWNER_PK || "").trim();
  const bumpPctEnv   = process.env.L1_MSGVALUE_BUMP_PCT || "15";

  if (!/^https?:\/\//.test(L1_RPC)) throw new Error("SEPOLIA_RPC_URL missing/invalid");
  if (!/^https?:\/\//.test(L2_RPC)) throw new Error("ARBITRUM_SEPOLIA_RPC_URL missing/invalid");
  if (!/^0x[a-fA-F0-9]{40}$/.test(L1_GOV)) throw new Error("L1_GOVERNANCE_ADDR invalid");
  if (!/^0x[a-fA-F0-9]{40}$/.test(L1_TIMELOCK)) throw new Error("L1_TIMELOCK invalid");
  if (!/^0x[a-fA-F0-9]{40}$/.test(L2_TOK)) throw new Error("L2_TOKEN_PROXY invalid");
  if (!/^0x[0-9a-fA-F]{64}$/.test(PK)) throw new Error("L1_OWNER_PK invalid");

  const bumpPct = Number(bumpPctEnv);

  const l1 = new ethers.JsonRpcProvider(L1_RPC);
  const l2 = new ethers.JsonRpcProvider(L2_RPC);
  const wallet = new ethers.Wallet(PK, l1);

  console.log("=== SCHEDULE L2", targetPaused ? "PAUSE" : "UNPAUSE", "(via Timelock) ===");
  console.log("Proposer wallet:", await wallet.getAddress());
  console.log("L1 Timelock    :", L1_TIMELOCK);
  console.log("L1 Governor    :", L1_GOV);
  console.log("L2 Token       :", L2_TOK);

  // Contracts
  const timelock = new ethers.Contract(
    L1_TIMELOCK,
    [
      "function schedule(address target,uint256 value,bytes data,bytes32 predecessor,bytes32 salt,uint256 delay)",
      "function getMinDelay() view returns (uint256)",
      "function hashOperation(address target,uint256 value,bytes data,bytes32 predecessor,bytes32 salt) view returns (bytes32)"
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

  const l2Token = new ethers.Contract(
    L2_TOK,
    [
      "function paused() view returns (bool)"
    ],
    l2
  );

  // Current L2 state
  const paused0 = await l2Token.paused().catch(() => false);
  console.log("\n📊 L2 State:");
  console.log("  paused() now:", paused0);
  console.log("  target      :", targetPaused);

  if (paused0 === targetPaused) {
    console.log("ℹ️ L2 already in desired state; you may not need this operation.");
  }

  // Build L2 call: l2SetPause(bool)
  const l2Iface = new ethers.Interface(["function l2SetPause(bool)"]);
  const l2CallData = l2Iface.encodeFunctionData("l2SetPause", [targetPaused]);

  // Wrap via L1 governance: callL2(bytes)
  const govIface = new ethers.Interface(["function callL2(bytes) payable returns (uint256)"]);
  const govCallData = govIface.encodeFunctionData("callL2", [l2CallData]);

  // Quote retryable costs
  const [total, submissionFee, gasFee] = await gov.quoteRetryable(l2CallData, 0n);
  const requiredValue = total + (total * BigInt(Math.round(bumpPct * 100))) / 10000n;

  console.log("\n💰 ETH Required for Retryable (before TL):");
  console.log("  submission fee:", ethers.formatEther(submissionFee), "ETH");
  console.log("  gas fee      :", ethers.formatEther(gasFee), "ETH");
  console.log("  total        :", ethers.formatEther(total), "ETH");
  console.log(`  + bump ${bumpPct}%:`, ethers.formatEther(requiredValue), "ETH");

  const balance = await l1.getBalance(wallet.address);
  console.log("  wallet bal   :", ethers.formatEther(balance), "ETH");
  if (balance < requiredValue) {
    throw new Error(
      `❌ Insufficient balance. Need ${ethers.formatEther(requiredValue)} ETH, have ${ethers.formatEther(balance)} ETH`
    );
  }

  // Timelock delay
  const minDelay = await timelock.getMinDelay();
  const predecessor = ethers.ZeroHash;
  const salt = ethers.hexlify(ethers.randomBytes(32));
  const now = Date.now();
  const readyTime = new Date(now + Number(minDelay) * 1000);

  console.log("\n⏰ Timelock Configuration:");
  console.log("  minDelay :", minDelay.toString(), "seconds");
  console.log("          =", (minDelay / 3600n).toString(), "hours");
  console.log("  salt    :", salt);
  console.log("  ready at:", readyTime.toISOString());
  console.log("  local   :", readyTime.toLocaleString());

  console.log(`\n📅 Scheduling ${targetPaused ? "PAUSE" : "UNPAUSE"} operation via Timelock...`);

  const scheduleTx = await timelock.schedule(
    L1_GOV,
    requiredValue,
    govCallData,
    predecessor,
    salt,
    minDelay
  );
  console.log("📝 Schedule tx:", scheduleTx.hash);
  const receipt = await scheduleTx.wait();
  console.log("✅ Scheduled in block:", receipt.blockNumber);

  const operationId = await timelock.hashOperation(
    L1_GOV,
    requiredValue,
    govCallData,
    predecessor,
    salt
  );

  console.log("\n🎯 OPERATION DETAILS");
  console.log("  operationId :", operationId);
  console.log("  salt        :", salt);
  console.log("  target      :", targetPaused ? "PAUSE (true)" : "UNPAUSE (false)");
  console.log("  L1 value    :", ethers.formatEther(requiredValue), "ETH");

  console.log("\n📋 NEXT STEP (after minDelay elapses):");
  console.log(
    `  node scripts/tl_pause_execute.js ${operationId} ${salt} ${targetPaused ? "--on" : "--off"}`
  );
}

main().catch((e) => {
  console.error("❌ schedule failed:", e.reason || e.shortMessage || e.message || e);
  process.exit(1);
});
