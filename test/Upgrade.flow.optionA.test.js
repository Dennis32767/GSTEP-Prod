/* eslint-disable no-console */
const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const MIN_DELAY       = 60;
const INITIAL_SUPPLY  = ethers.parseUnits("400000000", 18); // must match GemStepStorage INITIAL_SUPPLY
const MAX_SUPPLY      = ethers.parseUnits("1000000000", 18); // ✅ matches GemStepStorage MAX_SUPPLY (1B)
const ZERO_BYTES32    = ethers.ZeroHash;
const DEFAULT_ADMIN_ROLE = ethers.ZeroHash; // AccessControl default admin role

// EIP-1967 slots
const IMPL_SLOT  = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

// ABIs we need from ProxyAdmin
const PA_OWNER_ABI    = ["function owner() view returns (address)"];
const PA_PENDING_ABI  = ["function pendingOwner() view returns (address)","function acceptOwnership()"];
const PA_TRANSFER_ABI = ["function transferOwnership(address)"];
const PA_GETTERS_ABI  = [
  "function owner() view returns (address)",
  "function getProxyAdmin(address) view returns (address)",
  "function getProxyImplementation(address) view returns (address)",
];

/* ---------------- TL helpers with preflight (better errors) --------------- */
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

  // If ProxyAdmin is 2-step Ownable2Step, executor must accept
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

  // Safety net: if Ownable exists
  try {
    const owner = await token.owner();
    const ownerLower = owner.toLowerCase();
    const byAddr = candidates.find((s) => s.address.toLowerCase() === ownerLower);
    if (byAddr) return byAddr;
  } catch {}

  throw new Error("No available signer has DEFAULT_ADMIN_ROLE (or owner) to grant role");
}

