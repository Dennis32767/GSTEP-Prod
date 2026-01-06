/* eslint-disable no-undef */
const { expect } = require("chai");
const { ethers, network, upgrades } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { parseEther, parseUnits } = ethers;
const { expectRevert, mkErrorDecoderAt } = require("./helpers/reverts");

/** Use one version constant for BOTH domain init and payload struct **/
const DOMAIN_NAME = "GemStep";
const DOMAIN_VER = "1.0.0";
const PAYLOAD_VER = "1.0.0"; // <-- must match on-chain

/**********************
 * CORE TEST HELPERS  *
 **********************/

// Jump just over a UTC day boundary so (ts / 1 days) increments
async function bumpDay() {
  await time.increase(24 * 60 * 60 + 5);
}
async function bumpUtcDay() {
  return bumpDay();
}

// Respect per-source minInterval (API + user path)
async function bumpMinInterval(token, source, extra = 2) {
  let min = 0n;

  if (typeof token.getSourceConfig === "function") {
    // getSourceConfig(source) =>
    // [0]=requiresProof, [1]=requiresAttestation, [2]=merkleRoot,
    // [3]=maxStepsPerDay, [4]=minInterval
    const cfg = await token.getSourceConfig(source);
    min = BigInt(cfg[4].toString());
  } else if (typeof token.MIN_SUBMISSION_INTERVAL === "function") {
    min = BigInt((await token.MIN_SUBMISSION_INTERVAL()).toString());
  } else {
    // ultra-safe fallback (1h)
    min = 3600n;
  }

  if (min > 0n) {
    await time.increase(Number(min) + extra);
  }
}

// Read per-source daily cap & interval (used by halving + API tests)
async function getPerSourceLimits(token, source) {
  if (typeof token.getSourceConfig === "function") {
    const cfg = await token.getSourceConfig(source);
    return {
      maxStepsPerDay: BigInt(cfg[3].toString()),
      minInterval: BigInt(cfg[4].toString()),
    };
  }

  // Fallbacks (should not be needed with GS_Views)
  return {
    maxStepsPerDay: BigInt((await token.MAX_STEPS_PER_DAY()).toString()),
    minInterval: BigInt((await token.MIN_SUBMISSION_INTERVAL()).toString()),
  };
}

async function getChainId() {
  const { chainId } = await ethers.provider.getNetwork();
  return Number(chainId);
}

async function increaseTime(seconds) {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine");
}

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

  if (isApiSigned) {
    return token.connect(signer).logSteps(...args);
  }
  return token.connect(submitter).logSteps(...args);
}

async function deployGemStepFixture() {
  const [deployer, admin, user1, user2, apiSigner, trustedDevice] = await ethers.getSigners();

  const GemStepToken = await ethers.getContractFactory("GemStepToken");
  const token = await upgrades.deployProxy(
    GemStepToken,
    [parseUnits("40000000", 18), deployer.address, deployer.address],
    { initializer: "initialize" }
  );
  await token.waitForDeployment();

  // Roles
  await token.connect(deployer).grantRole(await token.DEFAULT_ADMIN_ROLE(), admin.address);
  await token.connect(deployer).grantRole(await token.PARAMETER_ADMIN_ROLE(), admin.address);
  await token.connect(deployer).grantRole(await token.SIGNER_ROLE(), admin.address);
  await token.connect(deployer).grantRole(await token.MINTER_ROLE(), admin.address);
  await token.connect(deployer).grantRole(await token.API_SIGNER_ROLE(), apiSigner.address);
  await token.connect(deployer).grantRole(await token.EMERGENCY_ADMIN_ROLE(), admin.address);
  await token.connect(deployer).grantRole(await token.PAUSER_ROLE(), admin.address);

  // API path prerequisites
  await token.connect(admin).setTrustedAPI(apiSigner.address, true);

  // Sources
  await token.connect(admin).configureSource("test-noproof", false, false);
  await token.connect(admin).configureSource("fitbit", true, true);
  await token.connect(admin).configureSource("applehealth", false, false);

  // Trusted device + supported version
  await token.connect(admin).addTrustedDevice(trustedDevice.address);
  await token.connect(admin).addSupportedVersion(PAYLOAD_VER);

  // Emergency recipients (EOA only)
  await token.connect(admin).approveRecipient(admin.address, true);

  // Fresh month
  await token.connect(admin).forceMonthUpdate();

  // Seed admin for emergency tests
  await token.connect(deployer).transfer(admin.address, parseEther("10000"));

  const tokenErr = await mkErrorDecoderAt(token);
  return { token, tokenErr, deployer, admin, user1, user2, apiSigner, trustedDevice };
}

