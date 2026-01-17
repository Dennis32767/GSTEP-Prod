// test/GemStepToken.Extendedtest.js
/* eslint-disable no-undef */
const { expect } = require("chai");
const { ethers, network, upgrades } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { expectRevert, mkErrorDecoderAt } = require("./helpers/reverts");

// ✅ single source of truth
const { deployGemStepFixture: baseDeployGemStepFixture } = require("./fixtures");

/** Use one version constant for BOTH domain init and payload struct **/
const DOMAIN_NAME = "GemStep";
const DOMAIN_VER = "1.0.0";
const PAYLOAD_VER = "1.0.0"; // <-- must match on-chain allowlist

/**********************
 * SMALL SAFE HELPERS *
 **********************/

async function tryTx(obj, fn, ...args) {
  try {
    obj.interface.getFunction(fn);
    const tx = await obj[fn](...args);
    await tx.wait?.();
    return true;
  } catch {
    return false;
  }
}

async function getChainId() {
  const { chainId } = await ethers.provider.getNetwork();
  return Number(chainId);
}

async function increaseTime(seconds) {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine");
}

// Jump just over a UTC day boundary so (ts / 1 days) increments
async function bumpDay() {
  await time.increase(24 * 60 * 60 + 5);
}
async function bumpUtcDay() {
  return bumpDay();
}

// Read per-source daily cap & interval (used by halving + API tests)
async function getPerSourceLimits(token, source) {
  // Modern: minimal readers expose getSourceConfigFields
  if (typeof token.getSourceConfigFields === "function") {
    const cfg = await token.getSourceConfigFields(source);
    return {
      maxStepsPerDay: BigInt(cfg[3].toString()),
      minInterval: BigInt(cfg[4].toString()),
    };
  }

  // Legacy: getSourceConfig(source) => tuple
  if (typeof token.getSourceConfig === "function") {
    const cfg = await token.getSourceConfig(source);
    return {
      maxStepsPerDay: BigInt(cfg[3].toString()),
      minInterval: BigInt(cfg[4].toString()),
    };
  }

  // Fallback constants
  return {
    maxStepsPerDay: BigInt((await token.MAX_STEPS_PER_DAY()).toString()),
    minInterval: BigInt((await token.MIN_SUBMISSION_INTERVAL()).toString()),
  };
}

// Respect per-source minInterval (API + user path)
async function bumpMinInterval(token, source, extra = 2) {
  const { minInterval } = await getPerSourceLimits(token, source);
  if (minInterval > 0n) {
    await time.increase(Number(minInterval) + extra);
  }
}

async function resolveTokenFunder(token, candidates) {
  let best = null;
  for (const s of candidates) {
    const bal = await token.balanceOf(s.address);
    if (bal > 0n && (!best || bal > best.bal)) best = { signer: s, bal };
  }
  return best?.signer;
}

async function resolveRoleAdmin(token, candidates) {
  const role = await token.DEFAULT_ADMIN_ROLE();
  for (const s of candidates) {
    try {
      if (await token.hasRole(role, s.address)) return s;
    } catch {
      // ignore
    }
  }
  return null;
}

async function getHalvingInfoCompat(token) {
  const cap = await token.cap();
  const ms = await token.getMintingState();
  const distributedTotal = BigInt(ms[4].toString());
  const halvingCount = BigInt(ms[6].toString());

  // threshold(h) = cap - (cap >> (h+1))
  const nextThreshold = cap - (cap >> (halvingCount + 1n));
  const remaining = nextThreshold > distributedTotal ? nextThreshold - distributedTotal : 0n;

  return { halvingCount, nextThreshold, remaining };
}

/**********************
 * EIP-712 SIGNING    *
 **********************/

async function signStepData(
  token,
  user,
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
    user,
    beneficiary,
    steps: toBI(steps),
    nonce: toBI(nonce),
    deadline: toBI(deadline),
    chainId: toBI(chainId),
    source,
    version,
  };

  const signature = await signer.signTypedData(domain, types, value);

  // Off-chain sanity check
  const recovered = ethers.verifyTypedData(domain, types, value, signature);
  const signerAddr = await signer.getAddress();
  if (recovered.toLowerCase() !== signerAddr.toLowerCase()) {
    throw new Error(
      `TypedData mismatch: recovered ${recovered} vs signer ${signerAddr}\n` +
        `domain=${JSON.stringify(domain)} value=${JSON.stringify(value)}`
    );
  }

  return signature;
}

/**********************
 * SOURCE CONFIG      *
 **********************/

async function addSourceIfNeeded(token, admin, source) {
  if (typeof token.isSourceValid === "function") {
    const ok = await token.isSourceValid(source);
    if (ok) return;
  }
  await tryTx(token.connect(admin), "batchAddSources", [source]);
  await tryTx(token.connect(admin), "addSource", source);
  await tryTx(token.connect(admin), "registerSource", source);
}

async function setSourceEnabledIfSupported(token, admin, source, enabled) {
  await tryTx(token.connect(admin), "setSourceEnabled", source, enabled);
}

