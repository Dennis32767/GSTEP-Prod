/* eslint-disable no-console */
const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

/* ---------------- constants & helpers ---------------- */
const MIN_DELAY          = 60;
const INITIAL_SUPPLY     = ethers.parseUnits("400000000",18);
const ZERO_BYTES32       = ethers.ZeroHash;
const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;

// EIP-1967 slots
const IMPL_SLOT  = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

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

function makeSalt(label = "") {
  return ethers.keccak256(ethers.toUtf8Bytes(label || `${Date.now()}-${Math.random()}`));
}

async function tlSchedule(tl, proposer, target, data, salt, delay) {
  await tl.connect(proposer).schedule(target, 0, data, ZERO_BYTES32, salt, delay);
}
async function tlExecute(tl, executor, target, data, salt) {
  const exec = tl.connect(executor).getFunction("execute");
  return exec(target, 0n, data, ZERO_BYTES32, salt);
}

/* ---- ProxyAdmin ownership helpers ---- */
const PA_OWNER_ABI    = ["function owner() view returns (address)"];
const PA_PENDING_ABI  = ["function pendingOwner() view returns (address)","function acceptOwnership()"];
const PA_TRANSFER_ABI = ["function transferOwnership(address)"];
const PA_GETTERS_ABI  = [
  "function owner() view returns (address)",
  "function getProxyAdmin(address) view returns (address)",
  "function getProxyImplementation(address) view returns (address)",
];

async function ensureProxyAdminOwnedByExecutor({ tokenAddress, executorAddress, deployer }) {
  const adminFromSlot = await readAdminFromSlot(tokenAddress);

  try {
    const paGetters = new ethers.Contract(adminFromSlot, PA_GETTERS_ABI, ethers.provider);
    const who = await paGetters.getProxyAdmin(tokenAddress);
    expect(who.toLowerCase()).to.equal(adminFromSlot.toLowerCase());
  } catch { /* optional */ }

  const paOwnerReader = new ethers.Contract(adminFromSlot, PA_OWNER_ABI, ethers.provider);
  const beforeOwner   = await paOwnerReader.owner();
  if (beforeOwner.toLowerCase() === executorAddress.toLowerCase()) return adminFromSlot;

  const paTransfer = new ethers.Contract(adminFromSlot, PA_TRANSFER_ABI, deployer);
  await (await paTransfer.transferOwnership(executorAddress)).wait();

  // If ProxyAdmin is 2-step ownable in your OZ version, support pendingOwner flow
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

/* ---------- choose a signer who really has DEFAULT_ADMIN_ROLE ---------- */
async function pickAdminForRoleGrant(token, candidates) {
  for (const s of candidates) {
    try {
      if (await token.hasRole(DEFAULT_ADMIN_ROLE, s.address)) return s;
    } catch { /* ignore */ }
  }
  try {
    const owner = await token.owner();
    const hit = candidates.find(c => c.address.toLowerCase() === owner.toLowerCase());
    if (hit) return hit;
  } catch { /* ignore */ }
  throw new Error("No candidate has DEFAULT_ADMIN_ROLE (or owner). Adjust initializer or candidates.");
}

/* ----------------------------- fixtures ----------------------------- */
/**
 * IMPORTANT:
 * Your GemStepToken.initialize now expects 4 args:
 *   (uint256 initialSupply, address admin, address priceOracle, address treasury)
 *
 * So every deployProxy MUST pass 4 values.
 */

// Base fixture: TL → Executor → ProxyAdmin; **no role grant**.
async function fixture_NoGrant() {
  // We need a treasury address for the initializer
  const [deployer, multisig, treasury] = await ethers.getSigners();

  const Timelock = await ethers.getContractFactory("TimelockController");
  const timelock = await Timelock.deploy(
    MIN_DELAY,
    [multisig.address],
    [multisig.address],
    deployer.address
  );
  await timelock.waitForDeployment();

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
      multisig.address,          // admin
      await oracle.getAddress(), // priceOracle
      treasury.address,          // treasury (4th arg)
    ],
    { initializer: "initialize", kind: "transparent", timeout: 180000 }
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

  // inner delay default 0 unless set elsewhere
  await (await executor.connect(deployer).setUpgradeDelay(0)).wait();
  await (await executor.connect(deployer).transferOwnership(await timelock.getAddress())).wait();

  // Timelock accepts executor ownership
  const acceptData = executor.interface.encodeFunctionData("acceptOwnership");
  const salt = makeSalt("accept");
  await tlSchedule(timelock, multisig, await executor.getAddress(), acceptData, salt, MIN_DELAY);
  await time.increase(MIN_DELAY + 1);
  await tlExecute(timelock, multisig, await executor.getAddress(), acceptData, salt);

  return {
    deployer,
    multisig,
    treasury,
    timelock,
    oracle,
    token,
    tokenAddress,
    executor,
    executorAddress,
    proxyAdminAddress,
  };
}

