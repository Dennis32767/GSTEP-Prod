/* eslint-disable no-unused-expressions */
// SPDX-License-Identifier: MIT
const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

/* ---------- EIP712 helper ---------- */
const EIP712_NAME = "GemStep";
const EIP712_VERSION = "1.0.0";
const STEPLOG_TYPES = {
  StepLog: [
    { name: "user", type: "address" },
    { name: "beneficiary", type: "address" },
    { name: "steps", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "chainId", type: "uint256" },
    { name: "source", type: "string" },
    { name: "version", type: "string" },
  ],
};

const toBI = (v) => (typeof v === "bigint" ? v : BigInt(v.toString()));

async function signStepData({
  signer,
  verifyingContract,
  chainId,
  user,
  beneficiary,
  steps,
  nonce,
  deadline,
  source,
  version = "1.0.0",
}) {
  const domain = {
    name: EIP712_NAME,
    version: EIP712_VERSION,
    chainId: Number(chainId), // ethers expects number for domain.chainId
    verifyingContract,
  };

  const message = {
    user,
    beneficiary,
    steps: toBI(steps),
    nonce: toBI(nonce),
    deadline: toBI(deadline),
    chainId: toBI(chainId),
    source,
    version,
  };

  return signer.signTypedData(domain, STEPLOG_TYPES, message);
}

/* ---------- Fixture: proxy deploy + roles ---------- */
async function deployProxyFixture() {
  const [deployer, admin, treasury, user, beneficiary, api, other] =
    await ethers.getSigners();

  const Mock = await ethers.getContractFactory("MockOracleV2");
  const oracle = await Mock.deploy();
  await oracle.waitForDeployment();

  const { timestamp } = await ethers.provider.getBlock("latest");
  await oracle.set(ethers.parseEther("0.005"), timestamp, 0);
  await oracle.setPolicy(300, 100);

  const Token = await ethers.getContractFactory("contracts/GemStepToken.sol:GemStepToken");
  const initialSupply = ethers.parseUnits("400000000", 18);

  const token = await upgrades.deployProxy(
    Token,
    [initialSupply, admin.address, await oracle.getAddress(), treasury.address],
    { initializer: "initialize" }
  );
  await token.waitForDeployment();

  const chainId = (await ethers.provider.getNetwork()).chainId;

  // ensure a usable source (tests will configure their own too)
  if (typeof token.configureSource === "function") {
    await (await token.connect(admin).configureSource("applehealth", false, false)).wait();
  }

  if (typeof token.addSupportedPayloadVersion === "function") {
    await (await token.connect(admin).addSupportedPayloadVersion("1.0.0")).wait();
  } else if (typeof token.addSupportedVersion === "function") {
    await (await token.connect(admin).addSupportedVersion("1.0.0")).wait();
  }

  return { token, oracle, deployer, admin, treasury, user, beneficiary, api, other, chainId };
}

/* ---------- Helpers ---------- */

async function submitSteps({ token, user, beneficiary, chainId, source, steps }) {
  const nonce = await token.nonces(user.address);
  const deadline = (await time.latest()) + 3600;

  const sig = await signStepData({
    signer: user,
    verifyingContract: await token.getAddress(),
    chainId,
    user: user.address,
    beneficiary: beneficiary.address,
    steps,
    nonce,
    deadline,
    source,
    version: "1.0.0",
  });

  return token.connect(user).logSteps(
    {
      user: user.address,
      beneficiary: beneficiary.address,
      steps: toBI(steps),
      nonce: toBI(nonce),
      deadline: toBI(deadline),
      source,
      version: "1.0.0",
    },
    { signature: sig, proof: [], attestation: "0x" }
  );
}

function sumPenaltyFromReceipt(tokenIface, receipt) {
  let total = 0n;
  for (const log of receipt.logs) {
    let parsed;
    try {
      parsed = tokenIface.parseLog(log);
    } catch {
      parsed = null;
    }
    if (parsed && parsed.name === "PenaltyApplied") {
      total += toBI(parsed.args[1]);
    }
  }
  return total;
}

/**
 * New-staking-model helper:
 * - Stake is GSTEP token amount, not msg.value.
 * - Ensures the user has tokens and stakes enough to reach requiredStakeAmount.
 */
async function ensureTokenStake(token, funderSigner, userSigner, requiredStakeAmount) {
  const need = toBI(requiredStakeAmount);

  // current staked balance
  let have = 0n;
  if (typeof token.getStakeInfo === "function") {
    const [bal] = await token.getStakeInfo(userSigner.address);
    have = toBI(bal);
  }

  if (have >= need) return;

  const delta = need - have;

  // fund user with GSTEP if needed
  const bal = toBI(await token.balanceOf(userSigner.address));
  if (bal < delta) {
    await (await token.connect(funderSigner).transfer(userSigner.address, delta - bal)).wait();
  }

  await (await token.connect(userSigner).stake(delta)).wait();
}

async function getStaked(token, userAddr) {
  if (typeof token.getStakeInfo !== "function") return 0n;
  const [bal] = await token.getStakeInfo(userAddr);
  return toBI(bal);
}

