/* eslint-disable no-console */
require("dotenv").config();
const fs = require("fs");
const hre = require("hardhat");
const chalk = require("chalk");

// Ethers v6 utils are exported at top-level on hre.ethers
const {
  parseUnits,
  formatUnits,
  isAddress,
  getAddress,
  ZeroAddress,
  keccak256,
  toUtf8Bytes,
  ZeroHash,
} = hre.ethers;

/* ============================================================================
 * Network Configuration
 * ==========================================================================*/
const NETWORK_CONFIG = {
  mainnet: {
    minDelay: 86400,
    gasBuffer: 1.3,
    requiredConfirmations: 3,
    safeDelay: 86400,
    verify: true,
    maxGasPrice: parseUnits("100", "gwei"),
  },
  sepolia: {
    minDelay: 300,
    gasBuffer: 1.25,
    requiredConfirmations: 2,
    safeDelay: 60,
    verify: true,
    maxGasPrice: parseUnits("50", "gwei"),
  },
  arbitrum: {
    minDelay: 86400,
    gasBuffer: 1.2,
    requiredConfirmations: 2,
    safeDelay: 86400,
    verify: true,
    maxGasPrice: parseUnits("0.1", "gwei"),
  },
  arbitrumSepolia: {
    minDelay: 60,
    gasBuffer: 1.15,
    requiredConfirmations: 1,
    safeDelay: 0,
    verify: true,
    maxGasPrice: parseUnits("0.1", "gwei"),
  },
  hardhat: {
    minDelay: 60,
    gasBuffer: 1.1,
    requiredConfirmations: 1,
    safeDelay: 0,
    verify: false,
    maxGasPrice: null,
  },
  localhost: {
    minDelay: 60,
    gasBuffer: 1.1,
    requiredConfirmations: 1,
    safeDelay: 0,
    verify: false,
    maxGasPrice: null,
  },
};

const isDevNetwork = (n) => n === "hardhat" || n === "localhost";

const EXECUTOR_UPGRADE_DELAY = BigInt(
  process.env.EXECUTOR_UPGRADE_DELAY
    ? Number(process.env.EXECUTOR_UPGRADE_DELAY)
    : isDevNetwork(hre.network.name)
    ? 0
    : 86400
);

/* ============================================================================
 * Utils
 * ==========================================================================*/
const delay = (ms) => new Promise((res) => setTimeout(res, ms));
const generateSalt = (label = "deploy") => keccak256(toUtf8Bytes(`${label}-${Date.now()}-${Math.random()}`));

async function isContract(addr) {
  if (!addr) return false;
  try {
    const code = await hre.ethers.provider.getCode(addr);
    return code && code !== "0x";
  } catch {
    return false;
  }
}

/* ---- strict address guards ---- */
function requireAddress(label, value, { allowZero = false } = {}) {
  if (!value || value === "0x") throw new Error(`Missing/placeholder address for ${label}.`);
  if (value === ZeroAddress && !allowZero) throw new Error(`Zero address not allowed for ${label}.`);
  if (!isAddress(value)) throw new Error(`Invalid ${label}: ${value}`);
  return getAddress(value);
}

function normalizeAddrArray(label, arr) {
  if (!Array.isArray(arr) || arr.length === 0) throw new Error(`${label} cannot be empty`);
  return arr.map((a) => requireAddress(label, a));
}

/* ============================================================================
 * Env Validation & Risk Checks
 * ==========================================================================*/
async function validateEnvironment() {
  console.log(chalk.blue("\n🔍 Validating environment..."));

  const requiredVars = {
    MULTISIG_ADDRESS: {
      required: !isDevNetwork(hre.network.name) && process.env.MULTISIG_MODE !== "mini",
      validate: (v) => !v || isAddress(v),
      msg: "must be a valid address",
    },
    PRICE_ORACLE_ADDRESS: {
      required: !isDevNetwork(hre.network.name),
      validate: (v) => !v || isAddress(v),
      msg: "must be a valid address (or empty on dev)",
    },
    ARBITRUM_INBOX_ADDRESS: { required: false, validate: (v) => !v || isAddress(v), msg: "must be a valid address" },
    L1_VALIDATOR_ADDRESS: { required: false, validate: (v) => !v || isAddress(v), msg: "must be a valid address" },

    // Keys
    DEPLOYER_PRIVATE_KEY: {
      required: false,
      validate: (v) => !v || (typeof v === "string" && v.replace(/^0x/, "").length === 64),
      msg: "must be a 32-byte hex private key",
    },
    MULTISIG_PRIVATE_KEY: {
      required: false,
      validate: (v) => !v || (typeof v === "string" && v.replace(/^0x/, "").length === 64),
      msg: "must be a 32-byte hex private key",
    },
  };

  if (process.env.MULTISIG_MODE === "mini") {
    requiredVars.MULTISIG_EOA_1 = { required: true, validate: isAddress, msg: "must be a valid address" };
    requiredVars.MULTISIG_EOA_2 = { required: true, validate: isAddress, msg: "must be a valid address" };
  }

  const errors = [];
  for (const [key, cfg] of Object.entries(requiredVars)) {
    const val = process.env[key];
    if (cfg.required && !val) errors.push(`${key} is required (${cfg.msg})`);
    if (val && cfg.validate && !cfg.validate(val)) errors.push(`${key} ${cfg.msg}`);
  }

  if (process.env.MULTISIG_PRIVATE_KEY && process.env.MULTISIG_ADDRESS) {
    const pk = process.env.MULTISIG_PRIVATE_KEY.startsWith("0x")
      ? process.env.MULTISIG_PRIVATE_KEY
      : `0x${process.env.MULTISIG_PRIVATE_KEY}`;
    const addrFromPk = new hre.ethers.Wallet(pk).address.toLowerCase();
    const msAddr = process.env.MULTISIG_ADDRESS.toLowerCase();
    if (addrFromPk !== msAddr) {
      errors.push(`MULTISIG_PRIVATE_KEY (${addrFromPk}) does not match MULTISIG_ADDRESS (${msAddr})`);
    }
  }

  if (errors.length) {
    console.error(chalk.red("✖ Environment validation failed:"));
    errors.forEach((e) => console.error(e));
    throw new Error("Invalid environment configuration");
  }

  console.log(chalk.green("✓ Environment validated"));
}

