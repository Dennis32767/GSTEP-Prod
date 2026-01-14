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
  // --- normalize all uint256-like inputs to BigInt ---
  const toBI = (v) => (typeof v === "bigint" ? v : BigInt(v.toString()));

  const domain = {
    name: EIP712_NAME,
    version: EIP712_VERSION,
    chainId: toBI(chainId),               // ✅ BigInt
    verifyingContract,
  };

  const message = {
    user,
    beneficiary,
    steps: toBI(steps),                   // ✅ BigInt
    nonce: toBI(nonce),                   // ✅ BigInt
    deadline: toBI(deadline),             // ✅ BigInt
    chainId: toBI(chainId),               // ✅ BigInt (because your struct includes chainId)
    source,
    version,
  };

  return signer.signTypedData(domain, STEPLOG_TYPES, message);
}

/* ---------- Helper: refresh mock oracle timestamp (keeps maxStaleness = 300s) ---------- */
async function refreshOracle(oracle, priceEthString) {
  const { timestamp } = await ethers.provider.getBlock("latest");
  await oracle.set(ethers.parseEther(priceEthString), timestamp, 0); // priceWei, updatedAt, confBps
}
async function getSuspendedUntil(token, userAddr) {
  const s = await token.getUserCoreStatus(userAddr);

  // try common named return first
  if (s?.suspendedUntil !== undefined) return BigInt(s.suspendedUntil.toString());

  // otherwise, pick the largest bigint-like field (usually suspendedUntil is a future timestamp)
  let best = 0n;
  for (const v of s) {
    try {
      const b = BigInt(v.toString());
      if (b > best) best = b;
    } catch {}
  }
  return best;
}

/* ---------- Error helpers ---------- */
function _errMsg(e) {
  return `${e?.reason || ""} ${e?.shortMessage || ""} ${e?.message || ""}`.toLowerCase();
}
function isRewardTooSmall(e) {
  return _errMsg(e).includes("reward too small");
}
function isInsufficientStake(e) {
  return _errMsg(e).includes("insufficient stake");
}

/* ---------- Helper: min steps to satisfy MIN_REWARD_AMOUNT (best-effort floor) ---------- */
async function minStepsForReward(token) {
  const rr = BigInt((await token.rewardRate()).toString());

  let minReward = 0n;
  if (typeof token.MIN_REWARD_AMOUNT === "function") {
    minReward = BigInt((await token.MIN_REWARD_AMOUNT()).toString());
  } else if (typeof token.minRewardAmount === "function") {
    minReward = BigInt((await token.minRewardAmount()).toString());
  } else if (typeof token.getMinRewardAmount === "function") {
    minReward = BigInt((await token.getMinRewardAmount()).toString());
  } else {
    minReward = 0n;
  }

  if (minReward === 0n) return 1n;
  if (rr === 0n) return 1n;

  return (minReward + rr - 1n) / rr; // ceil
}

/* ---------- Helper: ensure caller has enough stake for a given step count ---------- */
async function ensureStakeForSteps(token, stakerSigner, stepsBI, headroomWei = 0n) {
  // Some flows bypass stake (trusted API) — only stake when stake() exists and signer is expected
  if (!token?.stake) return;

  const stakePerStep = await token.currentStakePerStep();
  const need = BigInt(stakePerStep.toString()) * BigInt(stepsBI.toString()) + BigInt(headroomWei);

  // Top-up only if userStake is available; else stake full need (safe in HH)
  let current = 0n;
  if (typeof token.userStake === "function") {
    current = BigInt((await token.userStake(stakerSigner.address)).toString());
  }

  if (current < need) {
    await token.connect(stakerSigner).stake({ value: need - current });
  }

  return { stakePerStep, need, current };
}

/**
 * bumpStepsPastMinReward (STAKE-AWARE)
 *
 * - starts at max(startSteps, computed floor)
 * - ensures stake for that steps amount BEFORE staticCall probe
 * - if probe fails with "Insufficient stake" -> stakes and retries same steps
 * - if probe fails with "Reward too small" -> doubles steps, tops up stake, retries
 *
 * buildArgs(stepsBI) must return: { payload, proofObj, caller }
 * NOTE: caller must be the signer used for logSteps (usually user or trusted api).
 */
