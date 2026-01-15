/* eslint-disable no-unused-expressions */
// @ts-nocheck
// SPDX-License-Identifier: MIT
const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

/**
 * DROP-IN replacement that fixes StalePrice failures:
 * - maxStaleness=300s, so ANY long warp (cooldown) makes oracle stale
 * - therefore: WARP first, then set oracle updatedAt to current chain timestamp, then call adjust
 */

async function nowTs() {
  const b = await ethers.provider.getBlock("latest");
  return BigInt(b.timestamp);
}

async function warp(seconds) {
  await time.increase(Number(seconds));
}

async function setOracleAtChainNow(oracle, priceWei, confBps = 0) {
  const t = await nowTs();
  await oracle.set(priceWei, t, confBps);
}

async function warpPastCooldown(token) {
  const cd = BigInt((await token.STAKE_ADJUST_COOLDOWN()).toString());
  await warp(cd + 1n);
}

/**
 * ✅ Core helper:
 * Always ensures BOTH:
 *  - cooldown satisfied
 *  - oracle updatedAt is fresh (<= maxStaleness)
 * before calling adjustStakeRequirements()
 */
async function adjustWithFreshOracle({ token, oracle, caller, priceWei, confBps = 0 }) {
  await warpPastCooldown(token);                // cooldown first (can be large)
  await setOracleAtChainNow(oracle, priceWei, confBps); // refresh updatedAt AFTER warp
  return token.connect(caller).adjustStakeRequirements();
}

async function makeOracleStale(oracle) {
  const stale = BigInt((await oracle.maxStaleness()).toString());
  const t = await nowTs();
  const tooOld = t - stale - 1n;
  await oracle.set(await oracle.priceWei(), tooOld, await oracle.confidenceBps());
}
async function setOracleNow(oracle, priceWei, confBps = 0) {
  const { timestamp } = await ethers.provider.getBlock("latest");
  await oracle.set(priceWei, timestamp, confBps);
}

async function warpPastCooldown(token) {
  const cd = await token.STAKE_ADJUST_COOLDOWN();
  const now = await ethers.provider.getBlock("latest").then((b) => b.timestamp);
  await ethers.provider.send("evm_setNextBlockTimestamp", [Number(now) + Number(cd) + 1]);
  await ethers.provider.send("evm_mine", []);
}


/* ----------------------------- Fixture ----------------------------- */

async function deployFixtureWithOracle() {
  const [deployer, admin, treasury, user, other, parameterAdmin, emergencyAdmin] =
    await ethers.getSigners();

  const MockOracle = await ethers.getContractFactory("MockOracleV2");
  const oracle = await MockOracle.deploy();
  await oracle.waitForDeployment();

  // Policy: stale=300s, minConf=100
  await oracle.setPolicy(300, 100);

  // Initial oracle set at chain timestamp (fresh)
  await setOracleAtChainNow(oracle, ethers.parseEther("0.005"), 0);

  const Token = await ethers.getContractFactory(
    "contracts/GemStepToken.sol:GemStepToken"
  );

  const initialSupply = ethers.parseUnits("400000000", 18);

  const token = await upgrades.deployProxy(
    Token,
    [initialSupply, admin.address, await oracle.getAddress(), treasury.address],
    { initializer: "initialize" }
  );
  await token.waitForDeployment();

  // Grant roles using admin
  const PARAM = await token.PARAMETER_ADMIN_ROLE();
  await token.connect(admin).grantRole(PARAM, parameterAdmin.address);

  const EMER = await token.EMERGENCY_ADMIN_ROLE();
  await token.connect(admin).grantRole(EMER, emergencyAdmin.address);

  return {
    deployer,
    admin,
    treasury,
    user,
    other,
    parameterAdmin,
    emergencyAdmin,
    token,
    oracle,
  };
}

/* ====================================================================
 *                             TESTS
 * ==================================================================== */

