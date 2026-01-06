// scripts/checkProxyAdminOwner.js
require("dotenv").config();
const hre = require("hardhat");
const { ethers, upgrades } = hre;
const chalk = require("chalk");

async function main() {
  console.log(chalk.blue.bold("\n🔍 Starting Ownership Verification Process\n"));

  // 1) Resolve proxy address
  const proxyAddress = await determineProxyAddress();
  console.log(chalk.blue(`ℹ️  Using proxy address: ${chalk.bold(proxyAddress)}`));

  // 2) Sanity: it’s a contract
  await mustBeContract(proxyAddress, "Proxy");

  // 3) Read admin slot via plugin
  const proxyAdminAddress = await upgrades.erc1967.getAdminAddress(proxyAddress);
  console.log(chalk.blue(`🛠 ProxyAdmin address: ${chalk.bold(proxyAdminAddress)}`));
  await mustBeContract(proxyAdminAddress, "ProxyAdmin");

  // 4) Read ProxyAdmin.owner() (and pendingOwner if present)
  const proxyAdmin = await ethers.getContractAt(
    [
      "function owner() view returns (address)",
      "function pendingOwner() view returns (address)", // OZ Ownable2Step
    ],
    proxyAdminAddress
  );

  const [owner, pendingOwner] = await Promise.all([
    proxyAdmin.owner(),
    proxyAdmin
      .pendingOwner()
      .catch(() => ethers.ZeroAddress) // handle non-2step variants
  ]);

  // 5) Try to identify if owner is a Timelock (probe getMinDelay())
  const { isTimelock, minDelay } = await looksLikeTimelock(owner);

  // 6) Show results
  console.log(chalk.blue("\n📋 Ownership Information:"));
  console.log(`   Proxy address      : ${proxyAddress}`);
  console.log(`   ProxyAdmin address : ${proxyAdminAddress}`);
  console.log(`   Current Owner      : ${chalk.bold(owner)}`);
  if (pendingOwner && pendingOwner !== ethers.ZeroAddress) {
    console.log(`   Pending Owner      : ${chalk.yellow.bold(pendingOwner)}`);
  }
  console.log(
    `   Controlled by Timelock : ${isTimelock ? chalk.green("Yes") : chalk.red("No")}` +
      (isTimelock ? ` (minDelay=${minDelay}s)` : "")
  );

  // 7) Cross-check expected owner if provided
  if (process.env.EXPECTED_OWNER) {
    await verifyExpectedOwner(owner, process.env.EXPECTED_OWNER);
  }

  // 8) Optional: compare admin from storage slot directly
  const adminSlot = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"; // ERC1967 admin slot
  const raw = await ethers.provider.getStorage(proxyAddress, adminSlot);
  const slotAdmin = ethers.getAddress(ethers.dataSlice(raw, 12)); // last 20 bytes
  const matches = slotAdmin.toLowerCase() === proxyAdminAddress.toLowerCase();

  console.log(chalk.blue("\n🧪 ERC1967 Slot Check:"));
  console.log(`   Slot admin         : ${slotAdmin}`);
  console.log(`   Plugin admin       : ${proxyAdminAddress}`);
  console.log(`   Match              : ${matches ? chalk.green("true") : chalk.red("false")}`);

  console.log(chalk.green.bold("\n🎉 Verification Successful!\n"));
  return {
    proxyAddress,
    proxyAdminAddress,
    owner,
    pendingOwner,
    isTimelock,
    minDelay,
    slotAdmin,
    matches,
    verified: true
  };
}

async function determineProxyAddress() {
  if (process.env.PROXY_ADDRESS) return process.env.PROXY_ADDRESS;

  // Optional helper: deploy a test proxy locally if none provided
  if (["hardhat", "localhost"].includes(hre.network.name)) {
    console.log(chalk.yellow("⚠️  No PROXY_ADDRESS provided - deploying a local test proxy"));
    const [deployer] = await ethers.getSigners();
    const F = await ethers.getContractFactory("GemStepken", deployer);

    // ⚠️ Make sure these args match your initializer!
    const instance = await upgrades.deployProxy(
      F,
      [ethers.parseEther("1000000"), deployer.address], // <-- adjust to your init signature
      { kind: "transparent", initializer: "initialize" }
    );
    await instance.waitForDeployment();
    const addr = await instance.getAddress();
    console.log(chalk.gray(`   Deployed test proxy at ${addr}`));
    return addr;
  }

  throw new Error(
    "No PROXY_ADDRESS provided. Set PROXY_ADDRESS in .env or run on hardhat/localhost to auto-deploy."
  );
}

async function mustBeContract(address, label) {
  const code = await ethers.provider.getCode(address);
  if (!code || code === "0x") {
    throw new Error(`${label} not found at ${address}`);
  }
}

async function looksLikeTimelock(address) {
  if (address === ethers.ZeroAddress) return { isTimelock: false, minDelay: 0 };
  try {
    const tl = await ethers.getContractAt(
      [
        "function getMinDelay() view returns (uint256)",
        "function PROPOSER_ROLE() view returns (bytes32)",
        "function EXECUTOR_ROLE() view returns (bytes32)"
      ],
      address
    );
    const minDelay = await tl.getMinDelay();
    // if call didn’t revert, pretty strong signal it’s a TimelockController
    return { isTimelock: true, minDelay: Number(minDelay) };
  } catch {
    return { isTimelock: false, minDelay: 0 };
  }
}

async function verifyExpectedOwner(currentOwner, expected) {
  if (!ethers.isAddress(expected)) {
    console.log(chalk.yellow(`⚠️  EXPECTED_OWNER is not a valid address: ${expected}`));
    return;
  }
  if (currentOwner.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `Ownership mismatch!\n   Current:  ${currentOwner}\n   Expected: ${expected}`
    );
  }
  console.log(chalk.green("✓ Ownership matches EXPECTED_OWNER"));
}

main()
  .then((res) => {
    if (res) {
      console.log(chalk.gray(JSON.stringify(res, null, 2)));
    }
    process.exit(0);
  })
  .catch((err) => {
    console.error(chalk.red.bold("\n❌ Verification Failed:"));
    console.error(chalk.red(err.message));
    if (err.stack) console.error(chalk.gray(err.stack));
    process.exit(1);
  });
