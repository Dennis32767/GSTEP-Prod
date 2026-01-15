// test/fixtures.js
/* eslint-disable no-console */
// @ts-nocheck
const { ethers, upgrades } = require("hardhat");

// ✅ MUST match GemStepStorage/GemStepCore INITIAL_SUPPLY constant:
// 400_000_000 * 1e18
const INITIAL_SUPPLY = ethers.parseUnits("400000000", 18);

/** Best-effort helper: call a function iff it exists, ignore errors. */
async function tryTx(obj, fn, ...args) {
  try {
    obj.interface.getFunction(fn); // throws if not found
    const tx = await obj[fn](...args);
    await tx.wait?.();
    return true;
  } catch {
    return false;
  }
}

/** Enable a source and disable proof/attestation requirements (if supported). */
async function enableSourceNoProofNoAttestation(token, admin, source = "fitbit") {
  // Newer single-call config: configureSource(source, enabled, requireProof, requireAttestation)
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
      // optional two-step API
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

  // If Ownable2Step, let TL accept (local hardhat only)
  try {
    const pending = await pa.pendingOwner();
    if (pending && pending.toLowerCase() === tl.toLowerCase()) {
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

/**
 * Detect who received initial supply (treasury vs admin vs deployer),
 * and return a signer that can fund test accounts.
 */
async function resolveInitialHolder(token, candidates) {
  let best = null;

  for (const s of candidates) {
    try {
      const bal = await token.balanceOf(s.address);
      if (bal > 0n) {
        if (!best || bal > best.bal) best = { signer: s, bal };
      }
    } catch {
      // ignore
    }
  }

  return best; // { signer, bal } | null
}

/**
 * Seed test accounts with tokens from the true initial holder.
 * This fixes the mass ERC20InsufficientBalance failures when initialize mints to treasury.
 */
async function seedUsers(token, funderSigner, recipients, amountEach) {
  for (const r of recipients) {
    if (!r) continue;
    await (await token.connect(funderSigner).transfer(r.address, amountEach)).wait();
  }
}

async function deployGemStepFixture() {
  /**
   * Signers:
   * - admin: receives roles in initialize()
   * - treasury: receives the INITIAL_SUPPLY mint in initialize() (in your current design)
   */
  const [admin, treasury, user1, user2, ...rest] = await ethers.getSigners();

  // 1) Timelock (small delay for tests)
  const Timelock = await ethers.getContractFactory("TimelockController");
  const timelock = await Timelock.deploy(
    60,              // minDelay
    [admin.address], // proposers
    [admin.address], // executors
    admin.address    // admin
  );
  await timelock.waitForDeployment();

  // 2) Mock oracle (matches initializer: address _priceOracle)
  const Mock = await ethers.getContractFactory("MockOracleV2");
  const priceOracle = await Mock.deploy();
  await priceOracle.waitForDeployment();

  // Some repos call this `set(uint256,uint256,uint256)`; keep best-effort compatibility
  const latest = await ethers.provider.getBlock("latest");
  const ts = latest?.timestamp ?? Math.floor(Date.now() / 1000);

  await tryTx(priceOracle, "set", ethers.parseEther("0.005"), ts, 0); // priceWei, updatedAt, confBps
  await tryTx(priceOracle, "setPolicy", 300, 100); // maxStaleness=300s, minConfidenceBps=±1%

  // 3) Deploy proxy token
  // initialize(uint256 initialSupply, address admin, address _priceOracle, address _treasury)
  const GemStepToken = await ethers.getContractFactory("GemStepToken");

  const token = await upgrades.deployProxy(
    GemStepToken,
    [
      INITIAL_SUPPLY,                  // ✅ must equal contract constant INITIAL_SUPPLY
      admin.address,                   // admin
      await priceOracle.getAddress(),  // _priceOracle
      treasury.address,                // _treasury
    ],
    { initializer: "initialize" }
  );
  await token.waitForDeployment();

  // 4) Make "fitbit" usable for tests (best-effort across module versions)
  await enableSourceNoProofNoAttestation(token, admin, "fitbit");

  // 5) Determine who actually holds the initial supply (treasury vs admin vs deployer)
  const holder = await resolveInitialHolder(token, [treasury, admin, ...rest].slice(0, 3));
  if (!holder) {
    // Hard fail with a useful message instead of cascading test failures later
    const aBal = await token.balanceOf(admin.address);
    const tBal = await token.balanceOf(treasury.address);
    throw new Error(
      `[fixture] Could not find initial supply holder. adminBal=${aBal} treasuryBal=${tBal}`
    );
  }

  // 6) Seed users so tests that stake/transfer don’t explode under coverage
  // Tune this if you need more/less in tests.
  const SEED_EACH = ethers.parseUnits("10000", 18);
  await seedUsers(token, holder.signer, [user1, user2], SEED_EACH);

  // 7) Optional: Timelock owns ProxyAdmin
  await maybeWireProxyAdminToTimelock(token, timelock, admin);

  return {
    token,
    admin,
    treasury,
    user1,
    user2,
    rest,
    timelock,
    priceOracle,
    INITIAL_SUPPLY,
    // useful debugging
    initialHolder: holder.signer.address,
    initialHolderBalance: holder.bal,
  };
}

module.exports = { deployGemStepFixture, INITIAL_SUPPLY };