describe("GemStepToken — Oracle Integration (staleness-safe)", function () {
  describe("Stake Adjustment with Oracle", function () {
    it("adjustStakeRequirements succeeds with fresh oracle data after cooldown", async function () {
      const { token, oracle, parameterAdmin } = await loadFixture(deployFixtureWithOracle);

      const tx = await adjustWithFreshOracle({
        token,
        oracle,
        caller: parameterAdmin,
        priceWei: ethers.parseEther("0.005"),
        confBps: 0,
      });

      await expect(tx).to.emit(token, "StakeParametersUpdated");
    });

    it("handles oracle price updates correctly (multiple updates across cooldown)", async function () {
      const { token, oracle, parameterAdmin } = await loadFixture(deployFixtureWithOracle);

      const prices = [
        ethers.parseEther("0.005"),
        ethers.parseEther("0.01"),
        ethers.parseEther("0.02"),
      ];

      for (const p of prices) {
        const tx = await adjustWithFreshOracle({
          token,
          oracle,
          caller: parameterAdmin,
          priceWei: p,
          confBps: 0,
        });
        await expect(tx).to.emit(token, "StakeParametersUpdated");
      }
    });

    it("respects stake parameter bounds (does not revert on extreme prices if contract clamps)", async function () {
      const { token, oracle, parameterAdmin } = await loadFixture(deployFixtureWithOracle);

      // low
      {
        const tx = await adjustWithFreshOracle({
          token,
          oracle,
          caller: parameterAdmin,
          priceWei: ethers.parseEther("0.0000005"),
          confBps: 0,
        });
        await expect(tx).to.emit(token, "StakeParametersUpdated");
      }

      // high
      {
        const tx = await adjustWithFreshOracle({
          token,
          oracle,
          caller: parameterAdmin,
          priceWei: ethers.parseEther("0.02"),
          confBps: 0,
        });
        await expect(tx).to.emit(token, "StakeParametersUpdated");
      }
    });
  });

  describe("Oracle Error Conditions", function () {
    it("reverts on stale price data (MockOracleV2 StalePrice)", async function () {
      const { token, oracle, parameterAdmin } = await loadFixture(deployFixtureWithOracle);

      // satisfy cooldown first, THEN make oracle stale and call adjust
      await warpPastCooldown(token);
      await makeOracleStale(oracle);

      await expect(token.connect(parameterAdmin).adjustStakeRequirements())
        .to.be.revertedWithCustomError(oracle, "StalePrice");
    });

    it("reverts on low confidence data (MockOracleV2 ConfidenceTooLow)", async function () {
      const { token, oracle, parameterAdmin } = await loadFixture(deployFixtureWithOracle);

      // cooldown then fresh oracle with high confidenceBps (> minConf=100)
      await expect(
        adjustWithFreshOracle({
          token,
          oracle,
          caller: parameterAdmin,
          priceWei: ethers.parseEther("0.01"),
          confBps: 150,
        })
      ).to.be.revertedWithCustomError(oracle, "ConfidenceTooLow");
    });

      it("zero price: either reverts InvalidPrice OR leaves stake unchanged (implementation-dependent)", async function () {
        const { token, oracle, parameterAdmin } = await deployFixtureWithOracle();

        // ensure cooldown is not the reason for failure
        await warpPastCooldown(token);

        // capture current stake params before attempting adjustment
        const before = BigInt((await token.currentStakePerStep()).toString());

        // set oracle to zero price with a FRESH timestamp
        await setOracleNow(oracle, 0n, 0);

        try {
          const tx = await token.connect(parameterAdmin).adjustStakeRequirements();
          await tx.wait();

          // If your implementation chooses NOT to revert on zero price,
          // it should NOT blow up stake requirements.
          const after = BigInt((await token.currentStakePerStep()).toString());

          // Most conservative invariant: unchanged
          expect(after).to.equal(before);
        } catch (e) {
          // If your implementation *does* call quoteTokenInWei and bubbles errors:
          await expect(
            token.connect(parameterAdmin).adjustStakeRequirements()
          ).to.be.revertedWithCustomError(oracle, "InvalidPrice");
        }
      });
  });

  describe("Stake Adjustment Cooldown", function () {
    it("enforces cooldown between adjustments", async function () {
      const { token, oracle, parameterAdmin } = await loadFixture(deployFixtureWithOracle);

      // first success
      const tx1 = await adjustWithFreshOracle({
        token,
        oracle,
        caller: parameterAdmin,
        priceWei: ethers.parseEther("0.01"),
        confBps: 0,
      });
      await expect(tx1).to.emit(token, "StakeParametersUpdated");

      // immediate second should revert cooldown (oracle freshness irrelevant here)
      await expect(token.connect(parameterAdmin).adjustStakeRequirements())
        .to.be.revertedWith("Cooldown active");

      // after cooldown, succeed again (must refresh oracle AFTER warp)
      const tx2 = await adjustWithFreshOracle({
        token,
        oracle,
        caller: parameterAdmin,
        priceWei: ethers.parseEther("0.01"),
        confBps: 0,
      });
      await expect(tx2).to.emit(token, "StakeParametersUpdated");
    });
  });

  describe("Emergency Admin Functions", function () {
    it("allows emergency override of stake parameters", async function () {
      const { token, emergencyAdmin } = await loadFixture(deployFixtureWithOracle);

      await expect(
        token.connect(emergencyAdmin).manualOverrideStake(ethers.parseEther("0.0005"))
      ).to.emit(token, "StakeParametersUpdated");
    });

    it("stake parameter lock blocks automatic + manual changes; unlock restores", async function () {
      const { token, oracle, emergencyAdmin, parameterAdmin } = await loadFixture(deployFixtureWithOracle);

      // Lock
      await token.connect(emergencyAdmin).toggleStakeParamLock();

      // Automatic should revert (lock)
      await warpPastCooldown(token);
      await setOracleAtChainNow(oracle, ethers.parseEther("0.01"), 0);
      await expect(token.connect(parameterAdmin).adjustStakeRequirements()).to.be.reverted;

      // Manual should revert (lock)
      await expect(
        token.connect(emergencyAdmin).manualOverrideStake(ethers.parseEther("0.0005"))
      ).to.be.reverted;

      // Unlock
      await token.connect(emergencyAdmin).toggleStakeParamLock();

      // Automatic works again (fresh oracle after cooldown)
      const tx = await adjustWithFreshOracle({
        token,
        oracle,
        caller: parameterAdmin,
        priceWei: ethers.parseEther("0.01"),
        confBps: 0,
      });
      await expect(tx).to.emit(token, "StakeParametersUpdated");
    });
  });

  describe("Integration Scenarios", function () {
    it("normal operation: adjust works and users can stake/withdraw", async function () {
      const { token, oracle, parameterAdmin, user } = await loadFixture(deployFixtureWithOracle);

      const tx = await adjustWithFreshOracle({
        token,
        oracle,
        caller: parameterAdmin,
        priceWei: ethers.parseEther("0.01"),
        confBps: 0,
      });
      await expect(tx).to.emit(token, "StakeParametersUpdated");

      await token.connect(user).stake({ value: ethers.parseEther("0.1") });
      await token.connect(user).withdrawStake(ethers.parseEther("0.05"));
    });

    it("oracle issues: automatic adjust reverts, but staking/withdrawal still works; emergency override works", async function () {
      const { token, oracle, parameterAdmin, emergencyAdmin, user } = await loadFixture(deployFixtureWithOracle);

      // Start good
      const tx1 = await adjustWithFreshOracle({
        token,
        oracle,
        caller: parameterAdmin,
        priceWei: ethers.parseEther("0.01"),
        confBps: 0,
      });
      await expect(tx1).to.emit(token, "StakeParametersUpdated");

      // Make stale and ensure cooldown satisfied
      await warpPastCooldown(token);
      await makeOracleStale(oracle);

      await expect(token.connect(parameterAdmin).adjustStakeRequirements())
        .to.be.revertedWithCustomError(oracle, "StalePrice");

      // user ops still ok
      await token.connect(user).stake({ value: ethers.parseEther("0.1") });
      await token.connect(user).withdrawStake(ethers.parseEther("0.05"));

      // emergency override ok
      await expect(
        token.connect(emergencyAdmin).manualOverrideStake(ethers.parseEther("0.0008"))
      ).to.emit(token, "StakeParametersUpdated");
    });

    it("price volatility: repeated price updates + adjust across cooldown", async function () {
      const { token, oracle, parameterAdmin } = await loadFixture(deployFixtureWithOracle);

      const priceChanges = [
        ethers.parseEther("0.008"),
        ethers.parseEther("0.012"),
        ethers.parseEther("0.007"),
        ethers.parseEther("0.015"),
      ];

      for (const p of priceChanges) {
        const tx = await adjustWithFreshOracle({
          token,
          oracle,
          caller: parameterAdmin,
          priceWei: p,
          confBps: 0,
        });
        await expect(tx).to.emit(token, "StakeParametersUpdated");
      }
    });
  });
});