async function checkDeploymentRisks(deployerAddress) {
  console.log(chalk.blue("🔒 Checking deployment risks..."));

  const code = await hre.ethers.provider.getCode(deployerAddress);
  if (code !== "0x") throw new Error("Deployer address is a contract (unexpected)");

  const nonce = await hre.ethers.provider.getTransactionCount(deployerAddress);
  if (nonce > 0) console.warn(chalk.yellow("⚠️  Deployer has existing transactions; mind your nonces."));

  const bal = await hre.ethers.provider.getBalance(deployerAddress);
  if (bal < parseUnits("0.02", "ether")) {
    console.warn(chalk.yellow(`⚠️  Low balance: ${formatUnits(bal, 18)} ETH (top up recommended)`));
  }

  console.log(chalk.green("✓ Deployment risks assessed"));
}

/* ============================================================================
 * Signers & Multisig helpers
 * ==========================================================================*/
async function getDeployer() {
  if (process.env.DEPLOYER_PRIVATE_KEY) {
    const pk = process.env.DEPLOYER_PRIVATE_KEY.startsWith("0x")
      ? process.env.DEPLOYER_PRIVATE_KEY
      : `0x${process.env.DEPLOYER_PRIVATE_KEY}`;
    return new hre.ethers.Wallet(pk, hre.ethers.provider);
  }
  const [signer] = await hre.ethers.getSigners();
  return signer;
}

function getMode() {
  // eoa | mini | safe
  if (process.env.MULTISIG_MODE) return process.env.MULTISIG_MODE;
  if (isDevNetwork(hre.network.name)) return "eoa";
  if (["sepolia", "arbitrumSepolia"].includes(hre.network.name)) return "mini";
  return "safe";
}

/* (4) Hardened fallback to avoid ENS resolution */
function getMultisigAddressFallback(deployerAddr) {
  const mode = getMode();
  const env = (process.env.MULTISIG_ADDRESS || "").trim();

  if (mode === "eoa" || mode === "safe") {
    return env && env !== "0x" ? env : deployerAddr;
  }
  // mini → set after MiniMultisig deploy
  return process.env.MINI_MULTISIG_ADDRESS || "";
}

async function getMultisigSignerFlexible() {
  const pkRaw = (process.env.MULTISIG_PRIVATE_KEY || "").trim();
  if (pkRaw) {
    const pk = pkRaw.startsWith("0x") ? pkRaw : `0x${pkRaw}`;
    return new hre.ethers.Wallet(pk, hre.ethers.provider);
  }
  const msAddr = (process.env.MULTISIG_ADDRESS || "").toLowerCase();
  if (msAddr) {
    const locals = await hre.ethers.getSigners();
    const match = locals.find((s) => s.address.toLowerCase() === msAddr);
    if (match) return match;
  }
  return null;
}

/* ============================================================================
 * Tx helpers
 * ==========================================================================*/
async function safeTransaction(txPromise, operation, confirmations = 1) {
  try {
    const tx = await txPromise;
    const rcpt = await tx.wait(confirmations);
    console.log(chalk.green(`✅ ${operation}`));
    console.log(chalk.gray(`tx  : ${rcpt.hash}`));
    console.log(chalk.gray(`gas : ${rcpt.gasUsed.toString()}`));
    return rcpt;
  } catch (e) {
    console.error(chalk.red(`✖ ${operation} failed:`), e.message || e);
    throw e;
  }
}

async function checkGasPrice(networkConfig) {
  if (!networkConfig.maxGasPrice) return;
  const feeData = await hre.ethers.provider.getFeeData();
  // Prefer EIP-1559 maxFee if present; else gasPrice
  const candidate = feeData.maxFeePerGas ?? feeData.gasPrice;
  if (candidate && candidate > networkConfig.maxGasPrice) {
    console.warn(
      chalk.yellow(
        `⚠️  High gas: ${formatUnits(candidate, "gwei")} gwei (max: ${formatUnits(
          networkConfig.maxGasPrice,
          "gwei"
        )} gwei)`
      )
    );
  }
}

async function preFlightChecks(networkConfig, deployer) {
  console.log(chalk.blue("✈️  Running preflight checks..."));
  try {
    if (hre.upgrades?.admin?.getInstance) {
      const proxyAdmin = await hre.upgrades.admin.getInstance();
      const adminAddress = await proxyAdmin.getAddress();
      const adminCode = await hre.ethers.provider.getCode(adminAddress);
      if (adminCode !== "0x") console.log(chalk.gray(`   ProxyAdmin detected @ ${adminAddress}`));
    }
  } catch {
    // Upgrades plugin may not be loaded; ignore
  }
  await checkGasPrice(networkConfig);
  const network = await hre.ethers.provider.getNetwork();
  console.log(chalk.gray(`Chain ID: ${network.chainId}`));
  console.log(chalk.green("✓ Preflight checks passed"));
}

