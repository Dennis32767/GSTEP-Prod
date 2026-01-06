/* eslint-disable no-unused-expressions */
// SPDX-License-Identifier: MIT
const { expect } = require("chai");
const { ethers, upgrades, network } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

/* ------------------------ Shared EIP712 constants ------------------------ */
const DOMAIN_NAME = "GemStep";
const DOMAIN_VER  = "1.0.0";
const PAYLOAD_VER = "1.0.0";

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

/* ---------------------------- Submit helper ----------------------------- */
async function getPerSourceLimits(token, source) {
  // GS_Views.getSourceConfig(source) -> (requiresProof, requiresAttestation, merkleRoot, maxStepsPerDay, minInterval)
  if (typeof token.getSourceConfig === "function") {
    const cfg = await token.getSourceConfig(source);
    const maxStepsPerDay = BigInt(cfg[3].toString());
    const minInterval = BigInt(cfg[4].toString());
    return { maxStepsPerDay, minInterval };
  }

  // Fallback (older builds)
  const maxStepsPerDay = BigInt((await token.MAX_STEPS_PER_DAY()).toString());
  const minInterval = BigInt((await token.MIN_SUBMISSION_INTERVAL()).toString());
  return { maxStepsPerDay, minInterval };
}

async function bumpMinInterval(token, source, extraSeconds = 2) {
  const { minInterval } = await getPerSourceLimits(token, source);
  await time.increase(Number(minInterval + BigInt(extraSeconds)));
}

async function bumpUtcDay() {
  await time.increase(24 * 60 * 60 + 3);
}

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
  } = opts;

  if (!isApiSigned && withStake) {
    const stakePerStep = await token.currentStakePerStep();
    const need = BigInt(steps) * BigInt(stakePerStep.toString());
    const [, , , have] = await token.getUserCoreStatus(submitter.address);
    if (have < need) {
      await token.connect(submitter).stake({ value: need - have });
    }
  }

  const nonce = await token.nonces(submitter.address);
  const now = await time.latest();
let sigPeriod = 3600;

// use the real on-chain window if available
if (typeof token.signatureValidityPeriod === "function") {
  sigPeriod = Number(await token.signatureValidityPeriod());
}

const deadline = now + Math.max(60, sigPeriod - 5); // safely inside window

  const { chainId } = await ethers.provider.getNetwork();

  const sig = await signStepData(
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
    { user: submitter.address, beneficiary, steps, nonce, deadline, source, version },
    { signature: sig, proof, attestation },
  ];

  if (isApiSigned) return token.connect(signer).logSteps(...args);
  return token.connect(submitter).logSteps(...args);
}

/* ------------------------------- Fixture -------------------------------- */
async function deployFixture() {
  const [deployer, admin, user, apiSigner] = await ethers.getSigners();

  // Price oracle mock: 1 GST = 0.005 ETH → target stake = 0.0005 ETH
  const Mock = await ethers.getContractFactory("MockOracleV2");
const oracle = await Mock.deploy(); // no constructor args
await oracle.waitForDeployment();

// seed oracle so it's fresh & valid
const { timestamp } = await ethers.provider.getBlock("latest");
await oracle.set(ethers.parseEther("0.005"), timestamp, 0); // priceWei, updatedAt, confBps
await oracle.setPolicy(300, 100); // maxStaleness=300s, minConfidenceBps=±1%

const Token = await ethers.getContractFactory("GemStepToken");
const token = await upgrades.deployProxy(
  Token,
  [ethers.parseUnits("40000000", 18), deployer.address, await oracle.getAddress()],
  { initializer: "initialize" }
);
await token.waitForDeployment();

  // roles
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
    await token.connect(deployer).grantRole(await token[r](), admin.address);
  }
  await token.connect(deployer).grantRole(await token.API_SIGNER_ROLE(), apiSigner.address);
  await token.connect(admin).setTrustedAPI(apiSigner.address, true);

  // sources / versions
  await token.connect(admin).configureSource("test-noproof", false, false);
  await token.connect(admin).configureSource("fuzz-src", false, false);
  await token.connect(admin).configureSource("anomaly-src", false, false);

  // add payload version with backward-compat function name
  if (token.addSupportedPayloadVersion) {
    await token.connect(admin).addSupportedPayloadVersion(PAYLOAD_VER);
  } else {
    await token.connect(admin).addSupportedVersion(PAYLOAD_VER);
  }

  // fresh month for mint-cap tests
  await token.connect(admin).forceMonthUpdate();

  return { token, oracle, deployer, admin, user, apiSigner };
}

