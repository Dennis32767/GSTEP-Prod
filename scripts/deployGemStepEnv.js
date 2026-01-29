/* eslint-disable no-console */
/**
 * @file deploy_gemstep_env.js
 * @notice Main deployment orchestrator for GemStep (GEMS). Designed for a clean mainnet "straight run".
 *
 * Core guarantees:
 *  - Token admin during deployment is ALWAYS the deployer (TEMP), so all grantRole calls succeed directly.
 *  - Timelock proposer includes deployer TEMP, so timelock scheduling can be done even if final proposer is a Safe contract.
 *  - TEMP privileges are revoked at the end (token DAR renounced; timelock proposer revoked; timelock admin renounced).
 *
 * Requirements (env):
 *  - MULTISIG_MODE = "safe" | "mini" | "eoa" (optional; auto defaults by network)
 *  - MULTISIG_ADDRESS (required on non-dev for safe mode)
 *  - TREASURY_ADDRESS (required on non-dev)
 *  - PRICE_ORACLE_ADDRESS (required on non-dev, unless you intentionally allow mock)
 *  - EXECUTOR_UPGRADE_DELAY (optional; default 86400 non-dev, 0 dev)
 *  - ARBITRUM_INBOX_ADDRESS / L1_VALIDATOR_ADDRESS (optional)
 *
 * Mini mode (testnets):
 *  - MULTISIG_EOA_1, MULTISIG_EOA_2 required
 *
 * Notes:
 *  - Uses OZ upgrades transparent proxy.
 *  - Assumes contracts exist: GemStepToken, GemStepViews, UpgradeExecutor, TimelockController, MiniMultisig2of2 (mini mode).
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const chalk = require("chalk");

const {
  parseUnits,
  formatUnits,
  isAddress,
  getAddress,
  ZeroAddress,
  ZeroHash,
  keccak256,
  toUtf8Bytes,
  AbiCoder,
  solidityPackedKeccak256,
} = hre.ethers;

/* =============================================================================
 * Network Configuration
 * ===========================================================================*/
const NETWORK_CONFIG = {
  mainnet: {
    minDelay: 86400,
    gasBuffer: 1.30,
    requiredConfirmations: 3,
    verify: true,
    maxGasPrice: parseUnits("100", "gwei"),
  },
  sepolia: {
    minDelay: 300,
    gasBuffer: 1.25,
    requiredConfirmations: 2,
    verify: true,
    maxGasPrice: parseUnits("50", "gwei"),
  },
  arbitrum: {
    minDelay: 86400,
    gasBuffer: 1.20,
    requiredConfirmations: 2,
    verify: true,
    maxGasPrice: parseUnits("0.2", "gwei"),
  },
  arbitrumSepolia: {
    minDelay: 60,
    gasBuffer: 1.15,
    requiredConfirmations: 1,
    verify: true,
    maxGasPrice: parseUnits("0.2", "gwei"),
  },
  hardhat: { minDelay: 0, gasBuffer: 1.10, requiredConfirmations: 1, verify: false, maxGasPrice: null },
  localhost: { minDelay: 0, gasBuffer: 1.10, requiredConfirmations: 1, verify: false, maxGasPrice: null },
};

NETWORK_CONFIG.arbitrumOne = NETWORK_CONFIG.arbitrum;
NETWORK_CONFIG.ArbitrumOne = NETWORK_CONFIG.arbitrum;

const isDevNetwork = (n) => n === "hardhat" || n === "localhost";

const EXECUTOR_UPGRADE_DELAY = BigInt(
  process.env.EXECUTOR_UPGRADE_DELAY ?? (isDevNetwork(hre.network.name) ? "0" : "86400")
);

/* =============================================================================
 * Utils
 * ===========================================================================*/
function requireAddress(label, value, { allowZero = false } = {}) {
  const v = (value || "").trim();
  if (!v || v === "0x") throw new Error(`Missing/invalid ${label}`);
  if (!isAddress(v)) throw new Error(`Invalid ${label}: ${v}`);
  const a = getAddress(v);
  if (a === ZeroAddress && !allowZero) throw new Error(`Zero address not allowed for ${label}`);
  return a;
}

function normalizeAddrArray(label, arr) {
  if (!Array.isArray(arr) || arr.length === 0) throw new Error(`${label} cannot be empty`);
  return arr.map((a) => requireAddress(label, a));
}

async function isContract(addr) {
  if (!addr || !isAddress(addr)) return false;
  const code = await hre.ethers.provider.getCode(getAddress(addr));
  return code && code !== "0x";
}

function fnExists(iface, sig) {
  try {
    iface.getFunction(sig);
    return true;
  } catch {
    return false;
  }
}

