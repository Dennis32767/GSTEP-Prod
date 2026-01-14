/* eslint-disable no-console */
const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const MIN_DELAY = 60;

// ✅ Match GemStepStorage constants
const INITIAL_SUPPLY = ethers.parseUnits("400000000", 18);
const MAX_SUPPLY     = ethers.parseUnits("1000000000", 18);

const ZERO_BYTES32 = ethers.ZeroHash;
const DEFAULT_ADMIN_ROLE = ethers.ZeroHash; // AccessControl default admin role

// EIP-1967 slots
const IMPL_SLOT  = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

// Minimal ABIs we need from ProxyAdmin
const PA_OWNER_ABI    = ["function owner() view returns (address)"];
const PA_PENDING_ABI  = ["function pendingOwner() view returns (address)","function acceptOwnership()"];
const PA_TRANSFER_ABI = ["function transferOwnership(address)"];
const PA_GETTERS_ABI  = [
  "function owner() view returns (address)",
  "function getProxyAdmin(address) view returns (address)",
  "function getProxyImplementation(address) view returns (address)",
];

/* ---------------- TL helpers with a preflight for clearer errors --------------- */
function makeSalt(label = "") {
  return ethers.keccak256(ethers.toUtf8Bytes(label || `${Date.now()}-${Math.random()}`));
}
async function tlSchedule(tl, proposer, target, data, salt, delay) {
  await tl.connect(proposer).schedule(target, 0, data, ZERO_BYTES32, salt, delay);
}
async function tlExecVerbose(tl, multisig, target, data, label, delay = MIN_DELAY) {
  const salt = makeSalt(label);
  await tlSchedule(tl, multisig, target, data, salt, delay);
  await time.increase(delay + 1);

  const exec = tl.connect(multisig).getFunction("execute");
  try {
    await exec.staticCall(target, 0n, data, ZERO_BYTES32, salt);
  } catch (e) {
    const msg =
      e?.error?.data?.message ||
      e?.data?.message ||
      e?.shortMessage ||
      e?.reason ||
      e?.message ||
      "no reason";
    console.log(`[TL ${label}] callStatic reverted →`, msg);
    throw e;
  }

  const tx = await exec(target, 0n, data, ZERO_BYTES32, salt);
  const rcpt = await tx.wait();
  console.log(`[TL ${label}] executed, gasUsed=`, rcpt.gasUsed.toString());
  return rcpt;
}

/* ------------------- EIP-1967 storage readers ------------------- */
async function readStorage32(addr, slot) {
  return ethers.provider.send("eth_getStorageAt", [addr, slot, "latest"]);
}
function toAddressFromWord(word32) {
  return ethers.getAddress("0x" + word32.slice(26));
}
async function readImplFromSlot(proxyAddr) {
  return toAddressFromWord(await readStorage32(proxyAddr, IMPL_SLOT));
}
async function readAdminFromSlot(proxyAddr) {
  return toAddressFromWord(await readStorage32(proxyAddr, ADMIN_SLOT));
}

/* -------- Ensure ProxyAdmin is owned by UpgradeExecutor -------- */
async function ensureProxyAdminOwnedByExecutor({ tokenAddress, executorAddress, deployer }) {
  const adminFromSlot = await readAdminFromSlot(tokenAddress);

  // Best-effort sanity (if getter exists)
  try {
    const paGetters = new ethers.Contract(adminFromSlot, PA_GETTERS_ABI, ethers.provider);
    const who = await paGetters.getProxyAdmin(tokenAddress);
    console.log("ProxyAdmin.getProxyAdmin(proxy) =", who);
    expect(who.toLowerCase()).to.equal(adminFromSlot.toLowerCase());
  } catch {
    console.log("ProxyAdmin.getProxyAdmin unavailable — relying on EIP-1967 slot read.");
  }

  const paOwnerReader = new ethers.Contract(adminFromSlot, PA_OWNER_ABI, ethers.provider);
  const beforeOwner   = await paOwnerReader.owner();
  if (beforeOwner.toLowerCase() === executorAddress.toLowerCase()) {
    return adminFromSlot;
  }

  // 1-step or 2-step handoff to the executor
  const paTransfer = new ethers.Contract(adminFromSlot, PA_TRANSFER_ABI, deployer);
  await (await paTransfer.transferOwnership(executorAddress)).wait();

  // If ProxyAdmin is Ownable2Step, executor must accept
  try {
    const paTwoStep = new ethers.Contract(adminFromSlot, PA_PENDING_ABI, ethers.provider);
    const pending = await paTwoStep.pendingOwner();
    if (pending && pending.toLowerCase() === executorAddress.toLowerCase()) {
      const Executor = await ethers.getContractFactory("UpgradeExecutor");
      const executor = Executor.attach(executorAddress);
      await (await executor.connect(deployer).claimProxyAdminOwnership(adminFromSlot)).wait();
    }
  } catch { /* non 2-step */ }

  const afterOwner = await paOwnerReader.owner();
  expect(afterOwner.toLowerCase()).to.equal(executorAddress.toLowerCase());
  return adminFromSlot;
}

