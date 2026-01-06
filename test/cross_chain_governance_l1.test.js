// @ts-nocheck
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("CrossChainGovernanceL1 — unit", function () {
  async function deployFixture() {
    const [owner, other, l2Refund] = await ethers.getSigners();

    const Inbox = await ethers.getContractFactory("MockInbox");
    const inbox = await Inbox.deploy();
    await inbox.waitForDeployment();

    const Harness = await ethers.getContractFactory("CrossChainGovernanceL1_TestHarness");
    const l2Token = ethers.Wallet.createRandom().address;
    const c = await Harness.deploy(
      await owner.getAddress(),
      await inbox.getAddress(),
      l2Token,
      await l2Refund.getAddress()
    );
    await c.waitForDeployment();

    return { owner, other, l2Refund, c, inbox };
  }

  it("constructor & getConfig", async () => {
    const { c, owner, inbox, l2Refund } = await deployFixture();
    const cfg = await c.getConfig();
    expect(cfg[0]).to.equal(await owner.getAddress());
    expect(cfg[1]).to.equal(await inbox.getAddress());
    expect(cfg[3]).to.equal(await l2Refund.getAddress());
    expect(cfg[4]).to.equal(false); // paused
  });

  it("ownership transfer and admin setters", async () => {
    const { c, owner, other } = await deployFixture();

    await expect(c.connect(owner).transferOwnership(await other.getAddress()))
      .to.emit(c, "OwnerTransferred")
      .withArgs(await owner.getAddress(), await other.getAddress());

    // now other is owner
    await expect(c.connect(owner).setInbox(ethers.Wallet.createRandom().address)).to.be.reverted;

    await expect(c.connect(other).setInbox(ethers.Wallet.createRandom().address)).to.emit(c, "InboxSet");
    await expect(c.connect(other).setL2Token(ethers.Wallet.createRandom().address)).to.emit(c, "L2TokenSet");
    await expect(c.connect(other).setRefundL2(ethers.Wallet.createRandom().address)).to.emit(c, "RefundL2Set");
  });

  it("pause gating: blocked when paused except unpause payload", async () => {
  const { c, owner } = await deployFixture();

  // 1) Pause works
  await expect(c.connect(owner).emergencyPause())
    .to.emit(c, "ContractPaused")
    .withArgs(true);

  const msc = 1000n;
  const gl  = 200_000n;
  const mfpg = 1n;
  const required = msc + gl * mfpg;

  // 2) While paused, generic payload is blocked
  await expect(
    c.connect(owner).sendCall(
      ethers.toUtf8Bytes("anything"),
      msc, gl, mfpg,
      { value: required }
    )
  ).to.be.revertedWithCustomError(c, "ContractPausedErr");

  // 3) While paused, the *specific* unpause payload is allowed through
  await expect(
    c.connect(owner).sendPauseToL2(false, msc, gl, mfpg, { value: required })
  ).to.emit(c, "RetryableCreated");

  // IMPORTANT: L1 is still paused here (sendPauseToL2 only sends a retryable)
  // 4) Generic calls are STILL blocked until we resume on L1
  await expect(
    c.connect(owner).sendCall(
      ethers.toUtf8Bytes("x"),
      msc, gl, mfpg,
      { value: required }
    )
  ).to.be.revertedWithCustomError(c, "ContractPausedErr");

  // 5) Once we resume on L1, generic calls are allowed
  await expect(c.connect(owner).resume())
    .to.emit(c, "ContractPaused")
    .withArgs(false);

  await expect(
    c.connect(owner).sendCall(
      ethers.toUtf8Bytes("x"),
      msc, gl, mfpg,
      { value: required }
    )
  ).to.emit(c, "RetryableCreated");
});

  it("InsufficientMsgValue and exact value forwarded to Inbox; excess refunded", async () => {
    const { c, owner, inbox } = await deployFixture();

    const msc = 1234n;
    const gl = 300_000n;
    const mfpg = 2n;
    const required = msc + gl * mfpg;

    await expect(
      c.connect(owner).sendPauseToL2(true, msc, gl, mfpg, { value: required - 1n })
    ).to.be.revertedWithCustomError(c, "InsufficientMsgValue");

    // Pay a bit extra; contract should forward exactly `required` to Inbox
    await expect(
      c.connect(owner).sendPauseToL2(true, msc, gl, mfpg, { value: required + 777n })
    ).to.emit(c, "RetryableCreated");

    // Verify Inbox saw exactly `required`
    const lastMsgValue = await inbox.lastMsgValue();
    expect(lastMsgValue).to.equal(required);
  });

  it("sweep transfers full ETH balance", async () => {
    const { c, owner, other } = await deployFixture();

    // fund the helper
    await owner.sendTransaction({ to: await c.getAddress(), value: ethers.parseEther("0.5") });

    const before = await ethers.provider.getBalance(await other.getAddress());
    await expect(c.connect(owner).sweep(await other.getAddress()))
      .to.emit(c, "Swept")
      .withArgs(await other.getAddress(), ethers.parseEther("0.5"));
    const after = await ethers.provider.getBalance(await other.getAddress());
    expect(after - before).to.equal(ethers.parseEther("0.5"));
  });
});