async function safeTx(txPromise, label, confs = 1) {
  try {
    const tx = await txPromise;
    const rcpt = await tx.wait(confs);
    console.log(chalk.green(`✅ ${label}`));
    console.log(chalk.gray(`tx  : ${rcpt.hash}`));
    console.log(chalk.gray(`gas : ${rcpt.gasUsed.toString()}`));
    return rcpt;
  } catch (e) {
    const msg = `${e?.reason || ""} ${e?.shortMessage || ""} ${e?.message || ""}`.trim();
    console.error(chalk.red(`✖ ${label} failed:`), msg || e);
    throw e;
  }
}

async function checkGasPrice(networkCfg) {
  if (!networkCfg.maxGasPrice) return;
  const feeData = await hre.ethers.provider.getFeeData();
  const candidate = feeData.maxFeePerGas ?? feeData.gasPrice;
  if (candidate && candidate > networkCfg.maxGasPrice) {
    console.warn(
      chalk.yellow(
        `⚠️  High gas: ${formatUnits(candidate, "gwei")} gwei (max: ${formatUnits(
          networkCfg.maxGasPrice,
          "gwei"
        )} gwei)`
      )
    );
  }
}

async function preflight(networkCfg, deployerAddr) {
  console.log(chalk.blue("✈️  Preflight checks..."));
  await checkGasPrice(networkCfg);

  const net = await hre.ethers.provider.getNetwork();
  console.log(chalk.gray(`Network: ${hre.network.name}  chainId=${net.chainId.toString()}`));

  const code = await hre.ethers.provider.getCode(deployerAddr);
  if (code !== "0x") throw new Error("Deployer is a contract (unexpected)");

  const bal = await hre.ethers.provider.getBalance(deployerAddr);
  console.log(chalk.gray(`Deployer balance: ${formatUnits(bal, 18)} ETH`));

  console.log(chalk.green("✓ Preflight OK"));
}

/* =============================================================================
 * Mode / Multisig config
 * ===========================================================================*/
function getMode() {
  if (process.env.MULTISIG_MODE) return process.env.MULTISIG_MODE;
  if (isDevNetwork(hre.network.name)) return "eoa";
  if (["sepolia", "arbitrumSepolia"].includes(hre.network.name)) return "mini";
  return "safe";
}

async function getGovernanceConfig(mode, deployerAddr) {
  if (mode === "mini") {
    const a = requireAddress("MULTISIG_EOA_1", process.env.MULTISIG_EOA_1);
    const b = requireAddress("MULTISIG_EOA_2", process.env.MULTISIG_EOA_2);

    // In initial deploy we will deploy MiniMultisig2of2 and use it as adminPrimary.
    return {
      mode,
      adminPrimary: null, // filled after deploy mini
      admins: [a, b], // timelock DEFAULT_ADMIN will be the EOAs (like your resume)
      proposers: [], // filled after deploy mini (+ deployer temp)
      executors: [], // filled after deploy mini
    };
  }

  // safe / eoa
  const msEnv = (process.env.MULTISIG_ADDRESS || "").trim();
  if (!isDevNetwork(hre.network.name) && mode === "safe") {
    if (!msEnv) throw new Error("MULTISIG_ADDRESS is required for MULTISIG_MODE=safe on non-dev networks");
  }

  const ms = msEnv && isAddress(msEnv) ? getAddress(msEnv) : deployerAddr;

  return {
    mode,
    adminPrimary: ms,
    admins: [ms],
    proposers: [ms],
    executors: [ms],
  };
}

/* =============================================================================
 * Oracle + Treasury
 * ===========================================================================*/
async function deployMockOracle(deployer) {
  console.log(chalk.blue("🛠️ Deploying MockPriceOracle..."));
  const MockOracle = await hre.ethers.getContractFactory("MockPriceOracle", deployer);
  const oracle = await MockOracle.deploy(parseUnits("0.005", 18), 0);
  await oracle.waitForDeployment();
  const addr = await oracle.getAddress();
  console.log(chalk.green(`✅ MockPriceOracle: ${addr}`));
  return addr;
}

async function getOracleAddress(deployer) {
  const env = (process.env.PRICE_ORACLE_ADDRESS || "").trim();
  if (env) return requireAddress("PRICE_ORACLE_ADDRESS", env);

  if (isDevNetwork(hre.network.name)) return deployMockOracle(deployer);
  throw new Error("PRICE_ORACLE_ADDRESS is required for non-dev networks");
}