// With role grant + executor delay 0
async function fixture_WithGrantDelay0() {
  const f = await fixture_NoGrant();
  const { token, proxyAdminAddress } = f;

  const signers = await ethers.getSigners();
  const granter = await pickAdminForRoleGrant(token, signers);
  await (await token.connect(granter).grantRole(DEFAULT_ADMIN_ROLE, proxyAdminAddress)).wait();

  return f;
}

// With role grant + executor delay 3600
async function fixture_WithGrantDelay3600() {
  const f = await fixture_NoGrant();
  const { deployer, token, proxyAdminAddress, executor } = f;

  const signers = await ethers.getSigners();
  const granter = await pickAdminForRoleGrant(token, signers);
  await (await token.connect(granter).grantRole(DEFAULT_ADMIN_ROLE, proxyAdminAddress)).wait();

  // Set internal executor delay (while deployer is still owner? In this fixture, TL already owns executor.)
  // Since ownership was transferred+accepted in fixture_NoGrant, we MUST set delay BEFORE that transfer.
  // Easiest: re-deploy with a custom flow here (clean + correct), not mutate after acceptance.

  // Rebuild correctly: deploy everything but set delay BEFORE transferOwnership/acceptOwnership
  const [d, multisig, treasury] = await ethers.getSigners();

  const Timelock = await ethers.getContractFactory("TimelockController");
  const timelock = await Timelock.deploy(
    MIN_DELAY,
    [multisig.address],
    [multisig.address],
    d.address
  );
  await timelock.waitForDeployment();

  const Mock = await ethers.getContractFactory("MockOracleV2");
  const oracle = await Mock.deploy();
  await oracle.waitForDeployment();
  const { timestamp } = await ethers.provider.getBlock("latest");
  await oracle.set(ethers.parseEther("0.005"), timestamp, 0);
  await oracle.setPolicy(300, 100);

  const Token = await ethers.getContractFactory("GemStepToken");
  const token2 = await upgrades.deployProxy(
    Token,
    [
      INITIAL_SUPPLY,
      multisig.address,
      await oracle.getAddress(),
      treasury.address,
    ],
    { initializer: "initialize", kind: "transparent", timeout: 180000 }
  );
  await token2.waitForDeployment();
  const tokenAddress = await token2.getAddress();

  const Executor = await ethers.getContractFactory("UpgradeExecutor");
  const executor2 = await Executor.deploy(d.address);
  await executor2.waitForDeployment();
  const executorAddress = await executor2.getAddress();

  const proxyAdminAddress2 = await ensureProxyAdminOwnedByExecutor({
    tokenAddress,
    executorAddress,
    deployer: d,
  });

  const granter2 = await pickAdminForRoleGrant(token2, [multisig, d]);
  await (await token2.connect(granter2).grantRole(DEFAULT_ADMIN_ROLE, proxyAdminAddress2)).wait();

  // IMPORTANT: set delay BEFORE transferring ownership to TL
  await (await executor2.connect(d).setUpgradeDelay(3600)).wait();

  await (await executor2.connect(d).transferOwnership(await timelock.getAddress())).wait();
  const acceptData = executor2.interface.encodeFunctionData("acceptOwnership");
  const salt = makeSalt("accept-3600");
  await tlSchedule(timelock, multisig, await executor2.getAddress(), acceptData, salt, MIN_DELAY);
  await time.increase(MIN_DELAY + 1);
  await tlExecute(timelock, multisig, await executor2.getAddress(), acceptData, salt);

  return {
    deployer: d,
    multisig,
    treasury,
    timelock,
    oracle,
    token: token2,
    tokenAddress,
    executor: executor2,
    executorAddress,
    proxyAdminAddress: proxyAdminAddress2,
  };
}

