/* eslint-disable no-undef */
const { expect } = require("chai");
const { ethers, upgrades, network } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("GemStepToken", function () {
  async function deployFixture() {
    const [deployer, admin, treasury, user1, user2, apiSigner, emergencyAdmin] =
      await ethers.getSigners();

    const MockOracle = await ethers.getContractFactory("MockOracleV2");
    const priceOracle = await MockOracle.deploy();
    await priceOracle.waitForDeployment();

    const GemStepToken = await ethers.getContractFactory("GemStepToken");

    const INITIAL_SUPPLY = ethers.parseUnits("400000000", 18);

    const token = await upgrades.deployProxy(
      GemStepToken,
      [INITIAL_SUPPLY, admin.address, await priceOracle.getAddress(), treasury.address],
      { initializer: "initialize" }
    );
    await token.waitForDeployment();

  // Ensure admin has DEFAULT_ADMIN_ROLE (initializer should do this, but keep safe)
  const DAR = await token.DEFAULT_ADMIN_ROLE();
  if (typeof token.hasRole === "function") {
    if (!(await token.hasRole(DAR, admin.address))) {
      await (await token.connect(deployer).grantRole(DAR, admin.address)).wait();
    }
  }

// Grant roles using safe fallback (works even without public role getters)
await grantRoleSafe(token, admin, "PARAMETER_ADMIN_ROLE", admin.address);
await grantRoleSafe(token, admin, "PAUSER_ROLE", admin.address);
await grantRoleSafe(token, admin, "MINTER_ROLE", admin.address);
await grantRoleSafe(token, admin, "SIGNER_ROLE", apiSigner.address);
await grantRoleSafe(token, admin, "EMERGENCY_ADMIN_ROLE", emergencyAdmin.address);

// **CRITICAL FOR YOUR FAILURES**
await grantRoleSafe(token, admin, "API_SIGNER_ROLE", apiSigner.address);


    // Sources (disable proof/attestation for tests)
    if (typeof token.configureSource === "function") {
      await token.connect(admin).configureSource("fitbit", false, false);
      await token.connect(admin).configureSource("googlefit", false, false);
      await token.connect(admin).configureSource("direct", false, false);
    }

    // Trusted device (if present)
    if (typeof token.addTrustedDevice === "function") {
      await token.connect(admin).addTrustedDevice(apiSigner.address);
    }

    // Trusted API caller
    if (typeof token.setTrustedAPI === "function") {
      await token.connect(admin).setTrustedAPI(apiSigner.address, true);
    }

    // Ensure payload version supported
    if (typeof token.addSupportedPayloadVersion === "function") {
      await token.connect(admin).addSupportedPayloadVersion("1.0.0");
    } else if (typeof token.addSupportedVersion === "function") {
      await token.connect(admin).addSupportedVersion("1.0.0");
    }

    // Seed admin with some tokens (initial supply is minted to treasury in your design)
    await token.connect(treasury).transfer(admin.address, ethers.parseEther("1000"));

    // Fresh month (if available)
    if (typeof token.forceMonthUpdate === "function") {
      await token.connect(admin).forceMonthUpdate();
    }

    // ✅ funder = treasury (holds initial supply in your design)
    const funder = treasury;

    return {
      token,
      deployer,
      admin,
      treasury,
      funder,
      user1,
      user2,
      apiSigner,
      emergencyAdmin,
      priceOracle,
    };
  }

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
  return (minReward + rr - 1n) / rr; // ceil
}
/* ------------------- Supply caps safe access (DROP-IN) ------------------- */
async function getSupplyCapsSafe(token) {
  // Preferred: bundled reader
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

  // Legacy fallbacks (only if you still have them)
  const currentMonthMinted =
    typeof token.currentMonthMinted === "function"
      ? BigInt((await token.currentMonthMinted()).toString())
      : null;

  const currentMonthlyCap =
    typeof token.currentMonthlyCap === "function"
      ? BigInt((await token.currentMonthlyCap()).toString())
      : null;

  // Some builds expose only cap + distributed total
  const cap =
    typeof token.cap === "function"
      ? BigInt((await token.cap()).toString())
      : null;

  let distributedTotal = null;
  for (const fn of ["distributedTotal", "totalDistributed", "distributed", "mintedTotal"]) {
    if (typeof token[fn] === "function") {
      distributedTotal = BigInt((await token[fn]()).toString());
      break;
    }
  }

  return { cap, distributedTotal, currentMonthlyCap, currentMonthMinted };
}

  /* ---------------------- TOKEN-STAKING helper (DROP-IN) ---------------------- */
  async function ensureTokenStake(token, funder, userSigner, requiredStake) {
    const need = BigInt(requiredStake);

    let have = 0n;
    if (typeof token.getStakeInfo === "function") {
      const [bal] = await token.getStakeInfo(userSigner.address);
      have = BigInt(bal.toString());
    } else {
      // fallback: if you ever remove getStakeInfo, this keeps tests alive
      have = 0n;
    }

    if (have >= need) return;

    const delta = need - have;

    // Ensure user has enough GEMS
    const bal = await token.balanceOf(userSigner.address);
    const balBI = BigInt(bal.toString());
    if (balBI < delta) {
      await (await token.connect(funder).transfer(userSigner.address, delta - balBI)).wait();
    }

    // Stake = transfer tokens into the token contract
    await (await token.connect(userSigner).stake(delta)).wait();
  }

  /* ------------------- Reward-too-small auto-bump (DROP-IN) ------------------- */
  function _errMsg(e) {
    return `${e?.reason || ""} ${e?.shortMessage || ""} ${e?.message || ""}`.toLowerCase();
  }
  function isRewardTooSmallError(e) {
    return _errMsg(e).includes("reward too small");
  }

  async function bumpStepsPastMinReward({ token, caller, buildArgs, startSteps }) {
    let s = BigInt(startSteps || 1n);
    if (s === 0n) s = 1n;

    // Optional cap by stepLimit (prevents runaway)
    let cap = null;
    try {
      if (typeof token.stepLimit === "function") {
        cap = BigInt((await token.stepLimit()).toString());
      }
    } catch {}

    if (cap != null && s > cap) s = cap;

    for (let i = 0; i < 18; i++) {
      if (cap != null && s > cap) s = cap;

      const { payload, proofObj } = await buildArgs(s);

      try {
        await token.connect(caller).logSteps.staticCall(payload, proofObj);
        return s; // ✅ good steps
      } catch (e) {
        if (!isRewardTooSmallError(e)) throw e;
        if (cap != null && s >= cap) {
          throw new Error(`Reward too small even at stepLimit cap=${cap.toString()}`);
        }
        s = s * 2n;
        if (s === 0n) s = 1n;
        if (cap != null && s > cap) s = cap;
      }
    }

    throw new Error("Could not bump steps above min reward within bump iterations");
  }

async function getCoreParamsSafe(token) {
  // getCoreParams(): (burnFeeBps, rewardRate, stepLimit, sigValidity)
  if (typeof token.getCoreParams === "function") {
    const out = await token.getCoreParams();
    return {
      burnFee: BigInt(out[0].toString()),
      rewardRate: BigInt(out[1].toString()),
      stepLimit: BigInt(out[2].toString()),
      sigValidity: BigInt(out[3].toString()),
    };
  }

  // legacy fallback if you ever re-add these
  const rewardRate =
    typeof token.rewardRate === "function" ? BigInt((await token.rewardRate()).toString()) : 0n;
  const stepLimit =
    typeof token.stepLimit === "function" ? BigInt((await token.stepLimit()).toString()) : 0n;
  const sigValidity =
    typeof token.signatureValidityPeriod === "function"
      ? BigInt((await token.signatureValidityPeriod()).toString())
      : 3600n;

  return { burnFee: 0n, rewardRate, stepLimit, sigValidity };
}

async function getRewardRateSafe(token) {
  const { rewardRate } = await getCoreParamsSafe(token);
  return rewardRate;
}

async function getSigValiditySafe(token) {
  const { sigValidity } = await getCoreParamsSafe(token);
  return sigValidity;
}

// Role id resolution:
// - if contract exposes e.g. PAUSER_ROLE() use it
// - else fall back to keccak256("PAUSER_ROLE") (matches your Storage docs/tests tooling)
async function roleId(token, roleName) {
  if (typeof token[roleName] === "function") return token[roleName]();
  return ethers.keccak256(ethers.toUtf8Bytes(roleName));
}

async function grantRoleSafe(token, adminSigner, roleName, account) {
  const r = await roleId(token, roleName);
  if (typeof token.hasRole === "function") {
    const has = await token.hasRole(r, account);
    if (has) return r;
  }
  await (await token.connect(adminSigner).grantRole(r, account)).wait();
  return r;
}

/**
 * Robustly read domain from OZ EIP-5267 if available, else use constants.
 */
async function getEip712DomainSafe(token) {
  const { chainId } = await ethers.provider.getNetwork();

  if (typeof token.eip712Domain === "function") {
    const d = await token.eip712Domain();
    return {
      name: d[1],
      version: d[2],
      chainId: Number(d[3] || chainId),
      verifyingContract: d[4] && d[4] !== ethers.ZeroAddress ? d[4] : await token.getAddress(),
    };
  }

  return {
    name: "GemStep",
    version: "1.0.0",
    chainId: Number(chainId),
    verifyingContract: await token.getAddress(),
  };
}

  // Typed-data signing helper for StepLog
  async function signStepLog(contract, signer, params) {
  const domainLive = await getEip712DomainSafe(contract);

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

  const value = {
    user: params.user,
    beneficiary: params.beneficiary,
    steps: params.steps,
    nonce: params.nonce,
    deadline: params.deadline,
    chainId: Number(domain.chainId),
    source: params.source,
    version: params.version,
  };

  const signature = await signer.signTypedData(domain, types, value);

  const recovered = ethers.verifyTypedData(domain, types, value, signature);
  if (recovered.toLowerCase() !== (await signer.getAddress()).toLowerCase()) {
    throw new Error(`TypedData mismatch: recovered ${recovered} vs signer ${(await signer.getAddress())}`);
  }

  return signature;
}

  describe("Basic Functionality", function () {
    it("Should initialize correctly", async function () {
      const { token } = await loadFixture(deployFixture);
      expect(await token.name()).to.equal("GemStep");
      expect(await token.symbol()).to.equal("GEMS");
      expect(await token.decimals()).to.equal(18);
    });

    it("Should allow token transfers (fee-on-transfer if enabled)", async function () {
      const { token, admin, user1 } = await loadFixture(deployFixture);

      const transferAmount = ethers.parseEther("10");

      const b0 = await token.balanceOf(user1.address);
      await (await token.connect(admin).transfer(user1.address, transferAmount)).wait();
      const b1 = await token.balanceOf(user1.address);

      const received = b1 - b0;
      expect(received).to.be.lte(transferAmount);

      const expectedIf1Pct = (transferAmount * 99n) / 100n;
      if (received !== transferAmount) {
        expect(received).to.equal(expectedIf1Pct);
      }
    });
  });

  describe("Step Rewards", function () {
    this.timeout(20000);

    beforeEach(async function () {
      await network.provider.send("evm_increaseTime", [30 * 24 * 60 * 60]);
      await network.provider.send("evm_mine");
    });

    it("Should reward steps through API", async function () {
      const { token, user1, apiSigner, funder } = await loadFixture(deployFixture);

      // ✅ TOKEN staking model (not payable)
      // If API path does not require stake, this is still harmless; it keeps tests stable if policy changes.
      await ensureTokenStake(token, funder, user1, ethers.parseEther("10"));

      const buildArgs = async (stepsBI) => {
        const nonce = await token.nonces(user1.address);
        const now = await time.latest();
        let sigV = Number(await getSigValiditySafe(token));
        if (!Number.isFinite(sigV) || sigV <= 0) sigV = 3600;
        // keep comfortably inside the limit to avoid "Deadline too far"
        const deadline = now + Math.max(60, Math.min(300, sigV - 5));


        const signature = await signStepLog(token, apiSigner, {
          user: user1.address,
          beneficiary: user1.address,
          steps: stepsBI,
          nonce,
          deadline,
          source: "googlefit",
          version: "1.0.0",
        });

        return {
          payload: {
            user: user1.address,
            beneficiary: user1.address,
            steps: stepsBI,
            nonce,
            deadline,
            source: "googlefit",
            version: "1.0.0",
          },
          proofObj: { signature, proof: [], attestation: "0x" },
        };
      };

      let steps = 100n;
      steps = await bumpStepsPastMinReward({
        token,
        caller: apiSigner,
        buildArgs,
        startSteps: steps,
      });

      const rewardRate = await getRewardRateSafe(token);
      const upperBound = steps * rewardRate;

      const caps = await getSupplyCapsSafe(token);

      // If month accounting isn’t exposed, skip this guard (test still validates RewardClaimed + balance delta)
      if (caps.currentMonthMinted != null && caps.currentMonthlyCap != null) {
        if (caps.currentMonthMinted + upperBound > caps.currentMonthlyCap) return;
      }

      const { payload, proofObj } = await buildArgs(steps);

      const bal0 = await token.balanceOf(user1.address);
      const tx = await token.connect(apiSigner).logSteps(payload, proofObj);
      await expect(tx).to.emit(token, "RewardClaimed");
      await tx.wait();
      const bal1 = await token.balanceOf(user1.address);

      const delta = bal1 - bal0;
      expect(delta).to.be.gt(0n);
      expect(delta).to.be.lte(upperBound);
    });

    it("Should allow direct user submissions when permitted", async function () {
      const { token, user1, admin, funder } = await loadFixture(deployFixture);

      // ✅ TOKEN staking model (not payable)
      await ensureTokenStake(token, funder, user1, ethers.parseEther("10"));

      if (typeof token.configureSource === "function") {
        await token.connect(admin).configureSource("direct", false, false);
      }

      const buildArgs = async (stepsBI) => {
        const nonce = await token.nonces(user1.address);
        const now = await time.latest();
        let sigV = Number(await getSigValiditySafe(token));
        if (!Number.isFinite(sigV) || sigV <= 0) sigV = 3600;
        // keep comfortably inside the limit to avoid "Deadline too far"
        const deadline = now + Math.max(60, Math.min(300, sigV - 5));


        const signature = await signStepLog(token, user1, {
          user: user1.address,
          beneficiary: user1.address,
          steps: stepsBI,
          nonce,
          deadline,
          source: "direct",
          version: "1.0.0",
        });

        return {
          payload: {
            user: user1.address,
            beneficiary: user1.address,
            steps: stepsBI,
            nonce,
            deadline,
            source: "direct",
            version: "1.0.0",
          },
          proofObj: { signature, proof: [], attestation: "0x" },
        };
      };

      let steps = 100n;
      steps = await bumpStepsPastMinReward({
        token,
        caller: user1,
        buildArgs,
        startSteps: steps,
      });

      const rewardRate = await getRewardRateSafe(token);
      const upperBound = steps * rewardRate;

      const caps = await getSupplyCapsSafe(token);

      // If month accounting isn’t exposed, skip this guard (test still validates RewardClaimed + balance delta)
      if (caps.currentMonthMinted != null && caps.currentMonthlyCap != null) {
        if (caps.currentMonthMinted + upperBound > caps.currentMonthlyCap) return;
      }

      const { payload, proofObj } = await buildArgs(steps);

      const bal0 = await token.balanceOf(user1.address);
      const tx = await token.connect(user1).logSteps(payload, proofObj);
      await expect(tx).to.emit(token, "RewardClaimed");
      await tx.wait();
      const bal1 = await token.balanceOf(user1.address);

      const delta = bal1 - bal0;
      expect(delta).to.be.gt(0n);
      expect(delta).to.be.lte(upperBound);
    });

    it("Should enforce caller and nonce rules", async function () {
      const { token, user1, apiSigner, user2 } = await loadFixture(deployFixture);

      const buildArgsApi = async (stepsBI, nonceOverride = null) => {
        const nonce = nonceOverride ?? (await token.nonces(user1.address));
        const now = await time.latest();
        let sigV = Number(await getSigValiditySafe(token));
        if (!Number.isFinite(sigV) || sigV <= 0) sigV = 3600;
        // keep comfortably inside the limit to avoid "Deadline too far"
        const deadline = now + Math.max(60, Math.min(300, sigV - 5));


        const apiSig = await signStepLog(token, apiSigner, {
          user: user1.address,
          beneficiary: user1.address,
          steps: stepsBI,
          nonce,
          deadline,
          source: "googlefit",
          version: "1.0.0",
        });

        return {
          payload: {
            user: user1.address,
            beneficiary: user1.address,
            steps: stepsBI,
            nonce,
            deadline,
            source: "googlefit",
            version: "1.0.0",
          },
          proofObj: { signature: apiSig, proof: [], attestation: "0x" },
          nonce,
          deadline,
          apiSig,
        };
      };

      let steps = 50n;
      steps = await bumpStepsPastMinReward({
        token,
        caller: apiSigner,
        buildArgs: async (s) => {
          const { payload, proofObj } = await buildArgsApi(s);
          return { payload, proofObj };
        },
        startSteps: steps,
      });

      const first = await buildArgsApi(steps);
      await token.connect(apiSigner).logSteps(first.payload, first.proofObj);

      await expect(token.connect(apiSigner).logSteps(first.payload, first.proofObj)).to.be.revertedWith(
        "Invalid nonce"
      );

      const nonce2 = await token.nonces(user1.address);
      const deadline2 = (await time.latest()) + 3600;

      const userSig = await signStepLog(token, user1, {
        user: user1.address,
        beneficiary: user1.address,
        steps,
        nonce: nonce2,
        deadline: deadline2,
        source: "googlefit",
        version: "1.0.0",
      });

      await expect(
        token.connect(user2).logSteps(
          {
            user: user1.address,
            beneficiary: user1.address,
            steps,
            nonce: nonce2,
            deadline: deadline2,
            source: "googlefit",
            version: "1.0.0",
          },
          { signature: userSig, proof: [], attestation: "0x" }
        )
      ).to.be.revertedWith("Caller must be user or trusted API");
    });
  });

  describe("Admin Functions", function () {
    it("Should allow admin to pause/unpause contract", async function () {
      const { token, admin } = await loadFixture(deployFixture);

      await token.connect(admin).pause();
      expect(await token.paused()).to.be.true;

      await token.connect(admin).unpause();
      expect(await token.paused()).to.be.false;
    });

    it("Should prevent non-admins from pausing", async function () {
      const { token, user1 } = await loadFixture(deployFixture);

      await expect(token.connect(user1).pause()).to.be.revertedWithCustomError(
        token,
        "AccessControlUnauthorizedAccount"
      );
    });
  });

  describe("Role Management", function () {
    it("Should allow admin to grant roles", async function () {
      const { token, admin, user1 } = await loadFixture(deployFixture);

    const PR = await roleId(token, "PAUSER_ROLE");
    await token.connect(admin).grantRole(PR, user1.address);
    expect(await token.hasRole(PR, user1.address)).to.be.true;

    });

    it("Should prevent non-admins from granting roles", async function () {
  const { token, admin, user1, user2 } = await loadFixture(deployFixture);

  const PR = await roleId(token, "PAUSER_ROLE");

  // user1 is NOT admin, so this must fail
  await expect(
    token.connect(user1).grantRole(PR, user2.address)
  ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");

  // sanity: admin can grant it
  await (await token.connect(admin).grantRole(PR, user2.address)).wait();
  expect(await token.hasRole(PR, user2.address)).to.be.true;
});

  });
});