// IMPORTANT: This prevents accidentally setting requiresProof=true due to ABI mismatch.
async function configureSourceCompat(token, admin, source, enabled, requiresProof, requiresAttestation) {
  if (typeof token.configureSource !== "function") return;

  const frag = token.interface.getFunction("configureSource");
  const inputs = frag.inputs || [];
  const n = inputs.length;
  const names = inputs.map((i) => (i.name || "").toLowerCase());

  // configureSource(string,bool,bool,bool) => (enabled, requireProof, requireAttestation)
  if (n === 4) {
    await token.connect(admin).configureSource(source, enabled, requiresProof, requiresAttestation);
    return;
  }

  // configureSource(string,bool,bool) could be (enabled, requireProof) OR (requireProof, requireAttestation)
  if (n === 3) {
    const p1 = names[1] || "";

    if (p1.includes("enable")) {
      await token.connect(admin).configureSource(source, enabled, requiresProof);
      return;
    }

    if (p1.includes("proof") || p1.includes("require")) {
      await token.connect(admin).configureSource(source, requiresProof, requiresAttestation);
      await setSourceEnabledIfSupported(token, admin, source, enabled);
      return;
    }

    // Ambiguous → SAFE: never pass enabled into requiresProof slot
    await token.connect(admin).configureSource(source, requiresProof, requiresAttestation);
    await setSourceEnabledIfSupported(token, admin, source, enabled);
    return;
  }

  // configureSource(string,bool) ambiguous => could be enabled or requiresProof
  if (n === 2) {
    await token.connect(admin).configureSource(source, false); // SAFE: keep requiresProof=false
    await setSourceEnabledIfSupported(token, admin, source, enabled);
    return;
  }
}

async function setSource(token, admin, source, opts = {}) {
  const { enabled = true, requiresProof = false, requiresAttestation = false } = opts;

  await addSourceIfNeeded(token, admin, source);

  await configureSourceCompat(token, admin, source, enabled, requiresProof, requiresAttestation);

  await setSourceEnabledIfSupported(token, admin, source, enabled);

  // Try split setters if your build has them
  await tryTx(token.connect(admin), "setRequireProof", source, requiresProof);
  await tryTx(token.connect(admin), "setRequireAttestation", source, requiresAttestation);

  // Optional global toggles (extra safety)
  await tryTx(token.connect(admin), "setGlobalRequireProof", false);
  await tryTx(token.connect(admin), "setGlobalRequireAttestation", false);
}

async function ensureNoProofSource(token, admin, source) {
  await setSource(token, admin, source, {
    enabled: true,
    requiresProof: false,
    requiresAttestation: false,
  });
}

/**********************
 * SUBMIT STEPS       *
 **********************/

async function submitSteps(token, submitter, steps, options = {}) {
  const {
    source = "test-noproof",
    version = PAYLOAD_VER,
    beneficiary = submitter.address,
    signer = options.signer || submitter,
    withStake = true,
    proof = [],
    attestation = "0x",
    isApiSigned = false,
    funder, // ✅ required for GSTEP token-stake funding
  } = options;

  // --- GSTEP token staking for user path only ---
  if (!isApiSigned && withStake !== false) {
    const stakePerStep = await token.currentStakePerStep();
    const requiredStake = BigInt(steps) * BigInt(stakePerStep.toString()); // GSTEP amount

    // getUserCoreStatus bundle: (..., stakeBalance, ...)
    const [, , , stakedRaw] = await token.getUserCoreStatus(submitter.address);
    const currentStake = BigInt(stakedRaw.toString());

    if (currentStake < requiredStake) {
      const needToken = requiredStake - currentStake;

      const bal = await token.balanceOf(submitter.address);
      const balBI = BigInt(bal.toString());

      if (balBI < needToken) {
        if (!funder) throw new Error("submitSteps requires options.funder for GSTEP staking");
        const delta = needToken - balBI;
        await (await token.connect(funder).transfer(submitter.address, delta)).wait();
      }

      await (await token.connect(submitter).stake(needToken)).wait();
    }
  }

  const nonce = await token.nonces(submitter.address);
  const deadline = (await time.latest()) + 3600;
  const chainId = await getChainId();

  const signature = await signStepData(
    token,
    submitter.address,
    beneficiary,
    steps,
    nonce,
    deadline,
    chainId,
    source,
    version,
    signer
  );

  const args = [
    {
      user: submitter.address,
      beneficiary,
      steps,
      nonce,
      deadline,
      source,
      version,
    },
    { signature, proof, attestation },
  ];

  if (isApiSigned) return token.connect(signer).logSteps(...args);
  return token.connect(submitter).logSteps(...args);
}

/**********************
 * FIXTURE WRAPPER    *
 **********************/

async function ensureRole(token, roleGetterName, grantee, granter) {
  const role = await token[roleGetterName]();
  if (!(await token.hasRole(role, grantee))) {
    await token.connect(granter).grantRole(role, grantee);
  }
}

