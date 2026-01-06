// @ts-nocheck
const { expect } = require("chai");
const { ethers } = require("hardhat");

// ---------- shared fixture (same as your module test) ----------
async function deployFixture() {
  const [admin, l1GovEOA, emg, other, recipient, erc20Recipient] = await ethers.getSigners();

  // Fully-qualified MockArbSys so we don't clash with any other MockArbSys
  const MockArbSys = await ethers.getContractFactory(
    "contracts/test/harness/GS_EmergencyAndL2_TestHarness.sol:MockArbSys"
  );
  const mockArb = await MockArbSys.deploy();
  await mockArb.waitForDeployment();

  const Harness = await ethers.getContractFactory("GS_EmergencyAndL2_TestHarness");
  const h = await Harness.deploy(await admin.getAddress());
  await h.waitForDeployment();

  // Wire ArbSys
  await h.connect(admin).setArbSys(await mockArb.getAddress());

  // Roles used by tests
  await h.connect(admin).grantRole(await h.EMERGENCY_ADMIN_ROLE(), await emg.getAddress());
  await h.connect(admin).grantRole(await h.PARAMETER_ADMIN_ROLE(), await admin.getAddress());

  return { admin, l1GovEOA, emg, other, recipient, erc20Recipient, h, mockArb };
}

// For compatibility with older calls that used `deploy()`
const deploy = deployFixture;

// ---------- small helpers ----------
const add1 = (addr) =>
  ethers.getAddress("0x" + (BigInt(addr) + 1n).toString(16).padStart(40, "0"));

async function warp(seconds) {
  const blk = await ethers.provider.getBlock("latest");
  const now = BigInt(blk.timestamp);
  await ethers.provider.send("evm_setNextBlockTimestamp", [Number(now + BigInt(seconds))]);
  await ethers.provider.send("evm_mine", []);
}

// ====================================================================
//                               TESTS
// ====================================================================

describe("GS_EmergencyAndL2 — extra coverage", function () {
  it("aliasing negative: aliased+1 address must fail", async () => {
    const { admin, l1GovEOA, h } = await deployFixture();

    // Set legit L1 governance
    await h.connect(admin).setL1Governance(await l1GovEOA.getAddress());

    // Compute aliased L1 and then off-by-one
    const aliased = await h.exposedAlias(await l1GovEOA.getAddress());
    const aliasedPlusOne = add1(aliased);

    // Fund the off-by-one so it can send a tx
    const [funder] = await ethers.getSigners();
    await funder.sendTransaction({ to: aliasedPlusOne, value: ethers.parseEther("1") });

    await ethers.provider.send("hardhat_impersonateAccount", [aliasedPlusOne]);
    const bad = await ethers.getSigner(aliasedPlusOne);

    await expect(h.connect(bad).l2SetPause(true)).to.be.revertedWith("GS: not L1 governance");

    await ethers.provider.send("hardhat_stopImpersonatingAccount", [aliasedPlusOne]);
  });

  it("setL1Governance guards still hold (zero, set-once)", async () => {
    const { admin, l1GovEOA, h } = await deploy(); // alias to deployFixture

    // zero address rejected
    await expect(h.connect(admin).setL1Governance(ethers.ZeroAddress))
      .to.be.revertedWith("GS: L1 governance zero address");

    // first set ok
    await expect(h.connect(admin).setL1Governance(await l1GovEOA.getAddress()))
      .to.emit(h, "L1GovernanceSet")
      .withArgs(await l1GovEOA.getAddress());

    // second set rejected
    await expect(h.connect(admin).setL1Governance(await l1GovEOA.getAddress()))
      .to.be.revertedWith("GS: L1 governance already set");
  });

  it("toggleEmergencyWithdraw gate + timing w/ invalid recipient path", async () => {
    const { emg, h } = await deploy();

    // Enable emergency mode
    await expect(h.connect(emg).toggleEmergencyWithdraw(true))
      .to.emit(h, "EmergencyWithdrawEnabledChanged");

    // Must wait the EMERGENCY_DELAY (1h in harness)
    await warp(3601); // > 1 hour

    // Caller (emg) is NOT an approved recipient yet -> should revert with 'unauthorized recipient'
    await expect(h.connect(emg).emergencyWithdraw(ethers.parseEther("1")))
      .to.be.revertedWith("GS: unauthorized recipient");
  });

  it("initializeArbitrum rejects zero params; updateArbitrumGasParams writes", async () => {
    const { admin, other, h } = await deploy();

    // Reject zeros
    await expect(
      h.connect(admin).initializeArbitrum(ethers.ZeroAddress, ethers.ZeroAddress)
    ).to.be.revertedWith("GS: bad Arbitrum params");

    // Accept valid
    await expect(
      h.connect(admin).initializeArbitrum(
        ethers.Wallet.createRandom().address,
        ethers.Wallet.createRandom().address
      )
    ).to.not.be.reverted;

    // Param admin gate on gas params
    await expect(h.connect(other).updateArbitrumGasParams(1, 2, 3))
      .to.be.revertedWith("ACCESS: missing role");

    await expect(h.connect(admin).updateArbitrumGasParams(100, 200, 300))
      .to.not.be.reverted;

    expect(await h.arbMaxGas()).to.equal(100n);
    expect(await h.arbGasPriceBid()).to.equal(200n);
    expect(await h.arbMaxSubmissionCost()).to.equal(300n);
  });
});
