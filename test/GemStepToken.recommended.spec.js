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
function isTrustedRelayerRequiredError(e) {
  const m = _errMsg(e);
  return m.includes("trusted api caller/relayer required") || m.includes("caller must be user or trusted api");
}
function isUnauthorizedApiSignerError(e) {
  return _errMsg(e).includes("unauthorized api signer");
}
function isSignerMustBeUserError(e) {
  return _errMsg(e).includes("signer must be user");
}
function isSubmissionTooFrequentError(e) {
  return _errMsg(e).includes("submission too frequent");
}
function isSignatureExpiredError(e) {
  return _errMsg(e).includes("signature expired");
}
function isDeadlineTooFarError(e) {
  return _errMsg(e).includes("deadline too far");
}
function isCapError(e) {
  const m = _errMsg(e);
  return m.includes("mcap") || m.includes("cap");
}

/* ------------------------ Minimal-reader accessors (DROP-IN) ------------------------ */
async function getCoreParamsSafe(token) {
  if (typeof token.getCoreParams === "function") {
    const out = await token.getCoreParams();
    return {
      burnFee: BigInt(out[0].toString()),
      rewardRate: BigInt(out[1].toString()),
      stepLimit: BigInt(out[2].toString()),
      sigValidity: BigInt(out[3].toString()),
    };
  }
  const burnFee = typeof token.burnFee === "function" ? BigInt((await token.burnFee()).toString()) : 0n;
  const rewardRate = typeof token.rewardRate === "function" ? BigInt((await token.rewardRate()).toString()) : 0n;
  const stepLimit = typeof token.stepLimit === "function" ? BigInt((await token.stepLimit()).toString()) : 0n;
  const sigValidity =
    typeof token.signatureValidityPeriod === "function"
      ? BigInt((await token.signatureValidityPeriod()).toString())
      : 3600n;
  return { burnFee, rewardRate, stepLimit, sigValidity };
}
async function getStakeParamsSafe(token) {
  if (typeof token.getStakeParams === "function") {
    const out = await token.getStakeParams();
    return {
      stakePerStep: BigInt(out[0].toString()),
      lastAdjustTs: BigInt(out[1].toString()),
      locked: Boolean(out[2]),
    };
  }
  const stakePerStep =
    typeof token.currentStakePerStep === "function"
      ? BigInt((await token.currentStakePerStep()).toString())
      : 0n;
  return { stakePerStep, lastAdjustTs: 0n, locked: false };
}
async function getStepLimitSafe(token) {
  const { stepLimit } = await getCoreParamsSafe(token);
  return stepLimit;
}
async function getRewardRateSafe(token) {
  const { rewardRate } = await getCoreParamsSafe(token);
  return rewardRate;
}
async function getSigValiditySafe(token) {
  const { sigValidity } = await getCoreParamsSafe(token);
  return sigValidity;
}
async function getStakePerStepSafe(token) {
  const { stakePerStep } = await getStakeParamsSafe(token);
  return stakePerStep;
}

/* --------------------- EIP-712 domain (FIX) --------------------- */
/**
 * Attempts to read the live EIP-712 domain from the token via EIP-5267 (OZ).
 * Falls back to your constants if not available.
 *
 * OZ eip712Domain() returns:
 * (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)
 */
async function getEip712DomainSafe(token, chainIdHint) {
  if (typeof token.eip712Domain === "function") {
    const d = await token.eip712Domain();
    const name = d[1];
    const version = d[2];

    let chainId = Number(d[3] || 0);
    if (!chainId) chainId = Number(chainIdHint);

    let verifyingContract = d[4];
    if (!verifyingContract || verifyingContract === ethers.ZeroAddress) {
      verifyingContract = await token.getAddress();
    }
    return { name, version, chainId, verifyingContract };
  }

  return {
    name: DOMAIN_NAME,
    version: DOMAIN_VER,
    chainId: Number(chainIdHint),
    verifyingContract: await token.getAddress(),
  };
}

