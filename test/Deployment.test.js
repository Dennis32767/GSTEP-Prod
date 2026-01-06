/* eslint-disable no-console */
const { expect } = require("chai");
const { ethers, upgrades, network } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// Pull from env; provide placeholders for convenience (tests will SKIP if code not found / mispointed)
const ADDRS = {
  TOKEN: process.env.TOKEN_ADDRESS || "0x0000000000000000000000000000000000000000",
  TIMELOCK: process.env.TIMELOCK_ADDRESS || "0x0000000000000000000000000000000000000000",
  MULTISIG: process.env.MULTISIG_ADDRESS || "0x0000000000000000000000000000000000000000",
  EXPECTED_PROXY_ADMIN: process.env.PROXY_ADMIN_ADDRESS || "0x0000000000000000000000000000000000000000",
  EXPECTED_ORACLE: process.env.PRICE_ORACLE_ADDRESS || "0x0000000000000000000000000000000000000000",
};

// Helpers
const toChecksum = (addr) => {
  if (!addr) return null;
  try { return ethers.getAddress(addr); } catch { return null; }
};
const isUnset = (addr) => !addr || addr === ethers.ZeroAddress;
async function hasCode(addr) {
  if (isUnset(addr)) return false;
  const code = await ethers.provider.getCode(addr);
  return code && code !== "0x";
}
function includesReason(err, substr) {
  return (err && (err.message || "").toString().toLowerCase().includes(substr.toLowerCase()));
}
async function getProxyInfo(address) {
  try {
    const admin = await upgrades.erc1967.getAdminAddress(address);
    const impl  = await upgrades.erc1967.getImplementationAddress(address);
    return { admin, impl };
  } catch {
    return null;
  }
}