/* ============================================================================
 * MiniMultisig2of2 (testnets)
 * ==========================================================================*/
async function deployMiniMultisig(networkConfig, deployer) {
  if (getMode() !== "mini") {
    console.log(chalk.gray("⏭️  Skipping MiniMultisig (mode != mini)"));
    return null;
  }
  console.log(chalk.blue("\n🔐 Deploying MiniMultisig2of2..."));
  const a = requireAddress("MULTISIG_EOA_1", process.env.MULTISIG_EOA_1);
  const b = requireAddress("MULTISIG_EOA_2", process.env.MULTISIG_EOA_2);
  const MiniMultisig = await hre.ethers.getContractFactory("MiniMultisig2of2", deployer);

  const fee = await hre.ethers.provider.getFeeData();
  const txReq = await MiniMultisig.getDeployTransaction(a, b);
  txReq.from = await deployer.getAddress(); // ethers v6 estimate needs from
  const gasEst = await hre.ethers.provider.estimateGas(txReq).catch(() => null);
  const baseGas = gasEst ? gasEst : 1_200_000n;
  const gasLimit = (baseGas * BigInt(Math.ceil(networkConfig.gasBuffer * 100))) / 100n;

  const ms = await MiniMultisig.deploy(a, b, {
    gasLimit,
    maxFeePerGas: fee.maxFeePerGas ?? parseUnits("30", "gwei"),
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? parseUnits("1.5", "gwei"),
  });
  await ms.waitForDeployment();

  const addr = await ms.getAddress();
  console.log(chalk.green(`✅ MiniMultisig2of2: ${addr}`));
  console.log(chalk.gray(`Owner A: ${a}`));
  console.log(chalk.gray(`Owner B: ${b}`));
  process.env.MINI_MULTISIG_ADDRESS = addr;
  return ms;
}

/* ============================================================================
 * Core Deploys
 * ==========================================================================*/
async function deployTimelock(networkConfig, deployer, cfg) {
  console.log(chalk.blue("\n🕓 Deploying TimelockController (multisig actor)..."));
  const Timelock = await hre.ethers.getContractFactory("TimelockController", deployer);

  const proposers = normalizeAddrArray("Timelock proposers", cfg.proposers);
  const executors = normalizeAddrArray("Timelock executors", cfg.executors);

  const tl = await Timelock.deploy(networkConfig.minDelay, proposers, executors, deployer.address);
  await tl.waitForDeployment();

  const tlAddr = await tl.getAddress();
  console.log(chalk.green(`✅ Timelock deployed: ${tlAddr}`));

  // Grant admin to listed admins, then renounce deployer
  const TL_ADMIN = await tl.DEFAULT_ADMIN_ROLE();
  for (const admin of cfg.admins) {
    const adminChecked = requireAddress("Timelock admin", admin);
    if (!(await tl.hasRole(TL_ADMIN, adminChecked))) {
      await safeTransaction(
        tl.grantRole(TL_ADMIN, adminChecked),
        `TL: grant DEFAULT_ADMIN to ${adminChecked}`,
        networkConfig.requiredConfirmations
      );
    }
  }
  if (await tl.hasRole(TL_ADMIN, deployer.address)) {
    await safeTransaction(
      tl.renounceRole(TL_ADMIN, deployer.address),
      "TL: deployer renounce DEFAULT_ADMIN",
      networkConfig.requiredConfirmations
    );
  }
  return tl;
}

async function deployMockOracle(deployer) {
  console.log(chalk.blue("🛠️ Deploying MockPriceOracle..."));
  const MockOracle = await hre.ethers.getContractFactory("MockPriceOracle", deployer);
  const oracle = await MockOracle.deploy(parseUnits("0.005", 18), 0);
  await oracle.waitForDeployment();
  const addr = await oracle.getAddress();
  console.log(chalk.green(`✅ MockPriceOracle deployed: ${addr}`));
  return addr;
}

async function getOracleAddress(deployer) {
  if (process.env.PRICE_ORACLE_ADDRESS) {
    console.log(chalk.gray("Using PRICE_ORACLE_ADDRESS from env"));
    return requireAddress("PRICE_ORACLE_ADDRESS", process.env.PRICE_ORACLE_ADDRESS);
  }
  if (isDevNetwork(hre.network.name)) return deployMockOracle(deployer);
  throw new Error("PRICE_ORACLE_ADDRESS is required for non-dev networks");
}

/* (1) Token info logging via getCoreParams(); (3) print view fns */
async function deployToken(networkConfig, deployer, oracleAddress, adminAddress) {
  console.log(chalk.blue("\n🛠️ Deploying GemStepToken (proxy)..."));
  if (!hre.upgrades) throw new Error("OpenZeppelin upgrades plugin not loaded in Hardhat.");
  const GemStepToken = await hre.ethers.getContractFactory("GemStepToken", deployer);
  const initialSupply = parseUnits("40000000", 18);

  const token = await hre.upgrades.deployProxy(
    GemStepToken,
    [initialSupply, requireAddress("adminAddress", adminAddress), requireAddress("oracleAddress", oracleAddress)],
    { kind: "transparent", timeout: 180000 }
  );
  await token.waitForDeployment();

  const viewFns = token.interface.fragments
    .filter((f) => f.type === "function" && f.stateMutability === "view")
    .map((f) => f.format());
  console.log(chalk.gray(`view fns   : ${viewFns.join(", ")}`));

  const proxy = await token.getAddress();
  const impl = await hre.upgrades.erc1967.getImplementationAddress(proxy);

  // helper: does function exist?
  const fnExists = (iface, sig) => {
    try {
      iface.getFunction(sig);
      return true;
    } catch {
      return false;
    }
  };
  const i = token.interface;

  let totalSupply = null,
    cap = null,
    rewardPerStep = null;

  if (fnExists(i, "totalSupply()")) totalSupply = await token.totalSupply().catch(() => null);
  if (fnExists(i, "cap()")) cap = await token.cap().catch(() => null);
  if (fnExists(i, "getCoreParams()")) {
    const [_burnFee, _rewardRate] = await token.getCoreParams().catch(() => [null, null]);
    rewardPerStep = _rewardRate;
  }

  console.log(chalk.green(`✅ Token proxy: ${proxy}`));
  console.log(chalk.gray(`impl       : ${impl}`));
  console.log(chalk.gray(`supply     : ${totalSupply != null ? `${formatUnits(totalSupply)} GSTEP` : "(n/a)"}`));
  console.log(chalk.gray(`cap        : ${cap != null ? `${formatUnits(cap)} GSTEP` : "(n/a)"}`));
  console.log(chalk.gray(`rewardRate : ${rewardPerStep != null ? `${formatUnits(rewardPerStep)} GSTEP/step` : "(n/a)"}`));

  return token;
}