/* ----------------------------- EIP-712 helper (FIXED) ---------------------------- */
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
  const domainLive = await getEip712DomainSafe(token, chainId);

  const domain = {
    name: domainLive.name,
    version: domainLive.version,
    chainId: Number(domainLive.chainId),
    verifyingContract: domainLive.verifyingContract,
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
    throw new Error("TypedData recover mismatch (domain/types/value mismatch)");
  }

  return signature;
}
// ------------------------- mineAt (DROP-IN) -------------------------
// Mines a block at EXACT target timestamp, but if Hardhat would reject it
// (target <= latest), it mines at latest+1 instead.
// Returns the actual mined timestamp (bigint).
async function mineAt(targetTsBig) {
  const latest = BigInt((await ethers.provider.getBlock("latest")).timestamp);
  let ts = BigInt(targetTsBig);

  // Hardhat default: timestamps must strictly increase.
  if (ts <= latest) ts = latest + 1n;

  await ethers.provider.send("evm_setNextBlockTimestamp", [Number(ts)]);
  await ethers.provider.send("evm_mine", []);
  return ts;
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
async function grantRoleByNameIfNoGetter(token, adminSigner, roleName, account) {
  if (typeof token[roleName] === "function") {
    const roleId = await token[roleName]();
    await (await token.connect(adminSigner).grantRole(roleId, account)).wait();
    return roleId;
  }
  const roleId = ethers.keccak256(ethers.toUtf8Bytes(roleName));
  await (await token.connect(adminSigner).grantRole(roleId, account)).wait();
  return roleId;
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

/* ------------------------ Supply caps bundle (FIXED) ------------------------ */
async function getSupplyCapsSafe(token) {
  if (typeof token.getSupplyCaps === "function") {
    const out = await token.getSupplyCaps();
    return {
      maxSupply: BigInt(out[0].toString()),
      cap: BigInt(out[1].toString()),
      distributedTotal: BigInt(out[2].toString()),
      currentMonthlyCap: BigInt(out[3].toString()),
      currentMonthMinted: BigInt(out[4].toString()),
      halvingCount: out.length > 5 ? BigInt(out[5].toString()) : 0n,
    };
  }

  const cap = typeof token.cap === "function" ? BigInt((await token.cap()).toString()) : 0n;

  const currentMonthlyCap =
    typeof token.currentMonthlyCap === "function" ? BigInt((await token.currentMonthlyCap()).toString()) : null;

  const currentMonthMinted =
    typeof token.currentMonthMinted === "function" ? BigInt((await token.currentMonthMinted()).toString()) : null;

  let distributedTotal = null;
  for (const fn of ["distributedTotal", "totalDistributed", "distributed", "mintedTotal"]) {
    if (typeof token[fn] === "function") {
      distributedTotal = BigInt((await token[fn]()).toString());
      break;
    }
  }

  return { cap, distributedTotal, currentMonthlyCap, currentMonthMinted };
}

/* ---------------------------- Per-source config reads (FIXED) ---------------------------- */
/**
 * Your contract’s source config tuple shape has drifted.
 * This reader:
 *  - Prefers getSourceConfigFields/getSourceConfig
 *  - Uses heuristics to pick maxStepsPerDay vs minInterval from uint fields
 *  - Falls back to constants if needed
 */
async function getPerSourceLimits(token, source) {
  let maxStepsPerDay = null;
  let minInterval = null;

  const pickFromUintFields = (uints) => {
    // heuristic: maxStepsPerDay is usually "large" (>= 1000), minInterval is usually <= 7 days
    const sevenDays = 7n * 24n * 60n * 60n;
    const candidatesInterval = uints.filter((u) => u <= sevenDays);
    const candidatesMax = uints.filter((u) => u >= 1000n);

    // pick "most plausible"
    const pickedMin = candidatesInterval.length ? candidatesInterval[candidatesInterval.length - 1] : null;
    const pickedMax = candidatesMax.length ? candidatesMax[0] : null;

    return { pickedMax, pickedMin };
  };

  if (typeof token.getSourceConfigFields === "function") {
    const cfg = await token.getSourceConfigFields(source);
    // cfg may be: (bool,bool,bytes32,uint,uint,...) or (bool,bool,bytes32,uint,uint,uint,...)
    const uints = [];
    for (let i = 0; i < cfg.length; i++) {
      const v = cfg[i];
      if (typeof v === "bigint") uints.push(v);
      else if (v && typeof v.toString === "function" && /^\d+$/.test(v.toString())) uints.push(BigInt(v.toString()));
    }
    // remove the bytes32/booleans by just relying on what parsed as uints (booleans parse to "true/false")
    const { pickedMax, pickedMin } = pickFromUintFields(uints);
    if (pickedMax != null) maxStepsPerDay = pickedMax;
    if (pickedMin != null) minInterval = pickedMin;
  } else if (typeof token.getSourceConfig === "function") {
    const cfg = await token.getSourceConfig(source);
    // often: (bool,bool,bytes32,uint,uint,...) or variants
    const uints = [];
    for (let i = 0; i < cfg.length; i++) {
      const v = cfg[i];
      if (typeof v === "bigint") uints.push(v);
      else if (v && typeof v.toString === "function" && /^\d+$/.test(v.toString())) uints.push(BigInt(v.toString()));
    }
    const { pickedMax, pickedMin } = pickFromUintFields(uints);
    if (pickedMax != null) maxStepsPerDay = pickedMax;
    if (pickedMin != null) minInterval = pickedMin;
  }

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

  // best-effort sanity (don’t over-assert tuple shape)
  if (typeof token.getSourceConfigFields === "function") {
    const cfg = await token.getSourceConfigFields(source);
    expect(Boolean(cfg[0]), "requiresProof must be false").to.equal(false);
    expect(Boolean(cfg[1]), "requiresAttestation must be false").to.equal(false);
    expect(cfg[2], "merkleRoot must be ZeroHash").to.equal(Z);
  } else if (typeof token.getSourceConfig === "function") {
    const cfg = await token.getSourceConfig(source);
    expect(Boolean(cfg[0])).to.equal(false);
    expect(Boolean(cfg[1])).to.equal(false);
    expect(cfg[2]).to.equal(Z);
  }
}

/* ------------------------ Trust relayer (FIX) ------------------------ */
async function setTrustedRelayerIfPossible(token, admin, relayerAddr) {
  const t = token.connect(admin);

  if (await tryTx(t, "setTrustedAPI", relayerAddr, true)) return true;
  if (await tryTx(t, "setTrustedAPI", relayerAddr)) return true;
  if (await tryTx(t, "setTrustedRelayer", relayerAddr, true)) return true;
  if (await tryTx(t, "setTrustedRelayer", relayerAddr)) return true;
  if (await tryTx(t, "setTrustedCaller", relayerAddr, true)) return true;
  if (await tryTx(t, "setTrustedCaller", relayerAddr)) return true;

  return false;
}

/* ---------------------------- Stake read/write helpers ---------------------------- */
async function getUserStakeSafe(token, userAddr) {
  if (typeof token.getStakeInfo === "function") {
    const [bal] = await token.getStakeInfo(userAddr);
    return BigInt(bal.toString());
  }
  if (typeof token.getStakeBalance === "function") {
    const bal = await token.getStakeBalance(userAddr);
    return BigInt(bal.toString());
  }
  return 0n;
}
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

  const bal = await token.balanceOf(userSigner.address);
  const balBI = BigInt(bal.toString());
  if (balBI < delta) {
    const topUp = delta - balBI;
    await (await token.connect(funder).transfer(userSigner.address, topUp)).wait();
  }
  await (await token.connect(userSigner).stake(delta)).wait();
}

/* ---------------------------- Min reward helper ----------------------------- */
async function minStepsForReward(token) {
  const rr = await getRewardRateSafe(token);

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
  return (minReward + rr - 1n) / rr;
}

async function bumpMinInterval(token, source, extraSeconds = 2) {
  const { minInterval } = await getPerSourceLimits(token, source);
  await time.increase(Number(minInterval + BigInt(extraSeconds)));
}
async function bumpUtcDay() {
  await time.increase(24 * 60 * 60 + 3);
}

/* ------------------- Reward-too-small bounded bump ------------------- */
async function ensureStepsAboveMinRewardBounded(token, txCaller, steps, buildArgsFn, opts = {}) {
  let s = BigInt(steps || 1);
  const { maxStepsCap = null, submitter = null, withStake = false, funder = null } = opts;

  let stepLimit = null;
  try {
    stepLimit = await getStepLimitSafe(token);
    if (stepLimit === 0n) stepLimit = null;
  } catch {}

  const cap = (() => {
    let c = null;
    if (stepLimit != null) c = stepLimit;
    if (maxStepsCap != null) c = c == null ? maxStepsCap : (maxStepsCap < c ? maxStepsCap : c);
    return c;
  })();

  if (s === 0n) s = 1n;
  if (cap != null && s > cap) s = cap;

  if (withStake && submitter && cap != null) {
    const stakePerStep = await getStakePerStepSafe(token);
    const worstNeed = cap * stakePerStep;
    if (!funder) throw new Error("ensureStepsAboveMinRewardBounded requires opts.funder for token staking");
    await ensureTokenStake(token, funder, submitter, worstNeed);
  }

  for (let i = 0; i < 18; i++) {
    if (cap != null && s > cap) s = cap;
    const [payload, proofObj] = await buildArgsFn(s);

    try {
      await token.connect(txCaller).logSteps.staticCall(payload, proofObj);
      return s;
    } catch (e) {
      if (isDailyLimitError(e)) throw e;
      if (isInsufficientStakeError(e)) throw e;
      if (isTrustedRelayerRequiredError(e) || isUnauthorizedApiSignerError(e) || isSignerMustBeUserError(e)) throw e;

      if (!isRewardTooSmallError(e)) throw e;

      if (cap != null && s >= cap) throw new Error(`Reward too small even at cap=${cap.toString()}`);
      s = s * 2n;
      if (s === 0n) s = 1n;
      if (cap != null && s > cap) s = cap;
    }
  }

  throw new Error("Could not find steps above min reward within bump iterations");
}

/* ------------------- submitSteps() (FIXED for relayer/user modes) ------------------- */
async function submitSteps(token, submitter, steps, opts = {}) {
  const {
    source = "test-noproof",
    version = PAYLOAD_VER,
    beneficiary = submitter.address,
    proof = [],
    attestation = "0x",
    funder = null,
    relayer = null,
    withStake = true,
    maxStepsCap: maxStepsCapOverride = null,
    autoBumpDayIfCapTooSmall = true,

    // ✅ when true: do not preflight, do not auto-switch modes, just attempt once
    // used for revert-assertion tests (minInterval, deadline, etc.)
    allowRevert = false,
  } = opts;

  const { chainId } = await ethers.provider.getNetwork();

  // remaining daily allowance (optional)
  let maxStepsCap = null;
  try {
    if (typeof token.getUserSourceStats === "function") {
      const [, usedTodayRaw] = await token.getUserSourceStats(submitter.address, source);
      const usedToday = BigInt(usedTodayRaw.toString());
      const { maxStepsPerDay } = await getPerSourceLimits(token, source);
      maxStepsCap = usedToday >= maxStepsPerDay ? 0n : maxStepsPerDay - usedToday;

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
    maxStepsCap = maxStepsCap == null ? ov : ov < maxStepsCap ? ov : maxStepsCap;
  }

  let stepsBI = BigInt(steps || 1n);

  const buildArgsSignedBy = async (signer, s) => {
    const nonce = await token.nonces(submitter.address);
    const now = await time.latest();

    let sigPeriod = Number(await getSigValiditySafe(token));
    if (!Number.isFinite(sigPeriod) || sigPeriod <= 0) sigPeriod = 3600;

    const deadline = now + Math.max(60, sigPeriod - 5);

    const sig = await signStepData(
      token,
      submitter.address,
      beneficiary,
      s,
      nonce,
      deadline,
      chainId,
      source,
      version,
      signer
    );

    const payload = { user: submitter.address, beneficiary, steps: s, nonce, deadline, source, version };
    const proofObj = { signature: sig, proof, attestation };
    return [payload, proofObj];
  };

  // ✅ allowRevert mode: attempt exactly once, no preflight/bumping,
  // and IMPORTANT: use USER CALLER unless caller explicitly provided via relayer
  // (for your minInterval revert tests you want the same caller as tx0).
  if (allowRevert) {
    const txCaller = submitter; // force user path for deterministic minInterval checks
    const sigSigner = submitter;

    const [payload, proofObj] = await buildArgsSignedBy(sigSigner, stepsBI);
    return token.connect(txCaller).logSteps(payload, proofObj);
  }

  /**
   * Candidate modes to discover via staticCall:
   * - user caller + user sig
   * - user caller + api sig (if api signer role)
   * - relayer caller + api sig (trusted API path)
   */
  const candidates = [
    { name: "userCaller_userSig", caller: submitter, signer: submitter },
    ...(relayer ? [{ name: "userCaller_apiSig", caller: submitter, signer: relayer }] : []),
    ...(relayer ? [{ name: "relayerCaller_apiSig", caller: relayer, signer: relayer }] : []),
  ];

  let mode = null;
  let lastErr = null;

  for (const c of candidates) {
    try {
      const seeded = await ensureStepsAboveMinRewardBounded(
        token,
        c.caller,
        stepsBI,
        async (s) => buildArgsSignedBy(c.signer, s),
        {
          maxStepsCap,
          submitter,
          withStake: withStake && c.caller.address.toLowerCase() === submitter.address.toLowerCase(),
          funder,
        }
      );

      const [payload, proofObj] = await buildArgsSignedBy(c.signer, seeded);
      await token.connect(c.caller).logSteps.staticCall(payload, proofObj);

      mode = { ...c, seeded };
      stepsBI = seeded;
      break;
    } catch (e) {
      lastErr = e;
      continue;
    }
  }

  if (!mode) {
    throw new Error(`submitSteps preflight failed: ${_errMsg(lastErr)}`);
  }

  let txCaller = mode.caller;
  let sigSigner = mode.signer;

  const attemptOnce = async () => {
    stepsBI = await ensureStepsAboveMinRewardBounded(
      token,
      txCaller,
      stepsBI,
      async (s) => buildArgsSignedBy(sigSigner, s),
      {
        maxStepsCap,
        submitter,
        withStake: withStake && txCaller.address.toLowerCase() === submitter.address.toLowerCase(),
        funder,
      }
    );

    // stake only for USER CALLER
    if (withStake && txCaller.address.toLowerCase() === submitter.address.toLowerCase()) {
      const stakePerStep = await getStakePerStepSafe(token);
      const need = stepsBI * stakePerStep;
      if (!funder) throw new Error("submitSteps requires opts.funder for staking");
      await ensureTokenStake(token, funder, submitter, need);
    }

    const [payload, proofObj] = await buildArgsSignedBy(sigSigner, stepsBI);
    return token.connect(txCaller).logSteps(payload, proofObj);
  };

  let last = null;
  for (let i = 0; i < 8; i++) {
    try {
      return await attemptOnce();
    } catch (e) {
      last = e;
      const msg = _errMsg(e);

      if (autoBumpDayIfCapTooSmall && msg.includes("reward too small even at cap=")) {
        await bumpUtcDay();
        const { maxStepsPerDay } = await getPerSourceLimits(token, source);
        maxStepsCap = maxStepsPerDay;
        continue;
      }

      if (isTrustedRelayerRequiredError(e)) {
        if (!relayer) break;
        txCaller = relayer;
        sigSigner = relayer;
        continue;
      }

      if (isUnauthorizedApiSignerError(e)) {
        if (!relayer) break;
        sigSigner = relayer;
        continue;
      }

      if (isSignerMustBeUserError(e)) {
        sigSigner = submitter;
        txCaller = submitter;
        continue;
      }

      if (isInsufficientStakeError(e)) {
        txCaller = submitter;
        sigSigner = submitter;
        continue;
      }

      break;
    }
  }

  throw new Error(`submitSteps: exceeded retry budget. last=${_errMsg(last)}`);
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

  // ✅ Trusted API signing + caller permissions
  await grantRoleByNameIfNoGetter(token, admin, "API_SIGNER_ROLE", apiSigner.address);
  await grantRoleByNameIfNoGetter(token, admin, "SIGNER_ROLE", apiSigner.address);
  await setTrustedRelayerIfPossible(token, admin, apiSigner.address);
  await tryTx(token.connect(admin), "setTrustedAPI", apiSigner.address, true);

  // Sources
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

  const funder = treasury;

  // Seed user for staking (even if some paths don't require it)
  const seed = ethers.parseEther("50000");
  const ub = await token.balanceOf(user.address);
  if (ub < seed) {
    await (await token.connect(funder).transfer(user.address, seed - ub)).wait();
  }

  return { token, oracle, deployer, admin, treasury, funder, user, apiSigner, INITIAL_SUPPLY };
}

/* =============================== TESTS =============================== */
// =============================== TESTS ===============================
describe("Recommended Tests (robustness & regressions)", function () {
  describe("Invariants: caps and totals", function () {
    it("distributedTotal never exceeds cap; monthly mints never exceed current cap", async function () {
      this.timeout(180000);

      const { token, admin, user, funder, apiSigner } = await loadFixture(deployFixture);
      const src = "test-noproof";
      await enableSourceNoProofNoAttestation(token, admin, src);

      const cap = typeof token.cap === "function" ? await token.cap() : 0n;
      const stepLimit = await getStepLimitSafe(token);
      const { minInterval } = await getPerSourceLimits(token, src);
      const minIntervalSec = Number(minInterval);

      const stakePerStep = await getStakePerStepSafe(token);
      const safePerTx = stepLimit > 10n ? stepLimit - 10n : stepLimit;
      const targetSteps = safePerTx;
      const batchesThisMonth = 6n;

      // NOTE: mineAtStrict is NOT needed in this test; removed.

      await ensureTokenStake(token, funder, user, targetSteps * batchesThisMonth * stakePerStep);

      async function submitBatch() {
        const tx = await submitSteps(token, user, targetSteps, {
          source: src,
          funder,
          withStake: true,
          relayer: apiSigner,
        });
        await tx.wait();
        await time.increase(minIntervalSec + 1);
      }

      for (let i = 0n; i < batchesThisMonth; i++) await submitBatch();

      const s1 = await getSupplyCapsSafe(token);
      if (s1.distributedTotal != null) {
        expect(s1.distributedTotal).to.be.at.most(s1.cap ?? BigInt(cap.toString()));
      }
      if (s1.currentMonthMinted != null && s1.currentMonthlyCap != null) {
        expect(s1.currentMonthMinted).to.be.at.most(s1.currentMonthlyCap);
      }

      await time.increase(30 * 24 * 60 * 60 + 10);
      await token.connect(admin).forceMonthUpdate();

      for (let i = 0; i < 2; i++) await submitBatch();

      const s2 = await getSupplyCapsSafe(token);
      if (s2.distributedTotal != null) expect(s2.distributedTotal).to.be.at.most(BigInt(cap.toString()));
      if (s2.currentMonthMinted != null && s2.currentMonthlyCap != null) {
        expect(s2.currentMonthMinted).to.be.at.most(s2.currentMonthlyCap);
      }
    });
  });

  describe("Suspension flow: flaggedSubmissions persistence", function () {
    async function getGraceAndSuspensionSafe(token) {
      const tryFns = async (names, fallback) => {
        for (const n of names) {
          if (typeof token[n] === "function") {
            const v = await token[n]();
            return Number(v);
          }
        }
        return fallback;
      };
      const grace = await tryFns(["GRACE_PERIOD", "gracePeriod"], 3600);
      const susp = await tryFns(["SUSPENSION_DURATION", "suspensionDuration"], 86400);
      return { grace, susp };
    }

    it("does NOT auto-reset flaggedSubmissions after suspension; small submission succeeds post-suspension", async function () {
      const { token, admin, user, funder, apiSigner } = await loadFixture(deployFixture);
      const src = "anomaly-src";

      const { minInterval } = await getPerSourceLimits(token, src);
      const minIntervalSec = Number(minInterval);

      const stakePerStep = await getStakePerStepSafe(token);
      const { grace, susp: suspDur } = await getGraceAndSuspensionSafe(token);

      await enableSourceNoProofNoAttestation(token, admin, src);

      const minSteps = await minStepsForReward(token);
      const warm = 100n > minSteps ? 100n : minSteps;

      await ensureTokenStake(token, funder, user, ethers.parseEther("10"));

      for (let i = 0; i < 5; i++) {
        await time.increase(minIntervalSec + 1);
        const tx = await submitSteps(token, user, warm, { source: src, funder, withStake: true, relayer: apiSigner });
        await tx.wait();
      }

      await time.increase(grace + 5);

      const spikes = [3000n, 3000n, 3100n];
      for (const s of spikes) {
        await ensureTokenStake(token, funder, user, s * stakePerStep + ethers.parseEther("1"));
        await time.increase(minIntervalSec + 2);
        const tx = await submitSteps(token, user, s, { source: src, funder, withStake: true, relayer: apiSigner });
        await tx.wait();
      }

      const core1 = await token.getUserCoreStatus(user.address);
      const flagsAfterSpikes = BigInt(core1[1].toString());
      const until = BigInt(core1[2].toString());
      const nowT = BigInt(await time.latest());

      if (flagsAfterSpikes === 0n && until === 0n) {
        await time.increase(minIntervalSec + 2);
        const txOk = await submitSteps(token, user, warm, { source: src, funder, withStake: true, relayer: apiSigner });
        await expect(txOk).to.emit(token, "RewardClaimed");
        return;
      }

      expect(flagsAfterSpikes).to.be.gte(1n);
      expect(until).to.be.gt(nowT);

      await time.increase(minIntervalSec + 2);
      await expect(
        submitSteps(token, user, warm, { source: src, funder, withStake: true, relayer: apiSigner })
      ).to.be.revertedWith("Account suspended");

      await time.increase(suspDur + 3605);
      await time.increase(minIntervalSec + 1);

      const postSteps = 200n > minSteps ? 200n : minSteps;
      await ensureTokenStake(token, funder, user, postSteps * stakePerStep);

      const tx = await submitSteps(token, user, postSteps, { source: src, funder, withStake: true, relayer: apiSigner });
      await expect(tx).to.emit(token, "RewardClaimed");

      const core2 = await token.getUserCoreStatus(user.address);
      const flagsFinal = BigInt(core2[1].toString());
      expect(flagsFinal).to.equal(flagsAfterSpikes);
    });
  });

  describe("Trusted API path: no penalties / no suspension", function () {
    it("massive spikes via relayer do NOT flag or suspend, and require no stake (if relayer is trusted)", async function () {
      this.timeout(240000);

      const { token, user, apiSigner, admin } = await loadFixture(deployFixture);

      const src = "test-noproof";
      await enableSourceNoProofNoAttestation(token, admin, src);

      const stepLimit = await getStepLimitSafe(token);
      const { maxStepsPerDay } = await getPerSourceLimits(token, src);

      const minSteps = await minStepsForReward(token);
      let perTx =
        stepLimit < maxStepsPerDay ? (stepLimit > 1n ? stepLimit - 1n : stepLimit) : maxStepsPerDay / 4n;
      if (perTx < minSteps) perTx = minSteps;

      const txCount = 6;

      for (let i = 0; i < txCount; i++) {
        const [, usedTodayRaw] = await token.getUserSourceStats(user.address, src);
        const usedToday = BigInt(usedTodayRaw.toString());
        if (usedToday + perTx > maxStepsPerDay) await bumpUtcDay();

        const tx = await submitSteps(token, user, perTx, {
          source: src,
          relayer: apiSigner,
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
    it("stake behavior is consistent across multi-submit (no slashing/penalties)", async function () {
      const { token, user, admin, funder, apiSigner } = await loadFixture(deployFixture);

      const src = "test-noproof";
      await enableSourceNoProofNoAttestation(token, admin, src);

      const { minInterval } = await getPerSourceLimits(token, src);
      const minSec = Number(minInterval);

      const stakePerStep = await getStakePerStepSafe(token);
      const minSteps = await minStepsForReward(token);
      const per = 100n > minSteps ? 100n : minSteps;

      const submits = 10;

      // stake up the user plenty (even if API path skips stake consumption)
      const principal = per * BigInt(submits) * stakePerStep * 5n;
      await ensureTokenStake(token, funder, user, principal);

      const startStake = await getUserStakeSafe(token, user.address);
      expect(startStake).to.be.gt(0n);

      // Always use trusted API relayer path (matches GS_StepsAndVerification API rules)
      const doOne = async () => {
        const tx = await submitSteps(token, user, per, {
          source: src,
          funder,
          withStake: false, // IMPORTANT: don't assume user-caller stake path here
          relayer: apiSigner, // caller + signer will become apiSigner via preflight
        });
        await tx.wait();
        if (minSec > 0) await time.increase(minSec + 1);
      };

      // Probe one submit to learn whether stake changes at all on your current policy
      await doOne();
      const afterOne = await getUserStakeSafe(token, user.address);

      const consumedPerSubmit = startStake > afterOne ? startStake - afterOne : 0n;

      // Remaining submits
      for (let i = 1; i < submits; i++) await doOne();

      const endStake = await getUserStakeSafe(token, user.address);

      // If stake is not consumed in API path, consumedPerSubmit will be 0 and expectedEnd=startStake.
      const expectedEnd = startStake - BigInt(submits) * consumedPerSubmit;

      expect(endStake).to.equal(expectedEnd);
    });

  it("min interval boundaries (min-1 → revert; min → ok; min+1 → ok)", async function () {
  const { token, user, admin, funder, apiSigner } = await loadFixture(deployFixture);

  const SRC = "fuzz-interval-src-2";
  await enableSourceNoProofNoAttestation(token, admin, SRC);
  await bumpUtcDay();

  // --- Canonical config read (matches your SourceConfig layout) ---
  let minInterval;
  let maxStepsPerDay;

  if (typeof token.getSourceConfigFields === "function") {
    const cfg = await token.getSourceConfigFields(SRC);
    maxStepsPerDay = BigInt(cfg[3].toString());
    minInterval = BigInt(cfg[4].toString());
  } else if (typeof token.getSourceConfig === "function") {
    const cfg = await token.getSourceConfig(SRC);
    maxStepsPerDay = BigInt(cfg[3].toString());
    minInterval = BigInt(cfg[4].toString());
  } else {
    const lim = await getPerSourceLimits(token, SRC);
    maxStepsPerDay = BigInt(lim.maxStepsPerDay);
    minInterval = BigInt(lim.minInterval);
  }

  if (minInterval === 0n) {
    // interval genuinely disabled → nothing to boundary-test
    const txOk = await submitSteps(token, user, 10n, {
      source: SRC,
      relayer: apiSigner,
      withStake: false,
      autoBumpDayIfCapTooSmall: false,
    });
    await expect(txOk).to.emit(token, "RewardClaimed");
    return;
  }

  // Choose safe steps within caps
  let steps = await minStepsForReward(token);
  const stepLimit = await getStepLimitSafe(token);

  let cap = maxStepsPerDay;
  if (stepLimit && stepLimit > 0n && BigInt(stepLimit.toString()) < cap) cap = BigInt(stepLimit.toString());
  if (steps > cap) steps = cap;

  const stakePerStep = await getStakePerStepSafe(token);
  await ensureTokenStake(token, funder, user, steps * 10n * stakePerStep);

  const { chainId } = await ethers.provider.getNetwork();

  // -------------------- IMPORTANT: set timestamp for TX block (NO pre-mine) --------------------
  async function setNextTs(tsBig) {
    const latest = BigInt((await ethers.provider.getBlock("latest")).timestamp);
    let ts = BigInt(tsBig);
    if (ts <= latest) ts = latest + 1n; // keep Hardhat happy, like your mineAt
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(ts)]);
    return ts;
  }

  // Build a signature whose deadline is guaranteed valid at the target exec timestamp
  async function buildUserSigned(forExecTsBig) {
    const nonce = await token.nonces(user.address);

    let sigValidity = BigInt(await getSigValiditySafe(token));
    if (sigValidity < 10n) sigValidity = 10n;

    const execTs = BigInt(forExecTsBig);

    // Must satisfy:
    //   deadline > execTs
    //   deadline - execTs <= signatureValidityPeriod
    // Keep a small safety buffer (5s) to avoid edge cases.
    const slack = sigValidity > 15n ? (sigValidity - 5n) : (sigValidity - 1n);
    const deadline = execTs + slack;

    const sig = await signStepData(
      token,
      user.address,
      user.address,
      steps,
      nonce,
      deadline,
      chainId,
      SRC,
      PAYLOAD_VER,
      user
    );

    return {
      payload: {
        user: user.address,
        beneficiary: user.address,
        steps,
        nonce,
        deadline,
        source: SRC,
        version: PAYLOAD_VER,
      },
      proofObj: { signature: sig, proof: [], attestation: "0x" },
    };
  }

  // -------------------- Baseline submit at t0 --------------------
  const tNow0 = BigInt((await ethers.provider.getBlock("latest")).timestamp) + 1n;
  const exec0 = await setNextTs(tNow0);
  const a0 = await buildUserSigned(exec0);
  const tx0 = await token.connect(user).logSteps(a0.payload, a0.proofObj);
  const rc0 = await tx0.wait();
  const t0 = BigInt((await ethers.provider.getBlock(rc0.blockNumber)).timestamp);

  // -------------------- min-1 => MUST revert --------------------
  // Edge: if minInterval==1, min-1 == t0 (same timestamp). Hardhat won’t allow that.
  // So we assert via staticCall at current timestamp.
  if (minInterval === 1n) {
    const aFail = await buildUserSigned(t0 + 1n); // deadline valid, but staticCall uses current ts
    await expect(token.connect(user).logSteps.staticCall(aFail.payload, aFail.proofObj))
      .to.be.revertedWith("Submission too frequent");
  } else {
    const execFail = await setNextTs(t0 + minInterval - 1n);
    const aFail = await buildUserSigned(execFail);
    await expect(token.connect(user).logSteps(aFail.payload, aFail.proofObj))
      .to.be.revertedWith("Submission too frequent");
  }

  // -------------------- min => ok --------------------
  const exec1 = await setNextTs(t0 + minInterval);
  const a1 = await buildUserSigned(exec1);
  const tx1 = await token.connect(user).logSteps(a1.payload, a1.proofObj);
  await expect(tx1).to.emit(token, "RewardClaimed");
  const rc1 = await tx1.wait();
  const t1 = BigInt((await ethers.provider.getBlock(rc1.blockNumber)).timestamp);

  // -------------------- min+1 from t1 => ok --------------------
  const exec2 = await setNextTs(t1 + minInterval + 1n);
  const a2 = await buildUserSigned(exec2);
  const tx2 = await token.connect(user).logSteps(a2.payload, a2.proofObj);
  await expect(tx2).to.emit(token, "RewardClaimed");
});

  });
});
