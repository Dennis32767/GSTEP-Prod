// scripts/governance_schedule_update.js
// Schedules a param update on L2 via L1 Governance + Timelock, using current minDelay.

require("dotenv").config();
const { ethers } = require("ethers");

async function main() {
  const L1_RPC      = process.env.SEPOLIA_RPC_URL;
  const L2_RPC      = process.env.ARBITRUM_SEPOLIA_RPC_URL;
  const L1_GOV      = process.env.L1_GOVERNANCE_ADDR;
  const L1_TIMELOCK = process.env.L1_TIMELOCK;
  const L2_TOK      = process.env.L2_TOKEN_PROXY;
  const PK          = process.env.L1_OWNER_PK;

  if (!L1_RPC || !L2_RPC || !L1_GOV || !L1_TIMELOCK || !L2_TOK || !PK) {
    throw new Error("Missing one of SEPOLIA_RPC_URL, ARBITRUM_SEPOLIA_RPC_URL, L1_GOVERNANCE_ADDR, L1_TIMELOCK, L2_TOKEN_PROXY, L1_OWNER_PK");
  }

  const l1 = new ethers.JsonRpcProvider(L1_RPC);
  const l2 = new ethers.JsonRpcProvider(L2_RPC);
  const wallet = new ethers.Wallet(PK, l1);

  console.log("=== SCHEDULE GOVERNANCE PARAM UPDATE ===");
  console.log("Using wallet:", await wallet.getAddress());
  console.log("L1 Timelock: ", L1_TIMELOCK);
  console.log("L1 Governor: ", L1_GOV);
  console.log("L2 Token:    ", L2_TOK);

  const timelock = new ethers.Contract(
    L1_TIMELOCK,
    [
      "function schedule(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt, uint256 delay)",
      "function getMinDelay() view returns (uint256)",
      "function hashOperation(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt) view returns (bytes32)"
    ],
    wallet
  );

  const gov = new ethers.Contract(
    L1_GOV,
    [
      "function quoteRetryable(bytes,uint256) view returns (uint256,uint256,uint256)",
      "function callL2(bytes) payable returns (uint256)"
    ],
    wallet
  );

  const token = new ethers.Contract(
    L2_TOK,
    [
      "function getCoreParams() view returns (uint256,uint256,uint256,uint256)",
      "function l2UpdateParams(uint256,uint256)"
    ],
    l2
  );

  // ----------------------------------------------------------------
  // 1) Read current params
  // ----------------------------------------------------------------
  const [burnFee, rewardRate, stepLimit, sigValidity] = await token.getCoreParams();
  console.log("\n📊 Current L2 Parameters:");
  console.log("  stepLimit:  ", stepLimit.toString());
  console.log("  rewardRate: ", rewardRate.toString());

  // ----------------------------------------------------------------
  // 2) Target params (CLI overrides or defaults)
  //    Usage:
  //      node scripts/governance_schedule_update.js [stepLimit] [rewardRateWei]
  // ----------------------------------------------------------------
  const cliLimit = process.argv[2];
  const cliRate  = process.argv[3];

  const newLimit = cliLimit ? BigInt(cliLimit) : 6000n;
  const newRate  = cliRate  ? BigInt(cliRate)  : 2000000000000000000n; // 2e18

  console.log("\n🎯 Target Parameters:");
  console.log("  stepLimit:  ", newLimit.toString());
  console.log("  rewardRate: ", newRate.toString());

  if (stepLimit === newLimit && rewardRate === newRate) {
    console.log("\n✅ Parameters already match target values. Nothing to schedule.");
    return;
  }

  // ----------------------------------------------------------------
  // 3) Build L2 + L1 governance calldata
  // ----------------------------------------------------------------
  const l2Interface  = new ethers.Interface(["function l2UpdateParams(uint256,uint256)"]);
  const govInterface = new ethers.Interface(["function callL2(bytes) payable returns (uint256)"]);

  const l2CallData  = l2Interface.encodeFunctionData("l2UpdateParams", [newLimit, newRate]);
  const govCallData = govInterface.encodeFunctionData("callL2", [l2CallData]);

  // ----------------------------------------------------------------
  // 4) Quote retryable & determine required msg.value
  // ----------------------------------------------------------------
  const [total, submissionFee, gasFee] = await gov.quoteRetryable(l2CallData, 0n);
  const requiredValue = total + (total * 15n) / 100n; // 15% buffer

  console.log("\n💰 ETH Required for Cross-Chain Call (estimate):");
  console.log("  Submission fee: ", ethers.formatEther(submissionFee), "ETH");
  console.log("  Gas fee:        ", ethers.formatEther(gasFee), "ETH");
  console.log("  Total:          ", ethers.formatEther(total), "ETH");
  console.log("  With 15% buffer:", ethers.formatEther(requiredValue), "ETH");

  const balance = await l1.getBalance(wallet.address);
  console.log("  Wallet balance: ", ethers.formatEther(balance), "ETH");

  if (balance < requiredValue) {
    throw new Error(
      `❌ Insufficient balance. Need ${ethers.formatEther(requiredValue)} ETH but have ${ethers.formatEther(balance)} ETH`
    );
  }

  // ----------------------------------------------------------------
  // 5) Timelock configuration (now uses current minDelay, i.e. 3600s)
  // ----------------------------------------------------------------
  const minDelay = await timelock.getMinDelay();
  const predecessor = ethers.ZeroHash;
  const salt = ethers.hexlify(ethers.randomBytes(32));

  console.log("\n⏰ Timelock Configuration:");
  console.log("  Min Delay:", minDelay.toString(), "seconds");
  console.log("  Min Delay:", (minDelay / 3600n).toString(), "hours");
  console.log("  Salt:", salt);

  // ----------------------------------------------------------------
  // 6) Schedule operation
  // ----------------------------------------------------------------
  console.log("\n📅 Scheduling governance operation...");
  const scheduleTx = await timelock.schedule(
    L1_GOV,
    requiredValue,    // value the TL will forward when executing
    govCallData,
    predecessor,
    salt,
    minDelay          // use current TL delay (now 3600)
  );

  console.log("📝 Schedule Tx:", scheduleTx.hash);
  const scheduleReceipt = await scheduleTx.wait();
  console.log("✅ Scheduled in block:", scheduleReceipt.blockNumber);

  // Compute operationId
  const operationId = await timelock.hashOperation(
    L1_GOV,
    requiredValue,
    govCallData,
    predecessor,
    salt
  );

  const readyTime = new Date(Date.now() + Number(minDelay) * 1000);

  console.log("\n🎯 NEW OPERATION SCHEDULED SUCCESSFULLY!");
  console.log("  operationId :", operationId);
  console.log("  salt        :", salt);
  console.log("  ETH Value   :", ethers.formatEther(requiredValue), "ETH");
  console.log("  stepLimit   :", newLimit.toString());
  console.log("  rewardRate  :", newRate.toString());
  console.log("  Ready at    :", readyTime.toISOString());
  console.log("  Local time  :", readyTime.toLocaleString());

  console.log("\n📋 NEXT STEP (after delay elapses):");
  console.log("  node scripts/governance_execute_update.js", operationId, salt, newLimit.toString(), newRate.toString());

  console.log("\n💡 You can also check status with:");
  console.log("  node scripts/check_status.js", operationId);
}

main().catch((err) => {
  console.error("❌ Error scheduling governance update:", err);
  process.exit(1);
});