async function bumpStepsPastMinReward({ token, startSteps, buildArgs, maxIters = 12 }) {
  let s = BigInt(startSteps || 1n);
  const floor = await minStepsForReward(token);
  if (s < floor) s = floor;

  for (let i = 0; i < maxIters; i++) {
    const { payload, proofObj, caller } = await buildArgs(s);

    // ✅ critical: stake BEFORE probing, otherwise you'll get "Insufficient stake"
    await ensureStakeForSteps(token, caller, s);

    try {
      await token.connect(caller).logSteps.staticCall(payload, proofObj);
      return s;
    } catch (e) {
      if (isInsufficientStake(e)) {
        // stake & retry same s
        await ensureStakeForSteps(token, caller, s);
        i -= 1;
        continue;
      }
      if (isRewardTooSmall(e)) {
        s = s * 2n;
        // loop continues; stake top-up happens next iteration
        continue;
      }
      throw e;
    }
  }

  throw new Error("Could not bump steps past MIN_REWARD within iterations");
}

/* ---------- Deploy fixture (MockOracleV2, staleness = 300s) ---------- */
async function deployProxyFixture() {
  const [deployer, admin, treasury, user, beneficiary, api, other] =
    await ethers.getSigners();

  const Mock = await ethers.getContractFactory("MockOracleV2");
  const oracle = await Mock.deploy();
  await oracle.waitForDeployment();

  await refreshOracle(oracle, "0.005");
  await oracle.setPolicy(300, 100); // maxStaleness=300s, minConfidenceBps=±1%

  const Token = await ethers.getContractFactory(
    "contracts/GemStepToken.sol:GemStepToken"
  );

  const initialSupply = ethers.parseUnits("400000000", 18);

  const token = await upgrades.deployProxy(
    Token,
    [initialSupply, admin.address, await oracle.getAddress(), treasury.address],
    { initializer: "initialize" }
  );
  await token.waitForDeployment();

  const chainId = BigInt((await ethers.provider.getNetwork()).chainId.toString());

  // Ensure PARAMETER_ADMIN_ROLE
  let PARAMETER_ADMIN_ROLE;
  if (typeof token.PARAMETER_ADMIN_ROLE === "function") {
    PARAMETER_ADMIN_ROLE = await token.PARAMETER_ADMIN_ROLE();
  } else {
    PARAMETER_ADMIN_ROLE = ethers.keccak256(
      ethers.toUtf8Bytes("PARAMETER_ADMIN_ROLE")
    );
  }

  if (typeof token.hasRole === "function" && typeof token.grantRole === "function") {
    const has = await token.hasRole(PARAMETER_ADMIN_ROLE, admin.address);
    if (!has) {
      const DEFAULT_ADMIN_ROLE =
        typeof token.DEFAULT_ADMIN_ROLE === "function"
          ? await token.DEFAULT_ADMIN_ROLE()
          : ethers.ZeroHash;

      const grantWith = (await token.hasRole(DEFAULT_ADMIN_ROLE, admin.address))
        ? admin
        : deployer;

      await token.connect(grantWith).grantRole(PARAMETER_ADMIN_ROLE, admin.address);
    }
  }

  // Ensure a known usable source exists
  if (typeof token.configureSource === "function") {
    await token.connect(admin).configureSource("applehealth", false, false);
  }

  // Ensure payload version supported if gated
  if (typeof token.addSupportedPayloadVersion === "function") {
    await token.connect(admin).addSupportedPayloadVersion("1.0.0");
  } else if (typeof token.addSupportedVersion === "function") {
    await token.connect(admin).addSupportedVersion("1.0.0");
  }

  return {
    token,
    oracle,
    deployer,
    admin,
    treasury,
    user,
    beneficiary,
    api,
    other,
    chainId,
    initialSupply,
  };
}