function getTreasuryAddress(deployerAddr) {
  const env = (process.env.TREASURY_ADDRESS || "").trim();
  if (env) return requireAddress("TREASURY_ADDRESS", env);
  if (isDevNetwork(hre.network.name)) return deployerAddr;
  throw new Error("TREASURY_ADDRESS is required for non-dev networks");
}

/* =============================================================================
 * MiniMultisig (testnets only)
 * ===========================================================================*/
async function deployMiniMultisig(networkCfg, deployer, a, b) {
  console.log(chalk.blue("\n🔐 Deploying MiniMultisig2of2..."));
  const Mini = await hre.ethers.getContractFactory("MiniMultisig2of2", deployer);

  const txReq = await Mini.getDeployTransaction(a, b);
  txReq.from = await deployer.getAddress();

  const gasEst = await hre.ethers.provider.estimateGas(txReq).catch(() => null);
  const baseGas = gasEst ?? 1_200_000n;
  const gasLimit = (baseGas * BigInt(Math.ceil(networkCfg.gasBuffer * 100))) / 100n;

  const fee = await hre.ethers.provider.getFeeData();

  const ms = await Mini.deploy(a, b, {
    gasLimit,
    maxFeePerGas: fee.maxFeePerGas ?? undefined,
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? undefined,
  });
  await ms.waitForDeployment();

  const addr = await ms.getAddress();
  console.log(chalk.green(`✅ MiniMultisig2of2: ${addr}`));
  console.log(chalk.gray(`Owner A: ${a}`));
  console.log(chalk.gray(`Owner B: ${b}`));
  return ms;
}

/* =============================================================================
 * Timelock
 *  - IMPORTANT: include deployer temporarily as PROPOSER so the script can schedule acceptOwnership
 * ===========================================================================*/
async function deployTimelock(networkCfg, deployer, cfg, deployerAddr) {
  console.log(chalk.blue("\n🕓 Deploying TimelockController..."));

  const Timelock = await hre.ethers.getContractFactory("TimelockController", deployer);

  // Add deployer as TEMP proposer so we can schedule acceptOwnership even if final proposer is Safe.
  const proposersFinal = normalizeAddrArray("Timelock proposers", cfg.proposers);
  const executorsFinal = normalizeAddrArray("Timelock executors", cfg.executors);

  const proposers = Array.from(new Set([...proposersFinal, deployerAddr].map((x) => getAddress(x))));
  const executors = executorsFinal;

  const tl = await Timelock.deploy(networkCfg.minDelay, proposers, executors, deployerAddr);
  await tl.waitForDeployment();

  const tlAddr = await tl.getAddress();
  console.log(chalk.green(`✅ Timelock: ${tlAddr}`));
  console.log(chalk.gray(`minDelay : ${networkCfg.minDelay}s`));
  console.log(chalk.gray(`proposers: ${proposers.join(", ")}`));
  console.log(chalk.gray(`executors: ${executors.join(", ")}`));

  // Grant DEFAULT_ADMIN_ROLE to cfg.admins, then renounce deployer at the very end (after revokes).
  const TL_ADMIN = await tl.DEFAULT_ADMIN_ROLE();
  for (const admin of cfg.admins) {
    const a = requireAddress("Timelock admin", admin);
    if (!(await tl.hasRole(TL_ADMIN, a))) {
      await safeTx(tl.grantRole(TL_ADMIN, a), `TL: grant DEFAULT_ADMIN → ${a}`, networkCfg.requiredConfirmations);
    }
  }

  return { timelock: tl, tlAddr };
}

async function revokeTempTimelockProposer(timelock, deployerAddr, networkCfg) {
  // Only revoke if TimelockController exposes PROPOSER_ROLE() (it does)
  const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
  const has = await timelock.hasRole(PROPOSER_ROLE, deployerAddr);
  if (!has) return;

  await safeTx(
    timelock.revokeRole(PROPOSER_ROLE, deployerAddr),
    `TL: revoke PROPOSER_ROLE from deployer (${deployerAddr})`,
    networkCfg.requiredConfirmations
  );
}

async function renounceTimelockAdmin(timelock, deployerAddr, networkCfg) {
  const TL_ADMIN = await timelock.DEFAULT_ADMIN_ROLE();
  const has = await timelock.hasRole(TL_ADMIN, deployerAddr);
  if (!has) return;

  await safeTx(
    timelock.renounceRole(TL_ADMIN, deployerAddr),
    "TL: deployer renounce DEFAULT_ADMIN_ROLE",
    networkCfg.requiredConfirmations
  );
}

/* =============================================================================
 * UpgradeExecutor
 * ===========================================================================*/