/* ---- EIP-1559 + gas estimation for UpgradeExecutor */
async function deployUpgradeExecutor(networkConfig, deployer) {
  console.log(chalk.blue("\n🛠️ Deploying UpgradeExecutor..."));
  const Executor = await hre.ethers.getContractFactory("UpgradeExecutor", deployer);
  const fee = await hre.ethers.provider.getFeeData();

  const unsigned = await Executor.getDeployTransaction(deployer.address);
  unsigned.from = await deployer.getAddress(); // critical for estimate in v6
  const gasEst = await hre.ethers.provider.estimateGas(unsigned).catch(() => null);

  if (!gasEst) {
    console.warn(chalk.yellow("⚠️  Could not estimate gas for UpgradeExecutor. Using fallback 5,000,000."));
  }
  const baseGas = gasEst ? gasEst : 5_000_000n;
  const gasLimit = (baseGas * BigInt(Math.ceil(networkConfig.gasBuffer * 100))) / 100n;

  const maxPriority = fee.maxPriorityFeePerGas ?? parseUnits("1.5", "gwei");
  const maxFee = fee.maxFeePerGas ?? parseUnits("30", "gwei");

  const bal = await hre.ethers.provider.getBalance(deployer.address);
  const estCost = gasLimit * maxFee;
  if (bal < estCost) {
    console.warn(
      chalk.yellow(
        `⚠️  Balance ${formatUnits(bal, 18)} ETH may be too low for executor deploy (est ~${formatUnits(estCost, 18)} ETH).`
      )
    );
  }

  const executor = await Executor.deploy(deployer.address, {
    gasLimit,
    maxFeePerGas: maxFee,
    maxPriorityFeePerGas: maxPriority,
  });

  const receipt = await executor.deploymentTransaction().wait(networkConfig.requiredConfirmations);
  if (receipt.status !== 1) throw new Error("UpgradeExecutor constructor reverted (status 0).");

  await executor.waitForDeployment();

  const addr = await executor.getAddress();
  console.log(chalk.green(`✅ UpgradeExecutor: ${addr}`));

  const curr = await executor.upgradeDelay();
  if (curr !== EXECUTOR_UPGRADE_DELAY) {
    await safeTransaction(
      executor.setUpgradeDelay(EXECUTOR_UPGRADE_DELAY, { maxFeePerGas: maxFee, maxPriorityFeePerGas: maxPriority }),
      "Executor: set upgradeDelay",
      networkConfig.requiredConfirmations
    );
  }
  return executor;
}

/* ============================================================================
 * Configuration & Ownership Wiring
 * ==========================================================================*/
async function configureArbitrum(token, networkConfig) {
  if (process.env.ARBITRUM_INBOX_ADDRESS && process.env.L1_VALIDATOR_ADDRESS) {
    console.log(chalk.blue("📬 Configuring Arbitrum addresses..."));
    // Optional guard: if token has initializeArbitrum and not initialized
    try {
      await safeTransaction(
        token.initializeArbitrum(
          requireAddress("ARBITRUM_INBOX_ADDRESS", process.env.ARBITRUM_INBOX_ADDRESS),
          requireAddress("L1_VALIDATOR_ADDRESS", process.env.L1_VALIDATOR_ADDRESS)
        ),
        "Token: initializeArbitrum",
        networkConfig.requiredConfirmations
      );
    } catch (e) {
      if (String(e?.message || "").toLowerCase().includes("already initialized")) {
        console.log(chalk.gray("Arbitrum already initialized; skipping."));
      } else {
        throw e;
      }
    }
  }
}

