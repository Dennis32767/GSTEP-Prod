/* eslint-disable no-console */
/**
 * @file deploy_gemstep_env.js
 * @notice Production-ready deployment orchestrator for GemStep on dev/test/prod networks.
 *
 * @dev
 *  - Uses Hardhat + Ethers v6 + OZ Upgrades (Transparent Proxy).
 *  - Handles:
 *      - env validation & risk checks
 *      - optional MiniMultisig2of2 for testnets
 *      - TimelockController deployment and admin hardening
 *      - Oracle selection (env or mock on dev)
 *      - GemStepToken proxy deployment + post-config
 *      - UpgradeExecutor deployment + ownership transfers
 *      - role grants + DEFAULT_ADMIN_ROLE handover + deployer cleanup
 *      - artifact persistence + optional contract verification hooks
 *
 * IMPORTANT:
 *  - This file assumes repo-local helper functions exist (see bottom NOTE).
 *  - This script does not import "hardhat" inside hardhat.config.* (HH9 safe).
 */

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

/* =============================================================================
 * Network Configuration
 * ===========================================================================*/
/**
 * @notice Per-network operational safety configuration.
 * @dev
 *  - minDelay is used for TimelockController deployment.
 *  - requiredConfirmations reduces reorg risk on public nets.
 *  - gasBuffer is used to pad deploy tx gas limits for more reliable execution.
 *  - maxGasPrice is a safety alert threshold (not a hard block).
 */
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

/**
 * @notice Override executor upgrade delay via ENV.
 * @dev
 *  - Dev networks default to 0.
 *  - Non-dev defaults to 86400 (24h).
 */
const EXECUTOR_UPGRADE_DELAY = BigInt(
  process.env.EXECUTOR_UPGRADE_DELAY
    ? Number(process.env.EXECUTOR_UPGRADE_DELAY)
    : isDevNetwork(hre.network.name)
      ? 0
      : 86400
);

/* =============================================================================
 * Utils
 * ===========================================================================*/
/** @notice Sleep helper. */
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

/**
 * @notice Generate a pseudo-unique salt for timelock scheduling and artifacts.
 * @dev Not cryptographically secure; only intended for unique identifiers.
 */
const generateSalt = (label = "deploy") =>
  keccak256(toUtf8Bytes(`${label}-${Date.now()}-${Math.random()}`));

/**
 * @notice On-chain code existence check.
 * @param {string} addr Address to test.
 * @returns {Promise<boolean>} True if deployed bytecode exists.
 */
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
/**
 * @notice Validate and checksum an address.
 * @param {string} label Context label for error messages.
 * @param {string} value Candidate address.
 * @param {{allowZero?: boolean}} opts Options.
 * @returns {string} Checksummed address.
 */
function requireAddress(label, value, { allowZero = false } = {}) {
  if (!value || value === "0x") throw new Error(`Missing/placeholder address for ${label}.`);
  if (value === ZeroAddress && !allowZero) throw new Error(`Zero address not allowed for ${label}.`);
  if (!isAddress(value)) throw new Error(`Invalid ${label}: ${value}`);
  return getAddress(value);
}

/**
 * @notice Normalize an array of addresses with strict validation.
 * @param {string} label Label for context.
 * @param {string[]} arr Array of addresses.
 * @returns {string[]} Checksummed addresses.
 */
function normalizeAddrArray(label, arr) {
  if (!Array.isArray(arr) || arr.length === 0) throw new Error(`${label} cannot be empty`);
  return arr.map((a) => requireAddress(label, a));
}

/* =============================================================================
 * Env Validation & Risk Checks
 * ===========================================================================*/
