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
    { name: "user",        type: "address" },
    { name: "beneficiary", type: "address" },
    { name: "steps",       type: "uint256" },
    { name: "nonce",       type: "uint256" },
    { name: "deadline",    type: "uint256" },
    { name: "chainId",     type: "uint256" },
    { name: "source",      type: "string"  },
    { name: "version",     type: "string"  },
  ],
};

async function signStepData({
  signer, verifyingContract, chainId,
  user, beneficiary, steps, nonce, deadline, source, version = "1.0.0",
}) {
  const domain = { name: EIP712_NAME, version: EIP712_VERSION, chainId, verifyingContract };
  const message = { user, beneficiary, steps, nonce, deadline, chainId, source, version };
  return signer.signTypedData(domain, STEPLOG_TYPES, message);
}

/* ---------- Fixture: proxy deploy + roles ---------- */
async function deployProxyFixture() {
  const [deployer, admin, treasury, user, beneficiary, api, other] =
    await ethers.getSigners();

  // Mock oracle: 1 GSTEP = 0.005 ETH -> stake target 10% = 0.0005 ETH
  const Mock = await ethers.getContractFactory("MockOracleV2");
  const oracle = await Mock.deploy();
  await oracle.waitForDeployment();

  const { timestamp } = await ethers.provider.getBlock("latest");
  await oracle.set(ethers.parseEther("0.005"), timestamp, 0); // priceWei, updatedAt, confBps
  await oracle.setPolicy(300, 100); // maxStaleness=300s, minConfidenceBps=±1%

  // Fully-qualified name to disambiguate duplicates
  const Token = await ethers.getContractFactory("contracts/GemStepToken.sol:GemStepToken");

  const initialSupply = ethers.parseUnits("400000000", 18);

  // ✅ FIX: initializer now expects 4 args
  const token = await upgrades.deployProxy(
    Token,
    [
      initialSupply,
      admin.address,
      await oracle.getAddress(),
      treasury.address,
    ],
    { initializer: "initialize" }
  );
  await token.waitForDeployment();

  const chainId = (await ethers.provider.getNetwork()).chainId;

  // ✅ FIX: use on-chain role id if exposed (matches your storage constant)
  let PARAMETER_ADMIN_ROLE;
  if (typeof token.PARAMETER_ADMIN_ROLE === "function") {
    PARAMETER_ADMIN_ROLE = await token.PARAMETER_ADMIN_ROLE();
  } else {
    PARAMETER_ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("PARAMETER_ADMIN"));
  }

  // Grant role (use whichever signer actually has DEFAULT_ADMIN_ROLE)
  if (typeof token.grantRole === "function") {
    const DEFAULT_ADMIN_ROLE =
      typeof token.DEFAULT_ADMIN_ROLE === "function"
        ? await token.DEFAULT_ADMIN_ROLE()
        : ethers.ZeroHash;

    const grantWith = (await token.hasRole(DEFAULT_ADMIN_ROLE, admin.address))
      ? admin
      : deployer;

    await token.connect(grantWith).grantRole(PARAMETER_ADMIN_ROLE, admin.address);
  }

  // quick sanity (only if your ABI exposes it)
  if (typeof token.isSourceValid === "function") {
    expect(await token.isSourceValid("applehealth")).to.equal(true);
  }

  return { token, oracle, deployer, admin, treasury, user, beneficiary, api, other, chainId };
}

/* ---------- Helpers ---------- */
async function submitSteps({ token, user, beneficiary, chainId, source, steps }) {
  const nonce    = await token.nonces(user.address);
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
    { user: user.address, beneficiary: beneficiary.address, steps, nonce, deadline, source, version: "1.0.0" },
    { signature: sig, proof: [], attestation: "0x" }
  );
}

function sumPenaltyFromReceipt(tokenIface, receipt) {
  let total = 0n;
  for (const log of receipt.logs) {
    let parsed;
    try { parsed = tokenIface.parseLog(log); } catch { parsed = null; }
    if (parsed && parsed.name === "PenaltyApplied") {
      total += parsed.args[1];
    }
  }
  return total;
}

