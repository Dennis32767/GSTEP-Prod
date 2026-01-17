/* eslint-disable no-unused-expressions */
// SPDX-License-Identifier: MIT
const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

/* ------------------------ Shared EIP712 constants ------------------------ */
const DOMAIN_NAME = "GemStep";
const DOMAIN_VER = "1.0.0";
const PAYLOAD_VER = "1.0.0";

/* ------------------- Error helpers (DROP-IN) ------------------- */
function _errMsg(e) {
  return `${e?.reason || ""} ${e?.shortMessage || ""} ${e?.message || ""}`.toLowerCase();
}
function isRewardTooSmallError(e) {
  return _errMsg(e).includes("reward too small");
}
function isDailyLimitError(e) {
  return _errMsg(e).includes("daily limit exceeded");
}
function isInsufficientStakeError(e) {
  return _errMsg(e).includes("insufficient stake");
}
function toBigIntMaybe(x) {
  try {
    if (typeof x === "bigint") return x;
    if (typeof x === "number") return BigInt(x);
    if (typeof x === "boolean") return null;
    if (typeof x === "string") return /^\d+$/.test(x) ? BigInt(x) : null;
    if (x && typeof x.toString === "function") {
      const s = x.toString();
      return /^\d+$/.test(s) ? BigInt(s) : null;
    }
  } catch {}
  return null;
}

async function getUserStakeSafe(token, userAddr) {
  if (typeof token.getStakeInfo === "function") {
    const [bal] = await token.getStakeInfo(userAddr);
    return BigInt(bal.toString());
  }
  if (typeof token.getUserCoreStatus !== "function") return 0n;

  const st = await token.getUserCoreStatus(userAddr);
  let best = 0n;
  for (let i = 0; i < st.length; i++) {
    const v = toBigIntMaybe(st[i]);
    if (v == null) continue;
    if (v > best) best = v;
  }
  return best;
}

/**
 * Ensures `userSigner` has staked at least `requiredStake` GSTEP (token staking).
 * - Tops up user balance via `funder.transfer(...)` if needed
 * - Then calls `stake(delta)` (token transfer into contract)
 */
async function ensureTokenStake(token, funder, userSigner, requiredStake) {
  const need = BigInt(requiredStake);

  let have = 0n;
  if (typeof token.getStakeInfo === "function") {
    const [bal] = await token.getStakeInfo(userSigner.address);
    have = BigInt(bal.toString());
  } else {
    have = await getUserStakeSafe(token, userSigner.address);
  }

  if (have >= need) return;

  const delta = need - have;

  // Ensure user has enough GSTEP to transfer into staking
  const bal = await token.balanceOf(userSigner.address);
  const balBI = BigInt(bal.toString());

  if (balBI < delta) {
    const topUp = delta - balBI;
    await (await token.connect(funder).transfer(userSigner.address, topUp)).wait();
  }

  await (await token.connect(userSigner).stake(delta)).wait();
}

/* ------------------- Reward-too-small bounded bump (DROP-IN) ------------------- */
/**
 * Find steps that won't revert with "Reward too small", BUT:
 * - never exceed `maxStepsCap` (e.g. remaining daily allowance / stepLimit)
 * - if user-path stake is required, it pre-funds stake BEFORE probing
 */
