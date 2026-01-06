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

/* ---------- Helper: refresh mock oracle timestamp (keeps maxStaleness = 300s) ---------- */
async function refreshOracle(oracle, priceEthString) {
  const { timestamp } = await ethers.provider.getBlock("latest");
  await oracle.set(ethers.parseEther(priceEthString), timestamp, 0); // priceWei, updatedAt, confBps
}

/* ---------- Deploy fixture (MockOracleV2, staleness = 300s) ---------- */
async function deployProxyFixture() {
  const [deployer, admin, user, beneficiary, api, other] = await ethers.getSigners();

  // Mock oracle: 1 GST = 0.005 ETH -> target stake = 10% = 0.0005 ETH
  const Mock = await ethers.getContractFactory("MockOracleV2");
  const oracle = await Mock.deploy(); // no constructor args
  await oracle.waitForDeployment();

  // seed oracle with price/freshness (updatedAt = current block)
  await refreshOracle(oracle, "0.005");
  await oracle.setPolicy(300, 100); // maxStaleness=300s, minConfidenceBps=±1%

  // IMPORTANT: fully qualified to avoid HH701 (duplicate names)
  const Token = await ethers.getContractFactory("contracts/GemStepToken.sol:GemStepToken");
  const initialSupply = ethers.parseUnits("40000000", 18);

  const token = await upgrades.deployProxy(
    Token,
    [initialSupply, await admin.getAddress(), await oracle.getAddress()],
    { initializer: "initialize" }
  );
  await token.waitForDeployment();

  const chainId = (await ethers.provider.getNetwork()).chainId;

  // Ensure PARAMETER_ADMIN for configuring sources, etc. (in case not set by initialize)
  const PARAMETER_ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("PARAMETER_ADMIN"));
  if (!(await token.hasRole(PARAMETER_ADMIN_ROLE, admin.address))) {
    await token.grantRole(PARAMETER_ADMIN_ROLE, admin.address);
  }

  // sanity
  expect(await token.isSourceValid("applehealth")).to.equal(true);

  return { token, oracle, deployer, admin, user, beneficiary, api, other, chainId };
}