/**
 * @notice Validate environment variables and cross-check critical settings.
 * @dev Throws on invalid configuration.
 */
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
    TREASURY_ADDRESS: {
      required: !isDevNetwork(hre.network.name),
      validate: (v) => !v || isAddress(v),
      msg: "must be a valid address (required on non-dev)",
    },
    ARBITRUM_INBOX_ADDRESS: {
      required: false,
      validate: (v) => !v || isAddress(v),
      msg: "must be a valid address",
    },
    L1_VALIDATOR_ADDRESS: {
      required: false,
      validate: (v) => !v || isAddress(v),
      msg: "must be a valid address",
    },
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

  // Strong check: if both MULTISIG_PRIVATE_KEY and MULTISIG_ADDRESS are given, enforce match
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

/**
 * @notice Basic deployer sanity checks.
 * @param {string} deployerAddress Deployer EOA address.
 */
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

/* =============================================================================
 * Signers & Multisig helpers
 * ===========================================================================*/
/**
 * @notice Resolve deployer signer from env private key or Hardhat signers.
 * @returns {Promise<import("ethers").Signer>}
 */
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

/**
 * @notice Determine multisig mode.
 * @dev
 *  - eoa: single EOA controls everything (dev)
 *  - mini: MiniMultisig2of2 (testnets)
 *  - safe: Gnosis Safe (mainnets)
 */
function getMode() {
  if (process.env.MULTISIG_MODE) return process.env.MULTISIG_MODE;
  if (isDevNetwork(hre.network.name)) return "eoa";
  if (["sepolia", "arbitrumSepolia"].includes(hre.network.name)) return "mini";
  return "safe";
}

/**
 * @notice Hardened fallback for multisig address to avoid ENS resolution.
 * @dev In eoa/safe mode: env address or deployer fallback. In mini mode: set after deployMiniMultisig().
 */
function getMultisigAddressFallback(deployerAddr) {
  const mode = getMode();
  const env = (process.env.MULTISIG_ADDRESS || "").trim();

  if (mode === "eoa" || mode === "safe") {
    return env && env !== "0x" ? env : deployerAddr;
  }
  return process.env.MINI_MULTISIG_ADDRESS || "";
}

/* =============================================================================
 * Tx helpers
 * ===========================================================================*/
/**
 * @notice Wrap a tx and wait for confirmations, printing consistent logs.
 */
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

/**
 * @notice Warn if current gas exceeds configured threshold.
 */