/* =======================================================================
   Core suite
======================================================================= */
describe("GemStepToken — Proxy + Upgrade + Staking", function () {
  it("initializes behind proxy and mints initial supply to treasury", async function () {
    const { token, treasury, initialSupply } = await loadFixture(deployProxyFixture);
    expect(await token.totalSupply()).to.equal(initialSupply);
    expect(await token.balanceOf(treasury.address)).to.equal(initialSupply);
  });

  it("requires sufficient stake for user submissions and mints rewards", async function () {
  const { token, user, beneficiary, chainId } = await loadFixture(deployProxyFixture);

  const source = "applehealth";

  // retry loop: if "Reward too small", double steps and try again
  let steps = 100n;

  for (let i = 0; i < 12; i++) {
    // ensure stake for this steps value
    await ensureStakeForSteps(token, user, steps);

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

    const before = await token.balanceOf(beneficiary.address);

    try {
      const tx = await token.connect(user).logSteps(
        { user: user.address, beneficiary: beneficiary.address, steps, nonce, deadline, source, version: "1.0.0" },
        { signature: sig, proof: [], attestation: "0x" }
      );

      await expect(tx).to.emit(token, "RewardClaimed");
      await tx.wait();

      const after = await token.balanceOf(beneficiary.address);
      const delta = after - before;

      expect(delta).to.be.gt(0n);
      return; // ✅ success
    } catch (e) {
      const msg = _errMsg(e);
      if (msg.includes("reward too small")) {
        steps *= 2n;
        continue;
      }
      throw e;
    }
  }

  throw new Error("Could not find steps large enough to pass MIN_REWARD within iterations");
});


  it("reverts when user stake is insufficient", async function () {
    const { token, user, beneficiary, chainId } = await loadFixture(deployProxyFixture);

    const source = "applehealth";
    let steps = 1000n;

    // ensure we don't fail for Reward too small first
    const floor = await minStepsForReward(token);
    if (steps < floor) steps = floor;

    const nonce = await token.nonces(user.address);
    const deadline = (await time.latest()) + 3600;

    await token.connect(user).stake({ value: ethers.parseEther("0.00000001") });

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

    await expect(
      token.connect(user).logSteps(
        { user: user.address, beneficiary: beneficiary.address, steps, nonce, deadline, source, version: "1.0.0" },
        { signature: sig, proof: [], attestation: "0x" }
      )
    ).to.be.revertedWith("Insufficient stake");
  });

  it("trusted API bypasses user stake check when signature is from API_SIGNER", async function () {
    const { token, admin, api, user, beneficiary, chainId } = await loadFixture(deployProxyFixture);
    await token.connect(admin).setTrustedAPI(api.address, true);

    const source = "applehealth";
    let steps = 5000n;

    // ensure reward isn't too small
    const floor = await minStepsForReward(token);
    if (steps < floor) steps = floor;

    const nonce = await token.nonces(user.address);
    const deadline = (await time.latest()) + 3600;

    const deployer = (await ethers.getSigners())[0];
    const sig = await signStepData({
      signer: deployer,
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

    await expect(
      token.connect(api).logSteps(
        { user: user.address, beneficiary: beneficiary.address, steps, nonce, deadline, source, version: "1.0.0" },
        { signature: sig, proof: [], attestation: "0x" }
      )
    ).to.emit(token, "RewardClaimed");
  });

  it("adjusts stake via oracle (cooldown + bounds) and can lock/unlock + manual override", async function () {
    const { token, oracle, admin, deployer } = await loadFixture(deployProxyFixture);

    const cooldown = await token.STAKE_ADJUST_COOLDOWN();
    await time.increase(cooldown + 1n);

    await refreshOracle(oracle, "0.005");
    await expect(token.connect(admin).adjustStakeRequirements())
      .to.emit(token, "StakeParametersUpdated");

    expect(await token.currentStakePerStep()).to.equal(ethers.parseEther("0.0005"));

    await expect(token.connect(admin).adjustStakeRequirements())
      .to.be.revertedWith("Cooldown active");

    await time.increase(cooldown + 1n);
    await refreshOracle(oracle, "0.0000005");
    await expect(token.connect(admin).adjustStakeRequirements())
      .to.emit(token, "StakeParametersUpdated");
    expect(await token.currentStakePerStep()).to.equal(ethers.parseEther("0.0000001"));

    await expect(token.connect(deployer).manualOverrideStake(ethers.parseEther("0.0002")))
      .to.emit(token, "StakeParametersUpdated");
    expect(await token.currentStakePerStep()).to.equal(ethers.parseEther("0.0002"));

    await expect(token.connect(deployer).toggleStakeParamLock())
      .to.emit(token, "StakeEmergencyLocked");
    expect(await token.stakeParamsLocked()).to.equal(true);

    await time.increase(cooldown + 1n);
    await refreshOracle(oracle, "0.005");
    await expect(token.connect(admin).adjustStakeRequirements())
      .to.be.revertedWith("Stake parameters locked");
    await expect(token.connect(deployer).manualOverrideStake(ethers.parseEther("0.0003")))
      .to.be.revertedWith("Stake parameters locked");

    await token.connect(deployer).toggleStakeParamLock();
    await token.connect(deployer).manualOverrideStake(ethers.parseEther("0.0003"));
    expect(await token.currentStakePerStep()).to.equal(ethers.parseEther("0.0003"));
  });

  it("rejects stale nonce (cannot reuse a prior signature after nonce increments)", async function () {
    const { token, user, beneficiary, chainId } = await loadFixture(deployProxyFixture);

    const source = "applehealth";
    let steps = 10n;

    // ✅ stake-aware bump to satisfy reward floor + stake before first log
    steps = await bumpStepsPastMinReward({
      token,
      startSteps: steps,
      buildArgs: async (stepsBI) => {
        const nonce = await token.nonces(user.address);
        const deadline = (await time.latest()) + 3600;

        const sig = await signStepData({
          signer: user,
          verifyingContract: await token.getAddress(),
          chainId,
          user: user.address,
          beneficiary: beneficiary.address,
          steps: stepsBI,
          nonce,
          deadline,
          source,
          version: "1.0.0",
        });

        return {
          caller: user,
          payload: { user: user.address, beneficiary: beneficiary.address, steps: stepsBI, nonce, deadline, source, version: "1.0.0" },
          proofObj: { signature: sig, proof: [], attestation: "0x" },
        };
      },
    });

    await ensureStakeForSteps(token, user, steps);

    const n0 = await token.nonces(user.address);
    const d0 = (await time.latest()) + 3600;

    const sig0 = await signStepData({
      signer: user,
      verifyingContract: await token.getAddress(),
      chainId,
      user: user.address,
      beneficiary: beneficiary.address,
      steps,
      nonce: n0,
      deadline: d0,
      source,
      version: "1.0.0",
    });

    await token.connect(user).logSteps(
      { user: user.address, beneficiary: beneficiary.address, steps, nonce: n0, deadline: d0, source, version: "1.0.0" },
      { signature: sig0, proof: [], attestation: "0x" }
    );

    await expect(
      token.connect(user).logSteps(
        { user: user.address, beneficiary: beneficiary.address, steps, nonce: n0, deadline: d0, source, version: "1.0.0" },
        { signature: sig0, proof: [], attestation: "0x" }
      )
    ).to.be.revertedWith("Invalid nonce");
  });

  it("allows withdrawStake when not paused", async function () {
    const { token, user } = await loadFixture(deployProxyFixture);
    await token.connect(user).stake({ value: ethers.parseEther("0.001") });

    const amt = ethers.parseEther("0.0005");
    const addr = await token.getAddress();
    const before = await ethers.provider.getBalance(addr);

    await token.connect(user).withdrawStake(amt);
    const after = await ethers.provider.getBalance(addr);
    expect(before - after).to.equal(amt);
  });

  it("upgrades to V2, runs initializeV2, and preserves key state", async function () {
    const { token } = await loadFixture(deployProxyFixture);

    const proxyAddr = await token.getAddress();
    const nameBefore = await token.name();
    const symBefore = await token.symbol();
    const supplyBefore = await token.totalSupply();

    const V2 = await ethers.getContractFactory("GemStepTokenV2Mock");
    const v2 = await upgrades.upgradeProxy(proxyAddr, V2);
    await v2.waitForDeployment();

    await expect(v2.initializeV2()).to.emit(v2, "VersionUpgraded").withArgs(2);
    expect(await v2.version()).to.equal(2);

    expect(await v2.name()).to.equal(nameBefore);
    expect(await v2.symbol()).to.equal(symBefore);
    expect(await v2.totalSupply()).to.equal(supplyBefore);

    expect(await v2.newFunction()).to.equal(true);

    const [,, user] = await ethers.getSigners();
    await expect(v2.setRewardMultiplier(user.address, 7))
      .to.emit(v2, "RewardMultiplierSet").withArgs(user.address, 7);
    expect(await v2.userRewardMultipliers(user.address)).to.equal(7);
  });
});

/* =======================================================================
   Suspension flow (3 anomalies → suspend → reject during → accept after)
======================================================================= */
describe("Fraud prevention suspension", function () {
  it("suspends after 3 anomalies, then accepts after suspension ends", async function () {
    const { token, admin, user, beneficiary, chainId } = await loadFixture(deployProxyFixture);

    const source = "susp-src";
    await token.connect(admin).configureSource(source, false, false);

    const minInterval = await token.MIN_SUBMISSION_INTERVAL();
    const GRACE = await token.GRACE_PERIOD();
    const SUSP = await token.SUSPENSION_DURATION();

    // ------------------------------------------------------------------
    // 0) Pull step caps, but SANITY-CLAMP them to safe, human-sized values
    // ------------------------------------------------------------------

    // Per-submission cap (stepLimit)
    let perSubmissionCap = 10_000n;
    try {
      if (typeof token.stepLimit === "function") {
        const v = await token.stepLimit();
        const b = BigInt(v.toString());
        // sanity: anything above 1,000,000 is “not a steps cap”
        perSubmissionCap = (b > 0n && b <= 1_000_000n) ? b : 10_000n;
      }
    } catch {}

    // Per-day cap for this source (config.maxStepsPerDay)
    // If your configureSource sets maxStepsPerDay internally, it should be 10k, but read if available.
    let perDayCap = 10_000n;
    try {
      if (typeof token.getSourceConfig === "function") {
        const cfg = await token.getSourceConfig(source);
        // tuple: (requiresProof, requiresAttestation, merkleRoot, maxStepsPerDay, minInterval)
        const md = BigInt(cfg.maxStepsPerDay?.toString?.() ?? cfg[3].toString());
        if (md > 0n && md <= 1_000_000n) perDayCap = md;
      }
    } catch {}

    // Effective cap for a single submission cannot exceed daily cap
    const CAP = perSubmissionCap < perDayCap ? perSubmissionCap : perDayCap;

    // If CAP is tiny, keep test alive
    if (CAP < 10n) {
      // still try to run, but with very small spikes
    }

    // Big buffer stake (penalties may reduce stake)
    await token.connect(user).stake({ value: ethers.parseEther("1") });

    // Optional tightening: do NOT fail if contract rejects threshold edits
    try {
      if (typeof token.setAnomalyThreshold === "function") {
        // keep it conservative; some contracts restrict min/max
        await token.connect(admin).setAnomalyThreshold(3);
      }
    } catch {}

    // ------------------------------------------------------------------
    // 1) submit helper: ALWAYS pass BIGINTS for uint256 fields
    // ------------------------------------------------------------------
    const submit = async (steps0) => {
      let steps = BigInt(steps0);

      // clamp to CAP and keep >= 1
      if (steps > CAP) steps = CAP;
      if (steps === 0n) steps = 1n;

      for (let i = 0; i < 14; i++) {
        await ensureStakeForSteps(token, user, steps);

        const nonce = BigInt((await token.nonces(user.address)).toString());
        const deadline = BigInt((await time.latest()) + 3600); // convert to bigint

        const sig = await signStepData({
          signer: user,
          verifyingContract: await token.getAddress(),
          chainId, // ok as bigint/number depending on your helper
          user: user.address,
          beneficiary: beneficiary.address,
          steps,
          nonce,
          deadline,
          source,
          version: "1.0.0",
        });

        const payload = {
          user: user.address,
          beneficiary: beneficiary.address,
          steps,
          nonce,
          deadline,
          source,
          version: "1.0.0",
        };

        const proofObj = { signature: sig, proof: [], attestation: "0x" };

        try {
          // preflight (also helps decode custom errors)
          await token.connect(user).logSteps.staticCall(payload, proofObj);

          const tx = await token.connect(user).logSteps(payload, proofObj);
          await tx.wait();
          return steps;
        } catch (e) {
          const msg = _errMsg(e);

          if (msg.includes("reward too small")) {
            // increase, but do not exceed CAP
            const next = steps * 2n;
            steps = next > CAP ? CAP : next;
            continue;
          }

          if (msg.includes("step limit exceeded")) {
            // clamp hard
            steps = CAP > 1n ? (CAP - 1n) : 1n;
            continue;
          }

          if (msg.includes("daily limit exceeded")) {
            // move to next UTC day
            const now = await time.latest();
            const nextDay = Math.floor(now / 86400) * 86400 + 86400 + 2;
            await time.setNextBlockTimestamp(nextDay);
            await ethers.provider.send("evm_mine", []);
            continue;
          }

          if (msg.includes("submission too frequent")) {
            await time.increase(Number(minInterval) + 1);
            continue;
          }

          throw e;
        }
      }

      throw new Error("submit: could not find valid steps within MIN_REWARD and step cap");
    };

    // ------------------------------------------------------------------
    // 2) Seed avg, exit grace
    // ------------------------------------------------------------------
    await submit(200n);
    await time.increase(Number(GRACE) + 2);

    // ------------------------------------------------------------------
    // 3) Spikes: keep them inside CAP and inside daily cap
    //    Use “near cap” but still safe and deterministic.
    // ------------------------------------------------------------------
    const spike1 = CAP >= 100n ? (CAP * 90n) / 100n : CAP;     // 90% of cap
    const spike2 = spike1 > 2n ? spike1 : 2n;
    const spike3 = (spike2 + 1n) <= CAP ? (spike2 + 1n) : spike2;

    for (const s of [spike2, spike2, spike3]) {
      await time.increase(Number(minInterval) + 1);
      await submit(s);
    }

    // Confirm suspended
    const until = await getSuspendedUntil(token, user.address);
    const now = BigInt(await time.latest());
    expect(until).to.be.gt(now);

    // During suspension: must revert
    await time.increase(Number(minInterval) + 1);
    {
      const steps = 200n;
      await ensureStakeForSteps(token, user, steps);

      const nonce = BigInt((await token.nonces(user.address)).toString());
      const deadline = BigInt((await time.latest()) + 3600);

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

      await expect(
        token.connect(user).logSteps(
          { user: user.address, beneficiary: beneficiary.address, steps, nonce, deadline, source, version: "1.0.0" },
          { signature: sig, proof: [], attestation: "0x" }
        )
      ).to.be.revertedWith("Account suspended");
    }

    // Jump past suspension end
    await time.setNextBlockTimestamp(Number(until + 10n));
    await ethers.provider.send("evm_mine", []);

    await time.increase(Number(minInterval) + 1);

    // After suspension: should accept again
    await submit(200n);

    expect(BigInt(SUSP.toString())).to.be.gt(0n);
  });
});

/* =======================================================================
   Merkle proofs
======================================================================= */
function hashPair(a, b) {
  return ethers.solidityPackedKeccak256(
    ["bytes32", "bytes32"],
    BigInt(a) < BigInt(b) ? [a, b] : [b, a]
  );
}
function buildMerkle(leaves) {
  let level = [...leaves];
  const layers = [level];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(hashPair(left, right));
    }
    level = next;
    layers.push(level);
  }
  return { root: level[0], layers };
}
function getProof(index, layers) {
  const proof = [];
  for (let i = 0; i < layers.length - 1; i++) {
    const layer = layers[i];
    const isRight = index % 2 === 1;
    const pairIndex = isRight ? index - 1 : index + 1;
    proof.push(pairIndex < layer.length ? layer[pairIndex] : layer[index]);
    index = Math.floor(index / 2);
  }
  return proof;
}