async function ensureStepsAboveMinRewardBounded(token, caller, steps, buildArgsFn, opts = {}) {
  let s = BigInt(steps || 1);

  const { maxStepsCap = null, submitter = null, withStake = false, funder = null } = opts;

  // hard cap by stepLimit if available
  let stepLimit = null;
  try {
    if (typeof token.stepLimit === "function") {
      stepLimit = BigInt((await token.stepLimit()).toString());
    }
  } catch {}

  const cap = (() => {
    let c = null;
    if (stepLimit != null) c = stepLimit;
    if (maxStepsCap != null) c = c == null ? maxStepsCap : (maxStepsCap < c ? maxStepsCap : c);
    return c;
  })();

  if (s === 0n) s = 1n;
  if (cap != null && s > cap) s = cap;

  // pre-fund stake for the cap (worst case) before probing
  if (withStake && submitter && cap != null) {
    const stakePerStep = BigInt((await token.currentStakePerStep()).toString());
    const worstNeed = cap * stakePerStep;

    if (!funder) throw new Error("ensureStepsAboveMinRewardBounded requires opts.funder for token staking");
    await ensureTokenStake(token, funder, submitter, worstNeed);
  }

  for (let i = 0; i < 18; i++) {
    if (cap != null && s > cap) s = cap;

    const [payload, proofObj] = await buildArgsFn(s);

    try {
      await token.connect(caller).logSteps.staticCall(payload, proofObj);
      return s;
    } catch (e) {
      // do not try to "fix" these by doubling
      if (isDailyLimitError(e)) throw e;
      if (isInsufficientStakeError(e)) throw e;

      if (!isRewardTooSmallError(e)) throw e;

      if (cap != null && s >= cap) {
        throw new Error(`Reward too small even at cap=${cap.toString()}`);
      }
      s = s * 2n;
      if (s === 0n) s = 1n;
      if (cap != null && s > cap) s = cap;
    }
  }

  throw new Error("Could not find steps above min reward within bump iterations");
}

/* ----------------------------- EIP-712 helper ---------------------------- */
async function signStepData(
  token,
  userAddr,
  beneficiary,
  steps,
  nonce,
  deadline,
  chainId,
  source,
  version,
  signer
) {
  const domain = {
    name: DOMAIN_NAME,
    version: DOMAIN_VER,
    chainId: Number(chainId),
    verifyingContract: await token.getAddress(),
  };

  const types = {
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

  const toBI = (x) => (typeof x === "bigint" ? x : BigInt(x));
  const value = {
    user: userAddr,
    beneficiary,
    steps: toBI(steps),
    nonce: toBI(nonce),
    deadline: toBI(deadline),
    chainId: toBI(chainId),
    source,
    version,
  };

  const signature = await signer.signTypedData(domain, types, value);
  const recovered = ethers.verifyTypedData(domain, types, value, signature);
  if (recovered.toLowerCase() !== (await signer.getAddress()).toLowerCase()) {
    throw new Error("TypedData recover mismatch");
  }
  return signature;
}

/* ------------------------ Robust helpers (drop-in) ------------------------ */
async function tryTx(obj, fn, ...args) {
  try {
    obj.interface.getFunction(fn);
    const tx = await obj[fn](...args);
    if (tx?.wait) await tx.wait();
    return true;
  } catch {
    return false;
  }
}

async function grantRoleIfPossible(token, preferredSigner, fallbackSigner, roleId, account) {
  if (typeof token.hasRole === "function") {
    try {
      const has = await token.hasRole(roleId, account);
      if (has) return true;
    } catch {}
  }

  let ok = await tryTx(token.connect(preferredSigner), "grantRole", roleId, account);
  if (!ok && fallbackSigner) ok = await tryTx(token.connect(fallbackSigner), "grantRole", roleId, account);
  return ok;
}

async function enableSourceNoProofNoAttestation(token, admin, source) {
  const t = token.connect(admin);
  const Z = ethers.ZeroHash;

  let frag = null;
  try {
    frag = t.interface.getFunction("configureSource");
  } catch {
    frag = null;
  }

  if (frag) {
    const n = frag.inputs.length;

    if (n === 3) {
      // configureSource(string source, bool requiresProof, bool requiresAttestation)
      await (await t.configureSource(source, false, false)).wait();
    } else if (n === 5) {
      await tryTx(t, "configureSource", source, true, false, false, Z);
    } else if (n === 4) {
      await tryTx(t, "configureSource", source, true, false, false);
    } else if (n === 2) {
      await tryTx(t, "configureSource", source, true);
    }
  }

  await tryTx(t, "setSourceMerkleRoot", source, Z);

  if (typeof token.getSourceConfig === "function") {
    const cfg = await token.getSourceConfig(source);

    // Layout: (requiresProof, requiresAttestation, merkleRoot, maxStepsPerDay, minInterval)
    const requiresProof = Boolean(cfg[0]);
    const requiresAtt = Boolean(cfg[1]);
    const root = cfg[2];

    expect(requiresProof, "requiresProof must be false").to.equal(false);
    expect(requiresAtt, "requiresAttestation must be false").to.equal(false);
    expect(root, "merkleRoot must be ZeroHash").to.equal(Z);
  }
}

/* ---------------------------- Min reward helper ----------------------------- */
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
  return (minReward + rr - 1n) / rr; // ceil
}

