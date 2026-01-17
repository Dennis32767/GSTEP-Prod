// test/GS_Staking.withdrawStake.test.js
/* eslint-disable no-unused-expressions */
// @ts-nocheck
const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

/**
 * DROP-IN FIX:
 * - Your staking is ERC20 staking: stake(uint256) and withdrawStake(uint256)
 * - NOT payable ETH staking.
 * - So tests must:
 *    1) give user GSTEP
 *    2) user approves token contract
 *    3) user calls stake(amount)
 *    4) user calls withdrawStake(amount)
 */

async function deployFixture() {
  const [deployer, admin, treasury, user, other] = await ethers.getSigners();

  // ---- Mock Oracle (required by initializer in your build) ----
  const Mock = await ethers.getContractFactory("MockOracleV2");
  const oracle = await Mock.deploy();
  await oracle.waitForDeployment();

  const { timestamp } = await ethers.provider.getBlock("latest");
  await oracle.set(ethers.parseEther("0.005"), timestamp, 0);
  await oracle.setPolicy(300, 100);

  // ---- Deploy behind proxy (matches your production pattern) ----
  const Token = await ethers.getContractFactory("contracts/GemStepToken.sol:GemStepToken");
  const initialSupply = ethers.parseUnits("400000000", 18);

  const token = await upgrades.deployProxy(
    Token,
    [initialSupply, admin.address, await oracle.getAddress(), treasury.address],
    { initializer: "initialize" }
  );
  await token.waitForDeployment();

  // Prefund user with GSTEP from treasury (treasury holds initial supply)
  const fund = ethers.parseUnits("1000", 18);
  await token.connect(treasury).transfer(user.address, fund);

  return { deployer, admin, treasury, user, other, token, oracle };
}

async function stakeFor(token, user, amount) {
  // Stake transfers tokens from user -> token contract
  await token.connect(user).approve(await token.getAddress(), amount);
  return token.connect(user).stake(amount);
}

describe("GemStepToken — GS_Staking (stake/withdrawStake)", function () {
  it("reverts on zero stake amount", async () => {
    const { token, user } = await loadFixture(deployFixture);
    await expect(token.connect(user).stake(0)).to.be.revertedWith("0");
  });

  it("reverts on zero withdraw amount", async () => {
    const { token, user } = await loadFixture(deployFixture);
    await expect(token.connect(user).withdrawStake(0)).to.be.revertedWith("0");
  });

  it("reverts when withdrawing more than staked", async () => {
    const { token, user } = await loadFixture(deployFixture);

    const amt = ethers.parseUnits("10", 18);
    await stakeFor(token, user, amt);

    await expect(token.connect(user).withdrawStake(amt + 1n)).to.be.revertedWith("BAL");
  });

  it("stake succeeds: transfers to contract + emits Staked", async () => {
    const { token, user } = await loadFixture(deployFixture);

    const amt = ethers.parseUnits("25", 18);
    const userBalBefore = await token.balanceOf(user.address);
    const contractBalBefore = await token.balanceOf(await token.getAddress());

    const tx = await stakeFor(token, user, amt);
    await expect(tx).to.emit(token, "Staked").withArgs(user.address, amt);

    const userBalAfter = await token.balanceOf(user.address);
    const contractBalAfter = await token.balanceOf(await token.getAddress());

    expect(userBalBefore - userBalAfter).to.equal(amt);
    expect(contractBalAfter - contractBalBefore).to.equal(amt);

    // If getStakeInfo exists (it does in your module), validate it too
    if (typeof token.getStakeInfo === "function") {
      const [bal, startTs] = await token.getStakeInfo(user.address);
      expect(bal).to.equal(amt);
      expect(startTs).to.be.gt(0n);
    }
  });

  it("withdrawStake succeeds: transfers back + emits Withdrawn; clears stakeStart on full exit", async () => {
    const { token, user } = await loadFixture(deployFixture);

    const amt = ethers.parseUnits("40", 18);
    await stakeFor(token, user, amt);

    const userBalBefore = await token.balanceOf(user.address);
    const contractBalBefore = await token.balanceOf(await token.getAddress());

    const tx = await token.connect(user).withdrawStake(amt);
    await expect(tx).to.emit(token, "Withdrawn").withArgs(user.address, amt);

    const userBalAfter = await token.balanceOf(user.address);
    const contractBalAfter = await token.balanceOf(await token.getAddress());

    expect(userBalAfter - userBalBefore).to.equal(amt);
    expect(contractBalBefore - contractBalAfter).to.equal(amt);

    if (typeof token.getStakeInfo === "function") {
      const [bal, startTs] = await token.getStakeInfo(user.address);
      expect(bal).to.equal(0n);
      expect(startTs).to.equal(0n);
    }
  });

  it("respects whenNotPaused (if pause exists)", async () => {
    const { token, admin, user } = await loadFixture(deployFixture);
    if (typeof token.pause !== "function") return;

    const amt = ethers.parseUnits("5", 18);

    await token.connect(admin).pause();

    await token.connect(user).approve(await token.getAddress(), amt);
    await expect(token.connect(user).stake(amt)).to.be.reverted;

    await expect(token.connect(user).withdrawStake(amt)).to.be.reverted;

    await token.connect(admin).unpause();

    await expect(token.connect(user).stake(amt)).to.emit(token, "Staked");
  });

  it("allows multiple withdrawals over time", async () => {
    const { token, user } = await loadFixture(deployFixture);

    const amt = ethers.parseUnits("100", 18);
    await stakeFor(token, user, amt);

    await expect(token.connect(user).withdrawStake(ethers.parseUnits("10", 18)))
      .to.emit(token, "Withdrawn");

    await time.increase(3600);

    await expect(token.connect(user).withdrawStake(ethers.parseUnits("15", 18)))
      .to.emit(token, "Withdrawn");

    if (typeof token.getStakeInfo === "function") {
      const [bal] = await token.getStakeInfo(user.address);
      expect(bal).to.equal(ethers.parseUnits("75", 18));
    }
  });
});
