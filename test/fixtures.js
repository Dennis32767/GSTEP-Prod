// test/fixtures.js
/* eslint-disable no-console */
const { ethers, upgrades } = require("hardhat");

const INITIAL_SUPPLY = ethers.parseUnits("40000000", 18);

/** Best-effort helper: call a function iff it exists, ignore errors. */
async function tryTx(obj, fn, ...args) {
  try {
    // Will throw if fn missing in iface; catch below
    obj.interface.getFunction(fn);
    const tx = await obj[fn](...args);
    await tx.wait?.();
    return true;
  } catch {
    return false;
  }
}

/** Enable a source and disable proof/attestation requirements (if supported). */
async function enableSourceNoProofNoAttestation(token, admin, source = "fitbit") {
  // Newer single-call config (enabled, requireProof, requireAttestation)
  if (await tryTx(token.connect(admin), "configureSource", source, true, false, false)) return;

  // Older variants
  await tryTx(token.connect(admin), "configureSource", source, true, false);
  await tryTx(token.connect(admin), "configureSource", source, true);

  // Split setters (best-effort)
  await tryTx(token.connect(admin), "setSourceEnabled", source, true);
  await tryTx(token.connect(admin), "setRequireProof", source, false);
  await tryTx(token.connect(admin), "setRequireAttestation", source, false);

  // Global toggles, if present
  await tryTx(token.connect(admin), "setGlobalRequireProof", false);
  await tryTx(token.connect(admin), "setGlobalRequireAttestation", false);
}

/** If requested, transfer ProxyAdmin ownership to the Timelock (handles 1 or 2-step). */
async function maybeWireProxyAdminToTimelock(token, timelock, admin) {
  if (process.env.WIRE_PROXYADMIN_TO_TIMELOCK !== "1") return;

  const proxy = await token.getAddress();
  const paAddr = await upgrades.erc1967.getAdminAddress(proxy);
  const pa = await ethers.getContractAt(
    [
      "function owner() view returns (address)",
      "function transferOwnership(address newOwner)",
      // optional two-step API (older/newer forks)
      "function pendingOwner() view returns (address)",
      "function acceptOwnership()",
    ],
    paAddr,
    admin
  );

  const tl = await timelock.getAddress();
  const currentOwner = await pa.owner();
  if (currentOwner.toLowerCase() === tl.toLowerCase()) {
    console.log(`[fixture] ProxyAdmin already owned by Timelock @ ${tl}`);
    return;
  }

  console.log(`[fixture] Transferring ProxyAdmin @ ${paAddr} to Timelock @ ${tl}...`);
  await (await pa.transferOwnership(tl)).wait();

  // If the PA is Ownable2Step, let TL accept; otherwise this no-ops.
  try {
    const pending = await pa.pendingOwner();
    if (pending && pending.toLowerCase() === tl.toLowerCase()) {
      // Impersonate TL locally to accept (tests run on hardhat network)
      await ethers.provider.send("hardhat_impersonateAccount", [tl]);
      const tlSigner = await ethers.getSigner(tl);
      const paAsTL = pa.connect(tlSigner);
      await (await paAsTL.acceptOwnership()).wait();
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [tl]);
    }
  } catch {
    // Not two-step; nothing to accept.
  }

  const after = await pa.owner();
  console.log(`[fixture] ProxyAdmin.owner = ${after}`);
}

async function deployGemStepFixture() {
  const [admin, user1, user2, ...rest] = await ethers.getSigners();

  // 1) Timelock (minDelay small for tests; proposer/executor = admin so tests can operate)
  const Timelock = await ethers.getContractFactory("TimelockController");
  const timelock = await Timelock.deploy(
    60,                // minDelay
    [admin.address],   // proposers
    [admin.address],   // executors
    admin.address      // admin
  );
  await timelock.waitForDeployment();

  // 2) Mock oracle (matches token initializer)
 const Mock = await ethers.getContractFactory("MockOracleV2");
const priceOracle = await Mock.deploy(); // no constructor args
await priceOracle.waitForDeployment();

const { timestamp } = await ethers.provider.getBlock("latest");
await priceOracle.set(ethers.parseEther("0.005"), timestamp, 0); // priceWei, updatedAt, confBps
await priceOracle.setPolicy(300, 100); // maxStaleness=300s, minConfidenceBps=±1%

// 3) Deploy proxy token (initializer: initialSupply, admin, oracle)
const Token = await ethers.getContractFactory("GemStepToken");
const token = await upgrades.deployProxy(
  Token,
  [INITIAL_SUPPLY, admin.address, await priceOracle.getAddress()],
  { kind: "transparent", timeout: 180000 }
);
await token.waitForDeployment();

  // 4) Pre-enable a usable source for the step-submission tests (best-effort)
  await enableSourceNoProofNoAttestation(token, admin, "fitbit");

  // 5) (Optional) have the Timelock own the ProxyAdmin (toggle with env)
  await maybeWireProxyAdminToTimelock(token, timelock, admin);

  return {
    token,
    admin,
    user1,
    user2,
    rest,
    timelock,
    priceOracle,
  };
}

module.exports = { deployGemStepFixture };