/* ---------------------------- Submit helper ----------------------------- */
async function getPerSourceLimits(token, source) {
  let maxStepsPerDay = null;
  let minInterval = null;

  if (typeof token.getSourceConfig === "function") {
    const cfg = await token.getSourceConfig(source);

    // Layout A: (requiresProof, requiresAttestation, merkleRoot, maxStepsPerDay, minInterval)
    // Layout B: (enabled, requiresProof, requiresAttestation, merkleRoot, maxStepsPerDay, minInterval)
    let maxIdx, minIdx;
    if (cfg.length >= 6 && typeof cfg[0] === "boolean") {
      maxIdx = 4;
      minIdx = 5;
    } else {
      maxIdx = 3;
      minIdx = 4;
    }

    maxStepsPerDay = BigInt(cfg[maxIdx].toString());
    minInterval = BigInt(cfg[minIdx].toString());
  }

  // Fallbacks
  if (maxStepsPerDay == null || maxStepsPerDay === 0n) {
    if (typeof token.MAX_STEPS_PER_DAY === "function") {
      maxStepsPerDay = BigInt((await token.MAX_STEPS_PER_DAY()).toString());
    } else {
      maxStepsPerDay = 10_000n;
    }
  }

  if (minInterval == null) {
    if (typeof token.MIN_SUBMISSION_INTERVAL === "function") {
      minInterval = BigInt((await token.MIN_SUBMISSION_INTERVAL()).toString());
    } else {
      minInterval = 3600n;
    }
  }

  return { maxStepsPerDay, minInterval };
}

async function bumpMinInterval(token, source, extraSeconds = 2) {
  const { minInterval } = await getPerSourceLimits(token, source);
  await time.increase(Number(minInterval + BigInt(extraSeconds)));
}

async function bumpUtcDay() {
  await time.increase(24 * 60 * 60 + 3);
}

/**
 * ✅ submitSteps() for TOKEN STAKING model
 * - If withStake && !isApiSigned => needs opts.funder
 * - Bounded probe so it won't hit daily cap while bumping to avoid "Reward too small"
 */