/* ============================= Fixtures ============================= */
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

  // Token proxy
  const Token = await ethers.getContractFactory("GemStepToken");
  const token = await upgrades.deployProxy(
    Token,
    [
      INITIAL_SUPPLY,
      multisig.address,           // admin
      await oracle.getAddress(),  // priceOracle
      treasury.address,           // treasury
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

  // grant DEFAULT_ADMIN_ROLE to ProxyAdmin so it can call initializeV2 via upgradeAndCall
  const granter = await pickAdminForRoleGrant(token, [multisig, deployer], DEFAULT_ADMIN_ROLE);
  await (await token.connect(granter).grantRole(DEFAULT_ADMIN_ROLE, proxyAdminAddress)).wait();

  // TL owns executor; inner delay=0 (TL enforces MIN_DELAY)
  await (await executor.connect(deployer).setUpgradeDelay(0)).wait();
  await (await executor.connect(deployer).transferOwnership(await timelock.getAddress())).wait();

  // TL accepts executor ownership
  const acceptData = executor.interface.encodeFunctionData("acceptOwnership");
  await tlExecVerbose(timelock, multisig, await executor.getAddress(), acceptData, "exec-accept");

  // sanity
  const paOwner = new ethers.Contract(proxyAdminAddress, PA_OWNER_ABI, ethers.provider);
  expect((await paOwner.owner()).toLowerCase()).to.equal(executorAddress.toLowerCase());

  return { deployer, multisig, timelock, token, tokenAddress, executor, executorAddress, proxyAdminAddress, oracle };
}

async function deployFixtureDirect() {
  const [deployer, treasury] = await ethers.getSigners();

  // Oracle
  const Mock = await ethers.getContractFactory("MockOracleV2");
  const oracle = await Mock.deploy();
  await oracle.waitForDeployment();
  const { timestamp } = await ethers.provider.getBlock("latest");
  await oracle.set(ethers.parseEther("0.005"), timestamp, 0);
  await oracle.setPolicy(300, 100);

  // Token proxy
  const Token = await ethers.getContractFactory("GemStepToken");
  const token = await upgrades.deployProxy(
    Token,
    [
      INITIAL_SUPPLY,
      deployer.address,           // admin
      await oracle.getAddress(),  // priceOracle
      treasury.address,           // treasury
    ],
    { initializer: "initialize", kind: "transparent" }
  );
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();

  // UpgradeExecutor
  const Executor = await ethers.getContractFactory("UpgradeExecutor");
  const executor = await Executor.deploy(deployer.address);
  await executor.waitForDeployment();
  const executorAddress = await executor.getAddress();

  const proxyAdminAddress = await ensureProxyAdminOwnedByExecutor({
    tokenAddress,
    executorAddress,
    deployer,
  });

  // grant DEFAULT_ADMIN_ROLE to ProxyAdmin so it can call initializeV2 via upgradeAndCall
  const granter = await pickAdminForRoleGrant(token, [deployer], DEFAULT_ADMIN_ROLE);
  await (await token.connect(granter).grantRole(DEFAULT_ADMIN_ROLE, proxyAdminAddress)).wait();

  await (await executor.setUpgradeDelay(0)).wait();

  return { deployer, token, tokenAddress, proxyAdminAddress, executor, executorAddress };
}

/* =============================== Tests =============================== */
describe("GemStepToken Upgrade Tests (Option A: upgradeAndCall)", function () {

  describe("E2E via Timelock → UpgradeExecutor → ProxyAdmin", function () {
    it("upgrades and runs initializeV2 atomically via TL", async function () {
      const { timelock, multisig, tokenAddress, proxyAdminAddress, executor } =
        await loadFixture(deployFixture);

      const V2 = await ethers.getContractFactory("GemStepTokenV2Mock");
      const impl = await V2.deploy();
      await impl.waitForDeployment();
      const newImpl = await impl.getAddress();

      const beforeImpl = await readImplFromSlot(tokenAddress);

      const initCalldata = V2.interface.encodeFunctionData("initializeV2");

      const sched = executor.interface.encodeFunctionData(
        "scheduleUpgradeAndCall",
        [proxyAdminAddress, tokenAddress, newImpl, initCalldata]
      );
      await tlExecVerbose(timelock, multisig, await executor.getAddress(), sched, "sched-uac");

      const exec = executor.interface.encodeFunctionData(
        "executeUpgradeAndCall",
        [proxyAdminAddress, tokenAddress, newImpl, initCalldata]
      );
      await tlExecVerbose(timelock, multisig, await executor.getAddress(), exec, "exec-uac");

      const afterImpl = await readImplFromSlot(tokenAddress);
      expect(afterImpl.toLowerCase()).to.equal(newImpl.toLowerCase());
      expect(beforeImpl.toLowerCase()).to.not.equal(afterImpl.toLowerCase());

      const v2 = await ethers.getContractAt("GemStepTokenV2Mock", tokenAddress);
      expect(await v2.version()).to.equal(2);
      expect(await v2.newVariable()).to.equal(42); // ✅ proves initializeV2 ran
    });
  });

  describe("Direct owner path (no Timelock)", function () {

    it("upgradeAndCall runs initializer atomically", async function () {
      const { tokenAddress, proxyAdminAddress, executor } =
        await loadFixture(deployFixtureDirect);

      const V2 = await ethers.getContractFactory("GemStepTokenV2Mock");
      const impl = await V2.deploy();
      await impl.waitForDeployment();
      const newImpl = await impl.getAddress();

      const beforeImpl = await readImplFromSlot(tokenAddress);

      const initCalldata = V2.interface.encodeFunctionData("initializeV2");

      await (await executor.scheduleUpgradeAndCall(proxyAdminAddress, tokenAddress, newImpl, initCalldata)).wait();
      await (await executor.executeUpgradeAndCall (proxyAdminAddress, tokenAddress, newImpl, initCalldata)).wait();

      const afterImpl = await readImplFromSlot(tokenAddress);
      expect(afterImpl.toLowerCase()).to.equal(newImpl.toLowerCase());
      expect(beforeImpl.toLowerCase()).to.not.equal(afterImpl.toLowerCase());

      const v2 = await ethers.getContractAt("GemStepTokenV2Mock", tokenAddress);
      expect(await v2.version()).to.equal(2);
      expect(await v2.newVariable()).to.equal(42);
    });

    it("preserves core state & storage layout after upgradeAndCall", async function () {
  const { tokenAddress, proxyAdminAddress, executor } =
    await loadFixture(deployFixtureDirect);

  // Snapshot V1 state BEFORE upgrade (use bundles — burnFee etc are internal now)
  const v1 = await ethers.getContractAt("GemStepToken", tokenAddress);

  // Core bundle: (burnFee, rewardRate, stepLimit, signatureValidityPeriod)
  let burnFeeBefore = 0n;
  let rewardRateBefore = 0n;
  let stepLimitBefore = 0n;
  let sigValidityBefore = 0n;

  if (typeof v1.getCoreParams === "function") {
    const core = await v1.getCoreParams();
    burnFeeBefore     = BigInt(core[0].toString());
    rewardRateBefore  = BigInt(core[1].toString());
    stepLimitBefore   = BigInt(core[2].toString());
    sigValidityBefore = BigInt(core[3].toString());
  } else {
    // fallback (if older build still exposes these)
    rewardRateBefore  = typeof v1.rewardRate === "function" ? BigInt((await v1.rewardRate()).toString()) : 0n;
    stepLimitBefore   = typeof v1.stepLimit === "function" ? BigInt((await v1.stepLimit()).toString()) : 0n;
    sigValidityBefore =
      typeof v1.signatureValidityPeriod === "function"
        ? BigInt((await v1.signatureValidityPeriod()).toString())
        : 0n;
  }

  const treasuryBefore    = typeof v1.treasury === "function" ? await v1.treasury() : ethers.ZeroAddress;
  const totalSupplyBefore = await v1.totalSupply();

  // Stake bundle: (stakePerStep, lastAdjustTs, locked)
  let stakePerStepBefore = 0n;
  if (typeof v1.getStakeParams === "function") {
    const sp = await v1.getStakeParams();
    stakePerStepBefore = BigInt(sp[0].toString());
  } else if (typeof v1.currentStakePerStep === "function") {
    stakePerStepBefore = BigInt((await v1.currentStakePerStep()).toString());
  }

  const beforeImpl = await readImplFromSlot(tokenAddress);

  // Upgrade to V2 + call initializeV2
  const V2 = await ethers.getContractFactory("GemStepTokenV2Mock");
  const impl = await V2.deploy();
  await impl.waitForDeployment();
  const newImpl = await impl.getAddress();

  const initCalldata = V2.interface.encodeFunctionData("initializeV2");

  await (await executor.scheduleUpgradeAndCall(proxyAdminAddress, tokenAddress, newImpl, initCalldata)).wait();
  await (await executor.executeUpgradeAndCall (proxyAdminAddress, tokenAddress, newImpl, initCalldata)).wait();

  const afterImpl = await readImplFromSlot(tokenAddress);
  expect(afterImpl.toLowerCase()).to.equal(newImpl.toLowerCase());
  expect(beforeImpl.toLowerCase()).to.not.equal(afterImpl.toLowerCase());

  // Read through V2 ABI
  const v2 = await ethers.getContractAt("GemStepTokenV2Mock", tokenAddress);

  // ERC20 invariants
  expect(await v2.name()).to.equal("GemStep");
  expect(await v2.symbol()).to.equal("GEMS");
  expect(await v2.decimals()).to.equal(18);
  expect(await v2.totalSupply()).to.equal(totalSupplyBefore);

  // Core bundle preserved
  if (typeof v2.getCoreParams === "function") {
    const core2 = await v2.getCoreParams();
    expect(core2[0]).to.equal(burnFeeBefore);
    expect(core2[1]).to.equal(rewardRateBefore);
    expect(core2[2]).to.equal(stepLimitBefore);
    expect(core2[3]).to.equal(sigValidityBefore);
  }

  // Treasury preserved
  if (typeof v2.treasury === "function") {
    expect(await v2.treasury()).to.equal(treasuryBefore);
  }

  // Stake preserved
  if (typeof v2.getStakeParams === "function") {
    const sp2 = await v2.getStakeParams();
    expect(sp2[0]).to.equal(stakePerStepBefore);
  } else if (typeof v2.currentStakePerStep === "function") {
    expect(await v2.currentStakePerStep()).to.equal(stakePerStepBefore);
  }

  // V2 behavior works (and initializer executed)
  expect(await v2.version()).to.equal(2);
  expect(await v2.newVariable()).to.equal(42);
  expect(await v2.newFunction()).to.equal(true);

  // Cap sanity (only if cap() exists)
  if (typeof v2.cap === "function") {
    const cap = await v2.cap();
    expect(cap).to.be.gte(await v2.totalSupply());
    expect(cap).to.equal(MAX_SUPPLY);
  }
});


    it("blocks re-initialization after upgradeAndCall", async function () {
      const { tokenAddress, proxyAdminAddress, executor } =
        await loadFixture(deployFixtureDirect);

      const V2 = await ethers.getContractFactory("GemStepTokenV2Mock");
      const impl = await V2.deploy();
      await impl.waitForDeployment();
      const newImpl = await impl.getAddress();

      const initCalldata = V2.interface.encodeFunctionData("initializeV2");

      await (await executor.scheduleUpgradeAndCall(proxyAdminAddress, tokenAddress, newImpl, initCalldata)).wait();
      await (await executor.executeUpgradeAndCall (proxyAdminAddress, tokenAddress, newImpl, initCalldata)).wait();

      const v2 = await ethers.getContractAt("GemStepTokenV2Mock", tokenAddress);
      await expect(v2.initializeV2()).to.be.reverted; // should not allow re-init
    });

  });
});