/* (2) Role grants using getRoleIds() + DEFAULT_ADMIN_ROLE() */
async function grantTokenRoles(token, adminAddress, networkConfig) {
  console.log(chalk.blue("🔐 Granting roles to multisig..."));

  const admin = requireAddress("adminAddress", adminAddress);

  let pairs = [];
  const DEFAULT_ADMIN_ROLE = await token.DEFAULT_ADMIN_ROLE();

  // Prefer compact getRoleIds() if present
  const hasGetRoleIds = !!token.interface.getFunction("getRoleIds").selector;
  if (hasGetRoleIds) {
    try {
      const roleIds = await token.getRoleIds(); // [PAUSER, MINTER, SIGNER, PARAMETER_ADMIN, EMERGENCY_ADMIN, UPGRADER, API_SIGNER]
      pairs = [
        ["DEFAULT_ADMIN_ROLE", DEFAULT_ADMIN_ROLE],
        ["PAUSER_ROLE", roleIds[0]],
        ["MINTER_ROLE", roleIds[1]],
        ["SIGNER_ROLE", roleIds[2]],
        ["PARAMETER_ADMIN_ROLE", roleIds[3]],
        ["EMERGENCY_ADMIN_ROLE", roleIds[4]],
        ["UPGRADER_ROLE", roleIds[5]],
        ["API_SIGNER_ROLE", roleIds[6]],
      ];
    } catch {
      // fall back to named role getters below
    }
  }

  if (pairs.length === 0) {
    // Fallback: try common role-name getters if present; skip missing ones
    const maybe = async (name) => {
      try {
        const fn = token.interface.getFunction(name);
        return await token[name]();
      } catch {
        return null;
      }
    };
    pairs = [
      ["DEFAULT_ADMIN_ROLE", DEFAULT_ADMIN_ROLE],
      ["PAUSER_ROLE", await maybe("PAUSER_ROLE")],
      ["MINTER_ROLE", await maybe("MINTER_ROLE")],
      ["SIGNER_ROLE", await maybe("SIGNER_ROLE")],
      ["PARAMETER_ADMIN_ROLE", await maybe("PARAMETER_ADMIN_ROLE")],
      ["EMERGENCY_ADMIN_ROLE", await maybe("EMERGENCY_ADMIN_ROLE")],
      ["UPGRADER_ROLE", await maybe("UPGRADER_ROLE")],
      ["API_SIGNER_ROLE", await maybe("API_SIGNER_ROLE")],
    ].filter(([, v]) => v); // drop nulls
  }

  for (const [label, roleHash] of pairs) {
    if (!(await token.hasRole(roleHash, admin))) {
      await safeTransaction(
        token.grantRole(roleHash, admin),
        `Token: grant ${label} → ${admin}`,
        networkConfig.requiredConfirmations
      );
    }
  }
  console.log(chalk.green("✓ Multisig roles granted"));
}

async function transferProxyAdminOwnership(proxyAddress, executor, deployer, networkConfig) {
  console.log(chalk.blue("🛠️ Transferring ProxyAdmin ownership → UpgradeExecutor..."));
  const proxyAdminAddress = await hre.upgrades.erc1967.getAdminAddress(proxyAddress);
  console.log(chalk.gray(`ProxyAdmin @ ${proxyAdminAddress}`));

  const ProxyAdmin = await hre.ethers.getContractAt(
    [
      "function owner() view returns (address)",
      "function transferOwnership(address)",
      "function pendingOwner() view returns (address)",
      "function acceptOwnership()",
    ],
    proxyAdminAddress,
    deployer
  );

  const executorAddress = await executor.getAddress();
  const currentOwner = await ProxyAdmin.owner();

  if (currentOwner.toLowerCase() !== executorAddress.toLowerCase()) {
    await safeTransaction(
      ProxyAdmin.transferOwnership(executorAddress),
      "ProxyAdmin: transferOwnership → executor",
      networkConfig.requiredConfirmations
    );

    // If ProxyAdmin is Ownable2Step (OZ ≥ 5), complete the accept through the executor helper (if available)
    try {
      const pending = await ProxyAdmin.pendingOwner();
      if (pending && pending.toLowerCase() === executorAddress.toLowerCase()) {
        // UpgradeExecutor helper to call acceptOwnership on ProxyAdmin
        await safeTransaction(
          executor.claimProxyAdminOwnership(proxyAdminAddress),
          "Executor: claimProxyAdminOwnership",
          networkConfig.requiredConfirmations
        );
      }
    } catch {
      // If ProxyAdmin is single-step Ownable, nothing else to do
    }
  } else {
    console.log(chalk.gray("ProxyAdmin already owned by executor"));
  }

  return { proxyAdminAddress, executorAddress };
}

async function transferExecutorOwnership(executor, timelock, deployer, networkConfig) {
  console.log(chalk.blue("🛠️ Transferring UpgradeExecutor ownership → Timelock..."));

  const executorAddress = await executor.getAddress();
  const tlAddr = await timelock.getAddress();

  const exec = await hre.ethers.getContractAt(
    ["function owner() view returns (address)", "function transferOwnership(address)", "function acceptOwnership()"],
    executorAddress,
    deployer
  );

  const currentOwner = await exec.owner();
  if (currentOwner.toLowerCase() !== tlAddr.toLowerCase()) {
    await safeTransaction(
      exec.transferOwnership(tlAddr),
      "Executor: transferOwnership → Timelock",
      networkConfig.requiredConfirmations
    );
  } else {
    console.log(chalk.gray("Executor already owned by Timelock"));
  }
  return exec;
}

/* ============================================================================
 * Timelock acceptance (direct vs minisig-routed)
 * ==========================================================================*/
function encodeTimelockSchedule(timelock, target, value, data, predecessor, salt, delaySec) {
  return timelock.interface.encodeFunctionData("schedule", [target, value, data, predecessor, salt, delaySec]);
}
function encodeTimelockExecute(timelock, target, value, data, predecessor, salt) {
  return timelock.interface.encodeFunctionData("execute", [target, value, data, predecessor, salt]);
}

