// @ts-nocheck
const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * Assumptions:
 * - You already have CrossChainGovernanceL1_TestHarness.
 * - You already have MockInbox that records lastMsgValue()
 *   If not, you can still use RevertingInbox and focus on revert paths below.
 */

describe("CrossChainGovernanceL1 — extra coverage", function () {
  async function deployHarnessWithMockInbox() {
    const [owner, l2Refund] = await ethers.getSigners();

    // Prefer your existing MockInbox (the one used by your earlier tests)
    // Fallback: if not present, comment these two lines and use RevertingInbox tests only.
    const MockInbox = await ethers.getContractFactory("MockInbox");
    const inbox = await MockInbox.deploy();
    await inbox.waitForDeployment();

    const Harness = await ethers.getContractFactory("CrossChainGovernanceL1_TestHarness");
    const l2Token = ethers.Wallet.createRandom().address;
    const c = await Harness.deploy(await owner.getAddress(), await inbox.getAddress(), l2Token, await l2Refund.getAddress());
    await c.waitForDeployment();

    return { c, owner, l2Refund, inbox };
  }

  it("msg.value boundary: underpayment reverts; exact forwards; excess refunded", async () => {
    const { c, owner, inbox } = await deployHarnessWithMockInbox();

    // generate a few random-ish sets, but keep product safe
    const sets = [
      { msc: 1000n, gl: 200_000n, mfpg: 1n, extra: 777n },
      { msc: 1234n, gl: 300_000n, mfpg: 2n, extra: 333n },
      { msc: 1_000_000n, gl: 10_000n, mfpg: 10n, extra: 1n },
    ];

    for (const { msc, gl, mfpg, extra } of sets) {
      const required = msc + gl * mfpg;

      // underpay → revert
      await expect(
        c.connect(owner).sendPauseToL2(true, msc, gl, mfpg, { value: required - 1n })
      ).to.be.revertedWithCustomError(c, "InsufficientMsgValue");

      // exact → success & inbox sees exact value
      await expect(
        c.connect(owner).sendPauseToL2(true, msc, gl, mfpg, { value: required })
      ).to.emit(c, "RetryableCreated");

      expect(await inbox.lastMsgValue()).to.equal(required);

      // excess → success & still exact forwarded
      await expect(
        c.connect(owner).sendPauseToL2(true, msc, gl, mfpg, { value: required + extra })
      ).to.emit(c, "RetryableCreated");
      expect(await inbox.lastMsgValue()).to.equal(required);
    }
  });

  it("refunds go back to the caller (observable via RefundCatcher)", async () => {
  const { c, owner } = await deployHarnessWithMockInbox();

  // Use the specific file to avoid HH701
  const CatcherF = await ethers.getContractFactory(
    "contracts/test/mock/RefundCatcher.sol:RefundCatcher"
  );
  const catcher = await CatcherF.deploy();
  await catcher.waitForDeployment();

  // Make RefundCatcher the owner so refunds go back to it
  await c.connect(owner).transferOwnership(await catcher.getAddress());

  // Params
  const msc = 500n, gl = 50_000n, mfpg = 2n;
  const required = msc + gl * mfpg;
  const extra = 999n;
  const value = required + extra;

  // Call THROUGH the catcher so msg.sender at L1 is the RefundCatcher contract
  await expect(
    catcher.callSend(await c.getAddress(), value, true, msc, gl, mfpg, { value })
  ).to.emit(c, "RetryableCreated");

  // Its receive() should have recorded the refund (= extra)
  expect(await catcher.totalRefunded()).to.equal(extra);
});

  it("refund receiver that REVERTS causes the whole tx to revert", async () => {
  const { c } = await deployHarnessWithMockInbox();

  const Reverter = await ethers.getContractFactory("RefundReverter");
  const rr = await Reverter.deploy();
  await rr.waitForDeployment();

  // make rr the owner so refund goes back to rr
  await c.transferOwnership(await rr.getAddress());

  const msc = 7n, gl = 10_000n, mfpg = 3n;
  const required = msc + gl * mfpg;
  const extra = 1n;
  const value = required + extra;

  // call via rr so msg.sender == owner == rr
  await expect(
    rr.callSend(c.getAddress(), value, true, msc, gl, mfpg, { value })
  ).to.be.revertedWith("refund failed");
});

  it("strict unpause payload: while paused allow ONLY abi.encodeWithSignature('l2SetPause(bool)', false)", async () => {
    const { c, owner } = await deployHarnessWithMockInbox();

    // Pause the contract
    await c.connect(owner).emergencyPause();

    const msc = 1000n, gl = 200_000n, mfpg = 1n;
    const required = msc + gl * mfpg;

    // any generic payload must revert while paused
    const generic = ethers.toUtf8Bytes("anything");
    await expect(
      c.connect(owner).sendCall(generic, msc, gl, mfpg, { value: required })
    ).to.be.revertedWithCustomError(c, "ContractPausedErr");

    // l2SetPause(true) must also revert while paused
    const pauseTrue = (new ethers.Interface(["function l2SetPause(bool)"])).encodeFunctionData("l2SetPause", [true]);
    await expect(
      c.connect(owner).sendCall(pauseTrue, msc, gl, mfpg, { value: required })
    ).to.be.revertedWithCustomError(c, "ContractPausedErr");

    // EXACT l2SetPause(false) must pass while paused
    const pauseFalse = (new ethers.Interface(["function l2SetPause(bool)"])).encodeFunctionData("l2SetPause", [false]);
    await expect(
      c.connect(owner).sendCall(pauseFalse, msc, gl, mfpg, { value: required })
    ).to.emit(c, "RetryableCreated");
  });

  it("large but safe gas params (griefing boundary) behave and don't overflow", async () => {
    const { c, owner } = await deployHarnessWithMockInbox();
    const msc = 10_000n;
    const gl  = 10_000_000n;    // 1e7
    const mfpg = 1_000_000n;    // 1e6
    const required = msc + gl * mfpg; // 1e13 + 1e4 ~= fits in uint256 easily

    await expect(
      c.connect(owner).sendPauseToL2(true, msc, gl, mfpg, { value: required })
    ).to.emit(c, "RetryableCreated");
  });

  it("inbox failure bubbles up (using RevertingInbox)", async () => {
  const [owner, l2Refund] = await ethers.getSigners();

  // Fully-qualified to avoid HH701
  const RevertingInboxF = await ethers.getContractFactory(
    "contracts/test/mock/L1HardeningMocks.sol:RevertingInbox"
  );
  const badInbox = await RevertingInboxF.deploy();
  await badInbox.waitForDeployment();

  const Harness = await ethers.getContractFactory("CrossChainGovernanceL1_TestHarness");
  const l2Token = ethers.Wallet.createRandom().address;

  const c = await Harness.deploy(
    await owner.getAddress(),
    await badInbox.getAddress(),
    l2Token,
    await l2Refund.getAddress()
  );
  await c.waitForDeployment();

  const msc = 1000n, gl = 100_000n, mfpg = 1n;
  const required = msc + gl * mfpg;

  await expect(
    c.connect(owner).sendPauseToL2(true, msc, gl, mfpg, { value: required })
  ).to.be.revertedWith("MOCK_INBOX_REVERT");
});

});