describe("Merkle proofs", function () {
  it("accepts a valid Merkle proof when source requires proofs", async function () {
  const { token, admin, user, beneficiary, chainId } = await loadFixture(deployProxyFixture);

  const source = "merkle-src";
  await token.connect(admin).configureSource(source, true, false);

  // Retry loop: rebuild merkle root + proof each time steps changes
  let steps = 123n;

  for (let i = 0; i < 12; i++) {
    // Leaf MUST match the actual steps being submitted
    const leaf = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "uint256"],
        [user.address, steps, 0]
      )
    );
    const leaf2 = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "uint256"],
        [beneficiary.address, 999n, 0]
      )
    );

    const { root, layers } = buildMerkle([leaf, leaf2]);
    const proof = getProof(0, layers);

    // Root must correspond to the leaf for THIS steps value
    await token.connect(admin).setSourceMerkleRoot(source, root);

    await ensureStakeForSteps(token, user, steps);

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

    try {
      const tx = await token.connect(user).logSteps(
        { user: user.address, beneficiary: beneficiary.address, steps, nonce, deadline, source, version: "1.0.0" },
        { signature: sig, proof, attestation: "0x" }
      );

      await expect(tx).to.emit(token, "RewardClaimed");
      await tx.wait();
      return; // ✅ success
    } catch (e) {
      const msg = _errMsg(e);

      if (msg.includes("reward too small")) {
        steps *= 2n;
        continue;
      }

      // If you ever see Invalid proof here, it means leaf encoding doesn’t match contract expectations.
      throw e;
    }
  }

  throw new Error("Could not find steps large enough to pass MIN_REWARD with valid proof within iterations");
});

  it("rejects an invalid Merkle proof", async function () {
    const { token, admin, user, beneficiary, chainId } = await loadFixture(deployProxyFixture);

    const source = "merkle-src-invalid";
    await token.connect(admin).configureSource(source, true, false);

    let steps = 222n;
    const floor = await minStepsForReward(token);
    if (steps < floor) steps = floor;

    // Ensure stake so revert reason is proof, not stake
    await ensureStakeForSteps(token, user, steps);

    const targetLeaf = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "uint256"],
        [user.address, steps, 0]
      )
    );
    const otherLeaf = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "uint256"],
        [beneficiary.address, 777, 0]
      )
    );
    const { root, layers } = buildMerkle([targetLeaf, otherLeaf]);
    const wrongProof = getProof(1, layers);

    await token.connect(admin).setSourceMerkleRoot(source, root);

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

    await expect(
      token.connect(user).logSteps(
        { user: user.address, beneficiary: beneficiary.address, steps, nonce, deadline, source, version: "1.0.0" },
        { signature: sig, proof: wrongProof, attestation: "0x" }
      )
    ).to.be.revertedWith("Invalid proof");
  });

  it("rejects proofs that are too long", async function () {
    const { token, admin, user, beneficiary, chainId } = await loadFixture(deployProxyFixture);

    const source = "merkle-src-toolong";
    await token.connect(admin).configureSource(source, true, false);
    await token.connect(admin).setSourceMerkleRoot(source, ethers.ZeroHash);

    const tooLong = Array.from({ length: 33 }, (_, i) =>
      ethers.keccak256(ethers.toUtf8Bytes("node-" + i))
    );

    // ✅ IMPORTANT: do NOT bump via staticCall here (it will revert "Invalid proof" before "Proof too long")
    let steps = 10n;
    const floor = await minStepsForReward(token);
    if (steps < floor) steps = floor;

    await ensureStakeForSteps(token, user, steps);

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

    await expect(
      token.connect(user).logSteps(
        { user: user.address, beneficiary: beneficiary.address, steps, nonce, deadline, source, version: "1.0.0" },
        { signature: sig, proof: tooLong, attestation: "0x" }
      )
    ).to.be.revertedWith("Proof too long");
  });
});