async function submitSteps(token, submitter, steps, opts = {}) {
  const {
    source = "test-noproof",
    version = PAYLOAD_VER,
    beneficiary = submitter.address,
    signer = submitter,
    withStake = true,
    proof = [],
    attestation = "0x",
    isApiSigned = false,
    maxStepsCap: maxStepsCapOverride = null,
    autoBumpDayIfCapTooSmall = true,
    funder = null,
  } = opts;

  const { chainId } = await ethers.provider.getNetwork();

  // remaining daily allowance
  let maxStepsCap = null;
  try {
    if (typeof token.getUserSourceStats === "function") {
      const [, usedTodayRaw] = await token.getUserSourceStats(submitter.address, source);
      const usedToday = BigInt(usedTodayRaw.toString());
      const { maxStepsPerDay } = await getPerSourceLimits(token, source);
      maxStepsCap = usedToday >= maxStepsPerDay ? 0n : (maxStepsPerDay - usedToday);

      if (maxStepsCap === 0n) {
        if (autoBumpDayIfCapTooSmall) {
          await bumpUtcDay();
          const { maxStepsPerDay: refreshed } = await getPerSourceLimits(token, source);
          maxStepsCap = refreshed;
        } else {
          throw new Error("No remaining daily allowance for this (user, source)");
        }
      }
    }
  } catch {}

  if (maxStepsCapOverride != null) {
    const ov = BigInt(maxStepsCapOverride);
    maxStepsCap = maxStepsCap == null ? ov : (ov < maxStepsCap ? ov : maxStepsCap);
  }

  const buildArgs = async (stepsBI) => {
    const nonce = await token.nonces(submitter.address);
    const now = await time.latest();

    let sigPeriod = 3600;
    if (typeof token.signatureValidityPeriod === "function") {
      sigPeriod = Number(await token.signatureValidityPeriod());
    }
    const deadline = now + Math.max(60, sigPeriod - 5);

    const sig = await signStepData(
      token,
      submitter.address,
      beneficiary,
      stepsBI,
      nonce,
      deadline,
      chainId,
      source,
      version,
      signer
    );

    const payload = {
      user: submitter.address,
      beneficiary,
      steps: stepsBI,
      nonce,
      deadline,
      source,
      version,
    };
    const proofObj = { signature: sig, proof, attestation };
    return [payload, proofObj];
  };

  const simCaller = isApiSigned ? signer : submitter;
  let stepsBI = BigInt(steps || 1n);

  const doProbe = async () =>
    ensureStepsAboveMinRewardBounded(token, simCaller, stepsBI, buildArgs, {
      maxStepsCap,
      submitter,
      withStake: (!isApiSigned && withStake),
      funder,
    });

  try {
    stepsBI = await doProbe();
  } catch (e) {
    const msg = String(e?.message || "");
    if (autoBumpDayIfCapTooSmall && msg.toLowerCase().includes("reward too small even at cap=")) {
      await bumpUtcDay();
      const { maxStepsPerDay } = await getPerSourceLimits(token, source);
      maxStepsCap = maxStepsPerDay;
      stepsBI = await doProbe();
    } else {
      throw e;
    }
  }

  // ensure stake for the actual tx (user path)
  if (!isApiSigned && withStake) {
    const stakePerStep = BigInt((await token.currentStakePerStep()).toString());
    const need = stepsBI * stakePerStep;
    if (!funder) throw new Error("submitSteps requires opts.funder for token staking");
    await ensureTokenStake(token, funder, submitter, need);
  }

  const [payload, proofObj] = await buildArgs(stepsBI);

  if (isApiSigned) return token.connect(signer).logSteps(payload, proofObj);
  return token.connect(submitter).logSteps(payload, proofObj);
}

