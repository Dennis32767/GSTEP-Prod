/* eslint-disable no-console */
require("dotenv").config();
const hre = require("hardhat");
const { ethers } = hre;

/**
 * Run with:
 *  - L2 checks:   --network arbitrumSepolia
 *  - L1 actions:  --network sepolia (for the L1 part)
 *
 * Or split into two runs (recommended): first L2 tests on Arb-Sepolia, then L1 tests on Sepolia.
 * Below script autodetects and runs what’s possible per network name.
 */

async function main() {
  console.log("🔎 Validating L2-First Architecture…");
  const net = hre.network.name;

  if (net.toLowerCase().includes("arbitrum")) {
    await validateOnL2();
  } else if (net.toLowerCase().includes("sepolia")) {
    await validateOnL1();
  } else {
    console.warn(`⚠️ Unknown network "${net}". Use --network arbitrumSepolia or --network sepolia`);
  }
  console.log("🎉 Validation script finished for network:", net);
}

/* -------------------------------------------------------------------------- */
/*                                  L2 SIDE                                   */
/* -------------------------------------------------------------------------- */

async function validateOnL2() {
  const l2TokenAddr = mustEnv("L2_TOKEN");
  const userAddr = mustEnv("L2_USER");

  const token = await ethers.getContractAt("GemStepToken", l2TokenAddr);
  console.log("L2 token:", token.target);

  await assertL2UserOps(token, userAddr);
  await assertL2CrossChainState(token);
}

async function assertL2UserOps(token, userAddr) {
  console.log("1) ✅ L2 user operations");

  // 1a. Transfers (read-only check = balances move via a small self-transfer or zero-value?)
  const userBalBefore = await token.balanceOf(userAddr);

  // If you have a small faucet amount in the script signer, do a tiny transfer to the user for a positive test.
  const [signer] = await ethers.getSigners();
  const signerBal = await token.balanceOf(signer.address);
  if (signerBal > 0n) {
    const tx = await token.connect(signer).transfer(userAddr, 1n);
    await tx.wait();
  }

  const userBalAfter = await token.balanceOf(userAddr);
  assertTrue(userBalAfter >= userBalBefore, "L2 transfer sanity failed");

  // 1b. Step tracking basic read checks
  const stepLimit = await token.stepLimit();
  assertTrue(stepLimit > 0n, "stepLimit must be > 0");

  // 1c. Reward params exist
  const rewardRate = await token.rewardRate();
  assertTrue(rewardRate > 0n, "rewardRate must be > 0");

  console.log("   ✔ transfers, stepLimit, rewardRate sane");
}

async function assertL2CrossChainState(token) {
  console.log("2) 🔄 L2 cross-chain view sanity");

  // Ensure the getter exists and returns an address (may be zero pre-config)
  let l1Gov = ethers.ZeroAddress;
  try {
    l1Gov = await token.getL1Governance();
  } catch {
    throw new Error("getL1Governance() missing on L2 implementation");
  }
  console.log("   L1 governance (L2 view):", l1Gov);

  // Ensure L2 has Arbitrum config fields populated (at least inbox)
  const [inbox, , , maxGas, gasPriceBid, maxSubmissionCost] = await token.getArbitrumConfig();
  assertAddr(inbox, "Arbitrum inbox not set on L2");
  assertTrue(maxGas > 0n && gasPriceBid >= 0n && maxSubmissionCost >= 0n, "Arb gas params not sane");

  console.log("   ✔ cross-chain config getters are present & sane");
}

/* -------------------------------------------------------------------------- */
/*                                  L1 SIDE                                   */
/* -------------------------------------------------------------------------- */

async function validateOnL1() {
  console.log("L1 (Sepolia) checks…");
  const inboxAddr = mustEnv("L1_INBOX");
  const l2TokenAddr = mustEnv("L2_TOKEN");

  // 1) send pause retryable (true), 2) send unpause (false)
  await sendL1ToL2Pause(inboxAddr, l2TokenAddr, true);
  await sendL1ToL2Pause(inboxAddr, l2TokenAddr, false);

  // 3) optional param update call
  await sendL1ToL2UpdateParams(inboxAddr, l2TokenAddr, {
    newStepLimit: 8_000n,
    newRewardRate: 10n ** 18n, // 1e18
  });

  console.log("   ✔ L1→L2 messaging submitted (verify redemption on Arbiscan Arb-Sepolia).");
}

async function sendL1ToL2Pause(inboxAddr, l2TokenAddr, paused) {
  console.log(`2) L1→L2 pause=${paused}`);
  const inbox = new ethers.Contract(inboxAddr, [ABI.createRetryable], (await ethers.getSigners())[0]);

  const data = new ethers.Interface(["function l2SetPause(bool)"])
    .encodeFunctionData("l2SetPause", [paused]);

  const gasLimit = 1_000_000n; // safe test default
  const maxFeePerGas = ethers.parseUnits("0.2", "gwei");
  const maxSubmissionCost = ethers.parseEther("0.0003");
  const msgValue = maxSubmissionCost + gasLimit * maxFeePerGas;

  const tx = await inbox.createRetryableTicket(
    l2TokenAddr,
    0, // l2CallValue
    maxSubmissionCost,
    (await ethers.getSigners())[0].address, // refund L2 addr
    (await ethers.getSigners())[0].address, // callValue refund L2 addr
    gasLimit,
    maxFeePerGas,
    data,
    { value: msgValue }
  );
  console.log("   L1 tx:", tx.hash);
  await tx.wait();
}

async function sendL1ToL2UpdateParams(inboxAddr, l2TokenAddr, { newStepLimit, newRewardRate }) {
  console.log("3) L1→L2 params update");
  const signer = (await ethers.getSigners())[0];
  const inbox = new ethers.Contract(inboxAddr, [ABI.createRetryable], signer);

  const data = new ethers.Interface(["function l2UpdateParams(uint256,uint256)"])
    .encodeFunctionData("l2UpdateParams", [newStepLimit, newRewardRate]);

  const gasLimit = 1_000_000n;
  const maxFeePerGas = ethers.parseUnits("0.2", "gwei");
  const maxSubmissionCost = ethers.parseEther("0.0003");
  const msgValue = maxSubmissionCost + gasLimit * maxFeePerGas;

  const tx = await inbox.createRetryableTicket(
    l2TokenAddr,
    0,
    maxSubmissionCost,
    signer.address,
    signer.address,
    gasLimit,
    maxFeePerGas,
    data,
    { value: msgValue }
  );
  console.log("   L1 tx:", tx.hash);
  await tx.wait();
}

/* -------------------------------------------------------------------------- */
/*                                   utils                                    */
/* -------------------------------------------------------------------------- */

const ABI = {
  createRetryable:
    "function createRetryableTicket(address to,uint256 l2CallValue,uint256 maxSubmissionCost,address excessFeeRefundAddress,address callValueRefundAddress,uint256 gasLimit,uint256 maxFeePerGas,bytes data) payable returns (uint256)",
};

function mustEnv(k) {
  const v = process.env[k];
  if (!v || !v.trim()) throw new Error(`Missing env ${k}`);
  return v.trim();
}

function assertTrue(cond, msg) {
  if (!cond) throw new Error(msg || "assertTrue failed");
}

function assertAddr(addr, msg) {
  if (!addr || addr === ethers.ZeroAddress) throw new Error(msg || "zero addr");
}

/* -------------------------------------------------------------------------- */

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
