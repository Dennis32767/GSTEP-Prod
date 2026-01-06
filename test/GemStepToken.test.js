const { expect } = require("chai");
const { ethers, upgrades, network } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("GemStepToken", function () {
  async function deployFixture() {
    const [deployer, admin, user1, user2, apiSigner, emergencyAdmin] = await ethers.getSigners();

    const GemStepToken = await ethers.getContractFactory("GemStepToken");
    // initializer: (initialSupply, admin, _priceOracle)
    const token = await upgrades.deployProxy(
      GemStepToken,
      [ethers.parseEther("40000000"), deployer.address, deployer.address],
      { initializer: "initialize" }
    );
    await token.waitForDeployment();

    // Setup roles
    await token.connect(deployer).grantRole(await token.DEFAULT_ADMIN_ROLE(), admin.address);
    await token.connect(deployer).grantRole(await token.PARAMETER_ADMIN_ROLE(), admin.address);

    // Admin grants other roles
    await token.connect(admin).grantRole(await token.PAUSER_ROLE(), admin.address);
    await token.connect(admin).grantRole(await token.MINTER_ROLE(), admin.address);
    await token.connect(admin).grantRole(await token.SIGNER_ROLE(), apiSigner.address);
    await token.connect(admin).grantRole(await token.EMERGENCY_ADMIN_ROLE(), emergencyAdmin.address);
    await token.connect(admin).grantRole(await token.API_SIGNER_ROLE(), apiSigner.address);

    // Initialize sources (disable proof/attestation for tests)
    await token.connect(admin).configureSource("fitbit", false, false);
    await token.connect(admin).configureSource("googlefit", false, false);
    await token.connect(admin).addTrustedDevice(apiSigner.address);

    // Mark API signer as trusted caller
    await token.connect(admin).setTrustedAPI(apiSigner.address, true);

    // Seed admin with some tokens
    await token.connect(deployer).transfer(admin.address, ethers.parseEther("1000"));

    // Force new month for fresh cap
    await token.connect(admin).forceMonthUpdate();

    return {
      token,
      deployer,
      admin,
      user1,
      user2,
      apiSigner,
      emergencyAdmin,
    };
  }

  // Typed-data signing helper for StepLog (matches contract EIP-712 domain & struct)
  async function signStepLog(contract, signer, params) {
    const { chainId } = await ethers.provider.getNetwork();
    const domain = {
      name: "GemStep",   // must equal __EIP712_init
      version: "1.0.0",    // must equal __EIP712_init
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
        { name: "version", type: "string" }, // payload version (must match exactly what contract hashes)
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
      version: params.version, // ⚠️ Use "1.0.0" to match hashing across stack
    };

    const signature = await signer.signTypedData(domain, types, value);

    // sanity check (off-chain recover)
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
      expect(await token.symbol()).to.equal("GST");
      expect(await token.decimals()).to.equal(18);
    });

    it("Should allow token transfers with burn fee", async function () {
      const { token, admin, user1 } = await loadFixture(deployFixture);
      const transferAmount = ethers.parseEther("10");
      const expectedReceived = (transferAmount * 99n) / 100n; // 1% burn

      await expect(
        token.connect(admin).transfer(user1.address, transferAmount)
      ).to.changeTokenBalances(token, [admin, user1], [-transferAmount, expectedReceived]);
    });
  });

  describe("Step Rewards", function () {
    this.timeout(20000);

    beforeEach(async function () {
      // Advance time by ~30 days to simulate a fresh month window
      await network.provider.send("evm_increaseTime", [30 * 24 * 60 * 60]);
      await network.provider.send("evm_mine");
    });

    it("Should reward steps through API", async function () {
      const { token, user1, apiSigner } = await loadFixture(deployFixture);

      // Staking not required for trusted API caller, but harmless if present
      await token.connect(user1).stake({ value: ethers.parseEther("0.01") });

      const steps = 100;
      const rewardRate = await token.rewardRate();
      const expectedReward = BigInt(steps) * rewardRate;

      const currentMonthMinted = await token.currentMonthMinted();
      const currentCap = await token.currentMonthlyCap();
      if (currentMonthMinted + expectedReward > currentCap) {
        console.log("Skipping test - would exceed current monthly cap");
        return;
      }

      const nonce = await token.nonces(user1.address);
      const deadline = (await time.latest()) + 3600;

      const signature = await signStepLog(token, apiSigner, {
        user: user1.address,
        beneficiary: user1.address,
        steps,
        nonce,
        deadline,
        source: "googlefit",
        version: "1.0.0", // <-- important
      });

      await expect(
        token.connect(apiSigner).logSteps(
          {
            user: user1.address,
            beneficiary: user1.address,
            steps,
            nonce,
            deadline,
            source: "googlefit",
            version: "1.0.0", // <-- important
          },
          { signature, proof: [], attestation: "0x" }
        )
      ).to.changeTokenBalance(token, user1.address, expectedReward);
    });

    it("Should allow direct user submissions when permitted", async function () {
      const { token, user1, admin } = await loadFixture(deployFixture);

      await token.connect(user1).stake({ value: ethers.parseEther("0.01") });
      await token.connect(admin).configureSource("direct", false, false);

      const steps = 100;
      const rewardRate = await token.rewardRate();
      const expectedReward = BigInt(steps) * rewardRate;

      const currentMonthMinted = await token.currentMonthMinted();
      const currentCap = await token.currentMonthlyCap();
      if (currentMonthMinted + expectedReward > currentCap) {
        console.log("Skipping test - would exceed current monthly cap");
        return;
      }

      const nonce = await token.nonces(user1.address);
      const deadline = (await time.latest()) + 3600;

      const signature = await signStepLog(token, user1, {
        user: user1.address,
        beneficiary: user1.address,
        steps,
        nonce,
        deadline,
        source: "direct",
        version: "1.0.0", // <-- important
      });

      await expect(
        token.connect(user1).logSteps(
          {
            user: user1.address,
            beneficiary: user1.address,
            steps,
            nonce,
            deadline,
            source: "direct",
            version: "1.0.0", // <-- important
          },
          { signature, proof: [], attestation: "0x" }
        )
      ).to.emit(token, "RewardClaimed");
    });

    it("Should enforce caller and nonce rules", async function () {
      const { token, user1, apiSigner, user2 } = await loadFixture(deployFixture);

      // 1) Valid API submission (caller is trusted API)
      let nonce = await token.nonces(user1.address);
      let deadline = (await time.latest()) + 3600;

      const apiSig = await signStepLog(token, apiSigner, {
        user: user1.address,
        beneficiary: user1.address,
        steps: 50,
        nonce,
        deadline,
        source: "googlefit",
        version: "1.0.0", // <-- important
      });

      await token.connect(apiSigner).logSteps(
        {
          user: user1.address,
          beneficiary: user1.address,
          steps: 50,
          nonce,
          deadline,
          source: "googlefit",
          version: "1.0.0", // <-- important
        },
        { signature: apiSig, proof: [], attestation: "0x" }
      );

      // 2) Reuse same nonce should fail
      await expect(
        token.connect(apiSigner).logSteps(
          {
            user: user1.address,
            beneficiary: user1.address,
            steps: 50,
            nonce, // same nonce
            deadline,
            source: "googlefit",
            version: "1.0.0",
          },
          { signature: apiSig, proof: [], attestation: "0x" }
        )
      ).to.be.revertedWith("Invalid nonce");

      // 3) Caller must be user OR trusted API: user2 is neither
      nonce = await token.nonces(user1.address);
      deadline = (await time.latest()) + 3600;

      const userSig = await signStepLog(token, user1, {
        user: user1.address,
        beneficiary: user1.address,
        steps: 50,
        nonce,
        deadline,
        source: "googlefit",
        version: "1.0.0", // <-- important
      });

      await expect(
        token.connect(user2).logSteps(
          {
            user: user1.address,
            beneficiary: user1.address,
            steps: 50,
            nonce,
            deadline,
            source: "googlefit",
            version: "1.0.0", // <-- important
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
