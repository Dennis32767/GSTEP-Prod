// scripts/governance_execute_update.js
// Executes a previously scheduled L2 param update via Timelock + L1 Governance.

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

  // CLI args: opId, salt, newLimit, newRate
  const opIdArg   = process.argv[2];
  const saltArg   = process.argv[3];
  const limitArg  = process.argv[4];
  const rateArg   = process.argv[5];

  if (!opIdArg || !saltArg || !limitArg || !rateArg) {
    console.log("Usage:");
    console.log("  node scripts/governance_execute_update.js <operationId> <salt> <stepLimit> <rewardRateWei>");
    process.exit(1);
  }

  const operationId = opIdArg;
  const salt        = saltArg;
  const newLimit    = BigInt(limitArg);
  const newRate     = BigInt(rateArg);

  const l1 = new ethers.JsonRpcProvider(L1_RPC);
  const l2 = new ethers.JsonRpcProvider(L2_RPC);
  const wallet = new ethers.Wallet(PK, l1);

  console.log("=== EXECUTE GOVERNANCE PARAM UPDATE ===");
  console.log("Executor    :", await wallet.getAddress());
  console.log("Timelock    :", L1_TIMELOCK);
  console.log("Governor    :", L1_GOV);
  console.log("L2 Token    :", L2_TOK);
  console.log("operationId :", operationId);
  console.log("salt        :", salt);
  console.log("stepLimit   :", newLimit.toString());
  console.log("rewardRate  :", newRate.toString());

  const timelock = new ethers.Contract(
    L1_TIMELOCK,
    [
      "function execute(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt) external payable returns (bytes32)",
      "function isOperationReady(bytes32 id) external view returns (bool)",
      "function isOperationDone(bytes32 id) external view returns (bool)",
      "function hashOperation(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt) external pure returns (bytes32)"
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
      "function getCoreParams() view returns (uint256,uint256,uint256,uint256)"
    ],
    l2
  );

  // ----------------------------------------------------------------
  // 1) Rebuild calldata + value exactly as in schedule script
  // ----------------------------------------------------------------
  const predecessor = ethers.ZeroHash;

  const l2Interface  = new ethers.Interface(["function l2UpdateParams(uint256,uint256)"]);
  const govInterface = new ethers.Interface(["function callL2(bytes) payable returns (uint256)"]);

  const l2CallData  = l2Interface.encodeFunctionData("l2UpdateParams", [newLimit, newRate]);
  const govCallData = govInterface.encodeFunctionData("callL2", [l2CallData]);

  // Quote retryable again — deterministic if based on stored gasConfig
  const [total, submissionFee, gasFee] = await gov.quoteRetryable(l2CallData, 0n);
  const requiredValue = total + (total * 15n) / 100n;

  console.log("\n💰 Recomputed ETH Required (must match schedule):");
  console.log("  Submission fee: ", ethers.formatEther(submissionFee), "ETH");
  console.log("  Gas fee:        ", ethers.formatEther(gasFee), "ETH");
  console.log("  Total:          ", ethers.formatEther(total), "ETH");
  console.log("  With 15% buffer:", ethers.formatEther(requiredValue), "ETH");

  // ----------------------------------------------------------------
  // 2) Verify operationId matches these parameters
  // ----------------------------------------------------------------
  const calcId = await timelock.hashOperation(
    L1_GOV,
    requiredValue,
    govCallData,
    predecessor,
    salt
  );

  console.log("\n🔍 Verifying operation ID...");
  console.log("  Calculated:", calcId);
  console.log("  Provided  :", operationId);
  const match = calcId.toLowerCase() === operationId.toLowerCase();
  console.log("  Match     :", match ? "✅ YES" : "❌ NO");

  if (!match) {
    console.log("\n❌ Mismatch between provided operationId and reconstructed parameters.");
    console.log("   Make sure you passed the same stepLimit, rewardRate, and salt that were used when scheduling.");
    process.exit(1);
  }

  // ----------------------------------------------------------------
  // 3) Check operation status
  // ----------------------------------------------------------------
  const isReady = await timelock.isOperationReady(operationId);
  const isDone  = await timelock.isOperationDone(operationId);

  console.log("\nStatus:");
  console.log("  ready:", isReady);
  console.log("  done :", isDone);

  if (isDone) {
    console.log("✅ Operation already executed.");
    return;
  }
  if (!isReady) {
    console.log("❌ Operation not ready yet (minDelay not elapsed).");
    return;
  }

  // ----------------------------------------------------------------
  // 4) Check wallet balance
  // ----------------------------------------------------------------
  const balance = await l1.getBalance(wallet.address);
  console.log("\n💰 Wallet balance:", ethers.formatEther(balance), "ETH");
  console.log("💰 Required value:", ethers.formatEther(requiredValue), "ETH");

  if (balance < requiredValue) {
    throw new Error(
      `❌ Insufficient balance. Need ${ethers.formatEther(requiredValue)} ETH but have ${ethers.formatEther(balance)} ETH`
    );
  }

  // ----------------------------------------------------------------
  // 5) Execute via Timelock
  // ----------------------------------------------------------------
  try {
    console.log("\n🚀 Executing governance operation via Timelock...");
    const tx = await timelock.execute(
      L1_GOV,
      requiredValue,
      govCallData,
      predecessor,
      salt,
      {
        gasLimit: 500000,
        value: requiredValue
      }
    );

    console.log("📝 Execute tx:", tx.hash);
    const receipt = await tx.wait();
    console.log("✅ Executed in block:", receipt.blockNumber);
    console.log("🎉 Timelock operation executed!");
    console.log("💰 ETH sent for cross-chain call:", ethers.formatEther(requiredValue));

    // ----------------------------------------------------------------
    // 6) Poll L2 to confirm param update
    // ----------------------------------------------------------------
    console.log("\n⏳ Waiting for L2 parameter update (up to ~5 min)...");
    let attempts = 0;
    const maxAttempts = 30;

    while (attempts < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 10000)); // 10s

      const [burnFeeNew, rewardRateNew, stepLimitNew, sigValidityNew] =
        await token.getCoreParams();

      if (stepLimitNew === newLimit && rewardRateNew === newRate) {
        console.log("\n🎉 SUCCESS! L2 Parameters Updated:");
        console.log("  stepLimit:  ", stepLimitNew.toString(), "✅");
        console.log("  rewardRate: ", rewardRateNew.toString(), "✅");
        console.log("  burnFee:    ", burnFeeNew.toString());
        console.log("  sigValidity:", sigValidityNew.toString());
        return;
      }

      attempts++;
      process.stdout.write(`\r⏰ Waiting for L2... ${attempts * 10}s`);
    }

    console.log("\n⚠️ L2 update taking longer than expected.");
    console.log("   Check on Arbiscan:", `https://sepolia.arbiscan.io/address/${L2_TOK}`);
  } catch (err) {
    console.log("\n❌ Execution failed:", err.message);
    if (err.message.includes("revert")) {
      console.log("💡 Transaction reverted. Possible reasons:");
      console.log("   - Operation already executed");
      console.log("   - Caller doesn't have permission");
      console.log("   - Target contract reverted");
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("❌ Error in governance_execute_update:", err);
  process.exit(1);
});