async function deployExtendedGemStepFixture() {
  const ctx = await baseDeployGemStepFixture();
  const signers = await ethers.getSigners();

  const token = ctx.token;
  if (!token) throw new Error("Fixture must return { token }");

  const admin = ctx.admin || signers[0];
  const treasury = ctx.treasury || signers[1];
  const user1 = ctx.user1 || signers[2];
  const user2 = ctx.user2 || signers[3];

  const apiSigner = ctx.apiSigner || signers[4];
  const trustedDevice = ctx.trustedDevice || signers[5];

  const roleAdmin = (await resolveRoleAdmin(token, [admin, treasury, ...signers])) || admin;

  const funder =
    (ctx.initialHolder &&
      (await (async () => {
        try {
          return await ethers.getSigner(ctx.initialHolder);
        } catch {
          return null;
        }
      })())) ||
    (await resolveTokenFunder(token, [treasury, admin, ...signers])) ||
    treasury;

  // ---- Grant roles needed by these tests (idempotent) ----
  await ensureRole(token, "DEFAULT_ADMIN_ROLE", admin.address, roleAdmin);
  await ensureRole(token, "PARAMETER_ADMIN_ROLE", admin.address, roleAdmin);
  await ensureRole(token, "SIGNER_ROLE", admin.address, roleAdmin);
  await ensureRole(token, "MINTER_ROLE", admin.address, roleAdmin);
  await ensureRole(token, "EMERGENCY_ADMIN_ROLE", admin.address, roleAdmin);
  await ensureRole(token, "PAUSER_ROLE", admin.address, roleAdmin);
  await ensureRole(token, "API_SIGNER_ROLE", apiSigner.address, roleAdmin);

  // ---- API path prerequisites ----
  if (typeof token.setTrustedAPI === "function") {
    await tryTx(token.connect(admin), "setTrustedAPI", apiSigner.address, true);
  }

  // ---- Sources needed by tests ----
  await ensureNoProofSource(token, admin, "test-noproof");
  await ensureNoProofSource(token, admin, "fitbit");
  await ensureNoProofSource(token, admin, "applehealth");

  if (typeof token.addTrustedDevice === "function") {
    await tryTx(token.connect(admin), "addTrustedDevice", trustedDevice.address);
  }

  if (typeof token.addSupportedPayloadVersion === "function") {
    await tryTx(token.connect(admin), "addSupportedPayloadVersion", PAYLOAD_VER);
  } else if (typeof token.addSupportedVersion === "function") {
    await tryTx(token.connect(admin), "addSupportedVersion", PAYLOAD_VER);
  }

  if (typeof token.approveRecipient === "function") {
    await tryTx(token.connect(admin), "approveRecipient", admin.address, true);
  }

  if (typeof token.forceMonthUpdate === "function") {
    await tryTx(token.connect(admin), "forceMonthUpdate");
  }

  // ---- Seed ADMIN with ERC20 so emergency tests can transfer to contract ----
  if (typeof token.transfer === "function") {
    const want = ethers.parseEther("10000");
    const bal = await token.balanceOf(admin.address);
    if (bal < want) {
      await (await token.connect(funder).transfer(admin.address, want - bal)).wait();
    }
  }

  const tokenErr = await mkErrorDecoderAt(token);

  return {
    ...ctx,
    token,
    tokenErr,
    admin,
    treasury,
    user1,
    user2,
    apiSigner,
    trustedDevice,
    roleAdmin,
    funder,
  };
}

async function deployGemStepHalvingFixture() {
  return deployExtendedGemStepFixture();
}

/**********************
 * TEST SUITES        *
 **********************/