async function scheduleTimelockAcceptance(timelock, executor, deployer, networkConfig, cfg) {
  console.log(chalk.blue("⏲ Timelock acceptOwnership on UpgradeExecutor..."));

  const executorAddress = await executor.getAddress();
  const acceptData = executor.interface.encodeFunctionData("acceptOwnership");
  const salt = generateSalt("accept-executor");
  const predecessor = ZeroHash;

  const tlAddr = await timelock.getAddress();
  const isProposerContract = await isContract(cfg.proposers[0]);

  if (isProposerContract) {
    const scheduleCalldata = encodeTimelockSchedule(
      timelock,
      executorAddress,
      0,
      acceptData,
      predecessor,
      salt,
      networkConfig.minDelay
    );
    const executeCalldata = encodeTimelockExecute(timelock, executorAddress, 0, acceptData, predecessor, salt);
    console.log(chalk.yellow("Timelock PROPOSER is a contract (MiniMultisig/Safe). Use the multisig to:"));
    console.log(`1) propose(target=${tlAddr}, value=0, data=schedule(...))`);
    console.log(`   data = ${scheduleCalldata}`);
    console.log("2) Both owners approve, then multisig.execute(id).");
    console.log(`3) After delay, propose+execute acceptOwnership:`);
    console.log(`   data = ${executeCalldata}`);
    return salt;
  }

  const tl = timelock.connect(deployer);
  const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
  const hasProposer = await timelock.hasRole(PROPOSER_ROLE, await deployer.getAddress());
  console.log(chalk.gray(`caller ${await deployer.getAddress()} has PROPOSER_ROLE? ${hasProposer}`));
  if (!hasProposer) throw new Error(`Timelock schedule must be sent by a PROPOSER.`);

  await safeTransaction(
    tl.schedule(executorAddress, 0, acceptData, predecessor, salt, networkConfig.minDelay),
    `TL: schedule accept (delay=${networkConfig.minDelay}s)`,
    networkConfig.requiredConfirmations
  );
  console.log(chalk.yellow("✓ acceptOwnership flow prepared"));
  return salt;
}

/* ============================================================================
 * Post config checks
 * ==========================================================================*/
async function renounceDeployerRoles(token, deployer, networkConfig) {
  console.log(chalk.blue("🧹 Deployer renouncing token roles..."));

  const tryGet = async (name) => {
    try {
      const fn = token.interface.getFunction(name);
      return await token[name]();
    } catch {
      return null;
    }
  };

  const DEFAULT_ADMIN_ROLE = await token.DEFAULT_ADMIN_ROLE();
  const roleIds = await (async () => {
    try {
      return await token.getRoleIds(); // happy path
    } catch {
      // fallback: gather individually
      return [
        await tryGet("PAUSER_ROLE"),
        await tryGet("MINTER_ROLE"),
        await tryGet("SIGNER_ROLE"),
        await tryGet("PARAMETER_ADMIN_ROLE"),
        await tryGet("EMERGENCY_ADMIN_ROLE"),
        await tryGet("UPGRADER_ROLE"),
        await tryGet("API_SIGNER_ROLE"),
      ];
    }
  })();

  const pairs = [
    ["DEFAULT_ADMIN_ROLE", DEFAULT_ADMIN_ROLE],
    ["PAUSER_ROLE", roleIds[0]],
    ["MINTER_ROLE", roleIds[1]],
    ["SIGNER_ROLE", roleIds[2]],
    ["PARAMETER_ADMIN_ROLE", roleIds[3]],
    ["EMERGENCY_ADMIN_ROLE", roleIds[4]],
    ["UPGRADER_ROLE", roleIds[5]],
    ["API_SIGNER_ROLE", roleIds[6]],
  ].filter(([, v]) => v);

  for (const [label, roleHash] of pairs) {
    if (await token.hasRole(roleHash, deployer.address)) {
      await safeTransaction(
        token.renounceRole(roleHash, deployer.address),
        `Token: renounce ${label}`,
        networkConfig.requiredConfirmations
      );
    }
  }
  console.log(chalk.green("✓ Deployer roles renounced"));
}

async function verifyInvariants(token, timelock, cfg, proxyAdminAddress, executorAddress) {
  console.log(chalk.blue("\n🔍 Verifying security invariants..."));

  const DEFAULT_ADMIN_ROLE = await token.DEFAULT_ADMIN_ROLE();
  const tokenAdmin = requireAddress("token admin", cfg.admins[0]);
  if (!(await token.hasRole(DEFAULT_ADMIN_ROLE, tokenAdmin))) {
    throw new Error("Invariant failed: multisig must hold token DEFAULT_ADMIN_ROLE");
  }

  const TL_ADMIN = await timelock.DEFAULT_ADMIN_ROLE();
  for (const a of cfg.admins) {
    const adminChecked = requireAddress("Timelock admin", a);
    if (!(await timelock.hasRole(TL_ADMIN, adminChecked))) {
      throw new Error(`Invariant failed: ${adminChecked} must be Timelock DEFAULT_ADMIN`);
    }
  }

  const pa = await hre.ethers.getContractAt(["function owner() view returns (address)"], proxyAdminAddress);
  const paOwner = await pa.owner();
  if (paOwner.toLowerCase() !== executorAddress.toLowerCase()) {
    throw new Error("Invariant failed: ProxyAdmin must be owned by UpgradeExecutor");
  }
  console.log(chalk.green("✓ All invariants satisfied"));
}

/* ============================================================================
 * Artifacts & (Optional) Verification
 * ==========================================================================*/
