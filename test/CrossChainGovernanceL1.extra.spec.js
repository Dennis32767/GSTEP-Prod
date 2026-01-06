// @ts-nocheck
const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * Test doubles expected:
 * - InboxMock: records the last call (fields + msg.value) and returns incremental ticketIds starting at 1.
 *   Must expose:
 *     - function last() view returns (
 *         address to,
 *         uint256 l2CallValue,
 *         uint256 maxSubmissionCost,
 *         address excessFeeRefundAddress,
 *         address callValueRefundAddress,
 *         uint256 gasLimit,
 *         uint256 maxFeePerGas,
 *         bytes data,
 *         uint256 msgValue
 *       )
 *     - function lastMsgValue() view returns (uint256)
 *
 * - RevertingInbox (optional): reverts on createRetryableTicket with "MOCK_INBOX_REVERT".
 *
 * These names/paths match what you showed in your earlier passing tests. If your mock names differ,
 * just change the getContractFactory(...) strings below accordingly.
 */

describe("CrossChainGovernanceL1 — extra coverage (new ABI)", function () {
  async function deployAll() {
    const [deployer, other, pending, refundL2] = await ethers.getSigners();

    const Inbox = await ethers.getContractFactory("InboxMock");
    const inbox = await Inbox.deploy();
    await inbox.waitForDeployment();

    const GasCfg = { maxSubmissionCost: 11n, gasLimit: 22n, maxFeePerGas: 33n };
    const L2_TARGET = other.address;

    const L1 = await ethers.getContractFactory("CrossChainGovernanceL1");
    const l1 = await L1.deploy(
      deployer.address,
      await inbox.getAddress(),
      L2_TARGET,
      refundL2.address,
      GasCfg
    );
    await l1.waitForDeployment();

    return { l1, inbox, deployer, other, pending, refundL2, GasCfg, L2_TARGET };
  }

  it("onlyOwner gating on admin functions", async () => {
    const { l1, deployer, pending } = await deployAll();

    await expect(l1.connect(pending).setGasConfig(1, 2, 3))
      .to.be.revertedWithCustomError(l1, "NotOwner");
    await expect(l1.connect(pending).setInbox(ethers.Wallet.createRandom().address))
      .to.be.revertedWithCustomError(l1, "NotOwner");
    await expect(l1.connect(pending).setL2Target(ethers.Wallet.createRandom().address))
      .to.be.revertedWithCustomError(l1, "NotOwner");
    await expect(l1.connect(pending).setRefundL2(ethers.Wallet.createRandom().address))
      .to.be.revertedWithCustomError(l1, "NotOwner");

    // Ownable2Step transfer/accept
    await expect(l1.connect(pending).acceptOwnership())
      .to.be.revertedWithCustomError(l1, "NotPendingOwner");

    await expect(l1.connect(deployer).transferOwnership(pending.address))
      .to.emit(l1, "OwnershipTransferStarted")
      .withArgs(deployer.address, pending.address);

    await expect(l1.connect(pending).acceptOwnership())
      .to.emit(l1, "OwnershipTransferred")
      .withArgs(deployer.address, pending.address);
  });

  it("zero-address safety on setters + events", async () => {
    const { l1 } = await deployAll();

    await expect(l1.setInbox(ethers.ZeroAddress))
      .to.be.revertedWithCustomError(l1, "ZeroAddress");
    await expect(l1.setL2Target(ethers.ZeroAddress))
      .to.be.revertedWithCustomError(l1, "ZeroAddress");
    await expect(l1.setRefundL2(ethers.ZeroAddress))
      .to.be.revertedWithCustomError(l1, "ZeroAddress");

    // Positive path also emits events
    const inbox2 = ethers.Wallet.createRandom().address;
    const target2 = ethers.Wallet.createRandom().address;
    const refund2 = ethers.Wallet.createRandom().address;

    await expect(l1.setInbox(inbox2)).to.emit(l1, "InboxUpdated").withArgs(inbox2);
    await expect(l1.setL2Target(target2)).to.emit(l1, "L2TargetUpdated").withArgs(target2);
    await expect(l1.setRefundL2(refund2)).to.emit(l1, "RefundL2Updated").withArgs(refund2);
    await expect(l1.setGasConfig(1, 2, 3)).to.emit(l1, "GasConfigUpdated").withArgs(1, 2, 3);
  });

  it("quoteRetryable math reflects current gasConfig", async () => {
    const { l1 } = await deployAll();

    // Initial (from ctor)
    {
      const l2Value = 5n;
      const [total, subFee, gasFee] = await l1.quoteRetryable("0x", l2Value);
      expect(subFee).to.equal(11n);
      expect(gasFee).to.equal(22n * 33n);
      expect(total).to.equal(l2Value + subFee + gasFee);
    }

    // After update
    await l1.setGasConfig(5n, 7n, 11n);
    {
      const [total, subFee, gasFee] = await l1.quoteRetryable("0x", 2n);
      expect(subFee).to.eq(5n);
      expect(gasFee).to.eq(77n);
      expect(total).to.eq(2n + 5n + 77n);
    }
  });

  it("setGasConfig updates the exact values used by sendRetryable/sendPause", async () => {
  const { l1, inbox } = await deployAll();

  await l1.setGasConfig(100n, 200n, 3n);
  const need = 0n + 100n + 200n * 3n; // l2CallValue = 0

  // Expect the pause() selector in the event's data field
  const pauseSel = new ethers.Interface(["function pause()"]).encodeFunctionData("pause");

  await expect(l1.sendPause({ value: need }))
    .to.emit(l1, "RetryableSent")
    .withArgs(
      1,                   // ticketId from InboxMock (increments from 1)
      await l1.l2Target(), // to
      0n,                  // l2CallValue
      100n,                // maxSubmissionCost
      200n,                // gasLimit
      3n,                  // maxFeePerGas
      pauseSel             // data
    );

  const last = await inbox.last();
  expect(last.maxSubmissionCost).to.equal(100n);
  expect(last.gasLimit).to.equal(200n);
  expect(last.maxFeePerGas).to.equal(3n);
  expect(last.msgValue).to.equal(need);
  expect(last.data).to.equal(pauseSel); // sanity: inbox saw the same calldata
});

  it("msg.value boundaries: underpay reverts; exact succeeds; overpay is accepted and forwarded", async () => {
    const { l1, inbox } = await deployAll();

    // Pin a config so math is deterministic
    await l1.setGasConfig(1234n, 300_000n, 2n);
    const required = 0n + 1234n + 300_000n * 2n;

    // Underpay → revert with MsgValueTooLow(need, have)
    await expect(l1.sendPause({ value: required - 1n }))
      .to.be.revertedWithCustomError(l1, "MsgValueTooLow")
      .withArgs(required, required - 1n);

    // Exact → success; Inbox sees exact value
    await l1.sendPause({ value: required });
    expect((await inbox.last()).msgValue).to.equal(required);

    // Overpay → still success; contract forwards full msg.value to Inbox
    await l1.sendPause({ value: required + 777n });
    expect((await inbox.last()).msgValue).to.equal(required + 777n);
  });

  it("wrappers compose correct calldata: pause(), unpause(), setL1Governance(address), callL2(bytes)", async () => {
    const { l1, inbox } = await deployAll();

    // gas cfg: tiny but non-zero so value is small
    await l1.setGasConfig(10n, 20n, 30n);
    const need = 0n + 10n + 20n * 30n;

    // unpause
    const unpauseSel = new ethers.Interface(["function unpause()"]).encodeFunctionData("unpause");
    await l1.sendUnpause({ value: need });
    expect((await inbox.last()).data).to.equal(unpauseSel);

    // pause
    const pauseSel = new ethers.Interface(["function pause()"]).encodeFunctionData("pause");
    await l1.sendPause({ value: need });
    expect((await inbox.last()).data).to.equal(pauseSel);

    // setL1Governance(address)
    const to = (await ethers.getSigners())[1].address;
    const setSel = new ethers.Interface(["function setL1Governance(address)"])
      .encodeFunctionData("setL1Governance", [to]);
    await l1.sendSetL1Governance(to, { value: need });
    expect((await inbox.last()).data).to.equal(setSel);

    // callL2 passthrough
    const randomData = ethers.hexlify(ethers.randomBytes(16));
    await l1.callL2(randomData, { value: need });
    expect((await inbox.last()).data).to.equal(randomData);
  });

  it("inbox failure bubbles up (RevertingInbox)", async () => {
    const [owner, l2Refund] = await ethers.getSigners();

    const RevertingInboxF = await ethers.getContractFactory(
      "contracts/test/mock/L1HardeningMocks.sol:RevertingInbox"
    );
    const badInbox = await RevertingInboxF.deploy();
    await badInbox.waitForDeployment();

    const L1 = await ethers.getContractFactory("CrossChainGovernanceL1");
    const l1 = await L1.deploy(
      owner.address,
      await badInbox.getAddress(),
      ethers.Wallet.createRandom().address,
      l2Refund.address,
      { maxSubmissionCost: 1000n, gasLimit: 100_000n, maxFeePerGas: 1n }
    );
    await l1.waitForDeployment();

    const need = 0n + 1000n + 100_000n * 1n;

    await expect(l1.sendPause({ value: need }))
      .to.be.revertedWith("MOCK_INBOX_REVERT");
  });

  it("RetryableSent emits exact payload (sanity)", async () => {
    const { l1, inbox } = await deployAll();
    const data = ethers.hexlify(ethers.randomBytes(12));
    const l2CallValue = 7n;

    // Set gas config so we can compute required
    await l1.setGasConfig(11n, 22n, 33n);
    const required = l2CallValue + 11n + 22n * 33n;

    const tx = await l1.sendRetryable(data, l2CallValue, { value: required });
    await expect(tx)
      .to.emit(l1, "RetryableSent")
      .withArgs(
        1,                   // ticketId
        await l1.l2Target(), // to
        l2CallValue,
        11n,
        22n,
        33n,
        data
      );

    const last = await inbox.last();
    expect(last.to).to.equal(await l1.l2Target());
    expect(last.l2CallValue).to.equal(l2CallValue);
    expect(last.maxSubmissionCost).to.equal(11n);
    expect(last.gasLimit).to.equal(22n);
    expect(last.maxFeePerGas).to.equal(33n);
    expect(last.data).to.equal(data);
    expect(last.msgValue).to.equal(required);
  });

  it("rescueETH / rescueERC20 guards + happy paths", async () => {
    const { l1, deployer } = await deployAll();

    // Seed ETH then rescue
    await deployer.sendTransaction({ to: await l1.getAddress(), value: 1n });
    await expect(() => l1.rescueETH(deployer.address, 1n))
      .to.changeEtherBalance(deployer, 1n);

    await expect(l1.rescueETH(ethers.ZeroAddress, 1n))
      .to.be.revertedWithCustomError(l1, "ZeroAddress");

    // Mock ERC20 (fully-qualified path from your tree)
    const ERC20 = await ethers.getContractFactory(
      "contracts/test/harness/ERC20Mock.sol:ERC20Mock"
    );
    const mock = await ERC20.deploy(
      "Mock",
      "MOCK",
      deployer.address,
      ethers.parseEther("1000")
    );
    await mock.waitForDeployment();

    // Transfer to L1 and rescue
    await mock.transfer(await l1.getAddress(), 10n);

    await expect(
      l1.rescueERC20(await mock.getAddress(), deployer.address, 10n)
    )
      .to.emit(mock, "Transfer")
      .withArgs(await l1.getAddress(), deployer.address, 10n);

    // zero-address guards
    await expect(
      l1.rescueERC20(ethers.ZeroAddress, deployer.address, 1n)
    ).to.be.revertedWithCustomError(l1, "ZeroAddress");
    await expect(
      l1.rescueERC20(await mock.getAddress(), ethers.ZeroAddress, 1n)
    ).to.be.revertedWithCustomError(l1, "ZeroAddress");
  });
});