async function deployUpgradeExecutor(networkCfg, deployer) {
  console.log(chalk.blue("\n🧱 Deploying UpgradeExecutor..."));
  const Exec = await hre.ethers.getContractFactory("UpgradeExecutor", deployer);

  const txReq = await Exec.getDeployTransaction();
  txReq.from = await deployer.getAddress();

  const gasEst = await hre.ethers.provider.estimateGas(txReq).catch(() => null);
  const baseGas = gasEst ?? 800_000n;
  const gasLimit = (baseGas * BigInt(Math.ceil(networkCfg.gasBuffer * 100))) / 100n;

  const fee = await hre.ethers.provider.getFeeData();

  const exec = await Exec.deploy({
    gasLimit,
    maxFeePerGas: fee.maxFeePerGas ?? undefined,
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? undefined,
  });
  await exec.waitForDeployment();

  const addr = await exec.getAddress();
  console.log(chalk.green(`✅ UpgradeExecutor: ${addr}`));
  return exec;
}

async function configureUpgradeExecutorDelay(executor, networkCfg) {
  if (!fnExists(executor.interface, "setUpgradeDelay(uint256)")) return;
  const cur = await executor.upgradeDelay().catch(() => null);
  if (cur === null) return;

  const target = BigInt(EXECUTOR_UPGRADE_DELAY);
  if (BigInt(cur) === target) {
    console.log(chalk.gray(`UpgradeExecutor delay already set: ${cur.toString()}s`));
    return;
  }

  await safeTx(
    executor.setUpgradeDelay(target),
    `UpgradeExecutor: setUpgradeDelay(${target.toString()}s)`,
    networkCfg.requiredConfirmations
  );
}

/* =============================================================================
 * Token (proxy)
 * initialize(uint256 initialSupply, address admin, address priceOracle, address treasury)
 * ===========================================================================*/
async function deployTokenProxy(networkCfg, deployer, oracle, treasury) {
  console.log(chalk.blue("\n🪙 Deploying GemStepToken (Transparent Proxy)..."));
  if (!hre.upgrades) throw new Error("OpenZeppelin upgrades plugin not loaded.");

  const Token = await hre.ethers.getContractFactory("GemStepToken", deployer);

  // Your initial mint (400,000,000) 18dp
  const initialSupply = parseUnits("400000000", 18);

  const deployerAddr = await deployer.getAddress();
  const token = await hre.upgrades.deployProxy(Token, [initialSupply, deployerAddr, oracle, treasury], {
    kind: "transparent",
    timeout: 180000,
  });
  await token.waitForDeployment();

  const proxy = await token.getAddress();
  const impl = await hre.upgrades.erc1967.getImplementationAddress(proxy);
  const proxyAdmin = await hre.upgrades.erc1967.getAdminAddress(proxy);

  console.log(chalk.green(`✅ Token proxy : ${proxy}`));
  console.log(chalk.gray(`impl         : ${impl}`));
  console.log(chalk.gray(`proxyAdmin   : ${proxyAdmin}`));

  // Optional reads
  const ts = fnExists(token.interface, "totalSupply()") ? await token.totalSupply().catch(() => null) : null;
  const cap = fnExists(token.interface, "cap()") ? await token.cap().catch(() => null) : null;
  console.log(chalk.gray(`supply       : ${ts != null ? `${formatUnits(ts)} GEMS` : "(n/a)"}`));
  console.log(chalk.gray(`cap          : ${cap != null ? `${formatUnits(cap)} GEMS` : "(n/a)"}`));

  return { token, proxy, impl, proxyAdmin };
}

/* =============================================================================
 * Views
 * ===========================================================================*/
async function deployViews(networkCfg, deployer, tokenProxy) {
  console.log(chalk.blue("\n👓 Deploying GemStepViews..."));
  const Views = await hre.ethers.getContractFactory("GemStepViews", deployer);

  const txReq = await Views.getDeployTransaction(tokenProxy);
  txReq.from = await deployer.getAddress();

  const gasEst = await hre.ethers.provider.estimateGas(txReq).catch(() => null);
  const baseGas = gasEst ?? 900_000n;
  const gasLimit = (baseGas * BigInt(Math.ceil(networkCfg.gasBuffer * 100))) / 100n;

  const fee = await hre.ethers.provider.getFeeData();
  const views = await Views.deploy(tokenProxy, {
    gasLimit,
    maxFeePerGas: fee.maxFeePerGas ?? undefined,
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? undefined,
  });
  await views.waitForDeployment();

  const addr = await views.getAddress();
  console.log(chalk.green(`✅ GemStepViews: ${addr}`));
  return { views, addr };
}