function saveDeploymentArtifacts(deployment, networkName) {
  const artifact = {
    network: networkName,
    timestamp: new Date().toISOString(),
    deploymentId: generateSalt("deployment"),
    contracts: {
      tokenProxy: deployment.tokenProxy,
      implementation: deployment.implementation,
      timelock: deployment.timelock,
      proxyAdmin: deployment.proxyAdmin,
      upgradeExecutor: deployment.upgradeExecutor,
      miniMultisig: deployment.miniMultisig || null,
    },
    configuration: {
      minDelay: deployment.minDelay,
      executorUpgradeDelay: deployment.executorUpgradeDelay,
      multisig: deployment.multisig,
      oracle: deployment.oracle,
      mode: deployment.mode,
      proposers: deployment.proposers,
      executors: deployment.executors,
      admins: deployment.admins,
      tlScheduleCalldata: deployment.tlScheduleCalldata || null,
      tlExecuteCalldata: deployment.tlExecuteCalldata || null,
      acceptanceSalt: deployment.acceptanceSalt || null,
    },
    metadata: {
      hardhatVersion: require("hardhat/package.json").version,
    },
  };

  if (!fs.existsSync("deployments")) fs.mkdirSync("deployments");
  const filename = `deployments/${networkName}-deployment-${Date.now()}.json`;
  fs.writeFileSync(filename, JSON.stringify(artifact, null, 2));
  fs.writeFileSync(`deployments/${networkName}-latest.json`, JSON.stringify(artifact, null, 2));
  console.log(chalk.green(`📗 Artifacts saved: ${filename}`));
  return filename;
}

async function verifyContracts(deployment, networkConfig) {
  if (!networkConfig.verify) {
    console.log(chalk.gray("⏭️  Skipping block explorer verification for this network."));
    return;
  }
  console.log(chalk.blue("\n🔍 Verifying contracts..."));
  try {
    await hre.run("verify:verify", { address: deployment.implementation, constructorArguments: [] });
    console.log(chalk.green("✓ Token implementation verified"));
  } catch (e) {
    console.log(chalk.yellow("⚠️  Implementation verify skipped/failed:"), e.message || e);
  }
}

async function validateFinalState(deployment) {
  console.log(chalk.blue("\n🔎 Validating final state..."));
  const checks = [
    { name: "Token Proxy", address: deployment.tokenProxy },
    { name: "Timelock", address: deployment.timelock },
    { name: "UpgradeExecutor", address: deployment.upgradeExecutor },
  ];
  for (const check of checks) {
    const code = await hre.ethers.provider.getCode(check.address);
    if (code === "0x") throw new Error(`${check.name} not deployed at ${check.address}`);
    console.log(chalk.green(`✓ ${check.name} verified`));
  }

  const pa = await hre.ethers.getContractAt(["function owner() view returns (address)"], deployment.proxyAdmin);
  const owner = await pa.owner();
  if (owner.toLowerCase() !== deployment.upgradeExecutor.toLowerCase()) {
    throw new Error("ProxyAdmin ownership not correctly transferred");
  }
  console.log(chalk.green("✓ Final state validated"));
}

/* ============================================================================
 * Main Orchestration
 * ==========================================================================*/
async function getMultisigConfig(mode, deployerAddr) {
  if (mode === "mini") {
    const miniAddr = requireAddress("MINI_MULTISIG_ADDRESS", process.env.MINI_MULTISIG_ADDRESS);
    const a = requireAddress("MULTISIG_EOA_1", process.env.MULTISIG_EOA_1);
    const b = requireAddress("MULTISIG_EOA_2", process.env.MULTISIG_EOA_2);
    return {
      proposers: [miniAddr],
      executors: [miniAddr],
      admins: [a, b],
      adminPrimary: a,
    };
  }
  const ms = requireAddress("multisig/admin", getMultisigAddressFallback(deployerAddr));
  return {
    proposers: [ms],
    executors: [ms],
    admins: [ms],
    adminPrimary: ms,
  };
}