/* ------------------ helper: pick whoever can grant role ------------------ */
async function pickAdminForRoleGrant(token, candidates, role) {
  for (const s of candidates) {
    try {
      if (await token.hasRole(role, s.address)) return s;
    } catch {}
  }

  // Safety net if Ownable exists
  try {
    const owner = await token.owner();
    const ownerLower = owner.toLowerCase();
    const byAddr = candidates.find((s) => s.address.toLowerCase() === ownerLower);
    if (byAddr) return byAddr;
  } catch {}

  throw new Error("No available signer has DEFAULT_ADMIN_ROLE (or owner) to grant role");
}

/* ============================= Fixtures ============================= */
// E2E (Timelock → UpgradeExecutor → ProxyAdmin) — ✅ pass 4 initializer args
async function deployFixture() {
  const [deployer, multisig, treasury] = await ethers.getSigners();

  // Timelock
  const Timelock = await ethers.getContractFactory("TimelockController");
  const timelock = await Timelock.deploy(
    MIN_DELAY,
    [multisig.address],
    [multisig.address],
    deployer.address
  );
  await timelock.waitForDeployment();

  // Oracle
  const Mock = await ethers.getContractFactory("MockOracleV2");
  const oracle = await Mock.deploy();
  await oracle.waitForDeployment();
  const { timestamp } = await ethers.provider.getBlock("latest");
  await oracle.set(ethers.parseEther("0.005"), timestamp, 0);
  await oracle.setPolicy(300, 100);

  // Token proxy (✅ 4 args: initialSupply, admin, oracle, treasury)
  const Token = await ethers.getContractFactory("GemStepToken");
  const token = await upgrades.deployProxy(
    Token,
    [
      INITIAL_SUPPLY,
      multisig.address,
      await oracle.getAddress(),
      treasury.address,
    ],
    { initializer: "initialize", kind: "transparent", timeout: 180000 }
  );
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();

  // UpgradeExecutor
  const Executor = await ethers.getContractFactory("UpgradeExecutor");
  const executor = await Executor.deploy(deployer.address);
  await executor.waitForDeployment();
  const executorAddress = await executor.getAddress();

  // Ensure ProxyAdmin → executor
  const proxyAdminAddress = await ensureProxyAdminOwnedByExecutor({
    tokenAddress,
    executorAddress,
    deployer,
  });

  // Grant DEFAULT_ADMIN_ROLE to ProxyAdmin so initializeV2 can run during upgradeAndCall
  const granter = await pickAdminForRoleGrant(token, [multisig, deployer], DEFAULT_ADMIN_ROLE);
  await (await token.connect(granter).grantRole(DEFAULT_ADMIN_ROLE, proxyAdminAddress)).wait();

  // TL owns executor; inner delay=0 (TL enforces MIN_DELAY)
  await (await executor.connect(deployer).setUpgradeDelay(0)).wait();
  await (await executor.connect(deployer).transferOwnership(await timelock.getAddress())).wait();

  // TL accepts executor ownership
  const acceptData = executor.interface.encodeFunctionData("acceptOwnership");
  await tlExecVerbose(timelock, multisig, await executor.getAddress(), acceptData, "exec-accept");

  return { deployer, multisig, treasury, timelock, token, tokenAddress, executor, executorAddress, proxyAdminAddress, oracle };
}