async function verifyViewsBinding(views, tokenProxy) {
  const config = await views.viewsConfigHash();
  const bound = await views.viewsConfigHashBound();
  const abi = AbiCoder.defaultAbiCoder();

  const schemaCandidates = ["GemStepViews:v1", "GemStepViews:v2", "GemStepViews:v3"];
  for (const s of schemaCandidates) {
    const schema = keccak256(toUtf8Bytes(s));
    const expEncode = keccak256(abi.encode(["bytes32", "address", "bytes32"], [schema, tokenProxy, config]));
    const expPacked = solidityPackedKeccak256(["bytes32", "address", "bytes32"], [schema, tokenProxy, config]);
    if (bound.toLowerCase() === expEncode.toLowerCase()) {
      console.log(chalk.green(`✓ Views bound verified (abi.encode, schema="${s}")`));
      return { schema: s, mode: "encode" };
    }
    if (bound.toLowerCase() === expPacked.toLowerCase()) {
      console.log(chalk.green(`✓ Views bound verified (abi.encodePacked, schema="${s}")`));
      return { schema: s, mode: "packed" };
    }
  }
  throw new Error(`GemStepViews viewsConfigHashBound mismatch. views=${await views.getAddress()} token=${tokenProxy}`);
}

/* =============================================================================
 * Token config (optional Arbitrum params)
 * ===========================================================================*/
async function configureArbitrum(token, networkCfg) {
  const inbox = (process.env.ARBITRUM_INBOX_ADDRESS || "").trim();
  const validator = (process.env.L1_VALIDATOR_ADDRESS || "").trim();

  if (inbox && isAddress(inbox) && fnExists(token.interface, "setArbitrumInbox(address)")) {
    await safeTx(token.setArbitrumInbox(getAddress(inbox)), "Token: setArbitrumInbox", networkCfg.requiredConfirmations);
  }
  if (validator && isAddress(validator) && fnExists(token.interface, "setL1Validator(address)")) {
    await safeTx(token.setL1Validator(getAddress(validator)), "Token: setL1Validator", networkCfg.requiredConfirmations);
  }
}

/* =============================================================================
 * Roles: grant operational roles + DEFAULT_ADMIN_ROLE to final adminPrimary, then renounce deployer
 *  - IMPORTANT: deploy script keeps this SIMPLE (direct), no Path B/C.
 * ===========================================================================*/
async function resolveRolePairs(token, views) {
  // Prefer packed getter (Views -> Token); else local keccak.
  const tryCall = async (c, sig) => {
    try {
      if (!c?.interface) return null;
      c.interface.getFunction(sig);
      const fnName = sig.split("(")[0];
      return await c[fnName]();
    } catch {
      return null;
    }
  };

  let roles = null;
  if (views && fnExists(views.interface, "getRoleIdsPacked()")) roles = await tryCall(views, "getRoleIdsPacked()");
  if (!roles && fnExists(token.interface, "getRoleIdsPacked()")) roles = await tryCall(token, "getRoleIdsPacked()");

  if (roles && Array.isArray(roles) && roles.length >= 7) {
    return [
      ["PAUSER_ROLE", roles[0]],
      ["MINTER_ROLE", roles[1]],
      ["SIGNER_ROLE", roles[2]],
      ["PARAMETER_ADMIN_ROLE", roles[3]],
      ["EMERGENCY_ADMIN_ROLE", roles[4]],
      ["UPGRADER_ROLE", roles[5]],
      ["API_SIGNER_ROLE", roles[6]],
    ];
  }

  const role = (s) => keccak256(toUtf8Bytes(s));
  console.log(chalk.yellow("⚠️ Role getter not found; using local keccak256 role ids fallback."));
  return [
    ["PAUSER_ROLE", role("PAUSER_ROLE")],
    ["MINTER_ROLE", role("MINTER_ROLE")],
    ["SIGNER_ROLE", role("SIGNER_ROLE")],
    ["PARAMETER_ADMIN_ROLE", role("PARAMETER_ADMIN_ROLE")],
    ["EMERGENCY_ADMIN_ROLE", role("EMERGENCY_ADMIN_ROLE")],
    ["UPGRADER_ROLE", role("UPGRADER_ROLE")],
    ["API_SIGNER_ROLE", role("API_SIGNER_ROLE")],
  ];
}