/* =======================================================================
   Core suite
======================================================================= */
describe("GemStepToken — Proxy + Upgrade + Staking", function () {
  it("initializes behind proxy and mints initial supply to deployer", async function () {
    const { token, deployer } = await loadFixture(deployProxyFixture);
    const ts = await token.totalSupply();
    const balDeployer = await token.balanceOf(await deployer.getAddress());
    expect(balDeployer).to.equal(ts);
  });

  it("requires sufficient stake for user submissions and mints rewards", async function () {
    const { token, user, beneficiary, chainId } = await loadFixture(deployProxyFixture);

    const source = "applehealth";
    const steps = 100n;
    const nonce = await token.nonces(user.address);
    const deadline = (await time.latest()) + 3600;

    const stakePerStep = await token.currentStakePerStep();
    await token.connect(user).stake({ value: stakePerStep * steps });

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
    ).to.emit(token, "RewardClaimed");

    const rewardRate = await token.rewardRate();
    const expected = rewardRate * steps;
    expect(await token.balanceOf(beneficiary.address)).to.equal(expected);
  });

  it("reverts when user stake is insufficient", async function () {
    const { token, user, beneficiary, chainId } = await loadFixture(deployProxyFixture);

    const source = "applehealth";
    const steps = 1000n;
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
    const steps = 5000n;
    const nonce = await token.nonces(user.address);
    const deadline = (await time.latest()) + 3600;

    // deployer has API_SIGNER_ROLE by initialize()
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

    // advance past cooldown
    const cooldown = await token.STAKE_ADJUST_COOLDOWN(); // bigint (ethers v6)
    await time.increase(cooldown + 1n);

    // refresh oracle each time to keep updatedAt within 300s
    await refreshOracle(oracle, "0.005");
    await expect(token.connect(admin).adjustStakeRequirements())
      .to.emit(token, "StakeParametersUpdated");

    // target stake = 10% of 0.005 ETH = 0.0005 ETH
    expect(await token.currentStakePerStep()).to.equal(ethers.parseEther("0.0005"));

    await expect(token.connect(admin).adjustStakeRequirements())
      .to.be.revertedWith("Cooldown active");

    // lower oracle price -> clamp to MIN_STAKE_PER_STEP if below min
    await time.increase(cooldown + 1n);
    await refreshOracle(oracle, "0.0000005"); // 5e-7 ETH/GST
    await expect(token.connect(admin).adjustStakeRequirements())
      .to.emit(token, "StakeParametersUpdated");
    expect(await token.currentStakePerStep()).to.equal(ethers.parseEther("0.0000001"));

    // manual override by deployer (assumes deployer has permission in your contract)
    await expect(token.connect(deployer).manualOverrideStake(ethers.parseEther("0.0002")))
      .to.emit(token, "StakeParametersUpdated");
    expect(await token.currentStakePerStep()).to.equal(ethers.parseEther("0.0002"));

    // lock, then verify adjustments are blocked
    await expect(token.connect(deployer).toggleStakeParamLock())
      .to.emit(token, "StakeEmergencyLocked");
    expect(await token.stakeParamsLocked()).to.equal(true);

    await time.increase(cooldown + 1n);
    await refreshOracle(oracle, "0.005");
    await expect(token.connect(admin).adjustStakeRequirements())
      .to.be.revertedWith("Stake parameters locked");
    await expect(token.connect(deployer).manualOverrideStake(ethers.parseEther("0.0003")))
      .to.be.revertedWith("Stake parameters locked");

    // unlock and override again
    await token.connect(deployer).toggleStakeParamLock();
    await token.connect(deployer).manualOverrideStake(ethers.parseEther("0.0003"));
    expect(await token.currentStakePerStep()).to.equal(ethers.parseEther("0.0003"));
  });

  // ---------- Stale nonce / signature reuse ----------
  it("rejects stale nonce (cannot reuse a prior signature after nonce increments)", async function () {
    const { token, user, beneficiary, chainId } = await loadFixture(deployProxyFixture);

    const source = "applehealth";
    const steps = 10n;
    const stakePerStep = await token.currentStakePerStep();
    await token.connect(user).stake({ value: steps * stakePerStep });

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

  it("upgrades to V2, runs initializeV2, and preserves storage layout", async function () {
    const { token } = await loadFixture(deployProxyFixture);
    const V2 = await ethers.getContractFactory("GemStepTokenV2Mock");

    const v2 = await upgrades.upgradeProxy(await token.getAddress(), V2);
    await v2.waitForDeployment();

    await expect(v2.initializeV2()).to.emit(v2, "VersionUpgraded").withArgs(2);
    expect(await v2.version()).to.equal(2);
    expect(await v2.verifyStorage()).to.equal(true);
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
    const { token, admin, user, beneficiary } = await loadFixture(deployProxyFixture);

    const source = "susp-src";
    await token.connect(admin).configureSource(source, false, false);

    const minInterval  = await token.MIN_SUBMISSION_INTERVAL();
    const GRACE        = await token.GRACE_PERIOD();
    const SUSP         = await token.SUSPENSION_DURATION();
    const stakePerStep = await token.currentStakePerStep();
    const PENALTY_PCT  = await token.PENALTY_PERCENT();

    // Keep under daily cap: 100 + 3000 + 3000 + 3100 = 9,200 < 10,000
    const seedSteps = 100n;
    const spikes = [3000n, 3000n, 3100n];

    // Prefund stake for seed + spikes + estimated penalties + headroom
    let buffer = seedSteps * stakePerStep;
    for (const s of spikes) {
      const principal = s * stakePerStep;
      const penalty   = (principal * BigInt(PENALTY_PCT)) / 100n;
      buffer += principal + penalty;
    }
    buffer += ethers.parseEther("0.02");
    await token.connect(user).stake({ value: buffer });

    // Seed average
    {
      const nonce = await token.nonces(user.address);
      const deadline = (await time.latest()) + 3600;
      const sig = await signStepData({
        signer: user,
        verifyingContract: await token.getAddress(),
        chainId: (await ethers.provider.getNetwork()).chainId,
        user: user.address,
        beneficiary: beneficiary.address,
        steps: seedSteps,
        nonce,
        deadline,
        source,
        version: "1.0.0",
      });
      await token.connect(user).logSteps(
        { user: user.address, beneficiary: beneficiary.address, steps: seedSteps, nonce, deadline, source, version: "1.0.0" },
        { signature: sig, proof: [], attestation: "0x" }
      );
    }

    // Leave grace
    await time.increase(Number(GRACE) + 2);

    // 3 anomalies (each spaced by minInterval)
    for (let i = 0; i < spikes.length; i++) {
      await time.increase(Number(minInterval) + 1);
      const nonce = await token.nonces(user.address);
      const deadline = (await time.latest()) + 3600;
      const sig = await signStepData({
        signer: user,
        verifyingContract: await token.getAddress(),
        chainId: (await ethers.provider.getNetwork()).chainId,
        user: user.address,
        beneficiary: beneficiary.address,
        steps: spikes[i],
        nonce,
        deadline,
        source,
        version: "1.0.0",
      });
      const tx = await token.connect(user).logSteps(
        { user: user.address, beneficiary: beneficiary.address, steps: spikes[i], nonce, deadline, source, version: "1.0.0" },
        { signature: sig, proof: [], attestation: "0x" }
      );
      await expect(tx).to.emit(token, "PenaltyApplied");
      await tx.wait();
    }

    // Confirm suspended
    {
      const [,, until,,,] = await token.getUserCoreStatus(user.address);
      const now = await time.latest();
      expect(until).to.be.gt(now);
    }

    // During suspension: must fail
    await time.increase(Number(minInterval) + 1);
    {
      const nonce = await token.nonces(user.address);
      const deadline = (await time.latest()) + 3600;
      const sig = await signStepData({
        signer: user,
        verifyingContract: await token.getAddress(),
        chainId: (await ethers.provider.getNetwork()).chainId,
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

    // Hard jump to authoritative suspendedUntil + cushion
    {
      const [,, until,,,] = await token.getUserCoreStatus(user.address);
      const target = until + 600n;
      await time.setNextBlockTimestamp(Number(target));
      await ethers.provider.send("evm_mine", []);
      await time.setNextBlockTimestamp(Number(target + 2n));
      await ethers.provider.send("evm_mine", []);

      const now = await time.latest();
      const [,, until2,,,] = await token.getUserCoreStatus(user.address);
      expect(now).to.be.gte(until2);

      expect(now).to.be.gte(until);
      expect(Number(SUSP)).to.be.greaterThan(0);
    }

    // respect per-source min interval
    await time.increase(Number(minInterval) + 1);

    // Submit a small, non-anomalous payload (ensure stake exists)
    const postSteps = 200n;
    await token.connect(user).stake({ value: postSteps * stakePerStep });

    const okNonce = await token.nonces(user.address);
    const okDeadline = (await time.latest()) + 3600;
    const okSig = await signStepData({
      signer: user,
      verifyingContract: await token.getAddress(),
      chainId: (await ethers.provider.getNetwork()).chainId,
      user: user.address,
      beneficiary: beneficiary.address,
      steps: postSteps,
      nonce: okNonce,
      deadline: okDeadline,
      source,
      version: "1.0.0",
    });

    await expect(
      token.connect(user).logSteps(
        { user: user.address, beneficiary: beneficiary.address, steps: postSteps, nonce: okNonce, deadline: okDeadline, source, version: "1.0.0" },
        { signature: okSig, proof: [], attestation: "0x" }
      )
    ).to.emit(token, "RewardClaimed");
  });
});

/* =======================================================================
   Month rollover
======================================================================= */
describe("Month rollover edge", function () {
  it("resets currentMonthMinted after rollover", async function () {
    const { token, user, beneficiary, admin } = await loadFixture(deployProxyFixture);
    const [deployer] = await ethers.getSigners();
    await token.connect(deployer).grantRole(await token.DEFAULT_ADMIN_ROLE(), admin.address);

    const source = "rollover-src";
    await token.connect(admin).configureSource(source, false, false);

    const steps = 50n;
    const stakePerStep = await token.currentStakePerStep();
    await token.connect(user).stake({ value: steps * stakePerStep });

    const n1 = await token.nonces(user.address);
    const d1 = (await time.latest()) + 3600;
    const s1 = await signStepData({
      signer: user,
      verifyingContract: await token.getAddress(),
      chainId: (await ethers.provider.getNetwork()).chainId,
      user: user.address,
      beneficiary: beneficiary.address,
      steps,
      nonce: n1,
      deadline: d1,
      source,
      version: "1.0.0",
    });

    await token.connect(user).logSteps(
      { user: user.address, beneficiary: beneficiary.address, steps, nonce: n1, deadline: d1, source, version: "1.0.0" },
      { signature: s1, proof: [], attestation: "0x" }
    );

    expect(await token.currentMonthMinted()).to.be.gt(0n);

    await time.increase(30 * 24 * 60 * 60 + 10);
    await token.connect(admin).forceMonthUpdate();
    expect(await token.currentMonthMinted()).to.equal(0n);

    // next submission
    const stakePerStep2 = await token.currentStakePerStep();
    await token.connect(user).stake({ value: steps * stakePerStep2 });

    const n2 = await token.nonces(user.address);
    const d2 = (await time.latest()) + 3600;
    const s2 = await signStepData({
      signer: user,
      verifyingContract: await token.getAddress(),
      chainId: (await ethers.provider.getNetwork()).chainId,
      user: user.address,
      beneficiary: beneficiary.address,
      steps,
      nonce: n2,
      deadline: d2,
      source,
      version: "1.0.0",
    });

    await expect(
      token.connect(user).logSteps(
        { user: user.address, beneficiary: beneficiary.address, steps, nonce: n2, deadline: d2, source, version: "1.0.0" },
        { signature: s2, proof: [], attestation: "0x" }
      )
    ).to.emit(token, "RewardClaimed");
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
    const { token, admin, user, beneficiary } = await loadFixture(deployProxyFixture);

    const source = "merkle-src";
    await token.connect(admin).configureSource(source, true, false);

    const steps = 123n;
    const leaf = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "uint256"],
        [user.address, steps, 0]
      )
    );
    const leaf2 = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "uint256"],
        [beneficiary.address, 999, 0]
      )
    );

    const { root, layers } = buildMerkle([leaf, leaf2]);
    const proof = getProof(0, layers);
    await token.connect(admin).setSourceMerkleRoot(source, root);

    const stakePerStep = await token.currentStakePerStep();
    await token.connect(user).stake({ value: steps * stakePerStep });

    const nonce = await token.nonces(user.address);
    const deadline = (await time.latest()) + 3600;
    const sig = await signStepData({
      signer: user,
      verifyingContract: await token.getAddress(),
      chainId: (await ethers.provider.getNetwork()).chainId,
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
        { signature: sig, proof, attestation: "0x" }
      )
    ).to.emit(token, "RewardClaimed");
  });

  it("rejects an invalid Merkle proof", async function () {
    const { token, admin, user, beneficiary } = await loadFixture(deployProxyFixture);

    const source = "merkle-src-invalid";
    await token.connect(admin).configureSource(source, true, false);

    const steps = 222n;
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

    const stakePerStep = await token.currentStakePerStep();
    await token.connect(user).stake({ value: steps * stakePerStep });

    const nonce = await token.nonces(user.address);
    const deadline = (await time.latest()) + 3600;
    const sig = await signStepData({
      signer: user,
      verifyingContract: await token.getAddress(),
      chainId: (await ethers.provider.getNetwork()).chainId,
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
    const { token, admin, user, beneficiary } = await loadFixture(deployProxyFixture);

    const source = "merkle-src-toolong";
    await token.connect(admin).configureSource(source, true, false);
    await token.connect(admin).setSourceMerkleRoot(source, ethers.ZeroHash);

    const tooLong = Array.from({ length: 33 }, (_, i) =>
      ethers.keccak256(ethers.toUtf8Bytes("node-" + i))
    );

    const steps = 10n;
    const stakePerStep = await token.currentStakePerStep();
    await token.connect(user).stake({ value: steps * stakePerStep });

    const nonce = await token.nonces(user.address);
    const deadline = (await time.latest()) + 3600;
    const sig = await signStepData({
      signer: user,
      verifyingContract: await token.getAddress(),
      chainId: (await ethers.provider.getNetwork()).chainId,
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