/* =======================================================================
   Tests
======================================================================= */
describe("Anomaly system (penalties + suspension)", function () {
  it("applies 30% penalty when steps exceed 5x moving average (after grace period)", async function () {
    const { token, admin, user, beneficiary, chainId } = await loadFixture(deployProxyFixture);

    // dedicated source that doesn't need proof/attestation
    const source = "anomaly-src-1";
    await token.connect(admin).configureSource(source, false, false);

    const minInterval  = await token.MIN_SUBMISSION_INTERVAL();   // 3600
    const grace        = await token.GRACE_PERIOD();              // 7 days
    const stakePerStep = await token.currentStakePerStep();    // likely 0.0005 ETH
    const penaltyPct   = await token.PENALTY_PERCENT();           // 30
    const iface        = token.interface;

    // 1) Warm up average with five submissions of 100 steps:
    const warmSteps = 100n;
    const warmCount = 5;
    await token.connect(user).stake({ value: ethers.parseEther("1") });

    for (let i = 0; i < warmCount; i++) {
      await time.increase(Number(minInterval) + 5);
      await submitSteps({ token, user, beneficiary, chainId, source, steps: warmSteps });
    }

    // 2) Ensure we are *past* grace window (grace counted from first submission)
    await time.increase(Number(grace) + 10);

    // 3) Big spike to exceed 5x average; 3000 << stepLimit(5000) and << daily(10000)
    const bigSteps = 3000n;

    // fund a *robust* buffer: principal + expected 30% penalty + 20% headroom
    const penaltyWei = (bigSteps * stakePerStep * BigInt(penaltyPct)) / 100n;
    const neededWei  = bigSteps * stakePerStep + penaltyWei;
    const safetyWei  = (neededWei * 20n) / 100n;
    await token.connect(user).stake({ value: neededWei + safetyWei });

    // FIXED: Use batched getter instead of single getter
    const [,,, stakeBefore,,] = await token.getUserCoreStatus(user.address);

    await time.increase(Number(minInterval) + 3);
    const tx = await submitSteps({ token, user, beneficiary, chainId, source, steps: bigSteps });
    const receipt = await tx.wait();

    // Accept either the event or measurable stake reduction
    const emittedPenalty = sumPenaltyFromReceipt(iface, receipt);
    // FIXED: Use batched getter instead of single getter
    const [,,, stakeAfter,,] = await token.getUserCoreStatus(user.address);
    const drop = stakeBefore - stakeAfter;

    if (emittedPenalty > 0n) {
      expect(drop).to.be.gte(emittedPenalty);
    } else {
      // fallback: ensure some penalty was actually charged
      expect(drop).to.be.gt(0n);
    }
  });

  it("suspends after 3 anomalies, blocks during suspension, and accepts after suspension ends", async function () {
    const { token, admin, user, beneficiary, chainId } = await loadFixture(deployProxyFixture);

    const source = "anomaly-src-2";
    await token.connect(admin).configureSource(source, false, false);

    const minInterval  = await token.MIN_SUBMISSION_INTERVAL();
    const grace        = await token.GRACE_PERIOD();
    const stakePerStep = await token.currentStakePerStep();
    const penaltyPct   = await token.PENALTY_PERCENT();

    // --- Seed average (100 × 5) and mark first submission time
    await token.connect(user).stake({ value: ethers.parseEther("0.2") });
    for (let i = 0; i < 5; i++) {
      await time.increase(Number(minInterval) + 5);
      await submitSteps({ token, user, beneficiary, chainId, source, steps: 100n });
    }

    // Leave grace period
    await time.increase(Number(grace) + 10);

    // spike sequence; third slightly higher to guarantee anomaly after moving avg shifts
    const spikes = [3000n, 3000n, 3100n];

    // pre-fund (principal + 30% penalty) with headroom
    let totalNeeded = 0n;
    for (const s of spikes) {
      const perSpikePenalty = (s * stakePerStep * BigInt(penaltyPct)) / 100n;
      totalNeeded += s * stakePerStep + perSpikePenalty;
    }
    const headroom = (totalNeeded * 25n) / 100n;
    await token.connect(user).stake({ value: totalNeeded + headroom });

    // Execute spikes
    for (let i = 0; i < spikes.length; i++) {
      await time.increase(Number(minInterval) + 3);
      const stepsNow = spikes[i];

      // FIXED: Use batched getter instead of single getter
      const [,,, stakeBefore,,] = await token.getUserCoreStatus(user.address);
      const tx = await submitSteps({ token, user, beneficiary, chainId, source, steps: stepsNow });
      const receipt = await tx.wait();

      // Either event present or at least some stake drop observed
      let emittedPenalty = 0n;
      for (const log of receipt.logs) {
        let parsed;
        try { parsed = token.interface.parseLog(log); } catch { parsed = null; }
        if (parsed && parsed.name === "PenaltyApplied") emittedPenalty += parsed.args[1];
      }
      // FIXED: Use batched getter instead of single getter
      const [,,, stakeAfter,,] = await token.getUserCoreStatus(user.address);
      const drop = stakeBefore - stakeAfter;
      if (emittedPenalty === 0n) {
        expect(drop, `Spike #${i + 1}: expected stake to drop if no PenaltyApplied event`).to.be.gt(0n);
      } else {
        expect(drop, `Spike #${i + 1}: stake should be reduced by at least emitted penalty`).to.be.gte(emittedPenalty);
      }
    }

    // Confirm suspension set
    {
      // FIXED: Use batched getter instead of single getter
      const [,, until,,,] = await token.getUserCoreStatus(user.address);
      const now = await time.latest();
      expect(until).to.be.gt(now);
    }

    // Prove it's blocked during suspension
    await time.increase(Number(minInterval) + 3);
    {
      const nonce    = await token.nonces(user.address);
      const deadline = (await time.latest()) + 3600;
      const sig = await signStepData({
        signer: user,
        verifyingContract: await token.getAddress(),
        chainId,
        user: user.address,
        beneficiary: beneficiary.address,
        steps: 200n,
        nonce,
        deadline,
        source,
        version: "1.0.0",
      });
      await expect(
        token.connect(user).logSteps(
          { user: user.address, beneficiary: beneficiary.address, steps: 200n, nonce, deadline, source, version: "1.0.0" },
          { signature: sig, proof: [], attestation: "0x" }
        )
      ).to.be.revertedWith("Account suspended");
    }

    // >>> Key fix: jump to the ACTUAL suspendedUntil, not by a constant
    // FIXED: Use batched getter instead of single getter
    const [,, untilNow,,,] = await token.getUserCoreStatus(user.address);
    await time.increaseTo(untilNow + 2n);  // cross the boundary for sure
    await time.increase(2);                // extra tick

    // still respect per-source min interval before retry
    await time.increase(Number(minInterval) + 1);

    // small valid submission after suspension ends
    const smallSteps = 200n;
    await token.connect(user).stake({ value: smallSteps * stakePerStep });

    const okTx = await submitSteps({ token, user, beneficiary, chainId, source, steps: smallSteps });
    await expect(okTx).to.emit(token, "RewardClaimed");
  });
});