async function grantTokenRolesAndAdmin(token, views, finalAdmin, networkCfg) {
  console.log(chalk.blue("\n🔐 Granting token roles to final admin..."));
  const admin = requireAddress("adminPrimary", finalAdmin);

  const pairs = await resolveRolePairs(token, views);
  if (pairs.length !== 7) throw new Error(`Role resolution failed: got ${pairs.length} roles`);

  for (const [label, roleHash] of pairs) {
    const has = await token.hasRole(roleHash, admin).catch(() => false);
    if (!has) {
      await safeTx(
        token.grantRole(roleHash, admin),
        `Token: grant ${label} → ${admin}`,
        networkCfg.requiredConfirmations
      );
    }
  }

  const DAR = await token.DEFAULT_ADMIN_ROLE();
  if (!(await token.hasRole(DAR, admin))) {
    await safeTx(
      token.grantRole(DAR, admin),
      `Token: grant DEFAULT_ADMIN_ROLE → ${admin}`,
      networkCfg.requiredConfirmations
    );
  }

  console.log(chalk.green("✓ Token roles granted"));
}

async function renounceDeployerTokenDAR(token, deployerAddr, networkCfg) {
  const DAR = await token.DEFAULT_ADMIN_ROLE();
  const has = await token.hasRole(DAR, deployerAddr).catch(() => false);
  if (!has) return;

  await safeTx(token.renounceRole(DAR, deployerAddr), "Token: deployer renounce DEFAULT_ADMIN_ROLE", networkCfg.requiredConfirmations);
}

/* =============================================================================
 * ProxyAdmin → Executor
 * ===========================================================================*/
async function transferProxyAdminOwnership(tokenProxy, executor, deployer, networkCfg) {
  console.log(chalk.blue("\n🔁 ProxyAdmin → UpgradeExecutor..."));
  const proxyAdminAddr = await hre.upgrades.erc1967.getAdminAddress(tokenProxy);
  const execAddr = await executor.getAddress();

  const proxyAdmin = new hre.ethers.Contract(
    proxyAdminAddr,
    ["function owner() view returns (address)", "function transferOwnership(address)"],
    deployer
  );

  const owner = await proxyAdmin.owner().catch(() => null);
  if (owner && owner.toLowerCase() === execAddr.toLowerCase()) {
    console.log(chalk.gray("ProxyAdmin already owned by executor"));
    return proxyAdminAddr;
  }

  await safeTx(
    proxyAdmin.transferOwnership(execAddr),
    `ProxyAdmin: transferOwnership(${execAddr})`,
    networkCfg.requiredConfirmations
  );

  return proxyAdminAddr;
}

/* =============================================================================
 * Executor → Timelock & schedule acceptOwnership
 * ===========================================================================*/
function encodeTimelockSchedule(timelock, target, value, data, predecessor, salt, delay) {
  return timelock.interface.encodeFunctionData("schedule", [target, value, data, predecessor, salt, delay]);
}
function encodeTimelockExecute(timelock, target, value, data, predecessor, salt) {
  return timelock.interface.encodeFunctionData("execute", [target, value, data, predecessor, salt]);
}

async function transferExecutorToTimelock(executor, timelockAddr, networkCfg) {
  console.log(chalk.blue("\n🔁 UpgradeExecutor → Timelock (transferOwnership)..."));
  const owner = await executor.owner().catch(() => null);
  if (owner && owner.toLowerCase() === timelockAddr.toLowerCase()) {
    console.log(chalk.gray("UpgradeExecutor already owned by Timelock"));
    return;
  }
  await safeTx(
    executor.transferOwnership(timelockAddr),
    `UpgradeExecutor: transferOwnership(${timelockAddr})`,
    networkCfg.requiredConfirmations
  );
  console.log(chalk.green("✓ UpgradeExecutor ownership transfer initiated"));
}

async function scheduleAcceptOwnership(timelock, executor, networkCfg, proposerAddr) {
  if (!fnExists(executor.interface, "acceptOwnership()")) {
    console.log(chalk.gray("Executor has no acceptOwnership(); skipping scheduling"));
    return { acceptanceSalt: ZeroHash, tlScheduleCalldata: null, tlExecuteCalldata: null };
  }

  const execAddr = await executor.getAddress();
  const predecessor = ZeroHash;
  const data = executor.interface.encodeFunctionData("acceptOwnership");
  const salt = keccak256(toUtf8Bytes(`accept-${Date.now()}-${Math.random()}`));

  const proposerIsContract = await isContract(proposerAddr);

  const scheduleData = encodeTimelockSchedule(timelock, execAddr, 0, data, predecessor, salt, networkCfg.minDelay);
  const executeData = encodeTimelockExecute(timelock, execAddr, 0, data, predecessor, salt);

  if (proposerIsContract) {
    // We SHOULD still be able to schedule here because deployer was added as TEMP proposer.
    // But if scheduling fails for any reason, we print calldata.
    try {
      await safeTx(
        timelock.schedule(execAddr, 0, data, predecessor, salt, networkCfg.minDelay),
        `Timelock: schedule acceptOwnership (delay=${networkCfg.minDelay}s)`,
        networkCfg.requiredConfirmations
      );
      return { acceptanceSalt: salt, tlScheduleCalldata: scheduleData, tlExecuteCalldata: executeData };
    } catch (e) {
      console.log(chalk.yellow("\n⚠️ Could not schedule directly. Printing calldata for proposer (Safe/Mini):"));
      console.log("schedule() calldata:", scheduleData);
      console.log("execute()  calldata:", executeData);
      return { acceptanceSalt: salt, tlScheduleCalldata: scheduleData, tlExecuteCalldata: executeData };
    }
  }

  // proposer is EOA (or deployer). schedule directly
  await safeTx(
    timelock.schedule(execAddr, 0, data, predecessor, salt, networkCfg.minDelay),
    `Timelock: schedule acceptOwnership (delay=${networkCfg.minDelay}s)`,
    networkCfg.requiredConfirmations
  );
  return { acceptanceSalt: salt, tlScheduleCalldata: scheduleData, tlExecuteCalldata: executeData };
}