async function deployGemStepEnv() {
  console.log(chalk.bold(`\n🚀 Starting GemStep deployment → ${hre.network.name.toUpperCase()}`));
  console.log(
    chalk.gray(
      `[Build] profile=${process.env.BUILD_PROFILE || "dev"} runs=${process.env.OPTIMIZER_RUNS || 1} ` +
        `viaIR=${(process.env.USE_IR ?? "1") !== "0" ? "on" : "off"} yul=${(process.env.YUL ?? "1") !== "0" ? "true" : "false"} evm=shanghai`
    )
  );

  await validateEnvironment();

  const networkConfig = NETWORK_CONFIG[hre.network.name] || NETWORK_CONFIG.hardhat;
  const deployer = await getDeployer();
  await preFlightChecks(networkConfig, deployer);
  await checkDeploymentRisks(deployer.address);

  // 0) Optional: deploy MiniMultisig (mini mode)
  const mode = getMode();
  if (mode === "mini") {
    await deployMiniMultisig(networkConfig, deployer);
  }

  const cfg = await getMultisigConfig(mode, deployer.address);
  const multisigAddress = cfg.adminPrimary;

  const bal = await hre.ethers.provider.getBalance(deployer.address);
  console.log(chalk.blue("\n📓 Deployment Configuration:"));
  console.log(`Network     : ${chalk.bold(hre.network.name)}`);
  console.log(`Deployer    : ${deployer.address}`);
  console.log(`Balance     : ${formatUnits(bal, 18)} ETH`);
  console.log(`Mode        : ${mode}`);
  if (mode === "mini") {
    console.log(`Multisig    : ${process.env.MINI_MULTISIG_ADDRESS} (participants: ${cfg.admins.join(", ")})`);
  } else {
    console.log(`Multisig    : ${multisigAddress}`);
  }
  console.log(`Proposers   : ${cfg.proposers.join(", ")}`);
  console.log(`Executors   : ${cfg.executors.join(", ")}`);
  console.log(`Admins      : ${cfg.admins.join(", ")}`);
  console.log(`AdminPrimary: ${cfg.adminPrimary}`);
  console.log(`TL minDelay : ${networkConfig.minDelay}s`);
  console.log(`Exec delay  : ${EXECUTOR_UPGRADE_DELAY.toString()}s`);

  // 1) Timelock
  const timelock = await deployTimelock(networkConfig, deployer, cfg);

  // 2) Oracle
  const oracleAddress = await getOracleAddress(deployer);

  // 3) Token proxy (adminPrimary controls the token)
  const token = await deployToken(networkConfig, deployer, oracleAddress, cfg.adminPrimary);

  // 4) UpgradeExecutor
  const executor = await deployUpgradeExecutor(networkConfig, deployer);

  // Addresses
  const tokenAddress = await token.getAddress();
  const timelockAddress = await timelock.getAddress();
  const executorAddress = await executor.getAddress();
  const implementationAddress = await hre.upgrades.erc1967.getImplementationAddress(tokenAddress);
  const proxyAdminAddress = await hre.upgrades.erc1967.getAdminAddress(tokenAddress);

  // 5) Configure token
  await configureArbitrum(token, networkConfig);
  await grantTokenRoles(token, cfg.adminPrimary, networkConfig);

  // 6) ProxyAdmin → Executor
  await transferProxyAdminOwnership(tokenAddress, executor, deployer, networkConfig);

  // 7) Executor → Timelock
  await transferExecutorOwnership(executor, timelock, deployer, networkConfig);

  // 8) Timelock accepts executor (direct if EOA proposer, otherwise print multisig calldata)
  const acceptanceSalt = await scheduleTimelockAcceptance(timelock, executor, deployer, networkConfig, cfg);

  // Precompute (for artifacts) the schedule/execute calldata if proposer is contract
  let tlScheduleCalldata = null;
  let tlExecuteCalldata = null;
  if (await isContract(cfg.proposers[0])) {
    const acceptData = executor.interface.encodeFunctionData("acceptOwnership");
    const predecessor = ZeroHash;
    tlScheduleCalldata = encodeTimelockSchedule(
      timelock,
      executorAddress,
      0,
      acceptData,
      predecessor,
      acceptanceSalt,
      networkConfig.minDelay
    );
    tlExecuteCalldata = encodeTimelockExecute(timelock, executorAddress, 0, acceptData, predecessor, acceptanceSalt);
  }

  // 9) Remove deployer powers on token
  await renounceDeployerRoles(token, deployer, networkConfig);

  // 10) Invariants
  await verifyInvariants(token, timelock, cfg, proxyAdminAddress, executorAddress);

  // Persist
  const deployment = {
    minDelay: networkConfig.minDelay,
    tokenProxy: tokenAddress,
    implementation: implementationAddress,
    timelock: timelockAddress,
    proxyAdmin: proxyAdminAddress,
    upgradeExecutor: executorAddress,
    miniMultisig: mode === "mini" ? process.env.MINI_MULTISIG_ADDRESS : undefined,
    multisig: cfg.adminPrimary,
    proposers: cfg.proposers,
    executors: cfg.executors,
    admins: cfg.admins,
    oracle: oracleAddress,
    acceptanceSalt,
    executorUpgradeDelay: EXECUTOR_UPGRADE_DELAY.toString(),
    mode,
    tlScheduleCalldata,
    tlExecuteCalldata,
  };
  const artifactFile = saveDeploymentArtifacts(deployment, hre.network.name);

  await verifyContracts(deployment, networkConfig);
  await validateFinalState(deployment);

  // Summary
  console.log(chalk.green.bold("\n🎉 GemStep deployment completed!"));
  console.log(chalk.bold("\n📄 Summary"));
  console.log(`Token Proxy     : ${chalk.cyan(tokenAddress)}`);
  console.log(`Implementation  : ${chalk.cyan(implementationAddress)}`);
  console.log(`Timelock        : ${chalk.cyan(timelockAddress)}`);
  console.log(`Proxy Admin     : ${chalk.cyan(proxyAdminAddress)}`);
  console.log(`UpgradeExecutor : ${chalk.cyan(executorAddress)}`);
  if (mode === "mini") console.log(`   MiniMultisig    : ${chalk.cyan(process.env.MINI_MULTISIG_ADDRESS)}`);
  console.log(`Oracle          : ${chalk.cyan(oracleAddress)}`);

  if (await isContract(cfg.proposers[0])) {
    console.log(chalk.yellow("\nℹ️  Timelock scheduling via MiniMultisig required."));
    console.log(`schedule() calldata: ${tlScheduleCalldata}`);
    console.log(`execute()  calldata: ${tlExecuteCalldata}`);
  } else if (networkConfig.minDelay > 0) {
    console.log(chalk.yellow("\nℹ️  Next Step:"));
    console.log(`Execute acceptOwnership after ${networkConfig.minDelay}s`);
    console.log(`salt = ${acceptanceSalt}`);
  }

  console.log(chalk.gray(`\n📁 Artifacts: ${artifactFile}`));
  return deployment;
}

/* ============================================================================
 * Entrypoint
 * ==========================================================================*/
async function main() {
  const t0 = Date.now();
  try {
    await deployGemStepEnv();
    const dt = ((Date.now() - t0) / 1000).toFixed(2);
    console.log(chalk.green(`\n⏱️  Done in ${dt}s`));
  } catch (err) {
    console.error(chalk.red.bold("\n✖ Deployment failed:"));
    console.error(chalk.red(err.stack || err.message));
    process.exit(1);
  }
}

module.exports = { deployGemStepEnv, NETWORK_CONFIG };

if (require.main === module) {
  main();
}