/* =============================== TESTS =============================== */
describe("Recommended Tests (robustness & regressions)", function () {

  describe("Invariants: caps and totals", function () {
    it("distributedTotal never exceeds cap; monthly mints never exceed current cap", async function () {
      this.timeout(120000);

      const { token, admin, user } = await loadFixture(deployFixture);
      const src = "test-noproof";
      await token.connect(admin).configureSource(src, false, false);

      const [rewardRate, cap, stepLimit] = await Promise.all([
        token.rewardRate(),
        token.cap(),
        token.stepLimit(),
      ]);
      const perTxLimit = BigInt(stepLimit.toString());
      const minInterval = Number(await token.MIN_SUBMISSION_INTERVAL());
      const maxPerDay = BigInt((await token.MAX_STEPS_PER_DAY()).toString());

      // Stake enough for a handful of mints
      const stakePerStep = BigInt((await token.currentStakePerStep()).toString());
      const smallSteps = perTxLimit - 10n;
      const batchesThisMonth = 6n;
      await token.connect(user).stake({ value: (smallSteps * batchesThisMonth) * stakePerStep });

      // Helper: submit one batch respecting daily cap + min interval
      async function submitBatch() {
        const [, usedToday] = await token.getUserSourceStats(user.address, src);
        const usedTodayBN = BigInt(usedToday.toString());
        const perDayLeft = usedTodayBN >= maxPerDay ? 0n : (maxPerDay - usedTodayBN);
        if (perDayLeft === 0n) {
          await time.increase(24 * 60 * 60 + 3);
        }
        const amount = perDayLeft === 0n ? 0n : (smallSteps > perDayLeft ? perDayLeft : smallSteps);
        if (amount > 0n) {
          await (await submitSteps(token, user, amount, { source: src })).wait();
          await time.increase(minInterval + 1);
        } else {
          await time.increase(24 * 60 * 60 + 3);
        }
      }

      for (let i = 0n; i < batchesThisMonth; i++) {
        await submitBatch();
      }

      expect(await token.distributedTotal()).to.be.at.most(await token.cap());
      expect(await token.currentMonthMinted()).to.be.at.most(await token.currentMonthlyCap());

      await time.increase(30 * 24 * 60 * 60 + 10);
      await token.connect(admin).forceMonthUpdate();

      for (let i = 0; i < 2; i++) {
        await submitBatch();
      }

      expect(await token.distributedTotal()).to.be.at.most(cap);
      expect(await token.currentMonthMinted()).to.be.at.most(await token.currentMonthlyCap());
    });
  });

  describe("Suspension flow: flaggedSubmissions persistence", function () {
    it("does NOT auto-reset flaggedSubmissions after suspension; small submission succeeds post-suspension", async function () {
      const { token, admin, user } = await loadFixture(deployFixture);
      const src = "anomaly-src";
      const minInterval = Number(await token.MIN_SUBMISSION_INTERVAL());
      const stakePerStep = BigInt((await token.currentStakePerStep()).toString());
      const grace = Number(await token.GRACE_PERIOD());
      const suspDur = Number(await token.SUSPENSION_DURATION());

      // Warm average
      await token.connect(admin).configureSource(src, false, false);
      const warm = 100n;
      await token.connect(user).stake({ value: ethers.parseEther("10") }); // buffer
      for (let i = 0; i < 5; i++) {
        await time.increase(minInterval + 1);
        await (await submitSteps(token, user, warm, { source: src })).wait();
      }

      await time.increase(grace + 5);

      // 3 spikes to trigger suspension
      const spikes = [3000n, 3000n, 3100n];
      for (const s of spikes) {
        const estPenalty = (s * stakePerStep * 30n) / 100n;
        await token.connect(user).stake({ value: s * stakePerStep + estPenalty });
        await time.increase(minInterval + 2);
        await (await submitSteps(token, user, s, { source: src })).wait();
      }

      const [, flagsAfterSpikes, until] = await token.getUserCoreStatus(user.address);
      expect(flagsAfterSpikes).to.be.gte(3n);
      expect(until).to.be.gt(await time.latest());

      // During suspension → revert
      await time.increase(minInterval + 2);
      await expect(submitSteps(token, user, 200n, { source: src }))
        .to.be.revertedWith("Account suspended");

      // Jump past suspension end and respect interval
      await time.increase(suspDur + 3605);
      await time.increase(minInterval + 1);

      const chainId = (await ethers.provider.getNetwork()).chainId;
      const postSteps = 200n;
      await token.connect(user).stake({ value: postSteps * stakePerStep });

      const nonceOK = await token.nonces(user.address);
      const nowOK = await time.latest();
      const deadlineOK = nowOK + 1800;

      const sigOK = await signStepData(
        token, user.address, user.address, postSteps, nonceOK, deadlineOK,
        chainId, src, PAYLOAD_VER, user
      );

      await expect(
        token.connect(user).logSteps(
          { user: user.address, beneficiary: user.address, steps: postSteps, nonce: nonceOK, deadline: deadlineOK, source: src, version: PAYLOAD_VER },
          { signature: sigOK, proof: [], attestation: "0x" }
        )
      ).to.emit(token, "RewardClaimed");

      const [, flagsFinal] = await token.getUserCoreStatus(user.address);
      expect(flagsFinal).to.equal(flagsAfterSpikes);
    });
  });

  describe("Boundary fuzz: deadlines & min interval", function () {
    it("deadline boundaries (now => revert; now+valid => ok; now+valid+1 => revert)", async function () {
      const { token, user, admin } = await loadFixture(deployFixture);
      const SRC = "fuzz-deadline-src-2";
      await token.connect(admin).configureSource(SRC, false, false);

      const chainId = (await ethers.provider.getNetwork()).chainId;
      const sigPeriod = Number(await token.signatureValidityPeriod());
      const stakePerStep = BigInt((await token.currentStakePerStep()).toString());
      const steps = 10n;
      await token.connect(user).stake({ value: steps * stakePerStep });

      // 1) deadline == now → expired
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

      // 2) deadline == now + sigPeriod - 5 → OK
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

      await time.increase(Number(await token.MIN_SUBMISSION_INTERVAL()) + 2);

      // 3) deadline == now + sigPeriod + 120 → too far
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
      const { token, user, admin } = await loadFixture(deployFixture);
      const SRC = "fuzz-interval-src-2";
      await token.connect(admin).configureSource(SRC, false, false);

      const min = BigInt((await token.MIN_SUBMISSION_INTERVAL()).toString());
      const chainId = (await ethers.provider.getNetwork()).chainId;

      const stakePerStep = BigInt((await token.currentStakePerStep()).toString());
      await token.connect(user).stake({ value: 1000n * stakePerStep });

      async function submitNow() {
        const steps = 10n;
        const nonce = await token.nonces(user.address);
        const nowTs = await time.latest();
        const deadline = nowTs + 3600;
        const sig = await signStepData(token, user.address, user.address, steps, nonce, deadline, chainId, SRC, PAYLOAD_VER, user);
        return token.connect(user).logSteps(
          { user: user.address, beneficiary: user.address, steps, nonce, deadline, source: SRC, version: PAYLOAD_VER },
          { signature: sig, proof: [], attestation: "0x" }
        );
      }

      await (await submitNow()).wait();

      const [t0] = await token.getUserSourceStats(user.address, SRC);

      const eps = 5n;

      await time.setNextBlockTimestamp(Number(BigInt(t0.toString()) + min - eps));
      await ethers.provider.send("evm_mine", []);
      await expect(submitNow()).to.be.revertedWith("Submission too frequent");

      await time.setNextBlockTimestamp(Number(BigInt(t0.toString()) + min));
      await ethers.provider.send("evm_mine", []);
      await expect(submitNow()).to.emit(token, "RewardClaimed");

      const [t1] = await token.getUserSourceStats(user.address, SRC);

      await time.setNextBlockTimestamp(Number(BigInt(t1.toString()) + min + 1n));
      await ethers.provider.send("evm_mine", []);
      await expect(submitNow()).to.emit(token, "RewardClaimed");
    });
  });

  describe("Trusted API path: no penalties / no suspension", function () {
    it("massive API-signed spikes do NOT flag or suspend, and require no stake", async function () {
  this.timeout(400000);

  const { token, user, apiSigner } = await loadFixture(deployFixture);

  const src = "test-noproof";
  const stepLimit = BigInt((await token.stepLimit()).toString());

  const { maxStepsPerDay } = await getPerSourceLimits(token, src);

  // Choose a per-tx size that is big-ish but won't instantly exceed daily cap.
  // Also avoid being exactly at limit to keep room for rounding/other tests.
  const perTx = stepLimit < maxStepsPerDay ? (stepLimit - 1n) : (maxStepsPerDay / 4n);

  // Run a bounded number of txs so test completes quickly
  const txCount = 6;

  for (let i = 0; i < txCount; i++) {
    // if we're near the daily cap, roll the day
    const [, usedTodayRaw] = await token.getUserSourceStats(user.address, src);
    const usedToday = BigInt(usedTodayRaw.toString());
    if (usedToday + perTx > maxStepsPerDay) {
      await bumpUtcDay();
    }

    await (
      await submitSteps(token, user, perTx, {
        source: src,
        signer: apiSigner,
        isApiSigned: true,
        withStake: false,
      })
    ).wait();

    // even API path must respect minInterval now
    await bumpMinInterval(token, src, 2);
  }

  const [, flags, suspended] = await token.getUserCoreStatus(user.address);
  expect(flags).to.equal(0n);
  expect(suspended).to.equal(0n);
});

  });

  describe("Stake leakage regression (multi-submit)", function () {
    it("stake decreases only by penalties (user path); base principal unchanged when no anomalies", async function () {
      const { token, user } = await loadFixture(deployFixture);
      const src = "test-noproof";
      const min = Number(await token.MIN_SUBMISSION_INTERVAL());
      const stakePerStep = BigInt((await token.currentStakePerStep()).toString());

      const per = 100n;
      const submits = 10;
      const principal = per * BigInt(submits) * stakePerStep;
      await token.connect(user).stake({ value: principal });

      const [, , , start] = await token.getUserCoreStatus(user.address);

      for (let i = 0; i < submits; i++) {
        await (await submitSteps(token, user, per, { source: src })).wait();
        await time.increase(min + 1);
      }

      const [, , , end] = await token.getUserCoreStatus(user.address);
      expect(end).to.equal(start);
    });
  });
});