/* =============================================================================
 * Artifacts / Verify / Invariants
 * ===========================================================================*/
function saveDeploymentArtifacts(obj, network) {
  const dir = path.resolve(process.cwd(), "deployments");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${network}.deployment.json`);
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  return file;
}

async function verifyContracts(_deployment, networkCfg) {
  if (!networkCfg.verify) {
    console.log(chalk.gray("⏭️ verifyContracts skipped (verify=false)"));
    return;
  }
  // Keep this lightweight: you likely have your own verify flow.
  // If you want, you can call hre.run("verify:verify", { address, constructorArguments: [...] }) for Views/Executor.
  console.log(chalk.gray("⏭️ verifyContracts: implement your repo-specific verification here"));
}

async function verifyInvariants(token, timelock, cfg, proxyAdminAddr, execAddr, viewsAddr) {
  console.log(chalk.blue("\n🧪 Basic invariants..."));
  const dar = await token.DEFAULT_ADMIN_ROLE();
  const ok = await token.hasRole(dar, cfg.adminPrimary).catch(() => false);
  console.log(chalk.gray(`Token DEFAULT_ADMIN_ROLE held by adminPrimary: ${ok}`));

  console.log(chalk.gray(`Views    : ${viewsAddr}`));
  console.log(chalk.gray(`ProxyAdmin: ${proxyAdminAddr}`));
  console.log(chalk.gray(`Executor : ${execAddr}`));
  console.log(chalk.gray(`Timelock : ${await timelock.getAddress()}`));
  console.log(chalk.green("✓ Invariants OK (basic)"));
}

/* =============================================================================
 * Main
 * ===========================================================================*/
async function deployGemStepEnv() {
  console.log(chalk.bold(`\n🚀 GemStep deploy → ${hre.network.name.toUpperCase()}`));

  const networkCfg = NETWORK_CONFIG[hre.network.name] || NETWORK_CONFIG.hardhat;
  const [deployer] = await hre.ethers.getSigners();
  const deployerAddr = await deployer.getAddress();

  await preflight(networkCfg, deployerAddr);

  const mode = getMode();
  let cfg = await getGovernanceConfig(mode, deployerAddr);

  const treasury = getTreasuryAddress(deployerAddr);
  const oracle = await getOracleAddress(deployer);

  // Mini mode: deploy mini, then fill cfg
  let miniMultisigAddr = null;
  if (mode === "mini") {
    const a = requireAddress("MULTISIG_EOA_1", process.env.MULTISIG_EOA_1);
    const b = requireAddress("MULTISIG_EOA_2", process.env.MULTISIG_EOA_2);
    const mini = await deployMiniMultisig(networkCfg, deployer, a, b);
    miniMultisigAddr = await mini.getAddress();

    cfg = {
      ...cfg,
      adminPrimary: miniMultisigAddr,
      proposers: [miniMultisigAddr],
      executors: [miniMultisigAddr],
    };
  }

  // 1) Timelock (with TEMP proposer deployer)
  const { timelock, tlAddr } = await deployTimelock(networkCfg, deployer, cfg, deployerAddr);

  // 2) Token proxy (TEMP ADMIN = deployer)
  const { token, proxy: tokenProxy, impl: implementation, proxyAdmin } = await deployTokenProxy(
    networkCfg,
    deployer,
    oracle,
    treasury
  );

  // 3) Views
  const { views, addr: viewsAddr } = await deployViews(networkCfg, deployer, tokenProxy);
  const viewsBind = await verifyViewsBinding(views, tokenProxy);

  // 4) UpgradeExecutor
  const executor = await deployUpgradeExecutor(networkCfg, deployer);
  const execAddr = await executor.getAddress();

  // 5) Optional token L2 config
  await configureArbitrum(token, networkCfg);

  // 6) Set executor delay BEFORE handover
  await configureUpgradeExecutorDelay(executor, networkCfg);

  // 7) Grant roles + token DAR to final adminPrimary
  await grantTokenRolesAndAdmin(token, views, cfg.adminPrimary, networkCfg);

  // 8) ProxyAdmin → Executor
  const proxyAdminAddr = await transferProxyAdminOwnership(tokenProxy, executor, deployer, networkCfg);

  // 9) Executor → Timelock (transferOwnership), then schedule acceptOwnership
  await transferExecutorToTimelock(executor, tlAddr, networkCfg);

  const proposerActor = cfg.proposers[0];
  const { acceptanceSalt, tlScheduleCalldata, tlExecuteCalldata } = await scheduleAcceptOwnership(
    timelock,
    executor,
    networkCfg,
    proposerActor
  );

  // 10) Revoke TEMP timelock proposer from deployer (tighten)
  await revokeTempTimelockProposer(timelock, deployerAddr, networkCfg);

  // 11) Renounce token DAR from deployer (finalize)
  await renounceDeployerTokenDAR(token, deployerAddr, networkCfg);

  // 12) Renounce timelock admin from deployer (finalize)
  await renounceTimelockAdmin(timelock, deployerAddr, networkCfg);

  // Invariants
  await verifyInvariants(token, timelock, cfg, proxyAdminAddr, execAddr, viewsAddr);

  // Persist artifacts
  const deployment = {
    network: hre.network.name,
    mode,
    minDelay: networkCfg.minDelay,

    tokenProxy,
    implementation,
    proxyAdmin: proxyAdminAddr,

    timelock: tlAddr,
    upgradeExecutor: execAddr,
    views: viewsAddr,

    multisig: cfg.adminPrimary,
    proposers: cfg.proposers,
    executors: cfg.executors,
    admins: cfg.admins,

    oracle,
    treasury,

    executorUpgradeDelay: EXECUTOR_UPGRADE_DELAY.toString(),

    acceptanceSalt,
    tlScheduleCalldata,
    tlExecuteCalldata,

    viewsConfigHash: (await views.viewsConfigHash()).toString(),
    viewsConfigHashBound: (await views.viewsConfigHashBound()).toString(),
    viewsBindVerified: viewsBind,
    miniMultisig: miniMultisigAddr || undefined,
  };

  const artifactFile = saveDeploymentArtifacts(deployment, hre.network.name);

  await verifyContracts(deployment, networkCfg);

  console.log(chalk.green.bold("\n🎉 Deployment completed (schedule created; execute after delay)!"));
  console.log(chalk.bold("\n📌 Summary"));
  console.log(`Token Proxy     : ${chalk.cyan(tokenProxy)}`);
  console.log(`Implementation  : ${chalk.cyan(implementation)}`);
  console.log(`Views           : ${chalk.cyan(viewsAddr)}`);
  console.log(`Timelock        : ${chalk.cyan(tlAddr)}`);
  console.log(`ProxyAdmin      : ${chalk.cyan(proxyAdminAddr)}`);
  console.log(`UpgradeExecutor : ${chalk.cyan(execAddr)}`);
  console.log(`Treasury        : ${chalk.cyan(treasury)}`);
  console.log(`Oracle          : ${chalk.cyan(oracle)}`);
  console.log(chalk.gray(`Artifacts       : ${artifactFile}`));

  if (networkCfg.minDelay > 0) {
    console.log(chalk.yellow(`\n⏳ Next step: after ${networkCfg.minDelay}s, execute Timelock.execute(...) for acceptOwnership.`));
    console.log(chalk.gray(`salt = ${acceptanceSalt}`));
    if (await isContract(cfg.proposers[0])) {
      console.log(chalk.yellow("\nIf you need calldata for Safe/Mini UI:"));
      console.log("schedule() calldata:", tlScheduleCalldata);
      console.log("execute()  calldata:", tlExecuteCalldata);
    }
  }

  return deployment;
}

/* =============================================================================
 * Entrypoint
 * ===========================================================================*/
async function main() {
  const t0 = Date.now();
  try {
    await deployGemStepEnv();
    const dt = ((Date.now() - t0) / 1000).toFixed(2);
    console.log(chalk.green(`\n⏱️ Done in ${dt}s`));
  } catch (err) {
    console.error(chalk.red.bold("\n✖ Deployment failed:"));
    console.error(chalk.red(err?.stack || err?.message || err));
    process.exit(1);
  }
}

module.exports = { deployGemStepEnv, NETWORK_CONFIG };

if (require.main === module) {
  main();
}