/* -------------------------------- tests -------------------------------- */
describe("GemStepToken Upgrade – extra hardening", function () {
  it("fails upgradeAndCall initializer when ProxyAdmin lacks DEFAULT_ADMIN_ROLE (AccessControl)", async function () {
    const { timelock, multisig, tokenAddress, proxyAdminAddress, executor } =
      await loadFixture(fixture_NoGrant);

    const V2 = await ethers.getContractFactory("GemStepTokenV2Mock");
    const impl = await V2.deploy();
    await impl.waitForDeployment();
    const newImpl = await impl.getAddress();

    const initCalldata = V2.interface.encodeFunctionData("initializeV2");

    // NOTE: must schedule the execute call through TL
    const execData = executor.interface.encodeFunctionData(
      "executeUpgradeAndCall",
      [proxyAdminAddress, tokenAddress, newImpl, initCalldata]
    );

    const salt = makeSalt("no-grant-exec");
    await tlSchedule(timelock, multisig, await executor.getAddress(), execData, salt, MIN_DELAY);
    await time.increase(MIN_DELAY + 1);

    // Revert because initializeV2 has onlyRole(DEFAULT_ADMIN_ROLE) and ProxyAdmin has NOT been granted that role
    await expect(
      tlExecute(timelock, multisig, await executor.getAddress(), execData, salt)
    ).to.be.reverted;
  });

  it("enforces UpgradeExecutor.upgradeDelay (can’t execute early)", async function () {
    const { timelock, multisig, tokenAddress, proxyAdminAddress, executor } =
      await loadFixture(fixture_WithGrantDelay3600);

    const V2 = await ethers.getContractFactory("GemStepTokenV2Mock");
    const impl = await V2.deploy();
    await impl.waitForDeployment();
    const newImpl = await impl.getAddress();
    const initCalldata = V2.interface.encodeFunctionData("initializeV2");

    // 1) scheduleUpgradeAndCall via TL (TL delay)
    const schedData = executor.interface.encodeFunctionData(
      "scheduleUpgradeAndCall",
      [proxyAdminAddress, tokenAddress, newImpl, initCalldata]
    );
    const sSalt = makeSalt("sched-uac");
    await tlSchedule(timelock, multisig, await executor.getAddress(), schedData, sSalt, MIN_DELAY);
    await time.increase(MIN_DELAY + 1);
    await tlExecute(timelock, multisig, await executor.getAddress(), schedData, sSalt);

    // 2) executeUpgradeAndCall via TL, but executor has internal delay=3600, so early should revert
    const execData = executor.interface.encodeFunctionData(
      "executeUpgradeAndCall",
      [proxyAdminAddress, tokenAddress, newImpl, initCalldata]
    );
    const eSalt = makeSalt("exec-early");
    await tlSchedule(timelock, multisig, await executor.getAddress(), execData, eSalt, MIN_DELAY);
    await time.increase(MIN_DELAY + 1);

    await expect(
      tlExecute(timelock, multisig, await executor.getAddress(), execData, eSalt)
    ).to.be.reverted;

    // after executor delay
    await time.increase(3600 + 1);
    await tlExecute(timelock, multisig, await executor.getAddress(), execData, eSalt);

    const v2 = await ethers.getContractAt("GemStepTokenV2Mock", tokenAddress);
    expect(await v2.version()).to.equal(2);
  });

  it("Timelock delay is enforced: cannot execute before minDelay", async function () {
    const { timelock, multisig, tokenAddress, proxyAdminAddress, executor } =
      await loadFixture(fixture_WithGrantDelay0);

    const V2 = await ethers.getContractFactory("GemStepTokenV2Mock");
    const impl = await V2.deploy();
    await impl.waitForDeployment();
    const newImpl = await impl.getAddress();
    const initCalldata = V2.interface.encodeFunctionData("initializeV2");

    // First schedule+execute scheduleUpgradeAndCall (after TL delay)
    const schedData = executor.interface.encodeFunctionData(
      "scheduleUpgradeAndCall",
      [proxyAdminAddress, tokenAddress, newImpl, initCalldata]
    );
    const schedSalt = makeSalt("sched");
    await tlSchedule(timelock, multisig, await executor.getAddress(), schedData, schedSalt, MIN_DELAY);
    await time.increase(MIN_DELAY + 1);
    await tlExecute(timelock, multisig, await executor.getAddress(), schedData, schedSalt);

    // Now schedule executeUpgradeAndCall, attempt to execute immediately => TL should revert
    const execData = executor.interface.encodeFunctionData(
      "executeUpgradeAndCall",
      [proxyAdminAddress, tokenAddress, newImpl, initCalldata]
    );
    const execSalt = makeSalt("exec-too-soon");
    await tlSchedule(timelock, multisig, await executor.getAddress(), execData, execSalt, MIN_DELAY);

    await expect(
      tlExecute(timelock, multisig, await executor.getAddress(), execData, execSalt)
    ).to.be.reverted;

    // After delay it should succeed
    await time.increase(MIN_DELAY + 1);
    await tlExecute(timelock, multisig, await executor.getAddress(), execData, execSalt);

    const v2 = await ethers.getContractAt("GemStepTokenV2Mock", tokenAddress);
    expect(await v2.version()).to.equal(2);
  });

  it("idempotency: a completed TL operation cannot be executed twice", async function () {
    const { timelock, multisig, tokenAddress, proxyAdminAddress, executor } =
      await loadFixture(fixture_WithGrantDelay0);

    const V2 = await ethers.getContractFactory("GemStepTokenV2Mock");
    const impl = await V2.deploy();
    await impl.waitForDeployment();
    const newImpl = await impl.getAddress();
    const initCalldata = V2.interface.encodeFunctionData("initializeV2");

    // scheduleUpgradeAndCall
    const schedData = executor.interface.encodeFunctionData(
      "scheduleUpgradeAndCall",
      [proxyAdminAddress, tokenAddress, newImpl, initCalldata]
    );
    const sSalt = makeSalt("idemp-sched");
    await tlSchedule(timelock, multisig, await executor.getAddress(), schedData, sSalt, MIN_DELAY);
    await time.increase(MIN_DELAY + 1);
    await tlExecute(timelock, multisig, await executor.getAddress(), schedData, sSalt);

    // executeUpgradeAndCall
    const execData = executor.interface.encodeFunctionData(
      "executeUpgradeAndCall",
      [proxyAdminAddress, tokenAddress, newImpl, initCalldata]
    );
    const eSalt = makeSalt("idemp-exec");
    await tlSchedule(timelock, multisig, await executor.getAddress(), execData, eSalt, MIN_DELAY);
    await time.increase(MIN_DELAY + 1);
    await tlExecute(timelock, multisig, await executor.getAddress(), execData, eSalt);

    // executing same operation again should revert (Timelock: operation already done)
    await expect(
      tlExecute(timelock, multisig, await executor.getAddress(), execData, eSalt)
    ).to.be.reverted;
  });

  it("guards against non-contract impl address (EOA as impl should revert)", async function () {
    const { timelock, multisig, tokenAddress, proxyAdminAddress, executor } =
      await loadFixture(fixture_WithGrantDelay0);

    const eoaAsImpl = (await ethers.getSigners())[9].address;

    // NOTE: executeUpgrade does NOT require init calldata
    const execData = executor.interface.encodeFunctionData(
      "executeUpgrade",
      [proxyAdminAddress, tokenAddress, eoaAsImpl]
    );

    const salt = makeSalt("bad-impl");
    await tlSchedule(timelock, multisig, await executor.getAddress(), execData, salt, MIN_DELAY);
    await time.increase(MIN_DELAY + 1);

    await expect(
      tlExecute(timelock, multisig, await executor.getAddress(), execData, salt)
    ).to.be.reverted;
  });
});
