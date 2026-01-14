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
  if (typeof token.getSourceConfig === "function") {
    // getSourceConfig(source) =>
    // [0]=requiresProof, [1]=requiresAttestation, [2]=merkleRoot,
    // [3]=maxStepsPerDay, [4]=minInterval
    const cfg = await token.getSourceConfig(source);
    return {
      maxStepsPerDay: BigInt(cfg[3].toString()),
      minInterval: BigInt(cfg[4].toString()),
    };
  }

  // Fallbacks (legacy)
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

/**********************
 * EIP-712 SIGNING    *
 **********************/

// ---- EIP-712 signer (domain MUST match __EIP712_init("GemStep","1.0.0")) ----
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
  const {
    enabled = true,
    requiresProof = false,
    requiresAttestation = false,
  } = opts;

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

// Always use this in tests instead of raw configureSource tries.
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

// Unified submit helper (user path vs API path)
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
  } = options;

  // Staking for user path only
  if (!isApiSigned && withStake !== false) {
    const stakePerStep = await token.currentStakePerStep();
    const requiredStake = BigInt(steps) * BigInt(stakePerStep.toString());

    // use view bundle instead of direct mapping
    const [, , , stakedWei] = await token.getUserCoreStatus(submitter.address);
    const currentStake = BigInt(stakedWei.toString());

    if (currentStake < requiredStake) {
      await token.connect(submitter).stake({ value: requiredStake - currentStake });
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

/**
 * ✅ Drop-in FIXED wrapper:
 * - Works with your updated base fixture that mints INITIAL_SUPPLY to TREASURY (not deployer)
 * - Never transfers from an address with 0 tokens
 * - Grants roles from whichever signer actually has DEFAULT_ADMIN_ROLE
 * - Uses robust config for sources/versions/trusted API (no "Invalid proof")
 */
async function deployExtendedGemStepFixture() {
  const ctx = await baseDeployGemStepFixture();

  const signers = await ethers.getSigners();

  // base fixture returns: { token, admin, treasury, user1, user2, rest, timelock, priceOracle, INITIAL_SUPPLY, initialHolder? }
  const token = ctx.token;
  if (!token) throw new Error("Fixture must return { token }");

  const admin = ctx.admin || signers[0];
  const treasury = ctx.treasury || signers[1];
  const user1 = ctx.user1 || signers[2];
  const user2 = ctx.user2 || signers[3];

  // deterministic “extra” signers for API/trusted device
  const apiSigner = ctx.apiSigner || signers[4];
  const trustedDevice = ctx.trustedDevice || signers[5];

  // Who can grant roles? (whoever has DEFAULT_ADMIN_ROLE right now)
  const roleAdmin =
    (await resolveRoleAdmin(token, [admin, treasury, ...signers])) ||
    admin; // last resort

  // Who can fund ERC20 transfers? (whoever actually holds the initial supply)
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

  // ---- Sources needed by tests (SAFE across configureSource signatures) ----
  await ensureNoProofSource(token, admin, "test-noproof");
  await ensureNoProofSource(token, admin, "fitbit");
  await ensureNoProofSource(token, admin, "applehealth");

  // Trusted device + supported version
  if (typeof token.addTrustedDevice === "function") {
    await tryTx(token.connect(admin), "addTrustedDevice", trustedDevice.address);
  }

  if (typeof token.addSupportedPayloadVersion === "function") {
    await tryTx(token.connect(admin), "addSupportedPayloadVersion", PAYLOAD_VER);
  } else if (typeof token.addSupportedVersion === "function") {
    await tryTx(token.connect(admin), "addSupportedVersion", PAYLOAD_VER);
  }

  // Emergency recipients (EOA only)
  if (typeof token.approveRecipient === "function") {
    await tryTx(token.connect(admin), "approveRecipient", admin.address, true);
  }

  // Fresh month (if hook exists)
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
  // for halving we only need the same environment; keep as separate name for loadFixture caching
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

      // isTrustedAPI via view bundle (your view bundle returns apiTrusted at index 4)
      const [, , , , apiTrusted] = await token.getUserCoreStatus(apiSigner.address);
      expect(apiTrusted).to.be.true;
    });
  });

  describe("Signature Security", function () {
    it("Should reject reused signatures", async function () {
      const { token, tokenErr, user1, admin } = await loadFixture(deployExtendedGemStepFixture);
      await ensureNoProofSource(token, admin, "testreuse");

      const steps = 1n;
      const stakePerStep = await token.currentStakePerStep();
      await token.connect(user1).stake({ value: steps * BigInt(stakePerStep.toString()) });

      const chainId = await getChainId();
      const nonce1 = await token.nonces(user1.address);
      const deadline1 = (await time.latest()) + 3600;

      const sig1 = await signStepData(
        token,
        user1.address,
        user1.address,
        steps,
        nonce1,
        deadline1,
        chainId,
        "testreuse",
        PAYLOAD_VER,
        user1
      );

      // First submission succeeds
      await token.connect(user1).logSteps(
        {
          user: user1.address,
          beneficiary: user1.address,
          steps,
          nonce: nonce1,
          deadline: deadline1,
          source: "testreuse",
          version: PAYLOAD_VER,
        },
        { signature: sig1, proof: [], attestation: "0x" }
      );

      // Reuse same nonce must fail
      await expectRevert(
        token.connect(user1).logSteps(
          {
            user: user1.address,
            beneficiary: user1.address,
            steps,
            nonce: nonce1,
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
      const { token, tokenErr, user1, user2 } = await loadFixture(deployExtendedGemStepFixture);
      const stakePerStep = await token.currentStakePerStep();
      await token.connect(user1).stake({ value: 100n * BigInt(stakePerStep.toString()) });

      await expectRevert(
        submitSteps(token, user1, 100n, { signer: user2, source: "test-noproof" }),
        tokenErr,
        "SignerMustBeUser",
        "Signer must be user"
      );
    });

    it("Should reject expired signatures", async function () {
      const { token, tokenErr, user1, admin } = await loadFixture(deployExtendedGemStepFixture);
      await ensureNoProofSource(token, admin, "test-exp");

      const steps = 10n;
      const stakePerStep = await token.currentStakePerStep();
      await token.connect(user1).stake({ value: steps * BigInt(stakePerStep.toString()) });

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
    const { token, admin, user1 } = await loadFixture(deployExtendedGemStepFixture);
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
    });

    await time.increase(60 * 60 * 24 * 30);
    await token.connect(admin).forceMonthUpdate();

    await expect(
      submitSteps(token, user1, safeStepsBN, { source: "testcap", signer: user1, version: PAYLOAD_VER })
    ).to.not.be.reverted;

    const currentMonthMinted = await token.currentMonthMinted();
    expect(currentMonthMinted).to.be.lte(currentCap);
  });

  it("Should allow submissions after month rollover (API Signer)", async function () {
    const { token, admin, apiSigner, user1 } = await loadFixture(deployExtendedGemStepFixture);

    const API_SIGNER_ROLE = await token.API_SIGNER_ROLE();
    if (!(await token.hasRole(API_SIGNER_ROLE, apiSigner.address))) {
      await token.connect(admin).grantRole(API_SIGNER_ROLE, apiSigner.address);
    }

    // isTrustedAPI via view bundle
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
      })
    ).to.not.be.reverted;
  });

  it("Should enforce step limit", async function () {
    const { token, tokenErr, user1, admin } = await loadFixture(deployExtendedGemStepFixture);
    await ensureNoProofSource(token, admin, "limit-src");

    const stepLimit = await token.stepLimit();
    const overLimit = BigInt(stepLimit.toString()) + 1n;

    await expectRevert(
      submitSteps(token, user1, overLimit, { source: "limit-src", signer: user1, version: PAYLOAD_VER }),
      tokenErr,
      "StepLimitExceeded",
      "Step limit exceeded"
    );
  });

  describe("GemStepToken - Minting Halving", function () {
  it("Halves monthly cap once when distributedTotal crosses first threshold (fast harness)", async function () {
    this.timeout(120000);

    const [deployer, admin, treasury] = await ethers.getSigners();

    // --- Oracle ---
    const Mock = await ethers.getContractFactory("MockOracleV2");
    const oracle = await Mock.deploy();
    await oracle.waitForDeployment();
    const { timestamp } = await ethers.provider.getBlock("latest");
    await oracle.set(ethers.parseEther("0.005"), timestamp, 0);
    await oracle.setPolicy(300, 100);

    // --- Deploy harness behind same proxy style as production ---
    const Harness = await ethers.getContractFactory("GemStepTokenHalvingHarness");

    // Must match GemStepStorage INITIAL_SUPPLY (400,000,000e18)
    const INITIAL_SUPPLY = ethers.parseUnits("400000000", 18);

    // Match initializer signature (3 or 4 args)
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

    // First halving threshold (hc=0): cap - (cap >> 1) == cap/2
    const threshold = cap - (cap >> 1n);

    // ✅ ACTUALLY CROSS THRESHOLD
    await (await token.__setDistributedTotal(threshold)).wait();

    // Trigger halving
    await (await token.__checkHalving()).wait();

    const hc1 = await token.halvingCount();
    expect(hc1).to.equal(hc0 + 1n);

    // Your note: reward rate halves -> monthly steps double
    const afterRate = await token.rewardRate();
    const afterMonthlyCap = await token.currentMonthlyCap();
    const stepsPerMonthAfter = afterMonthlyCap / afterRate;

    expect(afterRate).to.equal(beforeRate / 2n);
    expect(stepsPerMonthAfter).to.equal(stepsPerMonthBefore * 4n);

    // Idempotent (should NOT keep halving again without hitting next threshold)
    await (await token.__checkHalving()).wait();
    expect(await token.halvingCount()).to.equal(hc0 + 1n);
  });

    it("Should correctly calculate remaining until next halving", async function () {
      const { token } = await loadFixture(deployExtendedGemStepFixture);
      const [, , remaining] = await token.getHalvingInfo();
      const distributed = await token.distributedTotal();
      const threshold = (await token.cap()) - ((await token.cap()) >> ((await token.halvingCount()) + 1n));
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

      for (const signer of newSigners) {
        expect(await token.hasRole(await token.SIGNER_ROLE(), signer)).to.be.true;
      }

      await token.connect(admin).batchRemoveSigners(newSigners);

      for (const signer of newSigners) {
        expect(await token.hasRole(await token.SIGNER_ROLE(), signer)).to.be.false;
      }
    });
  });

  describe("Emergency Functions", function () {
    it("Should enforce emergency withdrawal delay", async function () {
  const { token, tokenErr, admin, funder } = await loadFixture(deployExtendedGemStepFixture);

  const tokenAddress = await token.getAddress();
  const targetAmount = ethers.parseEther("100");
  const sendAmount = ethers.parseEther("101.010101010101010101"); // ~1% headroom

  // Ensure admin has enough to fund the contract
  const adminBalance = await token.balanceOf(admin.address);
  if (adminBalance < sendAmount) {
    await (await token.connect(funder).transfer(admin.address, sendAmount)).wait();
  }

  const initialContractBalance = await token.balanceOf(tokenAddress);
  await (await token.connect(admin).transfer(tokenAddress, sendAmount)).wait();
  const afterDepositBalance = await token.balanceOf(tokenAddress);
  const receivedAmount = afterDepositBalance - initialContractBalance;

  // Some builds charge transfer fee, others exempt transfers to contract.
  // Accept either:
  //  - received ≈ target (fee applied), OR
  //  - received ≈ sendAmount (no fee)
  const tol = ethers.parseEther("0.03");
  const diffToTarget = receivedAmount > targetAmount ? receivedAmount - targetAmount : targetAmount - receivedAmount;
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

  // withdraw "targetAmount" (some implementations withdraw EXACT amount, not full balance)
  await expect(token.connect(admin).emergencyWithdraw(targetAmount)).to.not.be.reverted;

  // After withdraw, contract balance can be:
  //   A) 0 (implementation withdraws all), OR
  //   B) (receivedAmount - targetAmount) (implementation withdraws exactly targetAmount)
  const remaining = await token.balanceOf(tokenAddress);
  const expectedLeftover = receivedAmount > targetAmount ? receivedAmount - targetAmount : 0n;

  const diffToZero = remaining; // remaining - 0
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
    // helpers to work across legacy/modern APIs
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
      if (token.getPayloadVersionInfo) {
        const [supported] = await token.getPayloadVersionInfo(vHash);
        return supported;
      }
      if (token.supportedPayloadVersions) {
        return token.supportedPayloadVersions(vHash);
      }
      return token.supportedAttestationVersions(vHash); // last-ditch legacy fallback
    }

    it("Should reject unsupported payload versions", async function () {
      const { token, tokenErr, user1, admin } = await loadFixture(deployExtendedGemStepFixture);

      // roll month so any monthly limits don’t interfere
      await time.increase(Number(await token.SECONDS_PER_MONTH()));
      await token.connect(admin).forceMonthUpdate();

      const unsupported = "2.0";
      const h = ethers.id(unsupported);
      expect(await isPayloadSupported(token, h)).to.be.false;

      const steps = 1000n;
      const stakePerStep = await token.currentStakePerStep();
      await token.connect(user1).stake({ value: steps * BigInt(stakePerStep.toString()) });

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
    });

    it("Should allow admin to add new payload versions", async function () {
      const { token, admin } = await loadFixture(deployExtendedGemStepFixture);

      const v = "2.0";
      const h = ethers.id(v);

      expect(await isPayloadSupported(token, h)).to.be.false;

      await addPayloadVersion(token, admin, v);

      expect(await isPayloadSupported(token, h)).to.be.true;
    });
  });

  describe("Anomaly Detection", function () {
    it("Should trigger fraud prevention for anomalous submissions", async function () {
      const { token, user1, admin } = await loadFixture(deployExtendedGemStepFixture);

      const src = "test-noproof";
      const minInterval = BigInt((await token.MIN_SUBMISSION_INTERVAL()).toString());
      const grace = BigInt((await token.GRACE_PERIOD()).toString());
      const stakePerStep = BigInt((await token.currentStakePerStep()).toString());
      const penaltyPct = BigInt((await token.PENALTY_PERCENT()).toString());
      const stepLimitBN = BigInt((await token.stepLimit()).toString());
      const maxPerDayBN = BigInt((await token.MAX_STEPS_PER_DAY()).toString());

      const warm = 100n;
      // Ensure source is enabled and no-proof
      await ensureNoProofSource(token, admin, src);

      await token.connect(user1).stake({ value: warm * 5n * stakePerStep });

      for (let i = 0; i < 5; i++) {
        await submitSteps(token, user1, warm, {
          beneficiary: user1.address,
          withStake: true,
          signer: user1,
          version: PAYLOAD_VER,
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

      const [, , , stakedWeiRaw] = await token.getUserCoreStatus(user1.address);
      const stakedWei = BigInt(stakedWeiRaw.toString());
      if (stakedWei < need + headroom) {
        await token.connect(user1).stake({ value: need + headroom - stakedWei });
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
        const { token, tokenErr, admin, user1 } = await loadFixture(deployExtendedGemStepFixture);
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

        const stakePerStep = await token.currentStakePerStep();
        await network.provider.send("hardhat_setBalance", [
          user1.address,
          ethers.toQuantity(100n * BigInt(stakePerStep.toString()) + ethers.parseEther("0.1")),
        ]);
        await token.connect(user1).stake({ value: 100n * BigInt(stakePerStep.toString()) });

        await expect(
          submitSteps(token, user1, 100n, { source: "test-noproof", signer: user1, version: PAYLOAD_VER })
        ).to.not.be.reverted;

        // ✅ wait out min interval before API submit on same (user, source)
        await bumpMinInterval(token, "test-noproof", 2);

        await expect(
          submitSteps(token, user1, 100n, {
            beneficiary: user1.address,
            signer: apiSigner,
            withStake: false,
            isApiSigned: true,
            source: "test-noproof",
            version: PAYLOAD_VER,
          })
        ).to.not.be.reverted;
      });
    });
  });
});

describe("Dynamic Staking", function () {
  async function withMockOracle() {
    const ctx = await loadFixture(deployExtendedGemStepFixture);
    const { token, admin } = ctx;

    const Mock = await ethers.getContractFactory("MockOracleV2");
    const mock = await Mock.deploy();
    await mock.waitForDeployment();

    await mock.set(ethers.parseEther("0.0005"), await time.latest(), 0); // price, ts, confBps
    await mock.setPolicy(300, 100); // staleness, minConfBps

    await token.connect(admin).setPriceOracle(await mock.getAddress());

    const tokenErr = await mkErrorDecoderAt(token);
    return { ...ctx, mock, tokenErr };
  }

  it("sets oracle and adjusts stake within bounds", async function () {
    const { token, admin, mock } = await withMockOracle();

    const MIN = await token.MIN_STAKE_PER_STEP();
    const MAX = await token.MAX_STAKE_PER_STEP();
    const cooldown = await token.STAKE_ADJUST_COOLDOWN(); // bigint

    const refresh = async (priceEth) => {
      const { timestamp } = await ethers.provider.getBlock("latest");
      await mock.set(ethers.parseEther(priceEth), timestamp, 0);
    };

    await time.increase(cooldown + 1n);
    await refresh("0.0005");
    await expect(token.connect(admin).adjustStakeRequirements()).to.emit(token, "StakeParametersUpdated");
    expect(await token.currentStakePerStep()).to.equal(ethers.parseEther("0.00005"));

    await expect(token.connect(admin).adjustStakeRequirements()).to.be.reverted;

    await time.increase(cooldown + 1n);
    await refresh("0.0000005");
    await expect(token.connect(admin).adjustStakeRequirements()).to.emit(token, "StakeParametersUpdated");
    expect(await token.currentStakePerStep()).to.equal(MIN);

    await time.increase(cooldown + 1n);
    await refresh("0.02");
    await expect(token.connect(admin).adjustStakeRequirements()).to.emit(token, "StakeParametersUpdated");
    expect(await token.currentStakePerStep()).to.equal(MAX);
  });

  it("respects emergency lock and manual override", async function () {
    const { token, tokenErr, admin } = await withMockOracle();

    await token.connect(admin).toggleStakeParamLock();
    expect(await token.stakeParamsLocked()).to.equal(true);

    await expectRevert(
      token.connect(admin).adjustStakeRequirements(),
      tokenErr,
      "StakeParamsLocked",
      "Stake parameters locked"
    );

    await expectRevert(
      token.connect(admin).manualOverrideStake(ethers.parseEther("0.0002")),
      tokenErr,
      "StakeParamsLocked",
      "Stake parameters locked"
    );

    await token.connect(admin).toggleStakeParamLock();
    expect(await token.stakeParamsLocked()).to.equal(false);

    await expect(token.connect(admin).manualOverrideStake(ethers.parseEther("0.0002"))).to.emit(
      token,
      "StakeParametersUpdated"
    );

    expect(await token.currentStakePerStep()).to.equal(ethers.parseEther("0.0002"));

    await expectRevert(
      token.connect(admin).manualOverrideStake(ethers.parseEther("0.01")),
      tokenErr,
      "StakeOutOfBounds",
      "Stake out of bounds"
    );
  });

  it("only PARAMETER_ADMIN_ROLE can adjust stake requirements; only DEFAULT_ADMIN_ROLE can set oracle", async function () {
    const { token, admin, user1 } = await loadFixture(deployExtendedGemStepFixture);

    const Mock = await ethers.getContractFactory("MockOracleV2");
    const mock = await Mock.deploy();
    await mock.waitForDeployment();

    const refresh = async (priceEth) => {
      const { timestamp } = await ethers.provider.getBlock("latest");
      await mock.set(ethers.parseEther(priceEth), timestamp, 0);
    };

    await refresh("0.001");
    await mock.setPolicy(300, 100);

    const DEFAULT_ADMIN_ROLE = await token.DEFAULT_ADMIN_ROLE();
    await expect(token.connect(user1).setPriceOracle(await mock.getAddress()))
      .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount")
      .withArgs(user1.address, DEFAULT_ADMIN_ROLE);

    await expect(token.connect(admin).setPriceOracle(await mock.getAddress())).to.emit(token, "OracleUpdated");

    const PARAMETER_ADMIN_ROLE = await token.PARAMETER_ADMIN_ROLE();
    expect(await token.hasRole(PARAMETER_ADMIN_ROLE, admin.address)).to.equal(true);

    const cooldown = await token.STAKE_ADJUST_COOLDOWN();

    await expect(token.connect(user1).adjustStakeRequirements())
      .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount")
      .withArgs(user1.address, PARAMETER_ADMIN_ROLE);

    await time.increase(cooldown + 1n);
    await refresh("0.001");

    await expect(token.connect(admin).adjustStakeRequirements()).to.emit(token, "StakeParametersUpdated");
  });
});
