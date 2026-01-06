// @ts-nocheck
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("GS_EmergencyAndL2 (module) — unit", function () {
  async function deployFixture() {
    const [admin, l1GovEOA, emg, other, recipient, erc20Recipient] = await ethers.getSigners();

    // Use fully qualified name for MockArbSys
    const MockArbSys = await ethers.getContractFactory("contracts/test/harness/GS_EmergencyAndL2_TestHarness.sol:MockArbSys");
    const mockArb = await MockArbSys.deploy();
    await mockArb.waitForDeployment();

    // Deploy harness
    const Harness = await ethers.getContractFactory("GS_EmergencyAndL2_TestHarness");
    const h = await Harness.deploy(await admin.getAddress());
    await h.waitForDeployment();

    // Set the MockArbSys address
    await h.connect(admin).setArbSys(await mockArb.getAddress());

    // Grant roles to test accounts
    await h.connect(admin).grantRole(await h.EMERGENCY_ADMIN_ROLE(), await emg.getAddress());
    await h.connect(admin).grantRole(await h.PARAMETER_ADMIN_ROLE(), await admin.getAddress());

    return {
      admin,
      l1GovEOA,
      emg,
      other,
      recipient,
      erc20Recipient,
      h,
      mockArb,
    };
  }

  it("setL1Governance: only admin, non-zero, only-once", async () => {
    const { admin, h, l1GovEOA } = await deployFixture();

    await expect(h.connect(admin).setL1Governance(await l1GovEOA.getAddress()))
      .to.emit(h, "L1GovernanceSet")
      .withArgs(await l1GovEOA.getAddress());

    expect(await h.getL1Governance()).to.equal(await l1GovEOA.getAddress());

    await expect(h.connect(admin).setL1Governance(await l1GovEOA.getAddress()))
      .to.be.revertedWith("GS: L1 governance already set");

    await expect(h.connect(admin).setL1Governance(ethers.ZeroAddress))
      .to.be.revertedWith("GS: L1 governance zero address");
  });

  it("onlyFromL1Governance: l2SetPause/l2UpdateParams require aliased L1", async () => {
    const { admin, l1GovEOA, other, h } = await deployFixture();
    await h.connect(admin).setL1Governance(await l1GovEOA.getAddress());

    await expect(h.connect(other).l2SetPause(true)).to.be.revertedWith("GS: not L1 governance");

    const aliased = await h.exposedAlias(await l1GovEOA.getAddress());
    await ethers.provider.send("hardhat_impersonateAccount", [aliased]);
    const aliasedSigner = await ethers.getSigner(aliased);

    const [funder] = await ethers.getSigners();
    await funder.sendTransaction({ to: aliased, value: ethers.parseEther("1") });

    await expect(h.connect(aliasedSigner).l2SetPause(true))
      .to.emit(h, "L2PausedByL1")
      .withArgs(true);
    expect(await h.paused()).to.equal(true);

    await expect(h.connect(aliasedSigner).l2UpdateParams(5000, 42))
      .to.emit(h, "ParameterUpdated").withArgs("stepLimit", 0, 5000)
      .and.to.emit(h, "ParameterUpdated").withArgs("rewardRate", 0, 42)
      .and.to.emit(h, "L2ParamsUpdatedByL1").withArgs(5000, 42);

    expect(await h.stepLimit()).to.equal(5000n);
    expect(await h.rewardRate()).to.equal(42n);

    await expect(h.connect(aliasedSigner).l2SetPause(false))
      .to.emit(h, "L2PausedByL1")
      .withArgs(false);
    expect(await h.paused()).to.equal(false);

    await ethers.provider.send("hardhat_stopImpersonatingAccount", [aliased]);
  });

  it("initializeArbitrum + updateArbitrumGasParams role gates", async () => {
    const { admin, other, h } = await deployFixture();

    await expect(
      h.connect(admin).initializeArbitrum(
        ethers.Wallet.createRandom().address,
        ethers.Wallet.createRandom().address
      )
    ).to.not.be.reverted;

    await expect(
      h.connect(other).initializeArbitrum(ethers.ZeroAddress, ethers.ZeroAddress)
    ).to.be.revertedWith("ACCESS: missing role");

    await expect(h.connect(other).updateArbitrumGasParams(1, 2, 3)).to.be.revertedWith("ACCESS: missing role");
    await expect(h.connect(admin).updateArbitrumGasParams(100, 200, 300)).to.not.be.reverted;

    expect(await h.arbMaxGas()).to.equal(100n);
    expect(await h.arbGasPriceBid()).to.equal(200n);
    expect(await h.arbMaxSubmissionCost()).to.equal(300n);
  });

  it("emergencyPingL1 uses ArbSys precompile and emits", async () => {
    const { emg, h, mockArb } = await deployFixture();
    const target = ethers.Wallet.createRandom().address;
    const data = ethers.toUtf8Bytes("hello-l1");

    // Reset the counter to ensure we get ID 1
    await mockArb.txCounter(); // Just to ensure it's deployed
    
    await expect(h.connect(emg).emergencyPingL1(target, data))
      .to.emit(h, "L2ToL1Tx")
      .withArgs(1, target, data);
  });

  it("toggleEmergencyWithdraw sets + delay gate + emergencyWithdraw", async () => {
    const { admin, emg, h } = await deployFixture();

    await expect(h.connect(emg).toggleEmergencyWithdraw(true))
      .to.emit(h, "EmergencyWithdrawEnabledChanged");

    await expect(h.connect(emg).emergencyWithdraw(ethers.parseEther("1")))
      .to.be.revertedWith("Emergency delay not passed");

    await h.connect(admin).approveRecipient(await emg.getAddress(), true);

    const blk = await ethers.provider.getBlock("latest");
    const now = BigInt(blk.timestamp);
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(now + 3601n)]);
    await ethers.provider.send("evm_mine", []);

    const before = await h.balanceOf(await emg.getAddress());
    await expect(h.connect(emg).emergencyWithdraw(ethers.parseEther("5")))
      .to.emit(h, "EmergencyWithdraw")
      .withArgs(await emg.getAddress(), ethers.parseEther("5"), await h.totalSupply());

    const after = await h.balanceOf(await emg.getAddress());
    expect(after - before).to.equal(ethers.parseEther("5"));
  });

  it("emergencyWithdrawERC20 + emergencyWithdrawETH", async () => {
    const { admin, emg, h, erc20Recipient, recipient } = await deployFixture();

    await h.connect(emg).toggleEmergencyWithdraw(true);
    const blk = await ethers.provider.getBlock("latest");
    const now = BigInt(blk.timestamp);
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(now + 3601n)]);
    await ethers.provider.send("evm_mine", []);

    const MockErc20 = await ethers.getContractFactory("MinimalERC20");
    const t = await MockErc20.deploy();
    await t.waitForDeployment();
    await t.mint(await h.getAddress(), ethers.parseEther("10"));

    await expect(
      h.connect(emg).emergencyWithdrawERC20(t, await erc20Recipient.getAddress(), ethers.parseEther("3"))
    ).to.emit(h, "EmergencyWithdrawERC20").withArgs(
      await t.getAddress(), await erc20Recipient.getAddress(), ethers.parseEther("3")
    );

    expect(await t.balanceOf(await erc20Recipient.getAddress())).to.equal(ethers.parseEther("3"));

    await admin.sendTransaction({ to: await h.getAddress(), value: ethers.parseEther("1") });

    await expect(
      h.connect(emg).emergencyWithdrawETH(await recipient.getAddress(), ethers.parseEther("0.4"))
    ).to.emit(h, "EmergencyWithdrawETH").withArgs(
      await recipient.getAddress(), ethers.parseEther("0.4")
    );

    const bal = await ethers.provider.getBalance(await recipient.getAddress());
    expect(bal).to.be.greaterThan(0n);
  });

  it("approveRecipient validates bad addresses", async () => {
    const { h } = await deployFixture();
    const [admin] = await ethers.getSigners();
    await expect(h.connect(admin).approveRecipient(ethers.ZeroAddress, true))
      .to.be.revertedWith("GS: invalid recipient");
    await expect(h.connect(admin).approveRecipient(await h.getAddress(), true))
      .to.be.revertedWith("GS: invalid recipient");
  });
});