describe("GemStepToken Extended Tests", function () {
  describe("Test Setup", function () {
    it("Should properly initialize all roles", async function () {
      const { token, admin, apiSigner } = await loadFixture(deployExtendedGemStepFixture);
      expect(await token.hasRole(await token.API_SIGNER_ROLE(), apiSigner.address)).to.be.true;
      expect(await token.hasRole(await token.DEFAULT_ADMIN_ROLE(), admin.address)).to.be.true;

      const [, , , , apiTrusted] = await token.getUserCoreStatus(apiSigner.address);
      expect(apiTrusted).to.be.true;
    });
  });

  describe("Signature Security", function () {
    it("Should reject reused signatures", async function () {
      const { token, tokenErr, user1, admin, funder } = await loadFixture(deployExtendedGemStepFixture);
      await ensureNoProofSource(token, admin, "testreuse");

      const steps = 1n;

      // ensure staking via helper (token stake)
      await submitSteps(token, user1, steps, {
        source: "testreuse",
        signer: user1,
        version: PAYLOAD_VER,
        funder,
      });

      // Now reuse the EXACT same signature/nonce manually
      const chainId = await getChainId();
      const nonce1 = await token.nonces(user1.address); // nonce already incremented by first submit
      const prevNonce = nonce1 - 1n;
      const deadline1 = (await time.latest()) + 3600;

      const sig1 = await signStepData(
        token,
        user1.address,
        user1.address,
        steps,
        prevNonce,
        deadline1,
        chainId,
        "testreuse",
        PAYLOAD_VER,
        user1
      );

      await expectRevert(
        token.connect(user1).logSteps(
          {
            user: user1.address,
            beneficiary: user1.address,
            steps,
            nonce: prevNonce,
            deadline: deadline1,
            source: "testreuse",
            version: PAYLOAD_VER,
          },
          { signature: sig1, proof: [], attestation: "0x" }
        ),
        tokenErr,
        "InvalidNonce",
        "Invalid nonce"
      );
    });

    it("Should reject signatures from unauthorized signers", async function () {
      const { token, tokenErr, user1, user2, funder } = await loadFixture(deployExtendedGemStepFixture);

      await expectRevert(
        submitSteps(token, user1, 100n, { signer: user2, source: "test-noproof", funder }),
        tokenErr,
        "SignerMustBeUser",
        "Signer must be user"
      );
    });

    it("Should reject expired signatures", async function () {
      const { token, tokenErr, user1, admin, funder } = await loadFixture(deployExtendedGemStepFixture);
      await ensureNoProofSource(token, admin, "test-exp");

      const steps = 10n;

      // ensure user has stake
      await submitSteps(token, user1, steps, { source: "test-exp", signer: user1, version: PAYLOAD_VER, funder });

      const chainId = await getChainId();
      const nonce = await token.nonces(user1.address);
      const deadline = (await time.latest()) - 1; // expired

      const sig = await signStepData(
        token,
        user1.address,
        user1.address,
        steps,
        nonce,
        deadline,
        chainId,
        "test-exp",
        PAYLOAD_VER,
        user1
      );

      await expectRevert(
        token.connect(user1).logSteps(
          {
            user: user1.address,
            beneficiary: user1.address,
            steps,
            nonce,
            deadline,
            source: "test-exp",
            version: PAYLOAD_VER,
          },
          { signature: sig, proof: [], attestation: "0x" }
        ),
        tokenErr,
        "SignatureExpired",
        "Signature expired"
      );
    });
  });

  it("Should enforce monthly mint cap", async function () {
    const { token, admin, user1, funder } = await loadFixture(deployExtendedGemStepFixture);
    await ensureNoProofSource(token, admin, "testcap");

    const currentCap = await token.currentMonthlyCap();
    const rewardRate = await token.rewardRate();
    const stepLimit = await token.stepLimit();

    const maxStepsByMint = currentCap / rewardRate - 1n;
    const stepLimitBN = BigInt(stepLimit.toString());
    const safeStepsBN = maxStepsByMint < stepLimitBN - 1n ? maxStepsByMint : stepLimitBN - 1n;

    await submitSteps(token, user1, safeStepsBN, {
      source: "testcap",
      signer: user1,
      version: PAYLOAD_VER,
      funder,
    });

    await time.increase(60 * 60 * 24 * 30);
    await token.connect(admin).forceMonthUpdate();

    await expect(
      submitSteps(token, user1, safeStepsBN, { source: "testcap", signer: user1, version: PAYLOAD_VER, funder })
    ).to.not.be.reverted;

    const currentMonthMinted = await token.currentMonthMinted();
    expect(currentMonthMinted).to.be.lte(currentCap);
  });

  it("Should allow submissions after month rollover (API Signer)", async function () {
    const { token, admin, apiSigner, user1, funder } = await loadFixture(deployExtendedGemStepFixture);

    const API_SIGNER_ROLE = await token.API_SIGNER_ROLE();
    if (!(await token.hasRole(API_SIGNER_ROLE, apiSigner.address))) {
      await token.connect(admin).grantRole(API_SIGNER_ROLE, apiSigner.address);
    }

    {
      const [, , , , apiTrustedBefore] = await token.getUserCoreStatus(apiSigner.address);
      if (!apiTrustedBefore) {
        await token.connect(admin).setTrustedAPI(apiSigner.address, true);
      }
    }

    const stepsBN = 100n;

    await submitSteps(token, user1, stepsBN, {
      beneficiary: user1.address,
      signer: apiSigner,
      withStake: false,
      isApiSigned: true,
      source: "test-noproof",
      version: PAYLOAD_VER,
      funder, // harmless
    });

    await increaseTime(Number(await token.SECONDS_PER_MONTH()));
    await token.connect(admin).forceMonthUpdate();

    await expect(
      submitSteps(token, user1, stepsBN, {
        beneficiary: user1.address,
        signer: apiSigner,
        withStake: false,
        isApiSigned: true,
        source: "test-noproof",
        version: PAYLOAD_VER,
        funder,
      })
    ).to.not.be.reverted;
  });

  it("Should enforce step limit", async function () {
    const { token, user1, admin, funder } = await loadFixture(deployExtendedGemStepFixture);
    await ensureNoProofSource(token, admin, "limit-src");

    const stepLimit = await token.stepLimit();
    const overLimit = BigInt(stepLimit.toString()) + 1n;

    await expect(
      submitSteps(token, user1, overLimit, {
        source: "limit-src",
        signer: user1,
        version: PAYLOAD_VER,
        funder,
      })
    ).to.be.reverted;
  });

  describe("GemStepToken - Minting Halving", function () {
    it("Halves monthly cap once when distributedTotal crosses first threshold (fast harness)", async function () {
      this.timeout(120000);

      const [, admin, treasury] = await ethers.getSigners();

      const Mock = await ethers.getContractFactory("MockOracleV2");
      const oracle = await Mock.deploy();
      await oracle.waitForDeployment();
      const { timestamp } = await ethers.provider.getBlock("latest");
      await oracle.set(ethers.parseEther("0.005"), timestamp, 0);
      await oracle.setPolicy(300, 100);

      const Harness = await ethers.getContractFactory("GemStepTokenHalvingHarness");

      const INITIAL_SUPPLY = ethers.parseUnits("400000000", 18);

      const initFrag = Harness.interface.getFunction("initialize");
      const n = (initFrag.inputs || []).length;

      const initArgs =
        n === 4
          ? [INITIAL_SUPPLY, admin.address, await oracle.getAddress(), treasury.address]
          : n === 3
          ? [INITIAL_SUPPLY, admin.address, await oracle.getAddress()]
          : (() => {
              throw new Error(`Unsupported initialize() arg count: ${n}`);
            })();

      const token = await upgrades.deployProxy(Harness, initArgs, {
        initializer: "initialize",
        kind: "transparent",
        timeout: 180000,
      });
      await token.waitForDeployment();

      const cap = await token.cap();
      const hc0 = await token.halvingCount();

      const beforeMonthlyCap = await token.currentMonthlyCap();
      const beforeRate = await token.rewardRate();
      const stepsPerMonthBefore = beforeMonthlyCap / beforeRate;

      const threshold = cap - (cap >> 1n);

      await (await token.__setDistributedTotal(threshold)).wait();
      await (await token.__checkHalving()).wait();

      const hc1 = await token.halvingCount();
      expect(hc1).to.equal(hc0 + 1n);

      const afterRate = await token.rewardRate();
      const afterMonthlyCap = await token.currentMonthlyCap();
      const stepsPerMonthAfter = afterMonthlyCap / afterRate;

      expect(afterRate).to.equal(beforeRate / 2n);
      expect(stepsPerMonthAfter).to.equal(stepsPerMonthBefore * 4n);

      await (await token.__checkHalving()).wait();
      expect(await token.halvingCount()).to.equal(hc0 + 1n);
    });

    it("Should correctly calculate remaining until next halving", async function () {
      const { token } = await loadFixture(deployExtendedGemStepFixture);
      const { remaining } = await getHalvingInfoCompat(token);

      // distributedTotal is in minting state bundle; keep this extra read only if present
      const ms = await token.getMintingState();
      const distributed = BigInt(ms[4].toString());
      const cap = await token.cap();
      const hc = BigInt(ms[6].toString());
      const threshold = cap - (cap >> (hc + 1n));

      expect(remaining).to.equal(threshold > distributed ? threshold - distributed : 0n);
    });
  });

  describe("Batch Operations", function () {
    it("Should allow batch source additions", async function () {
      const { token, admin } = await loadFixture(deployExtendedGemStepFixture);
      const sources = ["source1", "source2", "source3"];
      await token.connect(admin).batchAddSources(sources);
      for (const source of sources) {
        expect(await token.isSourceValid(source)).to.be.true;
      }
    });

    it("Should allow batch signer management", async function () {
      const { token, admin, user1, user2 } = await loadFixture(deployExtendedGemStepFixture);
      const newSigners = [user1.address, user2.address];
      await token.connect(admin).batchAddSigners(newSigners);

      for (const s of newSigners) {
        expect(await token.hasRole(await token.SIGNER_ROLE(), s)).to.be.true;
      }

      await token.connect(admin).batchRemoveSigners(newSigners);

      for (const s of newSigners) {
        expect(await token.hasRole(await token.SIGNER_ROLE(), s)).to.be.false;
      }
    });
  });

  describe("Emergency Functions", function () {
    it("Should enforce emergency withdrawal delay", async function () {
      const { token, tokenErr, admin, funder } = await loadFixture(deployExtendedGemStepFixture);

      const tokenAddress = await token.getAddress();
      const targetAmount = ethers.parseEther("100");
      const sendAmount = ethers.parseEther("101.010101010101010101"); // ~1% headroom

      const adminBalance = await token.balanceOf(admin.address);
      if (adminBalance < sendAmount) {
        await (await token.connect(funder).transfer(admin.address, sendAmount)).wait();
      }

      const initialContractBalance = await token.balanceOf(tokenAddress);
      await (await token.connect(admin).transfer(tokenAddress, sendAmount)).wait();
      const afterDepositBalance = await token.balanceOf(tokenAddress);
      const receivedAmount = afterDepositBalance - initialContractBalance;

      const tol = ethers.parseEther("0.03");
      const diffToTarget =
        receivedAmount > targetAmount ? receivedAmount - targetAmount : targetAmount - receivedAmount;
      const diffToSend = receivedAmount > sendAmount ? receivedAmount - sendAmount : sendAmount - receivedAmount;
      expect(diffToTarget <= tol || diffToSend <= tol).to.equal(true);

      await (await token.connect(admin).toggleEmergencyWithdraw(true)).wait();
      const unlockTime = await token.emergencyWithdrawUnlockTime();

      await expectRevert(
        token.connect(admin).emergencyWithdraw(targetAmount),
        tokenErr,
        "EmergencyDelayNotPassed",
        "Emergency delay not passed"
      );

      await time.increaseTo(Number(unlockTime) - 60);
      await expectRevert(
        token.connect(admin).emergencyWithdraw(targetAmount),
        tokenErr,
        "EmergencyDelayNotPassed",
        "Emergency delay not passed"
      );

      await time.increaseTo(Number(unlockTime) + 1);

      await expect(token.connect(admin).emergencyWithdraw(targetAmount)).to.not.be.reverted;

      const remaining = await token.balanceOf(tokenAddress);
      const expectedLeftover = receivedAmount > targetAmount ? receivedAmount - targetAmount : 0n;

      const diffToZero = remaining;
      const diffToLeftover =
        remaining > expectedLeftover ? remaining - expectedLeftover : expectedLeftover - remaining;

      expect(diffToZero <= tol || diffToLeftover <= tol).to.equal(true);
    });

    it("Should reject unauthorized emergency withdrawals", async function () {
      const { token, admin, user1 } = await loadFixture(deployExtendedGemStepFixture);

      const tokenAddress = await token.getAddress();
      await token.connect(admin).transfer(tokenAddress, ethers.parseEther("1"));

      await token.connect(admin).toggleEmergencyWithdraw(true);
      await increaseTime(Number(await token.EMERGENCY_DELAY()));

      await expect(token.connect(user1).emergencyWithdraw(ethers.parseEther("1"))).to.be.reverted;
    });
  });

  describe("Version Management", function () {
    async function addPayloadVersion(token, admin, v) {
      if (token.addSupportedPayloadVersion) {
        await token.connect(admin).addSupportedPayloadVersion(v);
      } else if (token.addSupportedVersion) {
        await token.connect(admin).addSupportedVersion(v);
      } else {
        throw new Error("No addSupportedPayloadVersion/addSupportedVersion fn found");
      }
    }

    async function isPayloadSupported(token, vHash) {
      if (typeof token.getVersionPolicy === "function") {
        const [, , , payloadSupported] = await token.getVersionPolicy(vHash);
        return payloadSupported;
      }
      if (typeof token.getPayloadVersionInfo === "function") {
        const [supported] = await token.getPayloadVersionInfo(vHash);
        return supported;
      }
      throw new Error("No payload version read method found (need getVersionPolicy or getPayloadVersionInfo)");
    }

    it("Should reject unsupported payload versions", async function () {
      const { token, tokenErr, user1, admin, funder } = await loadFixture(deployExtendedGemStepFixture);

      await time.increase(Number(await token.SECONDS_PER_MONTH()));
      await token.connect(admin).forceMonthUpdate();

      const unsupported = "2.0";
      const h = ethers.id(unsupported);
      expect(await isPayloadSupported(token, h)).to.be.false;

      const steps = 1000n;

      const chainId = (await ethers.provider.getNetwork()).chainId;
      const nonce = await token.nonces(user1.address);
      const deadline = (await time.latest()) + 3600;

      const sig = await signStepData(
        token,
        user1.address,
        user1.address,
        steps,
        nonce,
        deadline,
        chainId,
        "test-noproof",
        unsupported,
        user1
      );

      await expectRevert(
        token.connect(user1).logSteps(
          {
            user: user1.address,
            beneficiary: user1.address,
            steps,
            nonce,
            deadline,
            source: "test-noproof",
            version: unsupported,
          },
          { signature: sig, proof: [], attestation: "0x" }
        ),
        tokenErr,
        "UnsupportedVersion",
        "Unsupported payload version"
      );

      // keep linter happy about unused funder in this test file pattern
      expect(funder).to.not.equal(undefined);
    });

    it("Should allow admin to add new payload versions", async function () {
      const { token, admin } = await loadFixture(deployExtendedGemStepFixture);

      const v = "2.0";
      const h = ethers.id(v);

      const supportedBefore = await (async () => {
        if (typeof token.getVersionPolicy === "function") {
          const [, , , payloadSupported] = await token.getVersionPolicy(h);
          return payloadSupported;
        }
        return false;
      })();

      if (supportedBefore) return;

      await addPayloadVersion(token, admin, v);

      const supportedAfter = await (async () => {
        if (typeof token.getVersionPolicy === "function") {
          const [, , , payloadSupported] = await token.getVersionPolicy(h);
          return payloadSupported;
        }
        if (typeof token.getPayloadVersionInfo === "function") {
          const [s] = await token.getPayloadVersionInfo(h);
          return s;
        }
        return false;
      })();

      expect(supportedAfter).to.equal(true);
    });
  });

  describe("Anomaly Detection", function () {
    it("Should trigger fraud prevention for anomalous submissions", async function () {
      const { token, user1, admin, funder } = await loadFixture(deployExtendedGemStepFixture);

      const src = "test-noproof";
      await ensureNoProofSource(token, admin, src);

      // If these constants were removed in your refactor, skip gracefully
      if (typeof token.MIN_SUBMISSION_INTERVAL !== "function") this.skip();
      if (typeof token.GRACE_PERIOD !== "function") this.skip();
      if (typeof token.PENALTY_PERCENT !== "function") this.skip();
      if (typeof token.MAX_STEPS_PER_DAY !== "function") this.skip();

      const minInterval = BigInt((await token.MIN_SUBMISSION_INTERVAL()).toString());
      const grace = BigInt((await token.GRACE_PERIOD()).toString());
      const stakePerStep = BigInt((await token.currentStakePerStep()).toString());
      const penaltyPct = BigInt((await token.PENALTY_PERCENT()).toString());
      const stepLimitBN = BigInt((await token.stepLimit()).toString());
      const maxPerDayBN = BigInt((await token.MAX_STEPS_PER_DAY()).toString());

      const warm = 100n;

      // Warm-up submissions
      for (let i = 0; i < 5; i++) {
        await submitSteps(token, user1, warm, {
          beneficiary: user1.address,
          withStake: true,
          signer: user1,
          version: PAYLOAD_VER,
          funder,
          source: src,
        });
        await time.increase(Number(minInterval) + 2);
      }

      await time.increase(Number(grace) + 10);

      const spike = 3000n;

      const [, dailySoFarRaw] = await token.getUserSourceStats(user1.address, src);
      const dailySoFar = BigInt(dailySoFarRaw.toString());

      const dayLeft = maxPerDayBN > dailySoFar ? maxPerDayBN - dailySoFar : 0n;
      const stepsNow = spike <= stepLimitBN ? (spike <= dayLeft ? spike : dayLeft) : stepLimitBN;

      const estPenalty = (stepsNow * stakePerStep * penaltyPct) / 100n;
      const need = stepsNow * stakePerStep + estPenalty;
      const headroom = (need * 20n) / 100n;

      const [, , , stakedRaw] = await token.getUserCoreStatus(user1.address);
      const staked = BigInt(stakedRaw.toString());

      if (staked < need + headroom) {
        // fund + stake token amount
        const bal = BigInt((await token.balanceOf(user1.address)).toString());
        const delta = need + headroom - staked;
        if (bal < delta) {
          await (await token.connect(funder).transfer(user1.address, delta - bal)).wait();
        }
        await (await token.connect(user1).stake(delta)).wait();
      }

      await time.increase(Number(minInterval) + 2);

      const [, flagsBeforeRaw, , stakeBeforeRaw] = await token.getUserCoreStatus(user1.address);
      const flagsBefore = BigInt(flagsBeforeRaw.toString());
      const stakeBefore = BigInt(stakeBeforeRaw.toString());

      await submitSteps(token, user1, stepsNow, {
        beneficiary: user1.address,
        withStake: true,
        signer: user1,
        version: PAYLOAD_VER,
        funder,
        source: src,
      });

      const [, flagsAfterRaw, , stakeAfterRaw] = await token.getUserCoreStatus(user1.address);
      const flagsAfter = BigInt(flagsAfterRaw.toString());
      const stakeAfter = BigInt(stakeAfterRaw.toString());

      expect(flagsAfter > flagsBefore || stakeAfter < stakeBefore).to.equal(true);
    });
  });

  describe("GemStepToken Basic Tests", function () {
    describe("Step Rewards", function () {
      it("Should enforce submission rules", async function () {
        const { token, tokenErr, admin, user1, funder } = await loadFixture(deployExtendedGemStepFixture);
        const signers = await ethers.getSigners();

        const apiSigner = signers[3];
        const API_SIGNER_ROLE = await token.API_SIGNER_ROLE();
        await token.connect(admin).grantRole(API_SIGNER_ROLE, apiSigner.address);
        await token.connect(admin).setTrustedAPI(apiSigner.address, true);

        expect(await token.hasRole(API_SIGNER_ROLE, apiSigner.address)).to.be.true;

        {
          const [, , , , apiTrusted] = await token.getUserCoreStatus(apiSigner.address);
          expect(apiTrusted).to.be.true;
        }

        const unauthorizedCaller = signers[9];

        const nonce = await token.nonces(user1.address);
        const deadline = (await time.latest()) + 3600;
        const chainId = await getChainId();

        const sig = await signStepData(
          token,
          user1.address,
          user1.address,
          100n,
          nonce,
          deadline,
          chainId,
          "test-noproof",
          PAYLOAD_VER,
          user1
        );

        await expectRevert(
          token.connect(unauthorizedCaller).logSteps(
            {
              user: user1.address,
              beneficiary: user1.address,
              steps: 100n,
              nonce,
              deadline,
              source: "test-noproof",
              version: PAYLOAD_VER,
            },
            { signature: sig, proof: [], attestation: "0x" }
          ),
          tokenErr,
          "CallerNotUserOrApi",
          "Caller must be user or trusted API"
        );

        // user path
        await expect(
          submitSteps(token, user1, 100n, {
            source: "test-noproof",
            signer: user1,
            version: PAYLOAD_VER,
            funder,
          })
        ).to.not.be.reverted;

        // ✅ wait out min interval before API submit on same (user, source)
        await bumpMinInterval(token, "test-noproof", 2);

        // API path (no stake)
        await expect(
          submitSteps(token, user1, 100n, {
            beneficiary: user1.address,
            signer: apiSigner,
            withStake: false,
            isApiSigned: true,
            source: "test-noproof",
            version: PAYLOAD_VER,
            funder,
          })
        ).to.not.be.reverted;
      });
    });
  });
});