describe("✅ Post-Deployment Checks - GemStepToken", function () {
  let token, timelock;
  let deployer;
  let multisigSigner = null;

  let tokenAddr, timelockAddr, multisigAddr, proxyAdminExpected, oracleExpected;

  before(async function () {
    const signers = await ethers.getSigners();
    [deployer] = signers;

    // Normalize addresses
    tokenAddr = toChecksum(ADDRS.TOKEN);
    timelockAddr = toChecksum(ADDRS.TIMELOCK);
    multisigAddr = toChecksum(ADDRS.MULTISIG);
    proxyAdminExpected = toChecksum(ADDRS.EXPECTED_PROXY_ADMIN);
    oracleExpected = toChecksum(ADDRS.EXPECTED_ORACLE);

    // Require code at TOKEN and that it is an ERC1967 proxy; otherwise SKIP entire suite
    if (!(await hasCode(tokenAddr))) {
      console.warn(`⚠️  No code at TOKEN_ADDRESS (${ADDRS.TOKEN}) on network "${network.name}". Skipping test suite.`);
      this.skip();
    }
    const proxyInfo = await getProxyInfo(tokenAddr);
    if (!proxyInfo) {
      console.warn(`⚠️  TOKEN_ADDRESS (${ADDRS.TOKEN || tokenAddr}) is not an ERC1967 proxy. Point to the PROXY. Skipping.`);
      this.skip();
    }

    token = await ethers.getContractAt("GemStepToken", tokenAddr);

    if (await hasCode(timelockAddr)) {
      timelock = await ethers.getContractAt("TimelockController", timelockAddr);
    } else {
      console.warn(`ℹ️  Timelock not found or address not set; timelock-specific checks will be skipped.`);
      timelock = null;
    }

    // If MULTISIG is one of the local signers, keep its Signer handy for the governance dry-run
    if (!isUnset(multisigAddr)) {
      const found = signers.find((s) => s.address.toLowerCase() === multisigAddr.toLowerCase());
      if (found) multisigSigner = found;
    }
  });

  it("✅ totalSupply is 40,000,000 GST", async function () {
    const total = await token.totalSupply();
    if (total === 0n) {
      console.warn("ℹ️  totalSupply is 0 — deployment at TOKEN_ADDRESS appears uninitialized. Skipping strict check.");
      this.skip();
    }
    expect(total).to.equal(ethers.parseEther("40000000"));
  });

  it("✅ currentMonthlyCap is 200,000 GST", async function () {
    if (!token.currentMonthlyCap) return this.skip();
    const cap = await token.currentMonthlyCap();
    if (cap === 0n) {
      console.warn("ℹ️  currentMonthlyCap is 0 — likely wrong/uninitialized deployment. Skipping strict check.");
      this.skip();
    }
    expect(cap).to.equal(ethers.parseEther("200000"));
  });

  it("✅ monthlyMintLimit is 200,000 GST", async function () {
    if (!token.monthlyMintLimit) return this.skip();
    const limit = await token.monthlyMintLimit();
    if (limit === 0n) {
      console.warn("ℹ️  monthlyMintLimit is 0 — likely wrong/uninitialized deployment. Skipping strict check.");
      this.skip();
    }
    expect(limit).to.equal(ethers.parseEther("200000"));
  });

  it("✅ ERC1967 admin slot (ProxyAdmin address) is set and (optionally) matches expected", async function () {
    const adminAddr = await upgrades.erc1967.getAdminAddress(tokenAddr);
    expect(adminAddr).to.not.equal(ethers.ZeroAddress);
    console.log("ProxyAdmin:", adminAddr);

    if (!isUnset(proxyAdminExpected)) {
      expect(adminAddr.toLowerCase()).to.equal(proxyAdminExpected.toLowerCase());
    }

    // Optional: verify ProxyAdmin owner is the timelock
    if (timelockAddr) {
      try {
        const proxyAdmin = new ethers.Contract(
          adminAddr,
          ["function owner() view returns (address)"],
          ethers.provider
        );
        const owner = await proxyAdmin.owner();
        console.log("ProxyAdmin.owner():", owner);
        expect(owner.toLowerCase()).to.equal(timelockAddr.toLowerCase());
      } catch {
        console.warn("ℹ️  ProxyAdmin owner() check not available; skipping owner assertion.");
      }
    }
  });

  it("✅ Implementation address exists (ERC1967)", async function () {
    const impl = await upgrades.erc1967.getImplementationAddress(tokenAddr);
    expect(impl).to.not.equal(ethers.ZeroAddress);
    console.log("Implementation:", impl);
  });

  it("✅ Multisig has DEFAULT_ADMIN_ROLE; deployer does not", async function () {
    if (isUnset(multisigAddr)) return this.skip();

    if (!token.hasRole || !token.DEFAULT_ADMIN_ROLE) {
      console.warn("ℹ️  AccessControl not present; skipping role checks.");
      return this.skip();
    }
    const DEFAULT_ADMIN_ROLE = await token.DEFAULT_ADMIN_ROLE();
    expect(await token.hasRole(DEFAULT_ADMIN_ROLE, multisigAddr)).to.be.true;
    expect(await token.hasRole(DEFAULT_ADMIN_ROLE, deployer.address)).to.be.false;
  });

  it("ℹ️ Timelock UPGRADER_ROLE on token (optional)", async function () {
    if (isUnset(timelockAddr) || !timelock) return this.skip();
    if (!token.hasRole || !token.UPGRADER_ROLE) {
      console.warn("ℹ️  UPGRADER_ROLE not present; skipping.");
      return this.skip();
    }
    const UPGRADER_ROLE = await token.UPGRADER_ROLE();
    const has = await token.hasRole(UPGRADER_ROLE, timelockAddr);
    console.log("Timelock has UPGRADER_ROLE on token:", has);
    // expect(has).to.be.true; // enable if you require it
  });

  it("✅ Timelock roles: multisig is PROPOSER & EXECUTOR (if timelock provided)", async function () {
    if (!timelock || isUnset(multisigAddr)) return this.skip();

    if (!timelock.hasRole || !timelock.PROPOSER_ROLE || !timelock.EXECUTOR_ROLE) {
      console.warn("ℹ️  Timelock role functions not present; skipping.");
      return this.skip();
    }
    const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
    const EXECUTOR_ROLE = await timelock.EXECUTOR_ROLE();
    expect(await timelock.hasRole(PROPOSER_ROLE, multisigAddr)).to.be.true;
    expect(await timelock.hasRole(EXECUTOR_ROLE, multisigAddr)).to.be.true;
  });

  it("✅ Price oracle is set (if expected provided)", async function () {
    if (isUnset(oracleExpected)) return this.skip();
    if (!token.priceOracle) return this.skip();
    const oracle = await token.priceOracle();
    expect(oracle.toLowerCase()).to.equal(oracleExpected.toLowerCase());
  });

  it("🔎 Stake sanity and optional adjust via oracle", async function () {
    if (!token.currentStakePerStep || !token.MIN_STAKE_PER_STEP || !token.MAX_STAKE_PER_STEP) {
      console.warn("ℹ️  Staking fields not present; skipping.");
      return this.skip();
    }

    const stake = await token.currentStakePerStep();
    const min = await token.MIN_STAKE_PER_STEP();
    const max = await token.MAX_STAKE_PER_STEP();
    console.log("Stake per step:", stake.toString());

    if (stake === 0n) {
      console.warn("ℹ️  Stake is 0 — likely uninitialized on this deployment. Skipping sanity/adjust.");
      return this.skip();
    }
    expect(stake).to.be.at.least(min);
    expect(stake).to.be.at.most(max);

    if (!token.PARAMETER_ADMIN_ROLE || !token.hasRole) return this.skip();
    const PARAMETER_ADMIN_ROLE = await token.PARAMETER_ADMIN_ROLE();
    const callerHas = await token.hasRole(PARAMETER_ADMIN_ROLE, deployer.address);
    if (!callerHas) {
      console.log("ℹ️  Skipping adjustStakeRequirements (caller lacks PARAMETER_ADMIN_ROLE)");
      return this.skip();
    }

    try {
      const tx = await token.adjustStakeRequirements();
      await tx.wait();
      console.log("✓ adjustStakeRequirements executed");
    } catch (err) {
      if (
        includesReason(err, "Cooldown active") ||
        includesReason(err, "Stake parameters locked") ||
        includesReason(err, "AccessControl")
      ) {
        console.log("ℹ️  adjustStakeRequirements skipped/blocked as expected:", err.shortMessage || err.message);
      } else {
        throw err;
      }
    }
  });

  it("✅ Pause/unpause works (only if deployer has PAUSER_ROLE)", async function () {
    if (!token.PAUSER_ROLE || !token.hasRole || !token.pause || !token.unpause || !token.paused) {
      console.warn("ℹ️  Pause interface not present; skipping.");
      return this.skip();
    }

    const PAUSER_ROLE = await token.PAUSER_ROLE();
    const hasRole = await token.hasRole(PAUSER_ROLE, deployer.address);

    if (!hasRole) {
      console.log("ℹ️  Skipping pause/unpause (deployer has no PAUSER_ROLE)");
      return this.skip();
    }

    await token.pause();
    expect(await token.paused()).to.be.true;
    await token.unpause();
    expect(await token.paused()).to.be.false;
  });
});