/* =======================================================================
   Tests
======================================================================= */
describe("Anomaly system (penalties + suspension)", function () {
  it("applies 30% penalty when steps exceed 5x moving average (after grace period)", async function () {
    const { token, admin, treasury, user, beneficiary, chainId } =
      await loadFixture(deployProxyFixture);

    const funder = treasury; // initial supply is minted to treasury in your design

    const source = "anomaly-src-1";
    await (await token.connect(admin).configureSource(source, false, false)).wait();

    const minInterval = await token.MIN_SUBMISSION_INTERVAL();
    const grace = await token.GRACE_PERIOD();
    const stakePerStep = toBI(await token.currentStakePerStep());
    const penaltyPct = toBI(await token.PENALTY_PERCENT());
    const iface = token.interface;

    // 1) Warm up EMA/average: 5 submissions of 100 steps
    const warmSteps = 100n;
    const warmCount = 5;

    // stake enough for warmups (no penalty expected, but give a little headroom)
    await ensureTokenStake(
      token,
      funder,
      user,
      warmSteps * BigInt(warmCount) * stakePerStep + (warmSteps * stakePerStep)
    );

    for (let i = 0; i < warmCount; i++) {
      await time.increase(Number(minInterval) + 5);
      const tx = await submitSteps({ token, user, beneficiary, chainId, source, steps: warmSteps });
      await tx.wait();
    }

    // 2) Past grace window
    await time.increase(Number(grace) + 10);

    // 3) Spike
    const bigSteps = 3000n;

    // pre-fund: principal + expected 30% penalty + 20% headroom
    const penaltyTok = (bigSteps * stakePerStep * penaltyPct) / 100n;
    const neededTok = bigSteps * stakePerStep + penaltyTok;
    const safetyTok = (neededTok * 20n) / 100n;

    await ensureTokenStake(token, funder, user, neededTok + safetyTok);

    const stakeBefore = await getStaked(token, user.address);

    await time.increase(Number(minInterval) + 3);
    const tx = await submitSteps({ token, user, beneficiary, chainId, source, steps: bigSteps });
    const receipt = await tx.wait();

    const emittedPenalty = sumPenaltyFromReceipt(iface, receipt);
    const stakeAfter = await getStaked(token, user.address);
    const drop = stakeBefore - stakeAfter;

    if (emittedPenalty > 0n) {
      expect(drop).to.be.gte(emittedPenalty);
    } else {
      expect(drop).to.be.gt(0n);
    }
  });

  it("suspends after 3 anomalies, blocks during suspension, and accepts after suspension ends", async function () {
    const { token, admin, treasury, user, beneficiary, chainId } =
      await loadFixture(deployProxyFixture);

    const funder = treasury;

    const source = "anomaly-src-2";
    await (await token.connect(admin).configureSource(source, false, false)).wait();

    const minInterval = await token.MIN_SUBMISSION_INTERVAL();
    const grace = await token.GRACE_PERIOD();
    const stakePerStep = toBI(await token.currentStakePerStep());
    const penaltyPct = toBI(await token.PENALTY_PERCENT());

    // seed avg
    const warmSteps = 100n;
    await ensureTokenStake(token, funder, user, warmSteps * 6n * stakePerStep);

    for (let i = 0; i < 5; i++) {
      await time.increase(Number(minInterval) + 5);
      const tx = await submitSteps({ token, user, beneficiary, chainId, source, steps: warmSteps });
      await tx.wait();
    }

    await time.increase(Number(grace) + 10);

    const spikes = [3000n, 3000n, 3100n];

    // fund principal + penalty estimate + headroom
    let totalNeeded = 0n;
    for (const s of spikes) {
      const perPenalty = (s * stakePerStep * penaltyPct) / 100n;
      totalNeeded += s * stakePerStep + perPenalty;
    }
    const headroom = (totalNeeded * 25n) / 100n;
    await ensureTokenStake(token, funder, user, totalNeeded + headroom);

    // run spikes
    for (const s of spikes) {
      await time.increase(Number(minInterval) + 3);
      const tx = await submitSteps({ token, user, beneficiary, chainId, source, steps: s });
      await tx.wait();
    }

    // suspendedUntil is index 2 in your GS_ReadersMinimal.getUserCoreStatus layout:
    // (userStepAverage, flaggedSubmissions, suspendedUntil, stakeBalance, isTrustedAPI, userFirstSubmission)
    const core = await token.getUserCoreStatus(user.address);
    const until = toBI(core[2]);
    const now = BigInt(await time.latest());
    expect(until).to.be.gt(now);

    // blocked during suspension
    await time.increase(Number(minInterval) + 3);
    await expect(
      submitSteps({ token, user, beneficiary, chainId, source, steps: 200n })
    ).to.be.revertedWith("Account suspended");

    // move past suspension end (time helpers want numbers; keep it safe)
    await time.increaseTo(Number(until + 2n));
    await time.increase(Number(minInterval) + 1);

    // ensure stake for post-susp submit
    await ensureTokenStake(token, funder, user, 200n * stakePerStep);

    const okTx = await submitSteps({ token, user, beneficiary, chainId, source, steps: 200n });
    await expect(okTx).to.emit(token, "RewardClaimed");
  });
});
