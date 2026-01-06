// test/CrossChainGovernanceL1.spec.js
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("CrossChainGovernanceL1 (real contract)", function () {
  async function deployAll() {
    const [deployer, other, pending, refundL2] = await ethers.getSigners();

    const Inbox = await ethers.getContractFactory("InboxMock");
    const inbox = await Inbox.deploy();

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

    return { l1, inbox, deployer, other, pending, refundL2, GasCfg, L2_TARGET };
  }

  it("Ownable2Step: transfer/accept and reverts", async () => {
    const { l1, deployer, pending } = await deployAll();

    await expect(l1.connect(pending).acceptOwnership())
      .to.be.revertedWithCustomError(l1, "NotPendingOwner");

    await expect(l1.connect(deployer).transferOwnership(pending.address))
      .to.emit(l1, "OwnershipTransferStarted")
      .withArgs(deployer.address, pending.address);

    await expect(l1.connect(pending).acceptOwnership())
      .to.emit(l1, "OwnershipTransferred")
      .withArgs(deployer.address, pending.address);

    await expect(l1.connect(deployer).setGasConfig(1, 2, 3))
      .to.be.revertedWithCustomError(l1, "NotOwner");
  });

  it("quoteRetryable math (constructor enforces non-zero inbox)", async () => {
    const { l1 } = await deployAll();

    const l2Value = 5n;
    const [total, subFee, gasFee] = await l1.quoteRetryable("0x", l2Value);
    expect(subFee).to.equal(11n);
    expect(gasFee).to.equal(22n * 33n);
    expect(total).to.equal(l2Value + subFee + gasFee);

    // NOTE: InboxNotSet() branch is unreachable in production because
    // the constructor requires a non-zero inbox. We intentionally do not test it.
  });

  it("sendRetryable: MsgValueTooLow numbers", async () => {
    const { other } = await deployAll();
    const [deployer, refund] = await ethers.getSigners();

    const Inbox = await ethers.getContractFactory("InboxMock");
    const inbox = await Inbox.deploy();

    // Properly configured deployment
    const L1 = await ethers.getContractFactory("CrossChainGovernanceL1");
    const l1 = await L1.deploy(
      deployer.address,
      await inbox.getAddress(),
      other.address,       // non-zero l2Target
      refund.address,
      { maxSubmissionCost: 11n, gasLimit: 22n, maxFeePerGas: 33n }
    );

    const need = 0n + 11n + (22n * 33n);
    await expect(l1.sendRetryable("0x1234", 0, { value: need - 1n }))
      .to.be.revertedWithCustomError(l1, "MsgValueTooLow")
      .withArgs(need, need - 1n);
  });

  it("sendRetryable: exact params reach Inbox and RetryableSent emits", async () => {
    const { l1, inbox, L2_TARGET } = await deployAll();
    const data = ethers.hexlify(ethers.randomBytes(12));
    const l2CallValue = 7n;
    const required = l2CallValue + 11n + (22n * 33n);

    const tx = await l1.sendRetryable(data, l2CallValue, { value: required });
    await expect(tx)
      .to.emit(l1, "RetryableSent")
      .withArgs(
        1,        // InboxMock returns incremental ids starting from 1
        L2_TARGET,
        l2CallValue,
        11n,
        22n,
        33n,
        data
      );

    const last = await inbox.last();
    expect(last.to).to.equal(L2_TARGET);
    expect(last.l2CallValue).to.equal(l2CallValue);
    expect(last.maxSubmissionCost).to.equal(11n);
    expect(last.excessFeeRefundAddress).to.equal(await l1.refundL2());
    expect(last.callValueRefundAddress).to.equal(await l1.refundL2());
    expect(last.gasLimit).to.equal(22n);
    expect(last.maxFeePerGas).to.equal(33n);
    expect(last.data).to.equal(data);
    expect(last.msgValue).to.equal(required);
  });

  it("callL2 + wrappers (pause/unpause/setL1Governance) compose correctly", async () => {
    const { l1, inbox } = await deployAll();
    const required = 11n + (22n * 33n);

    const unpauseSel = new ethers.Interface(["function unpause()"]).encodeFunctionData("unpause");
    await l1.callL2(unpauseSel, { value: required });
    expect((await inbox.last()).data).to.equal(unpauseSel);

    const pauseSel = new ethers.Interface(["function pause()"]).encodeFunctionData("pause");
    await l1.sendPause({ value: required });
    expect((await inbox.last()).data).to.equal(pauseSel);

    await l1.sendUnpause({ value: required });
    expect((await inbox.last()).data).to.equal(unpauseSel);

    const to = (await ethers.getSigners())[1].address;
    const setSel = new ethers.Interface(["function setL1Governance(address)"])
      .encodeFunctionData("setL1Governance", [to]);
    await l1.sendSetL1Governance(to, { value: required });
    expect((await inbox.last()).data).to.equal(setSel);
  });

  it("rescueETH / rescueERC20", async () => {
  const { l1, deployer } = await deployAll();

  // ---- seed ETH & rescue ----
  await deployer.sendTransaction({ to: await l1.getAddress(), value: 1n });

  await expect(() => l1.rescueETH(deployer.address, 1n))
    .to.changeEtherBalance(deployer, 1n);

  await expect(l1.rescueETH(ethers.ZeroAddress, 1n))
    .to.be.revertedWithCustomError(l1, "ZeroAddress");

  // ---- deploy mock ERC20 ----
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

  // fund L1 with tokens then rescue
  await mock.transfer(await l1.getAddress(), 10n);

  await expect(
    l1.rescueERC20(await mock.getAddress(), deployer.address, 10n)
  )
    .to.emit(mock, "Transfer")
    .withArgs(await l1.getAddress(), deployer.address, 10n);
});

});