async function checkGasPrice(networkConfig) {
  if (!networkConfig.maxGasPrice) return;
  const feeData = await hre.ethers.provider.getFeeData();
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

/**
 * @notice Preflight checks that do not mutate state.
 */
async function preFlightChecks(networkConfig) {
  console.log(chalk.blue("✈️  Running preflight checks..."));
  try {
    if (hre.upgrades?.admin?.getInstance) {
      const proxyAdmin = await hre.upgrades.admin.getInstance();
      const adminAddress = await proxyAdmin.getAddress();
      const adminCode = await hre.ethers.provider.getCode(adminAddress);
      if (adminCode !== "0x") console.log(chalk.gray(`   ProxyAdmin detected @ ${adminAddress}`));
    }
  } catch {
    // ignore
  }
  await checkGasPrice(networkConfig);
  const network = await hre.ethers.provider.getNetwork();
  console.log(chalk.gray(`Chain ID: ${network.chainId}`));
  console.log(chalk.green("✓ Preflight checks passed"));
}

/* =============================================================================
 * MiniMultisig2of2 (testnets)
 * ===========================================================================*/
/**
 * @notice Deploy MiniMultisig2of2 if mode === "mini".
 * @returns {Promise<import("ethers").Contract|null>}
 */
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
  txReq.from = await deployer.getAddress();

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

/* =============================================================================
 * Timelock deploy
 * ===========================================================================*/
/**
 * @notice Deploy a TimelockController and harden admin roles.
 * @param {object} cfg Role configuration ({proposers, executors, admins}).
 * @returns {Promise<import("ethers").Contract>}
 */
async function deployTimelock(networkConfig, deployer, cfg) {
  console.log(chalk.blue("\n🕓 Deploying TimelockController (multisig actor)..."));
  const Timelock = await hre.ethers.getContractFactory("TimelockController", deployer);

  const proposers = normalizeAddrArray("Timelock proposers", cfg.proposers);
  const executors = normalizeAddrArray("Timelock executors", cfg.executors);

  const deployerAddr = await deployer.getAddress();
  const tl = await Timelock.deploy(networkConfig.minDelay, proposers, executors, deployerAddr);
  await tl.waitForDeployment();

  const tlAddr = await tl.getAddress();
  console.log(chalk.green(`✅ Timelock deployed: ${tlAddr}`));

  const TL_ADMIN = await tl.DEFAULT_ADMIN_ROLE();

  // Ensure designated admins have TL admin
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

  // Deployer renounces TL admin
  if (await tl.hasRole(TL_ADMIN, deployerAddr)) {
    await safeTransaction(
      tl.renounceRole(TL_ADMIN, deployerAddr),
      "TL: deployer renounce DEFAULT_ADMIN",
      networkConfig.requiredConfirmations
    );
  }

  return tl;
}

/* =============================================================================
 * Oracle helpers
 * ===========================================================================*/
/**
 * @notice Deploy a mock oracle on dev networks.
 * @returns {Promise<string>} Oracle address.
 */
async function deployMockOracle(deployer) {
  console.log(chalk.blue("🛠️ Deploying MockPriceOracle..."));
  const MockOracle = await hre.ethers.getContractFactory("MockPriceOracle", deployer);
  const oracle = await MockOracle.deploy(parseUnits("0.005", 18), 0);
  await oracle.waitForDeployment();
  const addr = await oracle.getAddress();
  console.log(chalk.green(`✅ MockPriceOracle deployed: ${addr}`));
  return addr;
}

/**
 * @notice Resolve oracle address from env or deploy mock on dev.
 */
async function getOracleAddress(deployer) {
  if (process.env.PRICE_ORACLE_ADDRESS) {
    console.log(chalk.gray("Using PRICE_ORACLE_ADDRESS from env"));
    return requireAddress("PRICE_ORACLE_ADDRESS", process.env.PRICE_ORACLE_ADDRESS);
  }
  if (isDevNetwork(hre.network.name)) return deployMockOracle(deployer);
  throw new Error("PRICE_ORACLE_ADDRESS is required for non-dev networks");
}

/**
 * @notice Resolve treasury address from env or default to deployer on dev.
 */
function getTreasuryAddress(deployerAddr) {
  const env = (process.env.TREASURY_ADDRESS || "").trim();
  if (env) return requireAddress("TREASURY_ADDRESS", env);
  if (isDevNetwork(hre.network.name)) return deployerAddr;
  throw new Error("TREASURY_ADDRESS is required for non-dev networks");
}

/* =============================================================================
 * Multisig config (deduped; mini adminPrimary = multisig contract)
 * ===========================================================================*/
/**
 * @notice Build timelock proposer/executor/admin config based on multisig mode.
 */
async function getMultisigConfig(mode, deployerAddr) {
  if (mode === "mini") {
    const miniAddr = requireAddress("MINI_MULTISIG_ADDRESS", process.env.MINI_MULTISIG_ADDRESS);
    const a = requireAddress("MULTISIG_EOA_1", process.env.MULTISIG_EOA_1);
    const b = requireAddress("MULTISIG_EOA_2", process.env.MULTISIG_EOA_2);
    return {
      proposers: [miniAddr],
      executors: [miniAddr],
      admins: [a, b],         // TL admins are the EOAs
      adminPrimary: miniAddr, // Token admin is the multisig contract (final)
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

/* =============================================================================
 * Token deploy (proxy)
 * initialize(uint256 initialSupply, address admin, address priceOracle, address treasury)
 * ===========================================================================*/
/**
 * @notice Deploy GemStepToken behind a transparent proxy.
 * @dev
 *  - Uses deployer as TEMP admin so post-deploy configuration can run.
 */
async function deployToken(networkConfig, deployer, oracleAddress, adminAddress, treasuryAddress) {
  console.log(chalk.blue("\n🛠️ Deploying GemStepToken (proxy)..."));
  if (!hre.upgrades) throw new Error("OpenZeppelin upgrades plugin not loaded in Hardhat.");

  const GemStepToken = await hre.ethers.getContractFactory("GemStepToken", deployer);

  // Tokenomics: 400,000,000 initial mint (18 decimals)
  const initialSupply = parseUnits("400000000", 18);

  const treasury = requireAddress("treasuryAddress", treasuryAddress);
  const admin = requireAddress("adminAddress", adminAddress);
  const oracle = requireAddress("oracleAddress", oracleAddress);

  const token = await hre.upgrades.deployProxy(
    GemStepToken,
    [initialSupply, admin, oracle, treasury],
    { kind: "transparent", timeout: 180000 }
  );
  await token.waitForDeployment();

  const proxy = await token.getAddress();
  const impl = await hre.upgrades.erc1967.getImplementationAddress(proxy);

  // Optional: lightweight readbacks if functions exist
  const fnExists = (iface, sig) => {
    try {
      iface.getFunction(sig);
      return true;
    } catch {
      return false;
    }
  };

  let totalSupply = null;
  let cap = null;
  let rewardPerStep = null;

  if (fnExists(token.interface, "totalSupply()")) totalSupply = await token.totalSupply().catch(() => null);
  if (fnExists(token.interface, "cap()")) cap = await token.cap().catch(() => null);
  if (fnExists(token.interface, "getCoreParams()")) {
    const [_burnFee, _rewardRate] = await token.getCoreParams().catch(() => [null, null]);
    rewardPerStep = _rewardRate;
  }

  console.log(chalk.green(`✅ Token proxy: ${proxy}`));
  console.log(chalk.gray(`impl       : ${impl}`));
  console.log(chalk.gray(`treasury   : ${treasury}`));
  console.log(chalk.gray(`supply     : ${totalSupply != null ? `${formatUnits(totalSupply)} GSTEP` : "(n/a)"}`));
  console.log(chalk.gray(`cap        : ${cap != null ? `${formatUnits(cap)} GSTEP` : "(n/a)"}`));
  console.log(chalk.gray(`rewardRate : ${rewardPerStep != null ? `${formatUnits(rewardPerStep)} GSTEP/step` : "(n/a)"}`));

  return token;
}

/* =============================================================================
 * Role grants using getRoleIdsPacked() + DEFAULT_ADMIN_ROLE()
 * ===========================================================================*/
/**
 * @notice Grant operational roles to the final admin (multisig/mini/safe).
 * @dev
 *  - Prefers GS_Views.getRoleIdsPacked() if present (smaller bytecode on-chain).
 *  - Falls back to reading public role constants.
 */
async function grantTokenRoles(token, adminAddress, networkConfig) {
  console.log(chalk.blue("🔐 Granting roles to multisig..."));

  const admin = requireAddress("adminAddress", adminAddress);
  const DEFAULT_ADMIN_ROLE = await token.DEFAULT_ADMIN_ROLE();

  // prefer packed getter from your GS_Views drop-in
  let roles = null;
  try {
    token.interface.getFunction("getRoleIdsPacked()");
    roles = await token.getRoleIdsPacked();
  } catch {
    roles = null;
  }

  let pairs = [];
  if (roles) {
    pairs = [
      ["PAUSER_ROLE", roles[0]],
      ["MINTER_ROLE", roles[1]],
      ["SIGNER_ROLE", roles[2]],
      ["PARAMETER_ADMIN_ROLE", roles[3]],
      ["EMERGENCY_ADMIN_ROLE", roles[4]],
      ["UPGRADER_ROLE", roles[5]],
      ["API_SIGNER_ROLE", roles[6]],
    ];
  } else {
    const maybe = async (name) => {
      try {
        token.interface.getFunction(`${name}()`);
        return await token[name]();
      } catch {
        return null;
      }
    };

    pairs = [
      ["PAUSER_ROLE", await maybe("PAUSER_ROLE")],
      ["MINTER_ROLE", await maybe("MINTER_ROLE")],
      ["SIGNER_ROLE", await maybe("SIGNER_ROLE")],
      ["PARAMETER_ADMIN_ROLE", await maybe("PARAMETER_ADMIN_ROLE")],
      ["EMERGENCY_ADMIN_ROLE", await maybe("EMERGENCY_ADMIN_ROLE")],
      ["UPGRADER_ROLE", await maybe("UPGRADER_ROLE")],
      ["API_SIGNER_ROLE", await maybe("API_SIGNER_ROLE")],
    ].filter(([, v]) => v);
  }

  // grant all roles if missing
  for (const [label, roleHash] of pairs) {
    if (!(await token.hasRole(roleHash, admin))) {
      await safeTransaction(
        token.grantRole(roleHash, admin),
        `Token: grant ${label} → ${admin}`,
        networkConfig.requiredConfirmations
      );
    }
  }

  // ensure DEFAULT_ADMIN_ROLE too (belt & suspenders)
  if (!(await token.hasRole(DEFAULT_ADMIN_ROLE, admin))) {
    await safeTransaction(
      token.grantRole(DEFAULT_ADMIN_ROLE, admin),
      `Token: grant DEFAULT_ADMIN_ROLE → ${admin}`,
      networkConfig.requiredConfirmations
    );
  }

  console.log(chalk.green("✓ Multisig roles granted"));
}

/* =============================================================================
 * Token admin handover
 * ===========================================================================*/
/**
 * @notice Transfer DEFAULT_ADMIN_ROLE to final admin and remove it from deployer.
 */
async function handoverTokenAdmin(token, deployerAddr, finalAdmin, networkConfig) {
  const DEFAULT_ADMIN_ROLE = await token.DEFAULT_ADMIN_ROLE();
  const finalAdminChecked = requireAddress("finalAdmin", finalAdmin);

  if (!(await token.hasRole(DEFAULT_ADMIN_ROLE, finalAdminChecked))) {
    await safeTransaction(
      token.grantRole(DEFAULT_ADMIN_ROLE, finalAdminChecked),
      `Token: grant DEFAULT_ADMIN_ROLE → ${finalAdminChecked}`,
      networkConfig.requiredConfirmations
    );
  }

  if (await token.hasRole(DEFAULT_ADMIN_ROLE, deployerAddr)) {
    await safeTransaction(
      token.renounceRole(DEFAULT_ADMIN_ROLE, deployerAddr),
      "Token: deployer renounce DEFAULT_ADMIN_ROLE",
      networkConfig.requiredConfirmations
    );
  }
}

/* =============================================================================
 * Main Orchestration
 * NOTE: Repo-local helpers are required for the remaining steps.
 * ===========================================================================*/
/**
 * @notice Deploy full GemStep environment on the current Hardhat network.
 * @dev Returns deployed instances and key addresses for scripts/tests.
 */
async function deployGemStepEnv() {
  console.log(chalk.bold(`\n🚀 Starting GemStep deployment → ${hre.network.name.toUpperCase()}`));

  await validateEnvironment();

  const networkConfig = NETWORK_CONFIG[hre.network.name] || NETWORK_CONFIG.hardhat;
  const deployer = await getDeployer();
  const deployerAddr = await deployer.getAddress();

  await preFlightChecks(networkConfig);
  await checkDeploymentRisks(deployerAddr);

  // 0) Optional: deploy MiniMultisig (mini mode)
  const mode = getMode();
  if (mode === "mini") {
    await deployMiniMultisig(networkConfig, deployer);
  }

  const cfg = await getMultisigConfig(mode, deployerAddr);

  // Treasury (single source of truth)
  const treasuryAddress = getTreasuryAddress(deployerAddr);

  // 1) Timelock
  const timelock = await deployTimelock(networkConfig, deployer, cfg);

  // 2) Oracle
  const oracleAddress = await getOracleAddress(deployer);

  // 3) Token proxy (TEMP ADMIN = deployer so post-deploy config works)
  const token = await deployToken(
    networkConfig,
    deployer,
    oracleAddress,
    deployerAddr, // TEMP ADMIN
    treasuryAddress
  );

  // 4+) The rest of the flow relies on repo-local helpers.
  // Keep behavior identical to your existing repo by calling them as before.
  const executor = await deployUpgradeExecutor(networkConfig, deployer);

  // Addresses
  const tokenAddress = await token.getAddress();
  const timelockAddress = await timelock.getAddress();
  const executorAddress = await executor.getAddress();
  const implementationAddress = await hre.upgrades.erc1967.getImplementationAddress(tokenAddress);
  const proxyAdminAddress = await hre.upgrades.erc1967.getAdminAddress(tokenAddress);

  // 5) Configure token (still deployer-admin here)
  await configureArbitrum(token, networkConfig);

  // 6) Grant non-default roles to final adminPrimary while deployer is admin
  await grantTokenRoles(token, cfg.adminPrimary, networkConfig);

  // 7) Hand over DEFAULT_ADMIN_ROLE to final adminPrimary, then renounce from deployer
  await handoverTokenAdmin(token, deployerAddr, cfg.adminPrimary, networkConfig);

  // 8) ProxyAdmin → Executor
  await transferProxyAdminOwnership(tokenAddress, executor, deployer, networkConfig);

  // 9) Executor → Timelock
  await transferExecutorOwnership(executor, timelock, deployer, networkConfig);

  // 10) Timelock accepts executor (direct if EOA proposer, otherwise print multisig calldata)
  const acceptanceSalt = await scheduleTimelockAcceptance(timelock, executor, deployer, networkConfig, cfg);

  // Precompute schedule/execute calldata if proposer is contract
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
    tlExecuteCalldata = encodeTimelockExecute(
      timelock,
      executorAddress,
      0,
      acceptData,
      predecessor,
      acceptanceSalt
    );
  }

  // 11) Remove deployer powers on token
  await renounceDeployerRoles(token, deployer, networkConfig);

  // 12) Invariants
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
    treasury: treasuryAddress,
    acceptanceSalt,
    executorUpgradeDelay: EXECUTOR_UPGRADE_DELAY.toString(),
    mode,
    tlScheduleCalldata,
    tlExecuteCalldata,
  };

  const artifactFile = saveDeploymentArtifacts(deployment, hre.network.name);

  await verifyContracts(deployment, networkConfig);
  await validateFinalState(deployment);

  console.log(chalk.green.bold("\n🎉 GemStep deployment completed!"));
  console.log(chalk.bold("\n📄 Summary"));
  console.log(`Token Proxy     : ${chalk.cyan(tokenAddress)}`);
  console.log(`Implementation  : ${chalk.cyan(implementationAddress)}`);
  console.log(`Timelock        : ${chalk.cyan(timelockAddress)}`);
  console.log(`Proxy Admin     : ${chalk.cyan(proxyAdminAddress)}`);
  console.log(`UpgradeExecutor : ${chalk.cyan(executorAddress)}`);
  console.log(`Treasury        : ${chalk.cyan(treasuryAddress)}`);
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
  return {
    token,
    timelock,
    executor,
    tokenAddress,
    timelockAddress,
    executorAddress,
    implementationAddress,
    proxyAdminAddress,
    oracleAddress,
    treasuryAddress,
    cfg,
    mode,
    networkConfig,
  };
}

/* =============================================================================
 * Entrypoint
 * ===========================================================================*/
/**
 * @notice CLI entrypoint.
 */
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

/* =============================================================================
 * NOTE:
 * This script assumes the following functions exist in your repo (as in your original file):
 * - deployUpgradeExecutor
 * - configureArbitrum
 * - transferProxyAdminOwnership
 * - transferExecutorOwnership
 * - scheduleTimelockAcceptance
 * - encodeTimelockSchedule / encodeTimelockExecute
 * - renounceDeployerRoles
 * - verifyInvariants
 * - saveDeploymentArtifacts
 * - verifyContracts
 * - validateFinalState
 * ===========================================================================*/
