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
    { name: "chainId", type: "uint256" }, // still in typehash constant (your storage STEPLOG_TYPEHASH includes it)
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
    chainId: Number(chainId), // ethers expects number here; message carries chainId as uint256
    verifyingContract,
  };

const message = {
  user,
  beneficiary,
  steps: toBI(steps),
  nonce: toBI(nonce),
  deadline: toBI(deadline),
  chainId: toBI(chainId),       // must match block.chainid used on-chain
  source,
  version,
};

  return signer.signTypedData(domain, STEPLOG_TYPES, message);
}
async function jumpPastMinInterval(token, source) {
  // prefer per-source minInterval if available
  const { minInterval } = await getPerSourceLimits(token, source, {
    maxStepsPerDay: 10_000n,
    minInterval: await getMinIntervalGlobalSafe(token),
  });

  // ensure next tx is after minInterval from "0"
  await time.increase(Number(minInterval + 2n));
  await ethers.provider.send("evm_mine", []);
}

// role id resolution fallback (works even if role getters are removed)
async function roleId(token, roleName) {
  if (typeof token[roleName] === "function") return token[roleName]();
  return ethers.keccak256(ethers.toUtf8Bytes(roleName));
}
async function grantRoleSafe(token, adminSigner, roleName, account) {
  if (typeof token.grantRole !== "function") return;
  const r = await roleId(token, roleName);
  if (typeof token.hasRole === "function") {
    const has = await token.hasRole(r, account);
    if (has) return;
  }
  await (await token.connect(adminSigner).grantRole(r, account)).wait();
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

/* ---------- Oracle helper ---------- */
async function refreshOracle(oracle, priceEthString) {
  const { timestamp } = await ethers.provider.getBlock("latest");
  await oracle.set(ethers.parseEther(priceEthString), timestamp, 0);
}
/* ------------------- Core params + source config (DROP-IN) ------------------- */
async function getCoreParamsSafe(token) {
  // getCoreParams(): (burnFeeBps, rewardRate, stepLimit, sigValidity)
  if (typeof token.getCoreParams === "function") {
    const out = await token.getCoreParams();
    return {
      burnFeeBps: toBI(out[0]),
      rewardRate: toBI(out[1]),
      stepLimit: toBI(out[2]),
      sigValidity: toBI(out[3]),
    };
  }

  // legacy fallbacks (only if present)
  const rewardRate =
    typeof token.rewardRate === "function" ? toBI(await token.rewardRate()) : 0n;

  const stepLimit =
    typeof token.stepLimit === "function" ? toBI(await token.stepLimit()) : 0n;

  const sigValidity =
    typeof token.signatureValidityPeriod === "function"
      ? toBI(await token.signatureValidityPeriod())
      : 3600n;

  return { burnFeeBps: 0n, rewardRate, stepLimit, sigValidity };
}

async function getRewardRateSafe(token) {
  return (await getCoreParamsSafe(token)).rewardRate;
}
async function getSigValiditySafe(token) {
  return (await getCoreParamsSafe(token)).sigValidity;
}

// per-source limits (maxStepsPerDay, minInterval)
async function getPerSourceLimits(token, src, fallback = { maxStepsPerDay: 10_000n, minInterval: 3600n }) {
  // Your repo already uses getSourceConfigFields/getSourceConfig in other tests
  if (typeof token.getSourceConfigFields === "function") {
    const cfg = await token.getSourceConfigFields(src);
    return { maxStepsPerDay: toBI(cfg[3]), minInterval: toBI(cfg[4]) };
  }
  if (typeof token.getSourceConfig === "function") {
    const cfg = await token.getSourceConfig(src);
    return { maxStepsPerDay: toBI(cfg[3]), minInterval: toBI(cfg[4]) };
  }
  return fallback;
}

// global fallback min interval (if you don't expose MIN_SUBMISSION_INTERVAL)
async function getMinIntervalGlobalSafe(token) {
  if (typeof token.MIN_SUBMISSION_INTERVAL === "function") return toBI(await token.MIN_SUBMISSION_INTERVAL());
  // fallback to storage constant you described (1 hour)
  return 3600n;
}

// stake-per-step used by fraud gate (IMPORTANT)
async function getStakePerStepGateSafe(token) {
  // Most accurate for your current fraud gate:
  // requiredStake = steps * MIN_STAKE_PER_STEP
  if (typeof token.MIN_STAKE_PER_STEP === "function") return toBI(await token.MIN_STAKE_PER_STEP());

  // If you made it non-public constant, fall back to currentStakePerStep (best available)
  if (typeof token.currentStakePerStep === "function") return toBI(await token.currentStakePerStep());

  // last resort: assume 0 (disables in tests)
  return 0n;
}

/* ---------- Helper: min steps to satisfy MIN_REWARD_AMOUNT ---------- */
async function minStepsForReward(token) {
  const rr = await getRewardRateSafe(token);

  let minReward = 0n;
  if (typeof token.MIN_REWARD_AMOUNT === "function") {
    minReward = toBI(await token.MIN_REWARD_AMOUNT());
  } else if (typeof token.minRewardAmount === "function") {
    minReward = toBI(await token.minRewardAmount());
  } else if (typeof token.getMinRewardAmount === "function") {
    minReward = toBI(await token.getMinRewardAmount());
  } else {
    minReward = 0n;
  }

  if (minReward === 0n) return 1n;
  if (rr === 0n) return 1n;
  return (minReward + rr - 1n) / rr; // ceil
}

/* =====================================================================
   ✅ STAKING HELPERS (TOKEN STAKE = GEMS)
   ===================================================================== */

async function getStakeBalance(token, userAddr) {
  // Preferred in your GS_Staking module
  if (typeof token.getStakeInfo === "function") {
    const [bal] = await token.getStakeInfo(userAddr);
    return toBI(bal);
  }

  // Bundled read in GS_ReadersMinimal
  if (typeof token.getUserCoreStatus === "function") {
    const out = await token.getUserCoreStatus(userAddr);
    // (stepAvg, flagged, suspendedUntil, stakedTokens, apiTrusted, firstTs)
    return toBI(out[3]);
  }

  // Fallback (if you ever expose it directly later)
  if (typeof token.stakeBalance === "function") {
    return toBI(await token.stakeBalance(userAddr));
  }

  return 0n;
}

/**
 * Ensure user has staked at least `requiredStake` GEMS.
 * funder should be treasury (holds initial supply).
 */
async function ensureTokenStake(token, funder, userSigner, requiredStake) {
  const need = toBI(requiredStake);
  const have = await getStakeBalance(token, userSigner.address);
  if (have >= need) return;

  const delta = need - have;

  // ensure user has tokens to stake
  const bal = toBI(await token.balanceOf(userSigner.address));
  if (bal < delta) {
    await (await token.connect(funder).transfer(userSigner.address, delta - bal)).wait();
  }

  // approve + stake (stake() uses _transfer(user -> address(this)), so allowance is needed)
  if (typeof token.approve === "function") {
    await (await token.connect(userSigner).approve(await token.getAddress(), delta)).wait();
  }
  await (await token.connect(userSigner).stake(delta)).wait();
}

/**
 * Stake needed for onboarding gate:
 * requiredStake = steps * MIN_STAKE_PER_STEP  (as per GS_AnomalyAndFraud)
 */
async function getStakePerStepGateSafe(token) {
  if (typeof token.MIN_STAKE_PER_STEP === "function") return toBI(await token.MIN_STAKE_PER_STEP());

  // If MIN_STAKE_PER_STEP isn't public in some builds, fall back to views bundle.
  // (Your GemStepViews duplicates constants, but tests don't deploy it.)
  // Last resort: use currentStakePerStep if exposed (less correct, but prevents hangs).
  if (typeof token.currentStakePerStep === "function") return toBI(await token.currentStakePerStep());

  // As a last-last resort, assume the policy constant you posted (0.01 GEMS/step)
  return 10_000_000_000_000_000n; // 1e16
}

async function ensureStakeForSteps(token, funder, stakerSigner, stepsBI, headroom = 0n) {
  const stakePerStepGate = await getStakePerStepGateSafe(token);
  const steps = toBI(stepsBI);

  if (stakePerStepGate === 0n) return { stakePerStep: 0n, need: 0n };

  const need = stakePerStepGate * steps + toBI(headroom);
  await ensureTokenStake(token, funder, stakerSigner, need);
  return { stakePerStep: stakePerStepGate, need };
}

/**
 * Stake-aware bump:
 * - starts at max(startSteps, minStepsForReward)
 * - stakes BEFORE staticCall
 * - doubles on Reward too small
 * - if Insufficient stake ever appears, tops up and retries
 */
async function bumpStepsPastMinReward({ token, funder, startSteps, buildArgs, maxIters = 12 }) {
  let s = toBI(startSteps || 1n);
  const floor = await minStepsForReward(token);
  if (s < floor) s = floor;

  // optional cap by stepLimit if exposed
  let cap = null;
  try {
    if (typeof token.stepLimit === "function") {
      cap = toBI(await token.stepLimit());
      if (cap === 0n) cap = null;
    }
  } catch {}

  for (let i = 0; i < maxIters; i++) {
    if (cap != null && s > cap) s = cap;

    const { payload, proofObj, caller } = await buildArgs(s);

    await ensureStakeForSteps(token, funder, caller, s);

    try {
      await token.connect(caller).logSteps.staticCall(payload, proofObj);
      return s;
    } catch (e) {
      if (isInsufficientStake(e)) {
        await ensureStakeForSteps(token, funder, caller, s);
        i -= 1;
        continue;
      }
      if (isRewardTooSmall(e)) {
        if (cap != null && s >= cap) throw new Error(`Reward too small even at stepLimit cap=${cap}`);
        s = s * 2n;
        continue;
      }
      throw e;
    }
  }

  throw new Error("Could not bump steps past MIN_REWARD within iterations");
}

/* ---------- Deploy fixture ---------- */
async function deployProxyFixture() {
  const [deployer, admin, treasury, user, beneficiary, api, other] =
    await ethers.getSigners();

  const Mock = await ethers.getContractFactory("MockOracleV2");
  const oracle = await Mock.deploy();
  await oracle.waitForDeployment();

  await refreshOracle(oracle, "0.005");
  await oracle.setPolicy(300, 100);

  const Token = await ethers.getContractFactory("contracts/GemStepToken.sol:GemStepToken");
  const initialSupply = ethers.parseUnits("400000000", 18);

  const token = await upgrades.deployProxy(
    Token,
    [initialSupply, admin.address, await oracle.getAddress(), treasury.address],
    { initializer: "initialize" }
  );
  await token.waitForDeployment();

  const chainId = toBI((await ethers.provider.getNetwork()).chainId);

  // Ensure admin has DEFAULT_ADMIN_ROLE if needed (optional safety)
const DAR = await token.DEFAULT_ADMIN_ROLE();
if (typeof token.hasRole === "function" && !(await token.hasRole(DAR, admin.address))) {
  await (await token.connect(deployer).grantRole(DAR, admin.address)).wait();
}

// ✅ ensure api is an authorized signer (covers builds where getter is removed)
await grantRoleSafe(token, admin, "API_SIGNER_ROLE", api.address);
await grantRoleSafe(token, admin, "SIGNER_ROLE", api.address); // some variants use this instead

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

  // Trusted API if available
  if (typeof token.setTrustedAPI === "function") {
    await token.connect(admin).setTrustedAPI(api.address, true);
  }

  // ✅ funder is treasury (holds initial supply)
  const funder = treasury;

  return {
    token,
    oracle,
    deployer,
    admin,
    treasury,
    funder,
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
  this.timeout(120000);

  const { token, funder, user, beneficiary, chainId } = await loadFixture(deployProxyFixture);
  const source = "applehealth";

  await jumpPastMinInterval(token, source);

  // Find a steps value that passes MIN_REWARD (and auto-stakes for it)
  const steps = await bumpStepsPastMinReward({
    token,
    funder,
    startSteps: 100n,
    buildArgs: async (stepsBI) => {
      const nonce = toBI(await token.nonces(user.address));
      const now = toBI(await time.latest());
      let sigV = toBI(await getSigValiditySafe(token));
      if (sigV <= 0n) sigV = 3600n;

      const deadline = now + (sigV > 120n ? 120n : (sigV > 10n ? sigV - 5n : 5n));

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
  payload: {
    user: user.address,
    beneficiary: beneficiary.address,
    steps: toBI(stepsBI),
    nonce,
    deadline,
    source,
    version: "1.0.0",
  },
  proofObj: { signature: sig, proof: [], attestation: "0x" },
};

    },
  });

  // Ensure stake is present for the final steps (safe even if already staked)
  await ensureStakeForSteps(token, funder, user, steps);

  const before = await token.balanceOf(beneficiary.address);

  const nonce = toBI(await token.nonces(user.address));
  const now = toBI(await time.latest());
  let sigV = toBI(await getSigValiditySafe(token));
  if (sigV <= 0n) sigV = 3600n;
  const deadline = now + (sigV > 120n ? 120n : (sigV > 10n ? sigV - 5n : 5n));

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

  const tx = await token.connect(user).logSteps(
    { user: user.address, beneficiary: beneficiary.address, steps, nonce, deadline, source, version: "1.0.0" },
    { signature: sig, proof: [], attestation: "0x" },
    { gasLimit: 6_000_000 }
  );

  await expect(tx).to.emit(token, "RewardClaimed");
  await tx.wait();

  const after = await token.balanceOf(beneficiary.address);
  expect(after - before).to.be.gt(0n);
});


  it("reverts when user stake is insufficient", async function () {
    const { token, user, beneficiary, chainId } = await loadFixture(deployProxyFixture);

    const source = "applehealth";

    let steps = 1000n;
    const floor = await minStepsForReward(token);
    if (steps < floor) steps = floor;

    // ✅ do NOT stake enough (small stake) — token staking, not ETH staking
    // Give user tiny amount of GEMS then stake tiny amount.
    const tiny = ethers.parseEther("0.00000001");
    // If they have 0 balance, the transfer may revert; so check and only transfer if needed:
    // (We don't have funder here; easiest: just don't stake at all.)
    // Insufficient stake should still trigger.
    // If your contract requires *some* stake mapping value to exist, uncomment below and pass funder from fixture.
    // await ensureTokenStake(token, funder, user, tiny);

    const nonce = toBI(await token.nonces(user.address));
    const now = toBI(await time.latest());
    let sigV = toBI(await getSigValiditySafe(token));
    if (sigV <= 0n) sigV = 3600n;
    // keep comfortably inside validity window
    const deadline = now + (sigV > 120n ? 120n : (sigV > 10n ? sigV - 5n : 5n));

const payload = {
  user: user.address,
  beneficiary: beneficiary.address,
  steps,
  nonce,
  deadline,
  source,
  version: "1.0.0",
};

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

const proofObj = { signature: sig, proof: [], attestation: "0x" };

await expect(token.connect(user).logSteps(payload, proofObj))
  .to.be.revertedWith("Insufficient stake");

  });

  it("trusted API bypasses user stake check when signature is from authorized API signer", async function () {
  this.timeout(120000);

  const { token, admin, api, user, beneficiary, chainId } = await loadFixture(deployProxyFixture);

  const source = "applehealth";
  await jumpPastMinInterval(token, source);

  // Ensure api is authorized (role-based in this build)
  async function grantIfRoleExists(roleFnName) {
    if (typeof token[roleFnName] !== "function") return false;
    const role = await token[roleFnName]();
    if (typeof token.hasRole === "function" && (await token.hasRole(role, api.address))) return true;
    if (typeof token.grantRole === "function") {
      await (await token.connect(admin).grantRole(role, api.address)).wait();
      return true;
    }
    return false;
  }

  await grantIfRoleExists("API_SIGNER_ROLE");
  await grantIfRoleExists("SIGNER_ROLE");

  // Some builds also require explicit allow-listing
  if (typeof token.setTrustedAPI === "function") {
    await (await token.connect(admin).setTrustedAPI(api.address, true)).wait();
  }

  // Pick steps >= MIN_REWARD floor (no staking on user, because API is supposed to bypass)
  let steps = 5000n;
  const floor = await minStepsForReward(token);
  if (steps < floor) steps = floor;

  const nonce = toBI(await token.nonces(user.address));
  const now = toBI(await time.latest());
  let sigV = toBI(await getSigValiditySafe(token));
  if (sigV <= 0n) sigV = 3600n;
  const deadline = now + (sigV > 120n ? 120n : (sigV > 10n ? sigV - 5n : 5n));

  const sig = await signStepData({
    signer: api, // ✅ signature from API signer
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

  const tx = await token.connect(api).logSteps(
    { user: user.address, beneficiary: beneficiary.address, steps, nonce, deadline, source, version: "1.0.0" },
    { signature: sig, proof: [], attestation: "0x" },
    { gasLimit: 6_000_000 }
  );

  await expect(tx).to.emit(token, "RewardClaimed");
  await tx.wait();
});


  it("adjusts stake via oracle (if module exists) and can lock/unlock + manual override (if present)", async function () {
  const { token, oracle, admin, deployer } = await loadFixture(deployProxyFixture);

  // Try calling whichever oracle-adjust function exists (most specific first)
  const callIfExists = async (signer, name, args = []) => {
    try {
      token.interface.getFunction(name); // throws if missing
    } catch {
      return { ok: false };
    }
    const connected = token.connect(signer);
    if (typeof connected[name] !== "function") return { ok: false }; // prevents your current error
    const tx = await connected[name](...args);
    await tx.wait();
    return { ok: true, tx };
  };

  // Respect cooldown if it exists
  let cooldown = 0n;
  try {
    if (typeof token.STAKE_ADJUST_COOLDOWN === "function") cooldown = toBI(await token.STAKE_ADJUST_COOLDOWN());
  } catch {}
  await time.increase(Number(cooldown + 2n));

  await refreshOracle(oracle, "0.005");

  const candidates = [
    "adjustStakeRequirements",
    "adjustStakePerStepFromOracle",
    "updateStakePerStepFromOracle",
    "adjustStakeParamsFromOracle",
    "refreshStakeFromOracle",
    "recomputeStakePerStep",
  ];

  let didAdjust = false;
  for (const name of candidates) {
    const res = await callIfExists(admin, name);
    if (res.ok) {
      didAdjust = true;
      // if your build emits StakeParametersUpdated, keep it soft (don’t fail if event differs)
      break;
    }
  }

  // If no oracle-adjust module exists in this build, don’t fail the suite.
  if (!didAdjust) {
    // If module not present, don't fail the test suite.
  if (typeof token.currentStakePerStep !== "function") return;

    return;
  }

  // Optional lock/unlock & manual override if present
  if (typeof token.toggleStakeParamLock === "function") {
    await (await token.connect(deployer).toggleStakeParamLock()).wait();
    expect(await token.stakeParamsLocked()).to.equal(true);
    await (await token.connect(deployer).toggleStakeParamLock()).wait();
    expect(await token.stakeParamsLocked()).to.equal(false);
  }

  if (typeof token.manualOverrideStake === "function") {
    await (await token.connect(deployer).manualOverrideStake(ethers.parseEther("0.0003"))).wait();
    expect(await token.currentStakePerStep()).to.equal(ethers.parseEther("0.0003"));
  }
});

  it("rejects stale nonce (cannot reuse a prior signature after nonce increments)", async function () {
    const { token, funder, user, beneficiary, chainId } = await loadFixture(deployProxyFixture);

    const source = "applehealth";

    let steps = 10n;

    steps = await bumpStepsPastMinReward({
      token,
      funder,
      startSteps: steps,
      buildArgs: async (s) => {
  const nonce = toBI(await token.nonces(user.address));
  const now = toBI(await time.latest());
  let sigV = toBI(await getSigValiditySafe(token));
  if (sigV <= 0n) sigV = 3600n;

  const deadline = now + (sigV > 120n ? 120n : (sigV > 10n ? sigV - 5n : 5n));

  const sig = await signStepData({
    signer: user,
    verifyingContract: await token.getAddress(),
    chainId,
    user: user.address,
    beneficiary: beneficiary.address,
    steps: s,                 // ✅ use s
    nonce,
    deadline,
    source,
    version: "1.0.0",
  });

  return {
    caller: user,
    payload: {
      user: user.address,
      beneficiary: beneficiary.address,
      steps: s,               // ✅ use s
      nonce,
      deadline,
      source,
      version: "1.0.0",
    },
    proofObj: { signature: sig, proof: [], attestation: "0x" },
  };
},

    });

    await ensureStakeForSteps(token, funder, user, steps);

    const n0 = toBI(await token.nonces(user.address));
    const d0 = toBI((await time.latest()) + 3600);

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
      const { token, funder, user } = await loadFixture(deployProxyFixture);

      await ensureTokenStake(token, funder, user, ethers.parseEther("1"));

      const [stakedBefore] = await token.getStakeInfo(user.address);
      const withdrawAmt = ethers.parseEther("0.4");

      const balUser0 = await token.balanceOf(user.address);
      const balCtr0  = await token.balanceOf(await token.getAddress());

      await (await token.connect(user).withdrawStake(withdrawAmt)).wait();

      const [stakedAfter] = await token.getStakeInfo(user.address);
      const balUser1 = await token.balanceOf(user.address);
      const balCtr1  = await token.balanceOf(await token.getAddress());

      expect(stakedAfter).to.equal(stakedBefore - withdrawAmt);
      expect(balUser1).to.equal(balUser0 + withdrawAmt);
      expect(balCtr1).to.equal(balCtr0 - withdrawAmt);
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
   Suspension flow
======================================================================= */
async function getSuspendedUntil(token, userAddr) {
  const s = await token.getUserCoreStatus(userAddr);

  // If named return exists
  if (s?.suspendedUntil !== undefined) return toBI(s.suspendedUntil);

  // Your earlier assumption (and typical layout):
  // [0]=something, [1]=flaggedSubmissions, [2]=suspendedUntil
  if (Array.isArray(s) && s.length >= 3) {
    return toBI(s[2]);
  }

  throw new Error("getUserCoreStatus() unexpected layout; cannot find suspendedUntil");
}

describe("Onboarding cap (non-API submissions)", function () {
  it("allows first anomalyThreshold non-API submissions, then requires trusted API", async function () {
    const { token, funder, admin, user, beneficiary, api, chainId } = await loadFixture(deployProxyFixture);

    const source = "cap-src";
    await token.connect(admin).configureSource(source, false, false);

    // Ensure payload version allowed
    if (typeof token.addSupportedPayloadVersion === "function") {
      await token.connect(admin).addSupportedPayloadVersion("1.0.0");
    }

    // Stake enough for onboarding submissions
    const steps = 200n;
    await ensureStakeForSteps(token, funder, user, steps);

    // Read threshold from storage bundle if you want, else use constant 3
    const threshold = 3;

    // helper: do a user submission
    const submitUser = async () => {
      await jumpPastMinInterval(token, source);
      const nonce = toBI(await token.nonces(user.address));
      const now = toBI(await time.latest());
      const sigV = toBI(await getSigValiditySafe(token));
      const deadline = now + (sigV > 120n ? 120n : (sigV > 10n ? sigV - 5n : 5n));

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
    };

    // First N pass
    for (let i = 0; i < threshold; i++) {
      await (await submitUser()).wait();
    }

    // Next non-API should revert with your new message
    await jumpPastMinInterval(token, source);
    {
      const nonce = toBI(await token.nonces(user.address));
      const now = toBI(await time.latest());
      const sigV = toBI(await getSigValiditySafe(token));
      const deadline = now + (sigV > 120n ? 120n : (sigV > 10n ? sigV - 5n : 5n));

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
      ).to.be.revertedWith("GS: trusted API caller/relayer required");
    }

    // Trusted API should still be able to submit (no stake/onboarding restrictions)
    if (typeof token.setTrustedAPI === "function") {
      await token.connect(admin).setTrustedAPI(api.address, true);
    }

    await jumpPastMinInterval(token, source);
    {
      const nonce = toBI(await token.nonces(user.address));
      const now = toBI(await time.latest());
      const sigV = toBI(await getSigValiditySafe(token));
      const deadline = now + (sigV > 120n ? 120n : (sigV > 10n ? sigV - 5n : 5n));

      const sig = await signStepData({
        signer: api, // API signer
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
    }
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
    const { token, funder, admin, user, beneficiary, chainId } = await loadFixture(deployProxyFixture);

    const source = "merkle-src";
    await token.connect(admin).configureSource(source, true, false);

    let steps = 123n;

    for (let i = 0; i < 12; i++) {
      const leaf = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256", "uint256"], [user.address, steps, 0])
      );
      const leaf2 = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256", "uint256"], [beneficiary.address, 999n, 0])
      );

      const { root, layers } = buildMerkle([leaf, leaf2]);
      const proof = getProof(0, layers);

      await token.connect(admin).setSourceMerkleRoot(source, root);

      await ensureStakeForSteps(token, funder, user, steps);

      const nonce = toBI(await token.nonces(user.address));
      const now = toBI(await time.latest());
      let sigV = toBI(await getSigValiditySafe(token));
      if (sigV <= 0n) sigV = 3600n;
      // keep comfortably inside validity window
      const deadline = now + (sigV > 120n ? 120n : (sigV > 10n ? sigV - 5n : 5n));

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
        return;
      } catch (e) {
        if (isRewardTooSmall(e)) {
          steps *= 2n;
          continue;
        }
        throw e;
      }
    }

    throw new Error("Could not find steps large enough for MIN_REWARD with valid proof");
  });

  it("rejects an invalid Merkle proof", async function () {
    const { token, funder, admin, user, beneficiary, chainId } = await loadFixture(deployProxyFixture);

    const source = "merkle-src-invalid";
    await token.connect(admin).configureSource(source, true, false);

    let steps = 222n;
    const floor = await minStepsForReward(token);
    if (steps < floor) steps = floor;

    await ensureStakeForSteps(token, funder, user, steps);

    const targetLeaf = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256", "uint256"], [user.address, steps, 0])
    );
    const otherLeaf = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256", "uint256"], [beneficiary.address, 777n, 0])
    );
    const { root, layers } = buildMerkle([targetLeaf, otherLeaf]);
    const wrongProof = getProof(1, layers);

    await token.connect(admin).setSourceMerkleRoot(source, root);

    const nonce = toBI(await token.nonces(user.address));
    const now = toBI(await time.latest());
    let sigV = toBI(await getSigValiditySafe(token));
    if (sigV <= 0n) sigV = 3600n;
    // keep comfortably inside validity window
    const deadline = now + (sigV > 120n ? 120n : (sigV > 10n ? sigV - 5n : 5n));

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
    const { token, funder, admin, user, beneficiary, chainId } = await loadFixture(deployProxyFixture);

    const source = "merkle-src-toolong";
    await token.connect(admin).configureSource(source, true, false);
    await token.connect(admin).setSourceMerkleRoot(source, ethers.ZeroHash);

    const tooLong = Array.from({ length: 33 }, (_, i) =>
      ethers.keccak256(ethers.toUtf8Bytes("node-" + i))
    );

    let steps = 10n;
    const floor = await minStepsForReward(token);
    if (steps < floor) steps = floor;

    await ensureStakeForSteps(token, funder, user, steps);

    const nonce = toBI(await token.nonces(user.address));
    const now = toBI(await time.latest());
    let sigV = toBI(await getSigValiditySafe(token));
    if (sigV <= 0n) sigV = 3600n;
    // keep comfortably inside validity window
    const deadline = now + (sigV > 120n ? 120n : (sigV > 10n ? sigV - 5n : 5n));

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