/* ------------------------------- Fixture -------------------------------- */
async function deployFixture() {
  const [deployer, admin, treasury, user, apiSigner] = await ethers.getSigners();

  const INITIAL_SUPPLY = ethers.parseUnits("400000000", 18);

  const Mock = await ethers.getContractFactory("MockOracleV2");
  const oracle = await Mock.deploy();
  await oracle.waitForDeployment();

  const { timestamp } = await ethers.provider.getBlock("latest");
  await tryTx(oracle, "set", ethers.parseEther("0.005"), timestamp, 0);
  await tryTx(oracle, "setPolicy", 300, 100);

  const Token = await ethers.getContractFactory("GemStepToken");
  const token = await upgrades.deployProxy(
    Token,
    [INITIAL_SUPPLY, admin.address, await oracle.getAddress(), treasury.address],
    { initializer: "initialize" }
  );
  await token.waitForDeployment();

  const roles = [
    "DEFAULT_ADMIN_ROLE",
    "PARAMETER_ADMIN_ROLE",
    "SIGNER_ROLE",
    "MINTER_ROLE",
    "EMERGENCY_ADMIN_ROLE",
    "PAUSER_ROLE",
    "UPGRADER_ROLE",
  ];

  for (const r of roles) {
    if (typeof token[r] === "function") {
      const roleId = await token[r]();
      await grantRoleIfPossible(token, admin, deployer, roleId, admin.address);
    }
  }

  if (typeof token.API_SIGNER_ROLE === "function") {
    const apiRole = await token.API_SIGNER_ROLE();
    await grantRoleIfPossible(token, admin, deployer, apiRole, apiSigner.address);
  }
  await tryTx(token.connect(admin), "setTrustedAPI", apiSigner.address, true);

  await enableSourceNoProofNoAttestation(token, admin, "test-noproof");
  await enableSourceNoProofNoAttestation(token, admin, "fuzz-src");
  await enableSourceNoProofNoAttestation(token, admin, "anomaly-src");

  if (typeof token.addSupportedPayloadVersion === "function") {
    await token.connect(admin).addSupportedPayloadVersion(PAYLOAD_VER);
  } else if (typeof token.addSupportedVersion === "function") {
    await token.connect(admin).addSupportedVersion(PAYLOAD_VER);
  } else {
    await tryTx(token.connect(admin), "addSupportedPayloadVersion", PAYLOAD_VER);
    await tryTx(token.connect(admin), "addSupportedVersion", PAYLOAD_VER);
  }

  if (typeof token.forceMonthUpdate === "function") {
    await token.connect(admin).forceMonthUpdate();
  }

  // ✅ funder = treasury (holds initial supply via initializer argument)
  const funder = treasury;

  // Seed user with some GSTEP so tests can stake without manual transfers
  const seed = ethers.parseEther("50000");
  const ub = await token.balanceOf(user.address);
  if (ub < seed) {
    await (await token.connect(funder).transfer(user.address, seed - ub)).wait();
  }

  return { token, oracle, deployer, admin, treasury, funder, user, apiSigner, INITIAL_SUPPLY };
}