/**********************
 * TEST SUITES        *
 **********************/
describe("GemStepToken Extended Tests", function () {
  describe("Test Setup", function () {
    it("Should properly initialize all roles", async function () {
      const { token, admin, apiSigner } = await loadFixture(deployGemStepFixture);
      expect(await token.hasRole(await token.API_SIGNER_ROLE(), apiSigner.address)).to.be.true;
      expect(await token.hasRole(await token.DEFAULT_ADMIN_ROLE(), admin.address)).to.be.true;

      // isTrustedAPI via view bundle
      const [, , , , apiTrusted] = await token.getUserCoreStatus(apiSigner.address);
      expect(apiTrusted).to.be.true;
    });
  });

  describe("Signature Security", function () {
    it("Should reject reused signatures", async function () {
      const { token, tokenErr, user1, admin } = await loadFixture(deployGemStepFixture);
      await token.connect(admin).configureSource("testreuse", false, false);

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
      const { token, tokenErr, user1, user2 } = await loadFixture(deployGemStepFixture);
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
      const { token, tokenErr, user1, admin } = await loadFixture(deployGemStepFixture);
      await token.connect(admin).configureSource("test-exp", false, false);

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
    const { token, admin, user1 } = await loadFixture(deployGemStepFixture);
    await token.connect(admin).configureSource("testcap", false, false);

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
    const { token, admin, apiSigner, user1 } = await loadFixture(deployGemStepFixture);

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
    const { token, tokenErr, user1, admin } = await loadFixture(deployGemStepFixture);
    await token.connect(admin).configureSource("limit-src", false, false);

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
    async function deployGemStepHalvingFixture() {
      const [deployer, admin, user1, apiSigner] = await ethers.getSigners();

      const GemStepToken = await ethers.getContractFactory("GemStepToken");
      const token = await upgrades.deployProxy(
        GemStepToken,
        [parseUnits("40000000", 18), deployer.address, deployer.address],
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
      ];
      for (const roleName of roles) {
        const role = await token[roleName]();
        await token.connect(deployer).grantRole(role, admin.address);
      }

      await token.connect(deployer).grantRole(await token.API_SIGNER_ROLE(), apiSigner.address);
      await token.connect(admin).setTrustedAPI(apiSigner.address, true);
      await token.connect(admin).configureSource("test-noproof", false, false);
      await token.connect(admin).addSupportedVersion(PAYLOAD_VER);

      const tokenErr = await mkErrorDecoderAt(token);
      return { token, tokenErr, deployer, admin, user1, apiSigner };
    }

    const MIN_INTERVAL = 3600n;

    async function bumpTime(interval = MIN_INTERVAL) {
      const lastBlock = await ethers.provider.getBlock("latest");
      const newTime = BigInt(lastBlock.timestamp) + BigInt(interval) + 3n;
      await time.increaseTo(Number(newTime));
      return newTime;
    }

    it("Mints up to first threshold and halves monthly cap once", async function () {
  // This test may require many tx depending on stepLimit/rewardRate,
  // AND must respect minInterval + per-source daily cap now.
  this.timeout(900000); // ✅ increase to 15 minutes

  const { token, admin, apiSigner, user1 } = await loadFixture(deployGemStepHalvingFixture);

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

  const HALVING_SRC = "test-noproof";

  // ---- helpers (local to this test) ----
  async function bumpUtcDay() {
    await time.increase(24 * 60 * 60 + 5);
  }

  async function getPerSourceLimits(source) {
    // GS_Views.getSourceConfig returns:
    // (requiresProof, requiresAttestation, merkleRoot, maxStepsPerDay, minInterval)
    if (!token.getSourceConfig) {
      throw new Error("getSourceConfig() not available; cannot read per-source limits");
    }
    const cfg = await token.getSourceConfig(source);
    return {
      maxStepsPerDay: BigInt(cfg[3].toString()),
      minInterval: BigInt(cfg[4].toString()),
    };
  }

  async function bumpMinIntervalForSource(source, extra = 2) {
    const { minInterval } = await getPerSourceLimits(source);
    if (minInterval > 0n) {
      await time.increase(Number(minInterval) + extra);
    }
  }

  // ---- read global + halving params ----
  const [cap, rewardRate, stepLimit, currentMonthlyCapBefore, secondsPerMonth] =
    await Promise.all([
      token.cap(),
      token.rewardRate(),
      token.stepLimit(),
      token.currentMonthlyCap(),
      token.SECONDS_PER_MONTH(),
    ]);

  const firstThreshold = cap - (cap >> 1n);

  let distributed = await token.distributedTotal();
  let remainingTokens = firstThreshold > distributed ? firstThreshold - distributed : 0n;

  // Already halved case
  if (remainingTokens === 0n) {
    const halvingCountNow = await token.halvingCount();
    expect(halvingCountNow).to.equal(1n);
    const currentMonthlyCapAfterNow = await token.currentMonthlyCap();
    expect(currentMonthlyCapAfterNow).to.equal(currentMonthlyCapBefore / 2n);
    return;
  }

  const stepsPerTx = BigInt(stepLimit.toString());
  const rewardPerTx = stepsPerTx * rewardRate;

  // Track per-day usage for the SOURCE (daily cap is per-source)
  let { maxStepsPerDay } = await getPerSourceLimits(HALVING_SRC);
  let usedToday = 0n;

  const sendApiTx = async (stepsToSend) => {
    await (
      await submitSteps(token, user1, stepsToSend, {
        beneficiary: user1.address,
        source: HALVING_SRC,
        withStake: false,
        signer: apiSigner,
        isApiSigned: true,
        version: PAYLOAD_VER,
      })
    ).wait();

    usedToday += stepsToSend;

    // ✅ enforce per-source minInterval
    await bumpMinIntervalForSource(HALVING_SRC, 2);
  };

  // ---- main loop ----
  while (remainingTokens > 0n) {
    // month cap room
    const mintedThisMonth = await token.currentMonthMinted();
    const capThisMonth = await token.currentMonthlyCap();
    const monthRoom = capThisMonth > mintedThisMonth ? capThisMonth - mintedThisMonth : 0n;

    // month rollover if needed
    if (monthRoom === 0n) {
      await time.increase(Number(secondsPerMonth) + 1);
      await token.connect(admin).forceMonthUpdate();
      // new month => daily usage should reset naturally when day changes, but keep logic safe:
      // we do nothing special here; daily rollover handled below when needed.
      continue;
    }

    // daily rollover if needed (per-source daily cap)
    if (usedToday >= maxStepsPerDay) {
      await bumpUtcDay();
      usedToday = 0n;
      // source limits might have changed (admin could reconfigure), re-read
      ({ maxStepsPerDay } = await getPerSourceLimits(HALVING_SRC));
    }

    const dayRoom = maxStepsPerDay > usedToday ? maxStepsPerDay - usedToday : 0n;
    if (dayRoom === 0n) {
      await bumpUtcDay();
      usedToday = 0n;
      ({ maxStepsPerDay } = await getPerSourceLimits(HALVING_SRC));
      continue;
    }

    const canMintNow = remainingTokens < monthRoom ? remainingTokens : monthRoom;

    // If the remaining mint is less than one full tx reward, do a partial tx (steps = tokens/rewardRate)
    if (canMintNow < rewardPerTx) {
      let stepsForFinal = canMintNow / rewardRate;
      if (stepsForFinal === 0n) break;

      // respect per-source daily cap and global stepLimit
      if (stepsForFinal > stepsPerTx) stepsForFinal = stepsPerTx;
      if (stepsForFinal > dayRoom) stepsForFinal = dayRoom;

      await sendApiTx(stepsForFinal);
      remainingTokens -= stepsForFinal * rewardRate;
    } else {
      // Full tx path, but still must respect daily cap: maybe split across days
      let stepsThisTx = stepsPerTx;
      if (stepsThisTx > dayRoom) stepsThisTx = dayRoom;

      await sendApiTx(stepsThisTx);
      remainingTokens -= stepsThisTx * rewardRate;
    }

    // If we hit month cap, roll the month
    const mintedAfter = await token.currentMonthMinted();
    if (mintedAfter >= (await token.currentMonthlyCap())) {
      await time.increase(Number(secondsPerMonth) + 1);
      await token.connect(admin).forceMonthUpdate();
    }
  }

  // ---- asserts ----
  const halvingCount = await token.halvingCount();
  expect(halvingCount).to.equal(1n);

  const currentMonthlyCapAfter = await token.currentMonthlyCap();
  expect(currentMonthlyCapAfter).to.equal(currentMonthlyCapBefore / 2n);

  const distributedAfter = await token.distributedTotal();
  expect(distributedAfter).to.be.gte(firstThreshold);
});

    it("Should correctly calculate remaining until next halving", async function () {
      const { token } = await loadFixture(deployGemStepFixture);
      const [, , remaining] = await token.getHalvingInfo();
      const distributed = await token.distributedTotal();
      const threshold =
        (await token.cap()) - ((await token.cap()) >> ((await token.halvingCount()) + 1n));
      expect(remaining).to.equal(threshold > distributed ? threshold - distributed : 0n);
    });
  });

  describe("Batch Operations", function () {
    it("Should allow batch source additions", async function () {
      const { token, admin } = await loadFixture(deployGemStepFixture);
      const sources = ["source1", "source2", "source3"];
      await token.connect(admin).batchAddSources(sources);
      for (const source of sources) {
        expect(await token.isSourceValid(source)).to.be.true; // view getter
      }
    });

    it("Should allow batch signer management", async function () {
      const { token, admin, user1, user2 } = await loadFixture(deployGemStepFixture);
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
      const { token, tokenErr, admin, deployer } = await loadFixture(deployGemStepFixture);

      const tokenAddress = await token.getAddress();
      const targetAmount = ethers.parseEther("100");
      const sendAmount = ethers.parseEther("101.010101010101010101"); // ~1% fee

      const adminBalance = await token.balanceOf(admin.address);
      if (adminBalance < sendAmount) {
        await token.connect(deployer).transfer(admin.address, sendAmount);
      }

      const initialContractBalance = await token.balanceOf(tokenAddress);
      await token.connect(admin).transfer(tokenAddress, sendAmount);
      const receivedAmount = (await token.balanceOf(tokenAddress)) - initialContractBalance;

      expect(receivedAmount).to.be.closeTo(targetAmount, ethers.parseEther("0.01"));

      await token.connect(admin).toggleEmergencyWithdraw(true);
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

      expect(await token.balanceOf(tokenAddress)).to.equal(0n);
    });

    it("Should reject unauthorized emergency withdrawals", async function () {
      const { token, admin, user1 } = await loadFixture(deployGemStepFixture);

      const tokenAddress = await token.getAddress();
      await token.connect(admin).transfer(tokenAddress, ethers.parseEther("1"));

      await token.connect(admin).toggleEmergencyWithdraw(true);
      await increaseTime(Number(await token.EMERGENCY_DELAY()));

      await expect(token.connect(user1).emergencyWithdraw(parseEther("1"))).to.be.reverted;
    });
  });

  describe("Version Management", function () {
  // roll month so any monthly limits don’t interfere
  beforeEach(async function () {
    const { token, admin } = await loadFixture(deployGemStepFixture);
    await time.increase(Number(await token.SECONDS_PER_MONTH()));
    await token.connect(admin).forceMonthUpdate();
  });

  // helpers to work across legacy/modern APIs
  async function addPayloadVersion(token, admin, v) {
    if (token.addSupportedPayloadVersion) {
      await token.connect(admin).addSupportedPayloadVersion(v);
    } else if (token.addSupportedVersion) {
      // legacy name in older builds points to payload allowlist
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
    // last-ditch legacy fallback (older single-mapping builds)
    return token.supportedAttestationVersions(vHash);
  }

  it("Should reject unsupported payload versions", async function () {
    const { token, tokenErr, user1 } = await loadFixture(deployGemStepFixture);

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
      token, user1.address, user1.address, steps, nonce, deadline,
      chainId, "test-noproof", unsupported, user1
    );

    await expectRevert(
      token.connect(user1).logSteps(
        { user: user1.address, beneficiary: user1.address, steps, nonce, deadline, source: "test-noproof", version: unsupported },
        { signature: sig, proof: [], attestation: "0x" }
      ),
      tokenErr,
      "UnsupportedVersion",
      "Unsupported payload version"
    );
  });

  it("Should allow admin to add new payload versions", async function () {
    const { token, admin } = await loadFixture(deployGemStepFixture);

    const v = "2.0";
    const h = ethers.id(v);

    expect(await isPayloadSupported(token, h)).to.be.false;

    await addPayloadVersion(token, admin, v);

    expect(await isPayloadSupported(token, h)).to.be.true;
  });
});

  describe("Anomaly Detection", function () {
    it("Should trigger fraud prevention for anomalous submissions", async function () {
      const { token, user1, admin } = await loadFixture(deployGemStepFixture);

      const src = "test-noproof";
      const minInterval = BigInt((await token.MIN_SUBMISSION_INTERVAL()).toString());
      const grace = BigInt((await token.GRACE_PERIOD()).toString());
      const stakePerStep = BigInt((await token.currentStakePerStep()).toString());
      const penaltyPct = BigInt((await token.PENALTY_PERCENT()).toString());
      const stepLimitBN = BigInt((await token.stepLimit()).toString());
      const maxPerDayBN = BigInt((await token.MAX_STEPS_PER_DAY()).toString());

      const warm = 100n;
      await token.connect(admin).configureSource(src, false, false);

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

      // use view getter for daily stats
      const [, dailySoFarRaw] = await token.getUserSourceStats(user1.address, src);
      const dailySoFar = BigInt(dailySoFarRaw.toString());

      const dayLeft = maxPerDayBN > dailySoFar ? maxPerDayBN - dailySoFar : 0n;
      const stepsNow = spike <= stepLimitBN ? (spike <= dayLeft ? spike : dayLeft) : stepLimitBN;

      const estPenalty = (stepsNow * stakePerStep * penaltyPct) / 100n;
      const need = stepsNow * stakePerStep + estPenalty;
      const headroom = (need * 20n) / 100n;

      // stake balance via view bundle
      const [, , , stakedWeiRaw] = await token.getUserCoreStatus(user1.address);
      const stakedWei = BigInt(stakedWeiRaw.toString());
      if (stakedWei < need + headroom) {
        await token.connect(user1).stake({ value: need + headroom - stakedWei });
      }

      await time.increase(Number(minInterval) + 2);

      // flags & stake via view bundle
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
        const { token, tokenErr, admin, user1 } = await loadFixture(deployGemStepFixture);
        const signers = await ethers.getSigners();

        const apiSigner = signers[3];
        const API_SIGNER_ROLE = await token.API_SIGNER_ROLE();
        await token.connect(admin).grantRole(API_SIGNER_ROLE, apiSigner.address);
        await token.connect(admin).setTrustedAPI(apiSigner.address, true);

        expect(await token.hasRole(API_SIGNER_ROLE, apiSigner.address)).to.be.true;

        // isTrustedAPI via view bundle
        {
          const [, , , , apiTrusted] = await token.getUserCoreStatus(apiSigner.address);
          expect(apiTrusted).to.be.true;
        }

        const unauthorizedCaller = (await ethers.getSigners())[9];

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

// ✅ NEW: wait out min interval before API submit on same (user, source)
await bumpMinInterval(token, "test-noproof", 2);

await expect(
  submitSteps(token, user1, 100n, {
    beneficiary: user1.address,
    signer: (await ethers.getSigners())[3],
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
    const ctx = await loadFixture(deployGemStepFixture);
    const { token, admin } = ctx;

    async function refreshOracle(oracle, priceEthString) {
  const { timestamp } = await ethers.provider.getBlock("latest");
  await oracle.set(ethers.parseEther(priceEthString), timestamp, 0); // priceWei, updatedAt, confBps
}

    const Mock = await ethers.getContractFactory("MockOracleV2");
const mock = await Mock.deploy();                       // no args
await mock.waitForDeployment();

await mock.set(ethers.parseEther("0.0005"), (await time.latest()), 0); // price, ts, confBps
await mock.setPolicy(300, 100);                                       // staleness, minConfBps

await token.connect(admin).setPriceOracle(await mock.getAddress());

    const tokenErr = await mkErrorDecoderAt(token);
    return { ...ctx, mock, tokenErr };
  }

  it("sets oracle and adjusts stake within bounds", async function () {
  const { token, tokenErr, admin, mock } = await withMockOracle();

  const MIN = await token.MIN_STAKE_PER_STEP();
  const MAX = await token.MAX_STAKE_PER_STEP();
  const cooldown = await token.STAKE_ADJUST_COOLDOWN(); // bigint

  // helper to keep oracle price fresh (maxStaleness=300s)
  const refresh = async (priceEth) => {
    const { timestamp } = await ethers.provider.getBlock("latest");
    await mock.set(ethers.parseEther(priceEth), timestamp, 0); // priceWei, updatedAt, confBps
  };

  // first adjust: 1 GSTEP = 0.0005 ETH → target 10% = 0.00005 ETH
  await time.increase(cooldown + 1n);
  await refresh("0.0005");
  await expect(token.connect(admin).adjustStakeRequirements())
    .to.emit(token, "StakeParametersUpdated");
  expect(await token.currentStakePerStep()).to.equal(ethers.parseEther("0.00005"));

  // cooldown enforced
  await expectRevert(
    token.connect(admin).adjustStakeRequirements(),
    tokenErr,
    "CooldownActive",
    "Cooldown active"
  );

  // below MIN path
  await time.increase(cooldown + 1n);
  await refresh("0.0000005"); // 5e-7 ETH/GSTEP → 10% below MIN
  await expect(token.connect(admin).adjustStakeRequirements())
    .to.emit(token, "StakeParametersUpdated");
  expect(await token.currentStakePerStep()).to.equal(MIN);

  // above MAX path
  await time.increase(cooldown + 1n);
  await refresh("0.02"); // 0.02 ETH/GSTEP → 10% above MAX
  await expect(token.connect(admin).adjustStakeRequirements())
    .to.emit(token, "StakeParametersUpdated");
  expect(await token.currentStakePerStep()).to.equal(MAX);
});

  it("respects emergency lock and manual override", async function () {
    const { token, tokenErr, admin } = await withMockOracle();

    await token.connect(admin).toggleStakeParamLock(); // lock ON
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

    await token.connect(admin).toggleStakeParamLock(); // lock OFF
    expect(await token.stakeParamsLocked()).to.equal(false);

    await expect(
      token.connect(admin).manualOverrideStake(ethers.parseEther("0.0002"))
    ).to.emit(token, "StakeParametersUpdated");

    expect(await token.currentStakePerStep()).to.equal(ethers.parseEther("0.0002"));

    await expectRevert(
      token.connect(admin).manualOverrideStake(ethers.parseEther("0.01")),
      tokenErr,
      "StakeOutOfBounds",
      "Stake out of bounds"
    );
  });

  it("only PARAMETER_ADMIN_ROLE can adjust stake requirements; only DEFAULT_ADMIN_ROLE can set oracle", async function () {
  const { token, tokenErr, admin, user1 } = await loadFixture(deployGemStepFixture);

  // --- deploy & seed oracle ---
  const Mock = await ethers.getContractFactory("MockOracleV2");
  const mock = await Mock.deploy(); // no args
  await mock.waitForDeployment();

  // helper to keep oracle fresh (maxStaleness = 300s)
  const refresh = async (priceEth) => {
    const { timestamp } = await ethers.provider.getBlock("latest");
    await mock.set(ethers.parseEther(priceEth), timestamp, 0); // priceWei, updatedAt, confBps
  };

  await refresh("0.001");         // 1 GSTEP = 0.001 ETH
  await mock.setPolicy(300, 100); // staleSec, minConfBps

  // --- only DEFAULT_ADMIN can set oracle ---
  const DEFAULT_ADMIN_ROLE = await token.DEFAULT_ADMIN_ROLE();
  await expect(token.connect(user1).setPriceOracle(await mock.getAddress()))
    .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount")
    .withArgs(user1.address, DEFAULT_ADMIN_ROLE);

  await expect(token.connect(admin).setPriceOracle(await mock.getAddress()))
    .to.emit(token, "OracleUpdated");

  // --- PARAMETER_ADMIN required for adjust ---
  const PARAMETER_ADMIN_ROLE = await token.PARAMETER_ADMIN_ROLE();
  expect(await token.hasRole(PARAMETER_ADMIN_ROLE, admin.address)).to.equal(true);

  const cooldown = await token.STAKE_ADJUST_COOLDOWN(); // bigint

  // non-admin adjust forbidden
  await expect(token.connect(user1).adjustStakeRequirements())
    .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount")
    .withArgs(user1.address, PARAMETER_ADMIN_ROLE);

  // wait out cooldown, refresh oracle, then adjust
  await time.increase(cooldown + 1n);
  await refresh("0.001");

  await expect(token.connect(admin).adjustStakeRequirements())
    .to.emit(token, "StakeParametersUpdated");
});
});