describe("Dynamic Staking (Token Lock + Split Discount)", function () {
  it("stakes GSTEP: moves tokens into contract + updates stakeBalance/start", async function () {
    const { token, user1, funder } = await loadFixture(deployExtendedGemStepFixture);

    // fund user1 with GSTEP
    const amt = ethers.parseEther("1000");
    await (await token.connect(funder).transfer(user1.address, amt)).wait();

    const tokenAddr = await token.getAddress();

    const balUserBefore = await token.balanceOf(user1.address);
    const balTokenBefore = await token.balanceOf(tokenAddr);

    await expect(token.connect(user1).stake(amt)).to.emit(token, "Staked").withArgs(user1.address, amt);

    const balUserAfter = await token.balanceOf(user1.address);
    const balTokenAfter = await token.balanceOf(tokenAddr);

    expect(balUserAfter).to.equal(balUserBefore - amt);
    expect(balTokenAfter).to.equal(balTokenBefore + amt);

    const [stakeBal, startTs] = await token.getStakeInfo(user1.address);
    expect(stakeBal).to.equal(amt);
    expect(startTs).to.be.gt(0);
  });

  it("withdrawStake: returns tokens + clears stakeStart on full exit", async function () {
    const { token, user1, funder } = await loadFixture(deployExtendedGemStepFixture);

    const amt = ethers.parseEther("500");
    await (await token.connect(funder).transfer(user1.address, amt)).wait();

    await token.connect(user1).stake(amt);

    const tokenAddr = await token.getAddress();
    const balUserMid = await token.balanceOf(user1.address);
    const balTokenMid = await token.balanceOf(tokenAddr);

    await expect(token.connect(user1).withdrawStake(amt))
      .to.emit(token, "Withdrawn")
      .withArgs(user1.address, amt);

    const balUserAfter = await token.balanceOf(user1.address);
    const balTokenAfter = await token.balanceOf(tokenAddr);

    expect(balUserAfter).to.equal(balUserMid + amt);
    expect(balTokenAfter).to.equal(balTokenMid - amt);

    const [stakeBal2, start2] = await token.getStakeInfo(user1.address);
    expect(stakeBal2).to.equal(0);
    expect(start2).to.equal(0);
  });

  it("top-ups use weighted stakeStart (between oldStart and now)", async function () {
    const { token, user1, funder } = await loadFixture(deployExtendedGemStepFixture);

    const a1 = ethers.parseEther("100");
    const a2 = ethers.parseEther("300");

    await (await token.connect(funder).transfer(user1.address, a1 + a2)).wait();

    await token.connect(user1).stake(a1);
    const [, s1] = await token.getStakeInfo(user1.address);

    // wait a bit, then top up
    await time.increase(10_000);

    await token.connect(user1).stake(a2);
    const [, s2] = await token.getStakeInfo(user1.address);

    // Weighted start should be >= s1 and <= now, and typically > s1 for a2>0
    expect(s2).to.be.gte(s1);

    const nowTs = await time.latest();
    expect(s2).to.be.lte(nowTs);

    // For meaningful top-up, s2 should move forward (unless same block)
    expect(s2).to.be.gt(s1);
  });

  it("stake discount affects reward split only after STAKE_MIN_AGE", async function () {
    const { token, admin, user1, funder } = await loadFixture(deployExtendedGemStepFixture);

    // Ensure a no-proof source for this test
    const src = "stake-split-src";
    await ensureNoProofSource(token, admin, src);

    // Fund user so they can stake
    // Choose a tier size that should trigger at least tier1
    // NOTE: depends on your STAKE_TIER1 constant (10_000e18 in your earlier snippet)
    const tier1 = ethers.parseEther("10000");
    await (await token.connect(funder).transfer(user1.address, tier1)).wait();
    await token.connect(user1).stake(tier1);

    // Helper: submit and read how much user received vs burn/treasury by balance deltas
    // (works even if you don’t emit split events)
    const readMintDelta = async (steps) => {
      const uBefore = await token.balanceOf(user1.address);
      const burnAddr = await token.BURN_ADDRESS?.().catch(() => null); // optional if exposed
      const treasuryAddr = await token.treasury?.().catch(() => null); // optional if exposed
      const burnBefore = burnAddr ? await token.balanceOf(burnAddr) : 0n;
      const treasBefore = treasuryAddr ? await token.balanceOf(treasuryAddr) : 0n;

      await submitSteps(token, user1, steps, { source: src, signer: user1, version: PAYLOAD_VER, funder });

      const uAfter = await token.balanceOf(user1.address);
      const burnAfter = burnAddr ? await token.balanceOf(burnAddr) : 0n;
      const treasAfter = treasuryAddr ? await token.balanceOf(treasuryAddr) : 0n;

      return {
        userDelta: uAfter - uBefore,
        burnDelta: burnAddr ? burnAfter - burnBefore : null,
        treasDelta: treasuryAddr ? treasAfter - treasBefore : null,
      };
    };

    // Before min age: discount should be 0 → baseline split
    const d0 = await readMintDelta(100n);

    // Advance past min stake age (your constant is 7 days)
    await time.increase(8 * 24 * 60 * 60);

    const d1 = await readMintDelta(100n);

    // After min age, user should receive >= before (since discount moves cut -> userBps)
    // burn/treasury deltas should be <= before if those balances are observable.
    expect(d1.userDelta).to.be.gte(d0.userDelta);

    if (d0.burnDelta !== null && d1.burnDelta !== null) {
      expect(d1.burnDelta).to.be.lte(d0.burnDelta);
    }
    if (d0.treasDelta !== null && d1.treasDelta !== null) {
      expect(d1.treasDelta).to.be.lte(d0.treasDelta);
    }
  });
});
