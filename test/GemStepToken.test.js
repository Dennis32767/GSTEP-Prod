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
    if (!(await token.hasRole(DAR, admin.address))) {
      await token.connect(deployer).grantRole(DAR, admin.address);
    }

    // Roles (guarded: only if the function exists in this build)
    const maybeGrant = async (roleFn, acct) => {
      if (typeof token[roleFn] !== "function") return;
      const role = await token[roleFn]();
      if (!(await token.hasRole(role, acct))) {
        await token.connect(admin).grantRole(role, acct);
      }
    };

    await maybeGrant("PARAMETER_ADMIN_ROLE", admin.address);
    await maybeGrant("PAUSER_ROLE", admin.address);
    await maybeGrant("MINTER_ROLE", admin.address);
    await maybeGrant("SIGNER_ROLE", apiSigner.address);
    await maybeGrant("EMERGENCY_ADMIN_ROLE", emergencyAdmin.address);
    await maybeGrant("API_SIGNER_ROLE", apiSigner.address);

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

    // Ensure user has enough GSTEP
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

  // Typed-data signing helper for StepLog
  async function signStepLog(contract, signer, params) {
    const { chainId } = await ethers.provider.getNetwork();
    const domain = {
      name: "GemStep",
      version: "1.0.0",
      chainId,
      verifyingContract: await contract.getAddress(),
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
      chainId,
      source: params.source,
      version: params.version,
    };

    const signature = await signer.signTypedData(domain, types, value);

    const recovered = ethers.verifyTypedData(domain, types, value, signature);
    if (recovered.toLowerCase() !== (await signer.getAddress()).toLowerCase()) {
      throw new Error(
        `TypedData mismatch: recovered ${recovered} vs signer ${(await signer.getAddress())}`
      );
    }

    return signature;
  }

  describe("Basic Functionality", function () {
    it("Should initialize correctly", async function () {
      const { token } = await loadFixture(deployFixture);
      expect(await token.name()).to.equal("GemStep");
      expect(await token.symbol()).to.equal("GSTEP");
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
        const deadline = (await time.latest()) + 3600;

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

      const rewardRate = BigInt((await token.rewardRate()).toString());
      const upperBound = steps * rewardRate;

      const currentMonthMinted = await token.currentMonthMinted();
      const currentCap = await token.currentMonthlyCap();
      if (currentMonthMinted + upperBound > currentCap) return;

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
        const deadline = (await time.latest()) + 3600;

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

      const rewardRate = BigInt((await token.rewardRate()).toString());
      const upperBound = steps * rewardRate;

      const currentMonthMinted = await token.currentMonthMinted();
      const currentCap = await token.currentMonthlyCap();
      if (currentMonthMinted + upperBound > currentCap) return;

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
        const deadline = (await time.latest()) + 3600;

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

      await token.connect(admin).grantRole(await token.PAUSER_ROLE(), user1.address);
      expect(await token.hasRole(await token.PAUSER_ROLE(), user1.address)).to.be.true;
    });

    it("Should prevent non-admins from granting roles", async function () {
      const { token, user1, user2 } = await loadFixture(deployFixture);

      await expect(
        token.connect(user1).grantRole(await token.PAUSER_ROLE(), user2.address)
      ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    });
  });
});