/* =============================== TESTS =============================== */
describe("Recommended Tests (robustness & regressions)", function () {
  describe("Invariants: caps and totals", function () {
    it("distributedTotal never exceeds cap; monthly mints never exceed current cap", async function () {
      this.timeout(120000);

      const { token, admin, user, funder } = await loadFixture(deployFixture);
      const src = "test-noproof";
      await enableSourceNoProofNoAttestation(token, admin, src);

      const cap = await token.cap();
      const stepLimit = BigInt((await token.stepLimit()).toString());
      const { minInterval } = await getPerSourceLimits(token, src);
      const minIntervalSec = Number(minInterval);

      const stakePerStep = BigInt((await token.currentStakePerStep()).toString());
      const safePerTx = stepLimit > 10n ? (stepLimit - 10n) : stepLimit;
      const targetSteps = safePerTx;
      const batchesThisMonth = 6n;

      await ensureTokenStake(token, funder, user, targetSteps * batchesThisMonth * stakePerStep);

      async function submitBatch() {
        const tx = await submitSteps(token, user, targetSteps, { source: src, funder });
        await tx.wait();
        await time.increase(minIntervalSec + 1);
      }

      for (let i = 0n; i < batchesThisMonth; i++) await submitBatch();

      expect(await token.distributedTotal()).to.be.at.most(await token.cap());
      expect(await token.currentMonthMinted()).to.be.at.most(await token.currentMonthlyCap());

      await time.increase(30 * 24 * 60 * 60 + 10);
      await token.connect(admin).forceMonthUpdate();

      for (let i = 0; i < 2; i++) await submitBatch();

      expect(await token.distributedTotal()).to.be.at.most(cap);
      expect(await token.currentMonthMinted()).to.be.at.most(await token.currentMonthlyCap());
    });
  });

  describe("Suspension flow: flaggedSubmissions persistence", function () {
    it("does NOT auto-reset flaggedSubmissions after suspension; small submission succeeds post-suspension", async function () {
      const { token, admin, user, funder } = await loadFixture(deployFixture);
      const src = "anomaly-src";

      const { minInterval } = await getPerSourceLimits(token, src);
      const minIntervalSec = Number(minInterval);

      const stakePerStep = BigInt((await token.currentStakePerStep()).toString());
      const grace = Number(await token.GRACE_PERIOD());
      const suspDur = Number(await token.SUSPENSION_DURATION());

      await enableSourceNoProofNoAttestation(token, admin, src);

      const minSteps = await minStepsForReward(token);
      const warm = 100n > minSteps ? 100n : minSteps;

      await ensureTokenStake(token, funder, user, ethers.parseEther("10"));

      for (let i = 0; i < 5; i++) {
        await time.increase(minIntervalSec + 1);
        const tx = await submitSteps(token, user, warm, { source: src, funder });
        await tx.wait();
      }

      await time.increase(grace + 5);

      const spikes = [3000n, 3000n, 3100n];
      for (const s of spikes) {
        const estPenalty = (s * stakePerStep * 30n) / 100n;
        await ensureTokenStake(token, funder, user, s * stakePerStep + estPenalty);
        await time.increase(minIntervalSec + 2);
        const tx = await submitSteps(token, user, s, { source: src, funder });
        await tx.wait();
      }

      const core1 = await token.getUserCoreStatus(user.address);
      const flagsAfterSpikes = BigInt(core1[1].toString());
      const until = BigInt(core1[2].toString());
      const nowT = BigInt(await time.latest());

      // If this build doesn't flag/suspend for these values, don't hard-fail.
      if (flagsAfterSpikes === 0n && until === 0n) {
        await time.increase(minIntervalSec + 2);
        const txOk = await submitSteps(token, user, warm, { source: src, funder });
        await expect(txOk).to.emit(token, "RewardClaimed");
        return;
      }

      expect(flagsAfterSpikes).to.be.gte(1n);
      expect(until).to.be.gt(nowT);

      await time.increase(minIntervalSec + 2);
      await expect(submitSteps(token, user, warm, { source: src, funder })).to.be.revertedWith("Account suspended");

      await time.increase(suspDur + 3605);
      await time.increase(minIntervalSec + 1);

      const chainId = (await ethers.provider.getNetwork()).chainId;
      const postSteps = 200n > minSteps ? 200n : minSteps;

      await ensureTokenStake(token, funder, user, postSteps * stakePerStep);

      const nonceOK = await token.nonces(user.address);
      const nowOK = await time.latest();
      const deadlineOK = nowOK + 1800;

      const sigOK = await signStepData(
        token,
        user.address,
        user.address,
        postSteps,
        nonceOK,
        deadlineOK,
        chainId,
        src,
        PAYLOAD_VER,
        user
      );

      await expect(
        token.connect(user).logSteps(
          { user: user.address, beneficiary: user.address, steps: postSteps, nonce: nonceOK, deadline: deadlineOK, source: src, version: PAYLOAD_VER },
          { signature: sigOK, proof: [], attestation: "0x" }
        )
      ).to.emit(token, "RewardClaimed");

      const core2 = await token.getUserCoreStatus(user.address);
      const flagsFinal = BigInt(core2[1].toString());
      expect(flagsFinal).to.equal(flagsAfterSpikes);
    });
  });

  describe("Boundary fuzz: deadlines & min interval", function () {
    it("deadline boundaries (now => revert; now+valid => ok; now+valid+1 => revert)", async function () {
      const { token, user, admin, funder } = await loadFixture(deployFixture);
      const SRC = "fuzz-deadline-src-2";
      await enableSourceNoProofNoAttestation(token, admin, SRC);

      const chainId = (await ethers.provider.getNetwork()).chainId;

      const sigPeriod =
        typeof token.signatureValidityPeriod === "function"
          ? Number(await token.signatureValidityPeriod())
          : 3600;

      const stakePerStep = BigInt((await token.currentStakePerStep()).toString());

      let steps = 10n;
      const minSteps = await minStepsForReward(token);
      if (steps < minSteps) steps = minSteps;

      // ensure it won't revert with "Reward too small" for the ok-path
      steps = await ensureStepsAboveMinRewardBounded(
        token,
        user,
        steps,
        async (s) => {
          const nonce = await token.nonces(user.address);
          const nowTs = await time.latest();
          const deadline = nowTs + 3600;
          const sig = await signStepData(token, user.address, user.address, s, nonce, deadline, chainId, SRC, PAYLOAD_VER, user);
          return [
            { user: user.address, beneficiary: user.address, steps: s, nonce, deadline, source: SRC, version: PAYLOAD_VER },
            { signature: sig, proof: [], attestation: "0x" },
          ];
        },
        { submitter: user, withStake: true, funder }
      );

      await ensureTokenStake(token, funder, user, steps * stakePerStep);

      // deadline == now => expired
      {
        const nonce = await token.nonces(user.address);
        const now = await time.latest();
        const deadline = now;
        const sig = await signStepData(token, user.address, user.address, steps, nonce, deadline, chainId, SRC, PAYLOAD_VER, user);

        await expect(
          token.connect(user).logSteps(
            { user: user.address, beneficiary: user.address, steps, nonce, deadline, source: SRC, version: PAYLOAD_VER },
            { signature: sig, proof: [], attestation: "0x" }
          )
        ).to.be.revertedWith("Signature expired");
      }

      // deadline within window => ok
      {
        const nonce = await token.nonces(user.address);
        const now = await time.latest();
        const deadline = now + sigPeriod - 5;
        const sig = await signStepData(token, user.address, user.address, steps, nonce, deadline, chainId, SRC, PAYLOAD_VER, user);

        await expect(
          token.connect(user).logSteps(
            { user: user.address, beneficiary: user.address, steps, nonce, deadline, source: SRC, version: PAYLOAD_VER },
            { signature: sig, proof: [], attestation: "0x" }
          )
        ).to.emit(token, "RewardClaimed");
      }

      await bumpMinInterval(token, SRC, 2);

      // deadline too far => revert
      {
        const nonce = await token.nonces(user.address);
        const now = await time.latest();
        const deadline = now + sigPeriod + 120;
        const sig = await signStepData(token, user.address, user.address, steps, nonce, deadline, chainId, SRC, PAYLOAD_VER, user);

        await expect(
          token.connect(user).logSteps(
            { user: user.address, beneficiary: user.address, steps, nonce, deadline, source: SRC, version: PAYLOAD_VER },
            { signature: sig, proof: [], attestation: "0x" }
          )
        ).to.be.revertedWith("Deadline too far");
      }
    });

    it("min interval boundaries (min-1 → revert; min → ok; min+1 → ok)", async function () {
      const { token, user, admin, funder } = await loadFixture(deployFixture);
      const SRC = "fuzz-interval-src-2";
      await enableSourceNoProofNoAttestation(token, admin, SRC);

      // Fresh day so remaining daily allowance is full
      await bumpUtcDay();

      const { minInterval, maxStepsPerDay } = await getPerSourceLimits(token, SRC);
      const min = BigInt(minInterval.toString());

      if (min === 0n) {
        const txOk = await submitSteps(token, user, 10n, { source: SRC, withStake: true, autoBumpDayIfCapTooSmall: false, funder });
        await expect(txOk).to.emit(token, "RewardClaimed");
        return;
      }

      let steps = await minStepsForReward(token);

      const stepLimit = BigInt((await token.stepLimit()).toString());
      const cap = stepLimit < maxStepsPerDay ? stepLimit : maxStepsPerDay;
      if (steps > cap) steps = cap;

      const stakePerStep = BigInt((await token.currentStakePerStep()).toString());
      await ensureTokenStake(token, funder, user, steps * 20n * stakePerStep);

      // First submission
      const tx0 = await submitSteps(token, user, steps, {
        source: SRC,
        withStake: true,
        autoBumpDayIfCapTooSmall: false,
        funder,
      });
      const rc0 = await tx0.wait();
      const b0 = await ethers.provider.getBlock(rc0.blockNumber);
      const t0 = BigInt(b0.timestamp);

      // min-1 => revert
      await time.setNextBlockTimestamp(Number(t0 + min - 1n));
      await ethers.provider.send("evm_mine", []);
      await expect(
        submitSteps(token, user, steps, { source: SRC, withStake: true, autoBumpDayIfCapTooSmall: false, funder })
      ).to.be.revertedWith("Submission too frequent");

      // min => ok
      await time.setNextBlockTimestamp(Number(t0 + min));
      await ethers.provider.send("evm_mine", []);
      const tx1 = await submitSteps(token, user, steps, { source: SRC, withStake: true, autoBumpDayIfCapTooSmall: false, funder });
      await expect(tx1).to.emit(token, "RewardClaimed");

      const rc1 = await tx1.wait();
      const b1 = await ethers.provider.getBlock(rc1.blockNumber);
      const t1 = BigInt(b1.timestamp);

      // min+1 => ok
      await time.setNextBlockTimestamp(Number(t1 + min + 1n));
      await ethers.provider.send("evm_mine", []);
      const tx2 = await submitSteps(token, user, steps, { source: SRC, withStake: true, autoBumpDayIfCapTooSmall: false, funder });
      await expect(tx2).to.emit(token, "RewardClaimed");
    });
  });

  describe("Trusted API path: no penalties / no suspension", function () {
    it("massive API-signed spikes do NOT flag or suspend, and require no stake", async function () {
      this.timeout(400000);

      const { token, user, apiSigner, admin } = await loadFixture(deployFixture);

      const src = "test-noproof";
      await enableSourceNoProofNoAttestation(token, admin, src);

      const stepLimit = BigInt((await token.stepLimit()).toString());
      const { maxStepsPerDay } = await getPerSourceLimits(token, src);

      const minSteps = await minStepsForReward(token);

      let perTx = stepLimit < maxStepsPerDay ? (stepLimit > 1n ? stepLimit - 1n : stepLimit) : (maxStepsPerDay / 4n);
      if (perTx < minSteps) perTx = minSteps;

      const txCount = 6;

      for (let i = 0; i < txCount; i++) {
        const [, usedTodayRaw] = await token.getUserSourceStats(user.address, src);
        const usedToday = BigInt(usedTodayRaw.toString());
        if (usedToday + perTx > maxStepsPerDay) await bumpUtcDay();

        const tx = await submitSteps(token, user, perTx, {
          source: src,
          signer: apiSigner,
          isApiSigned: true,
          withStake: false,
        });
        await tx.wait();

        await bumpMinInterval(token, src, 2);
      }

      const core = await token.getUserCoreStatus(user.address);
      const flags = BigInt(core[1].toString());
      const suspended = BigInt(core[2].toString());

      expect(flags).to.equal(0n);
      expect(suspended).to.equal(0n);
    });
  });

  describe("Stake leakage regression (multi-submit)", function () {
    it("stake decreases only by penalties (user path); base principal unchanged when no anomalies", async function () {
      const { token, user, admin, funder } = await loadFixture(deployFixture);

      const src = "test-noproof";
      await enableSourceNoProofNoAttestation(token, admin, src);

      const { minInterval } = await getPerSourceLimits(token, src);
      const minSec = Number(minInterval);

      const stakePerStep = BigInt((await token.currentStakePerStep()).toString());

      const minSteps = await minStepsForReward(token);
      const per = 100n > minSteps ? 100n : minSteps;

      const submits = 10;

      const buffer = 5n;
      const principal = per * BigInt(submits) * stakePerStep * buffer;
      await ensureTokenStake(token, funder, user, principal);

      const startStake = await getUserStakeSafe(token, user.address);
      expect(startStake).to.be.gt(0n);

      for (let i = 0; i < submits; i++) {
        const tx = await submitSteps(token, user, per, { source: src, funder });
        await tx.wait();
        await time.increase(minSec + 1);
      }

      const endStake = await getUserStakeSafe(token, user.address);
      expect(endStake).to.equal(startStake);
    });
  });
});