// Direct owner path (no TL) — ✅ pass 4 initializer args
async function deployFixtureDirect() {
  const [deployer, treasury] = await ethers.getSigners();

  // Oracle
  const Mock = await ethers.getContractFactory("MockOracleV2");
  const oracle = await Mock.deploy();
  await oracle.waitForDeployment();
  const { timestamp } = await ethers.provider.getBlock("latest");
  await oracle.set(ethers.parseEther("0.005"), timestamp, 0);
  await oracle.setPolicy(300, 100);

  const Token = await ethers.getContractFactory("GemStepToken");
  const token = await upgrades.deployProxy(
    Token,
    [
      INITIAL_SUPPLY,
      deployer.address,
      await oracle.getAddress(),
      treasury.address,
    ],
    { initializer: "initialize", kind: "transparent" }
  );
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();

  const Executor = await ethers.getContractFactory("UpgradeExecutor");
  const executor = await Executor.deploy(deployer.address);
  await executor.waitForDeployment();
  const executorAddress = await executor.getAddress();

  const proxyAdminAddress = await ensureProxyAdminOwnedByExecutor({
    tokenAddress,
    executorAddress,
    deployer,
  });

  // Grant DEFAULT_ADMIN_ROLE to ProxyAdmin so initializeV2 can run during upgradeAndCall
  const granter = await pickAdminForRoleGrant(token, [deployer], DEFAULT_ADMIN_ROLE);
  await (await token.connect(granter).grantRole(DEFAULT_ADMIN_ROLE, proxyAdminAddress)).wait();

  await (await executor.setUpgradeDelay(0)).wait();

  return { deployer, treasury, token, tokenAddress, proxyAdminAddress, executor, executorAddress, oracle };
}

/* =============================== Tests =============================== */

