/* eslint-disable no-unused-expressions */
// SPDX-License-Identifier: MIT
const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

/* =======================================================================
   GS_AnomalyAndFraud — UPDATED (no penalties / no suspension)
   - Enforces per-(user,source) min-interval: "Submission too frequent"
   - Enforces per-(user,source) daily cap: "Daily limit exceeded"
   - NON-trusted callers:
       * require stake >= steps * MIN_STAKE_PER_STEP (token or ETH-based depending on staking module)
       * allow only first `anomalyThreshold` successful NON-API submissions
         then revert: "GS: trusted API caller/relayer required"
   - Trusted API callers bypass stake + onboarding cap
======================================================================= */

/* =======================================================================
   EIP-712
======================================================================= */
const EIP712_NAME = "GemStep";
const EIP712_VERSION = "1.0.0";
const PAYLOAD_VERSION = "1.0.0";

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

/* =======================================================================
   Small helpers
======================================================================= */
const toBI = (v) => (typeof v === "bigint" ? v : BigInt(v.toString()));

function _errMsg(e) {
  return `${e?.reason || ""} ${e?.shortMessage || ""} ${e?.message || ""}`.toLowerCase();
}
function isInsufficientStake(e) {
  return _errMsg(e).includes("insufficient stake");
}
function isTooFrequent(e) {
  return _errMsg(e).includes("submission too frequent");
}
function isDailyLimit(e) {
  return _errMsg(e).includes("daily limit exceeded");
}
function isTrustedRequired(e) {
  return _errMsg(e).includes("trusted api caller/relayer required");
}

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
  version = PAYLOAD_VERSION,
}) {
  const domain = {
    name: EIP712_NAME,
    version: EIP712_VERSION,
    chainId: Number(chainId),
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

/* =======================================================================
   Source config readers (NO dependency on MIN_SUBMISSION_INTERVAL getter)
   Expected layout:
     cfg[3] = maxStepsPerDay
     cfg[4] = minInterval
======================================================================= */
async function getPerSourceLimits(token, src) {
  // prefer canonical tuple readers used elsewhere in your suite
  if (typeof token.getSourceConfigFields === "function") {
    const cfg = await token.getSourceConfigFields(src);
    return { maxStepsPerDay: toBI(cfg[3]), minInterval: toBI(cfg[4]) };
  }
  if (typeof token.getSourceConfig === "function") {
    const cfg = await token.getSourceConfig(src);
    return { maxStepsPerDay: toBI(cfg[3]), minInterval: toBI(cfg[4]) };
  }

  // last-resort safe defaults (should not be hit in your repo)
  return { maxStepsPerDay: 10_000n, minInterval: 3600n };
}

async function jumpPastMinInterval(token, src) {
  const { minInterval } = await getPerSourceLimits(token, src);
  await time.increase(Number(minInterval + 2n));
  await ethers.provider.send("evm_mine", []);
}

async function jumpToNextUtcDay() {
  const now = BigInt(await time.latest());
  const nextDay = ((now / 86400n) + 1n) * 86400n + 2n;
  await time.increaseTo(Number(nextDay));
  await ethers.provider.send("evm_mine", []);
}

/* =======================================================================
   Stake model adapter (FIXED for overloads / ethers v6)
   - Prefers stake(uint256) if present (your current build)
   - Otherwise falls back to stake() payable
   - Always verifies stakeBalance actually increased
======================================================================= */

async function getStakeBalanceBI(token, userAddr) {
  // Prefer your readers bundle if present
  if (typeof token.getUserCoreStatus === "function") {
    const out = await token.getUserCoreStatus(userAddr);
    // (.., stakedTokens, ..) = index 3 per your GS_ReadersMinimal
    return toBI(out[3]);
  }
  if (typeof token.getStakeInfo === "function") {
    const [bal] = await token.getStakeInfo(userAddr);
    return toBI(bal);
  }
  if (typeof token.stakeBalance === "function") {
    return toBI(await token.stakeBalance(userAddr));
  }
  return 0n;
}

function hasFn(token, sig) {
  try {
    // ethers v6 exposes overloads via token["fn(sig)"]
    return typeof token[sig] === "function";
  } catch {
    return false;
  }
}

async function ensureStakeForSteps(token, funder, userSigner, stepsBI, headroomBI = 0n) {
  const steps = toBI(stepsBI);

  // Prefer MIN_STAKE_PER_STEP (your GemStepStorage constant is internal, but
  // many builds expose currentStakePerStep as the active gate).
  let perStep = 0n;
  if (typeof token.MIN_STAKE_PER_STEP === "function") {
    perStep = toBI(await token.MIN_STAKE_PER_STEP());
  } else if (typeof token.currentStakePerStep === "function") {
    perStep = toBI(await token.currentStakePerStep());
  } else if (typeof token.getStakeParams === "function") {
    const out = await token.getStakeParams();
    perStep = toBI(out[0]);
  } else {
    // last resort; should not happen in your repo
    perStep = 1n;
  }

  const required = steps * perStep + toBI(headroomBI);

  const before = await getStakeBalanceBI(token, userSigner.address);
  if (before >= required) return { perStep, required };

  const delta = required - before;

  // Ensure user has tokens (token-stake path needs balance)
  const bal = toBI(await token.balanceOf(userSigner.address));
  if (bal < delta) {
    await (await token.connect(funder).transfer(userSigner.address, delta - bal)).wait();
  }

  // ---- Prefer token-stake: stake(uint256) ----
  if (hasFn(token, "stake(uint256)")) {
    // Some implementations pull via transferFrom; approving is harmless if unused.
    if (typeof token.approve === "function") {
      await (await token.connect(userSigner).approve(await token.getAddress(), delta)).wait();
    }

    await (await token.connect(userSigner)["stake(uint256)"](delta)).wait();

    const after = await getStakeBalanceBI(token, userSigner.address);
    // hard assert: staking MUST actually increase stakeBalance for tests to be meaningful
    expect(after).to.be.gte(before + delta);
    return { perStep, required };
  }

  // ---- Fallback ETH-stake: stake() payable ----
  if (hasFn(token, "stake()")) {
    await (await token.connect(userSigner)["stake()"]({ value: delta })).wait();
    const after = await getStakeBalanceBI(token, userSigner.address);
    expect(after).to.be.gte(before + delta);
    return { perStep, required };
  }

  // If we got here, your ABI doesn’t match expected staking module.
  throw new Error("No supported stake function found (expected stake(uint256) or stake())");
}

/* =======================================================================
   Submission helper (NO overrides object stuffed into struct fields)
======================================================================= */
async function submitSteps({ token, caller, signerForSig, user, beneficiary, chainId, source, steps }) {
  const nonce = toBI(await token.nonces(user.address));
  const now = toBI(await time.latest());

  // keep signatures short & safe
  const deadline = now + 600n;

  const sig = await signStepData({
    signer: signerForSig,
    verifyingContract: await token.getAddress(),
    chainId,
    user: user.address,
    beneficiary: beneficiary.address,
    steps: toBI(steps),
    nonce,
    deadline,
    source,
    version: PAYLOAD_VERSION,
  });

  return token.connect(caller).logSteps(
    {
      user: user.address,
      beneficiary: beneficiary.address,
      steps: toBI(steps),
      nonce,
      deadline,
      source,
      version: PAYLOAD_VERSION,
    },
    { signature: sig, proof: [], attestation: "0x" }
  );
}

/* =======================================================================
   Role / trusted API helpers (best-effort)
======================================================================= */
async function roleId(token, roleName) {
  if (typeof token[roleName] === "function") return token[roleName]();
  return ethers.keccak256(ethers.toUtf8Bytes(roleName));
}

async function grantRoleSafe(token, adminSigner, roleName, account) {
  if (typeof token.grantRole !== "function") return false;
  const r = await roleId(token, roleName);
  if (typeof token.hasRole === "function") {
    try {
      if (await token.hasRole(r, account)) return true;
    } catch {}
  }
  try {
    await (await token.connect(adminSigner).grantRole(r, account)).wait();
    return true;
  } catch {
    return false;
  }
}

async function setTrustedApiSafe(token, adminSigner, apiAddr, enabled = true) {
  if (typeof token.setTrustedAPI === "function") {
    await (await token.connect(adminSigner).setTrustedAPI(apiAddr, enabled)).wait();
    return true;
  }
  return false;
}

async function getOnboardingThresholdSafe(token) {
  // In your updated GS_AnomalyAndFraud, anomalyThreshold is repurposed as the onboarding limit.
  if (typeof token.anomalyThreshold === "function") {
    try {
      const v = toBI(await token.anomalyThreshold());
      if (v > 0n) return v;
    } catch {}
  }
  // Conservative fallback aligned with your stated behavior
  return 3n;
}

/* =======================================================================
   Fixture (proxy deploy)
======================================================================= */
async function deployProxyFixture() {
  const [deployer, admin, treasury, user, beneficiary, api, other] = await ethers.getSigners();

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

  const chainId = toBI((await ethers.provider.getNetwork()).chainId);

  // make sure a common source exists (tests create their own too)
  if (typeof token.configureSource === "function") {
    await (await token.connect(admin).configureSource("applehealth", false, false)).wait();
  }

  if (typeof token.addSupportedPayloadVersion === "function") {
    await (await token.connect(admin).addSupportedPayloadVersion(PAYLOAD_VERSION)).wait();
  } else if (typeof token.addSupportedVersion === "function") {
    await (await token.connect(admin).addSupportedVersion(PAYLOAD_VERSION)).wait();
  }

  // best-effort: authorize api signer if your build requires it (some variants do)
  await grantRoleSafe(token, admin, "API_SIGNER_ROLE", api.address);
  await grantRoleSafe(token, admin, "SIGNER_ROLE", api.address);

  // best-effort: trust API (bypass path)
  await setTrustedApiSafe(token, admin, api.address, true);

  const funder = treasury; // initial supply minted here in your design

  return { token, oracle, deployer, admin, treasury, funder, user, beneficiary, api, other, chainId };
}
async function alignToUtcDayWithRoom(minInterval, jumps = 2n, margin = 10n) {
  const now = BigInt(await time.latest());
  const dayStart = (now / 86400n) * 86400n;
  const nextDay = dayStart + 86400n;

  // we need: start + jumps*(minInterval+2) + margin < nextDay
  const needed = jumps * (toBI(minInterval) + 2n) + margin;

  // pick a start early enough in THIS day if possible; otherwise move to NEXT day early
  let start = dayStart + 5n;

  if (start + needed >= nextDay) {
    start = nextDay + 5n; // early next UTC day
  }

  await time.increaseTo(Number(start));
  await ethers.provider.send("evm_mine", []);
}

/* =======================================================================
   Tests (UPDATED for no-penalty / no-suspension behavior)
======================================================================= */
describe("GS_AnomalyAndFraud — updated (no penalties / no suspension)", function () {
  it("enforces min-interval per (user, source)", async function () {
    const { token, admin, funder, user, beneficiary, chainId } = await loadFixture(deployProxyFixture);

    const source = "minint-src";
    await (await token.connect(admin).configureSource(source, false, false)).wait();

    // pick a small steps value and stake enough (NON-trusted path needs stake)
    const steps = 100n;
    await ensureStakeForSteps(token, funder, user, steps);

    // first submission should pass
    await jumpPastMinInterval(token, source);
    await (await submitSteps({
      token,
      caller: user,
      signerForSig: user,
      user,
      beneficiary,
      chainId,
      source,
      steps,
    })).wait();

    // immediate second submission should fail with "Submission too frequent"
    await expect(
      submitSteps({
        token,
        caller: user,
        signerForSig: user,
        user,
        beneficiary,
        chainId,
        source,
        steps,
      })
    ).to.be.revertedWith("Submission too frequent");

    // after min-interval passes, it should succeed again
    await jumpPastMinInterval(token, source);
    await (await submitSteps({
      token,
      caller: user,
      signerForSig: user,
      user,
      beneficiary,
      chainId,
      source,
      steps,
    })).wait();
  });

  it("enforces daily cap per (user, source) and resets on next UTC day", async function () {
  const { token, admin, funder, user, beneficiary, chainId } = await loadFixture(deployProxyFixture);

  const source = "dailycap-src";
  await (await token.connect(admin).configureSource(source, false, false)).wait();

  const { maxStepsPerDay, minInterval } = await getPerSourceLimits(token, source);
  expect(maxStepsPerDay).to.be.gt(0n);

  // ✅ Make sure we're EARLY in a UTC day *without ever going backwards*.
  // If we're late in the day, move forward to early next day. Never use increaseTo() with a past ts.
  async function alignToUtcDayWithRoom(mi, jumps = 2n, margin = 10n) {
    const now = BigInt(await time.latest());
    const dayStart = (now / 86400n) * 86400n;
    const nextDay = dayStart + 86400n;

    const needed = jumps * (BigInt(mi) + 2n) + margin;

    // preferred: early today, but only if it's still in the future and leaves enough room
    const earlyToday = dayStart + 5n;

    let target;
    if (earlyToday >= now && earlyToday + needed < nextDay) {
      target = earlyToday;
    } else {
      // otherwise: early next day (always > now)
      target = nextDay + 5n;
    }

    // Use increase(), not increaseTo(), to avoid "lower than previous timestamp"
    await time.increase(Number(target - now));
    await ethers.provider.send("evm_mine", []);
  }

  await alignToUtcDayWithRoom(minInterval, 2n);

  // Use a safe split that hits the cap then exceeds by 1
  const a = maxStepsPerDay - 1n;
  const b = 2n;

  // stake for the bigger of a/b (requiredStake = steps * perStep, so stake for a)
  await ensureStakeForSteps(token, funder, user, a);

  await jumpPastMinInterval(token, source);
  await (await submitSteps({
    token,
    caller: user,
    signerForSig: user,
    user,
    beneficiary,
    chainId,
    source,
    steps: a,
  })).wait();

  // next submission (same UTC day) should exceed cap => revert
  await jumpPastMinInterval(token, source);
  await expect(
    submitSteps({
      token,
      caller: user,
      signerForSig: user,
      user,
      beneficiary,
      chainId,
      source,
      steps: b,
    })
  ).to.be.revertedWith("Daily limit exceeded");

  // next UTC day resets totals => b should succeed
  await jumpToNextUtcDay();
  await jumpPastMinInterval(token, source);

  // stake may need to cover b too (usually already covered, but safe)
  await ensureStakeForSteps(token, funder, user, b);

  await (await submitSteps({
    token,
    caller: user,
    signerForSig: user,
    user,
    beneficiary,
    chainId,
    source,
    steps: b,
  })).wait();
});

  it("requires stake for NON-trusted callers and blocks after onboarding threshold; trusted API bypasses both", async function () {
    this.timeout(120000);

    const { token, admin, funder, user, beneficiary, api, chainId } = await loadFixture(deployProxyFixture);

    const source = "onboard-src";
    await (await token.connect(admin).configureSource(source, false, false)).wait();

    // Make sure API is trusted for the bypass portion
    await setTrustedApiSafe(token, admin, api.address, true);

    const threshold = await getOnboardingThresholdSafe(token);
    expect(threshold).to.be.gte(1n);

    const steps = 200n;

    // 1) Without stake, NON-trusted should revert "Insufficient stake"
    await jumpPastMinInterval(token, source);
    await expect(
      submitSteps({
        token,
        caller: user,
        signerForSig: user,
        user,
        beneficiary,
        chainId,
        source,
        steps,
      })
    ).to.be.revertedWith("Insufficient stake");

    // 2) Stake enough, then allow exactly `threshold` NON-API submissions
    await ensureStakeForSteps(token, funder, user, steps);

    for (let i = 0n; i < threshold; i++) {
      await jumpPastMinInterval(token, source);
      const tx = await submitSteps({
        token,
        caller: user,
        signerForSig: user,
        user,
        beneficiary,
        chainId,
        source,
        steps,
      });
      await expect(tx).to.emit(token, "RewardClaimed");
      await tx.wait();
    }

    // 3) Next NON-API submission should be blocked by onboarding cap
    await jumpPastMinInterval(token, source);
    await expect(
      submitSteps({
        token,
        caller: user,
        signerForSig: user,
        user,
        beneficiary,
        chainId,
        source,
        steps,
      })
    ).to.be.revertedWith("GS: trusted API caller/relayer required");

    // 4) Trusted API bypass: API caller + API signature should succeed WITHOUT requiring stake/onboarding
    // (We still sign the payload; signerForSig = api)
    await jumpPastMinInterval(token, source);
    const txApi = await submitSteps({
      token,
      caller: api,          // msg.sender is trusted API
      signerForSig: api,    // signature from API signer
      user,
      beneficiary,
      chainId,
      source,
      steps,
    });
    await expect(txApi).to.emit(token, "RewardClaimed");
    await txApi.wait();
  });
});