describe("GemStepToken Upgrade Tests (Timelock → UpgradeExecutor → ProxyAdmin)", function () {
  describe("Upgrade Process", function () {
    it("completes a full upgrade via Timelock → UpgradeExecutor (atomic upgradeAndCall)", async function () {
      const { timelock, multisig, tokenAddress, proxyAdminAddress, executor } =
        await loadFixture(deployFixture);

      const V2 = await ethers.getContractFactory("GemStepTokenV2Mock");
      const v2Impl = await V2.deploy();
      await v2Impl.waitForDeployment();
      const newImpl = await v2Impl.getAddress();

      const beforeImpl = await readImplFromSlot(tokenAddress);

      const initCalldata = V2.interface.encodeFunctionData("initializeV2");

      // schedule & execute upgradeAndCall via TL (executor owner = timelock)
      const scheduleData = executor.interface.encodeFunctionData(
        "scheduleUpgradeAndCall",
        [proxyAdminAddress, tokenAddress, newImpl, initCalldata]
      );
      await tlExecVerbose(timelock, multisig, await executor.getAddress(), scheduleData, "sched-uac");

      const executeData = executor.interface.encodeFunctionData(
        "executeUpgradeAndCall",
        [proxyAdminAddress, tokenAddress, newImpl, initCalldata]
      );
      await tlExecVerbose(timelock, multisig, await executor.getAddress(), executeData, "exec-uac");

      const afterImpl = await readImplFromSlot(tokenAddress);
      expect(afterImpl.toLowerCase()).to.equal(newImpl.toLowerCase());
      expect(beforeImpl.toLowerCase()).to.not.equal(afterImpl.toLowerCase());

      const v2 = await ethers.getContractAt("GemStepTokenV2Mock", tokenAddress);
      expect(await v2.version()).to.equal(2);
      expect(await v2.newVariable()).to.equal(42); // proves initializeV2 ran inside upgradeAndCall
    });

    it("direct ProxyAdmin.upgradeAndCall via executor (no TL)", async function () {
      const { tokenAddress, proxyAdminAddress, executor } =
        await loadFixture(deployFixtureDirect);

      const V2 = await ethers.getContractFactory("GemStepTokenV2Mock");
      const v2Impl = await V2.deploy();
      await v2Impl.waitForDeployment();
      const newImpl = await v2Impl.getAddress();

      const beforeImpl = await readImplFromSlot(tokenAddress);

      const initCalldata = V2.interface.encodeFunctionData("initializeV2");

      await (await executor.scheduleUpgradeAndCall(proxyAdminAddress, tokenAddress, newImpl, initCalldata)).wait();
      await (await executor.executeUpgradeAndCall(proxyAdminAddress, tokenAddress, newImpl, initCalldata)).wait();

      const afterImpl = await readImplFromSlot(tokenAddress);
      expect(afterImpl.toLowerCase()).to.equal(newImpl.toLowerCase());
      expect(beforeImpl.toLowerCase()).to.not.equal(afterImpl.toLowerCase());

      const v2 = await ethers.getContractAt("GemStepTokenV2Mock", tokenAddress);
      expect(await v2.version()).to.equal(2);
      expect(await v2.newVariable()).to.equal(42);
    });

    it("rejects unauthorized direct upgrades (caller is not executor owner)", async function () {
      const { tokenAddress, proxyAdminAddress, executor, multisig } =
        await loadFixture(deployFixture);

      const V2 = await ethers.getContractFactory("GemStepTokenV2Mock");
      const v2Impl = await V2.deploy();
      await v2Impl.waitForDeployment();
      const newImpl = await v2Impl.getAddress();

      const initCalldata = V2.interface.encodeFunctionData("initializeV2");

      await expect(
        executor.connect(multisig).executeUpgradeAndCall(proxyAdminAddress, tokenAddress, newImpl, initCalldata)
      ).to.be.reverted; // onlyOwner (owner is Timelock)
    });

    it("preserves existing functionality after upgrade (atomic path)", async function () {
      const { timelock, multisig, tokenAddress, proxyAdminAddress, executor } =
        await loadFixture(deployFixture);

      // snapshot V1 values
      const v1 = await ethers.getContractAt("GemStepToken", tokenAddress);
      const nameBefore = await v1.name();
      const symbolBefore = await v1.symbol();
      const supplyBefore = await v1.totalSupply();

      const V2 = await ethers.getContractFactory("GemStepTokenV2Mock");
      const v2Impl = await V2.deploy();
      await v2Impl.waitForDeployment();
      const newImpl = await v2Impl.getAddress();

      const initCalldata = V2.interface.encodeFunctionData("initializeV2");

      const scheduleData = executor.interface.encodeFunctionData(
        "scheduleUpgradeAndCall",
        [proxyAdminAddress, tokenAddress, newImpl, initCalldata]
      );
      const executeData = executor.interface.encodeFunctionData(
        "executeUpgradeAndCall",
        [proxyAdminAddress, tokenAddress, newImpl, initCalldata]
      );

      await tlExecVerbose(timelock, multisig, await executor.getAddress(), scheduleData, "sched");
      await tlExecVerbose(timelock, multisig, await executor.getAddress(), executeData, "exec");

      const v2 = await ethers.getContractAt("GemStepTokenV2Mock", tokenAddress);

      expect(await v2.name()).to.equal(nameBefore);
      expect(await v2.symbol()).to.equal(symbolBefore);
      expect(await v2.totalSupply()).to.equal(supplyBefore);

      expect(await v2.version()).to.equal(2);
      expect(await v2.newVariable()).to.equal(42);
    });

    it("initializes new V2 features and prevents re-init (atomic path)", async function () {
      const { timelock, multisig, tokenAddress, proxyAdminAddress, executor } =
        await loadFixture(deployFixture);

      const V2 = await ethers.getContractFactory("GemStepTokenV2Mock");
      const v2Impl = await V2.deploy();
      await v2Impl.waitForDeployment();
      const newImpl = await v2Impl.getAddress();

      const initCalldata = V2.interface.encodeFunctionData("initializeV2");

      const scheduleData = executor.interface.encodeFunctionData(
        "scheduleUpgradeAndCall",
        [proxyAdminAddress, tokenAddress, newImpl, initCalldata]
      );
      const executeData = executor.interface.encodeFunctionData(
        "executeUpgradeAndCall",
        [proxyAdminAddress, tokenAddress, newImpl, initCalldata]
      );

      await tlExecVerbose(timelock, multisig, await executor.getAddress(), scheduleData, "sched");
      await tlExecVerbose(timelock, multisig, await executor.getAddress(), executeData, "exec");

      const v2 = await ethers.getContractAt("GemStepTokenV2Mock", tokenAddress);
      expect(await v2.newFunction()).to.equal(true);
      await expect(v2.initializeV2()).to.be.reverted; // Already initialized
    });
  });

  describe("Post-Upgrade Validation", function () {
    it("maintains storage layout and key slots", async function () {
      const { timelock, multisig, tokenAddress, proxyAdminAddress, executor } =
        await loadFixture(deployFixture);

      // Snapshot key storage BEFORE upgrade (layout proof)
      const v1 = await ethers.getContractAt("GemStepToken", tokenAddress);
      const burnFeeBefore     = await v1.burnFee();
      const rewardRateBefore  = await v1.rewardRate();
      const stepLimitBefore   = await v1.stepLimit();
      const sigValidBefore    = await v1.signatureValidityPeriod();
      const treasuryBefore    = await v1.treasury();
      const stakeBefore       = await v1.currentStakePerStep();
      const supplyBefore      = await v1.totalSupply();
      const beforeImpl        = await readImplFromSlot(tokenAddress);
      const adminSlotBefore   = await readAdminFromSlot(tokenAddress);

      const V2 = await ethers.getContractFactory("GemStepTokenV2Mock");
      const v2Impl = await V2.deploy();
      await v2Impl.waitForDeployment();
      const newImpl = await v2Impl.getAddress();

      const initCalldata = V2.interface.encodeFunctionData("initializeV2");

      const scheduleData = executor.interface.encodeFunctionData(
        "scheduleUpgradeAndCall",
        [proxyAdminAddress, tokenAddress, newImpl, initCalldata]
      );
      const executeData = executor.interface.encodeFunctionData(
        "executeUpgradeAndCall",
        [proxyAdminAddress, tokenAddress, newImpl, initCalldata]
      );

      await tlExecVerbose(timelock, multisig, await executor.getAddress(), scheduleData, "sched");
      await tlExecVerbose(timelock, multisig, await executor.getAddress(), executeData, "exec");

      const v2 = await ethers.getContractAt("GemStepTokenV2Mock", tokenAddress);

      // Key slot/admin slot stable for transparent proxy
      const adminSlotAfter = await readAdminFromSlot(tokenAddress);
      expect(adminSlotAfter.toLowerCase()).to.equal(adminSlotBefore.toLowerCase());

      const afterImpl = await readImplFromSlot(tokenAddress);
      expect(afterImpl.toLowerCase()).to.equal(newImpl.toLowerCase());
      expect(afterImpl.toLowerCase()).to.not.equal(beforeImpl.toLowerCase());

      // Layout preserved
      expect(await v2.burnFee()).to.equal(burnFeeBefore);
      expect(await v2.rewardRate()).to.equal(rewardRateBefore);
      expect(await v2.stepLimit()).to.equal(stepLimitBefore);
      expect(await v2.signatureValidityPeriod()).to.equal(sigValidBefore);
      expect(await v2.treasury()).to.equal(treasuryBefore);
      expect(await v2.currentStakePerStep()).to.equal(stakeBefore);
      expect(await v2.totalSupply()).to.equal(supplyBefore);

      // Cap should be MAX_SUPPLY from your storage/erc20capped
      expect(await v2.cap()).to.equal(MAX_SUPPLY);
      expect(await v2.newVariable()).to.equal(42);
    });

    it("emits UpgradeExecutedWithData during the upgrade", async function () {
      const { timelock, multisig, tokenAddress, proxyAdminAddress, executor } =
        await loadFixture(deployFixture);

      const V2 = await ethers.getContractFactory("GemStepTokenV2Mock");
      const v2Impl = await V2.deploy();
      await v2Impl.waitForDeployment();
      const newImpl = await v2Impl.getAddress();

      const initCalldata = V2.interface.encodeFunctionData("initializeV2");

      // schedule via timelock
      const scheduleData = executor.interface.encodeFunctionData(
        "scheduleUpgradeAndCall",
        [proxyAdminAddress, tokenAddress, newImpl, initCalldata]
      );
      const schedSalt = makeSalt("sched-emit");
      await tlSchedule(timelock, multisig, await executor.getAddress(), scheduleData, schedSalt, MIN_DELAY);
      await time.increase(MIN_DELAY + 1);
      await timelock.connect(multisig).execute(await executor.getAddress(), 0, scheduleData, ZERO_BYTES32, schedSalt);

      // execute via timelock (expect event on executor)
      const executeData = executor.interface.encodeFunctionData(
        "executeUpgradeAndCall",
        [proxyAdminAddress, tokenAddress, newImpl, initCalldata]
      );
      const execSalt = makeSalt("exec-emit");
      await tlSchedule(timelock, multisig, await executor.getAddress(), executeData, execSalt, MIN_DELAY);
      await time.increase(MIN_DELAY + 1);

      await expect(
        timelock.connect(multisig).execute(await executor.getAddress(), 0, executeData, ZERO_BYTES32, execSalt)
      )
        .to.emit(executor, "UpgradeExecutedWithData")
        .withArgs(proxyAdminAddress, tokenAddress, newImpl, initCalldata);
    });
  });
  it("keeps ProxyAdmin ownership with the UpgradeExecutor", async function () {
  const { timelock, multisig, tokenAddress, proxyAdminAddress, executor, executorAddress } =
    await loadFixture(deployFixture);

  const V2 = await ethers.getContractFactory("GemStepTokenV2Mock");
  const v2Impl = await V2.deploy(); await v2Impl.waitForDeployment();
  const newImpl = await v2Impl.getAddress();
  const initCalldata = V2.interface.encodeFunctionData("initializeV2");

  const scheduleData = executor.interface.encodeFunctionData(
    "scheduleUpgradeAndCall", [proxyAdminAddress, tokenAddress, newImpl, initCalldata]
  );
  const executeData = executor.interface.encodeFunctionData(
    "executeUpgradeAndCall", [proxyAdminAddress, tokenAddress, newImpl, initCalldata]
  );

  await tlExecVerbose(timelock, multisig, await executor.getAddress(), scheduleData, "sched");
  await tlExecVerbose(timelock, multisig, await executor.getAddress(), executeData, "exec");

  const paOwner = new ethers.Contract(proxyAdminAddress, PA_OWNER_ABI, ethers.provider);
  expect((await paOwner.owner()).toLowerCase()).to.equal(executorAddress.toLowerCase());
});

it("keeps the EIP-1967 admin slot unchanged across upgrade", async function () {
  const { timelock, multisig, tokenAddress, proxyAdminAddress, executor } =
    await loadFixture(deployFixture);

  const adminBefore = await readAdminFromSlot(tokenAddress);

  const V2 = await ethers.getContractFactory("GemStepTokenV2Mock");
  const v2Impl = await V2.deploy(); await v2Impl.waitForDeployment();
  const newImpl = await v2Impl.getAddress();
  const initCalldata = V2.interface.encodeFunctionData("initializeV2");

  const scheduleData = executor.interface.encodeFunctionData(
    "scheduleUpgradeAndCall", [proxyAdminAddress, tokenAddress, newImpl, initCalldata]
  );
  const executeData = executor.interface.encodeFunctionData(
    "executeUpgradeAndCall", [proxyAdminAddress, tokenAddress, newImpl, initCalldata]
  );

  await tlExecVerbose(timelock, multisig, await executor.getAddress(), scheduleData, "sched");
  await tlExecVerbose(timelock, multisig, await executor.getAddress(), executeData, "exec");

  const adminAfter = await readAdminFromSlot(tokenAddress);
  expect(adminAfter.toLowerCase()).to.equal(adminBefore.toLowerCase());
});

});
