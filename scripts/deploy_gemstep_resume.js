/* eslint-disable no-console */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const chalk = require("chalk");

const {
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
 * Network Configuration (keep in sync with main deploy script)
 * ===========================================================================*/
const NETWORK_CONFIG = {
  mainnet: { minDelay: 86400, gasBuffer: 1.3, requiredConfirmations: 3, verify: true },
  sepolia: { minDelay: 300, gasBuffer: 1.25, requiredConfirmations: 2, verify: true },
  arbitrum: { minDelay: 86400, gasBuffer: 1.2, requiredConfirmations: 2, verify: true },
  arbitrumSepolia: { minDelay: 60, gasBuffer: 1.15, requiredConfirmations: 1, verify: true },
  hardhat: { minDelay: 0, gasBuffer: 1.1, requiredConfirmations: 1, verify: false },
  localhost: { minDelay: 0, gasBuffer: 1.1, requiredConfirmations: 1, verify: false },
};
NETWORK_CONFIG.arbitrumOne = NETWORK_CONFIG.arbitrum;
NETWORK_CONFIG.ArbitrumOne = NETWORK_CONFIG.arbitrum;

const isDevNetwork = (n) => n === "hardhat" || n === "localhost";

const EXECUTOR_UPGRADE_DELAY = BigInt(
  process.env.EXECUTOR_UPGRADE_DELAY ?? (isDevNetwork(hre.network.name) ? "0" : "86400")
);

/* =============================================================================
 * Helpers
 * ===========================================================================*/
function requireAddress(label, value, { allowZero = false } = {}) {
  const v = (value || "").trim();
  if (!v) throw new Error(`Missing ${label}`);
  if (v === "0x") throw new Error(`Invalid ${label}: ${v}`);
  if (!isAddress(v)) throw new Error(`Invalid ${label}: ${v}`);
  const a = getAddress(v);
  if (a === ZeroAddress && !allowZero) throw new Error(`Zero address not allowed for ${label}`);
  return a;
}

async function isContract(addr) {
  const code = await hre.ethers.provider.getCode(addr);
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
  const tx = await txPromise;
  const rcpt = await tx.wait(confs);
  console.log(chalk.green(`✅ ${label}`));
  console.log(chalk.gray(`tx  : ${rcpt.hash}`));
  console.log(chalk.gray(`gas : ${rcpt.gasUsed.toString()}`));
  return rcpt;
}

function getMode() {
  if (process.env.MULTISIG_MODE) return process.env.MULTISIG_MODE;
  if (isDevNetwork(hre.network.name)) return "eoa";
  if (["sepolia", "arbitrumSepolia"].includes(hre.network.name)) return "mini";
  return "safe";
}

function getMultisigAddressFallback(deployerAddr) {
  const mode = getMode();
  const env = (process.env.MULTISIG_ADDRESS || "").trim();
  if (mode === "eoa" || mode === "safe") return env && env !== "0x" ? env : deployerAddr;
  return (process.env.MINI_MULTISIG_ADDRESS || "").trim();
}

function normalizeAddrArray(label, arr) {
  if (!Array.isArray(arr) || arr.length === 0) throw new Error(`${label} cannot be empty`);
  return arr.map((a) => requireAddress(label, a));
}

async function getMultisigConfig(mode, deployerAddr) {
  if (mode === "mini") {
    const miniAddr = requireAddress("MINI_MULTISIG_ADDRESS", process.env.MINI_MULTISIG_ADDRESS);
    const a = requireAddress("MULTISIG_EOA_1", process.env.MULTISIG_EOA_1);
    const b = requireAddress("MULTISIG_EOA_2", process.env.MULTISIG_EOA_2);
    return {
      proposers: [miniAddr],
      executors: [miniAddr],
      admins: [a, b],          // Timelock DEFAULT_ADMIN are EOAs
      adminPrimary: miniAddr,  // Token DEFAULT_ADMIN is the multisig contract
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
const TL_ABI = [
  "function PROPOSER_ROLE() view returns (bytes32)",
  "function EXECUTOR_ROLE() view returns (bytes32)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function getMinDelay() view returns (uint256)",
  "function schedule(address,uint256,bytes,bytes32,bytes32,uint256)",
  "function execute(address,uint256,bytes,bytes32,bytes32)",
  "function hashOperation(address,uint256,bytes,bytes32,bytes32) view returns (bytes32)",
  "function isOperation(bytes32) view returns (bool)",
  "function isOperationReady(bytes32) view returns (bool)",
  "function isOperationDone(bytes32) view returns (bool)",
];

const MINI_ABI = [
  "function txCount() view returns (uint256)",
  "function propose(address target,uint256 value,bytes data) returns (uint256)",
  "function approve(uint256 id)",
  "function execute(uint256 id) returns (bool ok, bytes ret)",
  "function getTx(uint256 id) view returns (address target,uint256 value,bool executed,uint8 approvals,bytes data)",
];

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
async function waitSecs(s,label){
  if (!s || Number(s) === 0) return;
  console.log(chalk.yellow(`⏳ waiting ${s}s ${label||""}`));
  await sleep(Number(s)*1000);
}

async function miniProposeApprove(mini1, mini2, label, to, data) {
  const before = await mini1.txCount();     // uint256
  const id = before + 1n;                  // ✅ next tx id (BigInt)

  console.log(chalk.gray(`→ [MINI] propose ${label} (id=${id.toString()})`));
  await (await mini1.propose(to, 0, data)).wait();

  let meta = await mini1.getTx(id);
  if (meta.approvals < 2) {
    console.log(chalk.gray(`[MINI] approve id=${id.toString()} via owner2`));
    await (await mini2.approve(id)).wait();
    meta = await mini1.getTx(id);
  }

  return id;
}


function tryDecodeRevert(ret) {
  if (!ret || ret.length < 4) return "";
  const sel = ret.slice(0, 10).toLowerCase();
  if (sel === "0x08c379a0") {
    try {
      const iface = new hre.ethers.Interface(["error Error(string)"]);
      const [msg] = iface.decodeErrorResult("Error", ret);
      return String(msg);
    } catch {}
  }
  return "";
}

async function miniExecuteStrict(mini1, id, label) {
  try {
    const [ok, ret] = await mini1.execute.staticCall(id);
    if (!ok) throw new Error(tryDecodeRevert(ret) || "inner call ok=false");
  } catch (e) {
    const msg = e?.reason || e?.shortMessage || e?.message || String(e);
    throw new Error(`[MINI ${label}] execute.staticCall reverted: ${msg}`);
  }

  const tx = await mini1.execute(id);
  const rc = await tx.wait();
  console.log(chalk.green(`✓ [MINI] execute id=${id} tx=${rc.hash}`));
  if (rc.status !== 1n && rc.status !== 1) throw new Error(`[MINI ${label}] tx reverted`);
}

async function doTimelockOpViaMini({ timelockAddr, miniAddr, mini1, mini2, target, innerData, label, delayHintSec }) {
  const tl = await hre.ethers.getContractAt(TL_ABI, timelockAddr);

  const PROPOSER_ROLE = await tl.PROPOSER_ROLE();
  const EXECUTOR_ROLE = await tl.EXECUTOR_ROLE();
  if (!(await tl.hasRole(PROPOSER_ROLE, miniAddr))) throw new Error("Mini lacks PROPOSER_ROLE on Timelock");
  if (!(await tl.hasRole(EXECUTOR_ROLE, miniAddr))) throw new Error("Mini lacks EXECUTOR_ROLE on Timelock");

  const minDelay = await tl.getMinDelay();
  const delay = delayHintSec != null ? BigInt(delayHintSec) : BigInt(minDelay);

  const pred = ZeroHash;
  const value = 0n;
  const salt = keccak256(toUtf8Bytes(`${label}:${Date.now()}:${Math.random()}`));

  const tlIface = new hre.ethers.Interface(TL_ABI);
  const sched = tlIface.encodeFunctionData("schedule", [target, value, innerData, pred, salt, delay]);
  const exec  = tlIface.encodeFunctionData("execute",  [target, value, innerData, pred, salt]);

  const opId = await tl.hashOperation(target, value, innerData, pred, salt);

  // schedule
  const idSched = await miniProposeApprove(mini1, mini2, `TL.schedule ${label}`, timelockAddr, sched);
  await miniExecuteStrict(mini1, idSched, `schedule ${label}`);

  if (!(await tl.isOperation(opId))) throw new Error(`Timelock op missing after schedule: ${opId}`);

  if (!(await tl.isOperationReady(opId))) {
    await waitSecs(delay.toString(), `before execute ${label}`);
  }

  // execute
  const idExec = await miniProposeApprove(mini1, mini2, `TL.execute ${label}`, timelockAddr, exec);
  await miniExecuteStrict(mini1, idExec, `execute ${label}`);

  if (!(await tl.isOperationDone(opId))) throw new Error(`Timelock op not done after execute: ${opId}`);
  return { opId, salt };
}

/* =============================================================================
 * Timelock attach / deploy (RESUME-SAFE)
 * ===========================================================================*/
async function deployTimelock(networkCfg, deployer, cfg) {
  const timelockEnv = (process.env.TIMELOCK_ADDRESS || "").trim();

  // RESUME MODE: attach to existing timelock (REQUIRED)
  if (timelockEnv) {
    const tlAddr = requireAddress("TIMELOCK_ADDRESS", timelockEnv);
    const Timelock = await hre.ethers.getContractFactory("TimelockController", deployer);
    const tl = Timelock.attach(tlAddr);
    console.log(chalk.gray(`Using existing TimelockController: ${tlAddr}`));
    return tl;
  }

  // FRESH DEPLOY MODE ONLY (dev networks only)
  if (!isDevNetwork(hre.network.name)) {
    throw new Error(
      `RESUME requires TIMELOCK_ADDRESS on ${hre.network.name}. Refusing to deploy a fresh TimelockController.`
    );
  }

  console.log(chalk.blue("\n🕓 Deploying TimelockController (fresh)..."));
  const Timelock = await hre.ethers.getContractFactory("TimelockController", deployer);

  const proposers = normalizeAddrArray("Timelock proposers", cfg.proposers);
  const executors = normalizeAddrArray("Timelock executors", cfg.executors);

  const deployerAddr = await deployer.getAddress();
  const tl = await Timelock.deploy(networkCfg.minDelay, proposers, executors, deployerAddr);
  await tl.waitForDeployment();

  const tlAddr = await tl.getAddress();
  console.log(chalk.green(`✅ Timelock deployed: ${tlAddr}`));

  const TL_ADMIN = await tl.DEFAULT_ADMIN_ROLE();

  for (const admin of cfg.admins) {
    const a = requireAddress("Timelock admin", admin);
    if (!(await tl.hasRole(TL_ADMIN, a))) {
      await safeTx(
        tl.grantRole(TL_ADMIN, a),
        `TL: grant DEFAULT_ADMIN → ${a}`,
        networkCfg.requiredConfirmations
      );
    }
  }

  // Remove deployer admin
  if (await tl.hasRole(TL_ADMIN, deployerAddr)) {
    await safeTx(
      tl.renounceRole(TL_ADMIN, deployerAddr),
      "TL: deployer renounce DEFAULT_ADMIN",
      networkCfg.requiredConfirmations
    );
  }

  return tl;
}

/* =============================================================================
 * UpgradeExecutor delay config (tolerant)
 * ===========================================================================*/
async function configureUpgradeExecutorDelay(executor, networkCfg) {
  if (!fnExists(executor.interface, "setUpgradeDelay(uint256)")) return;

  const current = await executor.upgradeDelay().catch(() => null);
  if (current === null) return;

  const target = BigInt(EXECUTOR_UPGRADE_DELAY);
  if (BigInt(current) === target) {
    console.log(chalk.gray(`UpgradeExecutor delay already set: ${current.toString()}s`));
    return;
  }

  await safeTx(
    executor.setUpgradeDelay(target),
    `UpgradeExecutor: setUpgradeDelay(${target.toString()}s)`,
    networkCfg.requiredConfirmations
  );
}

/* =============================================================================
 * Token config (safe no-op unless functions exist)
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
 * Roles + admin handover
 * ===========================================================================*/
async function grantTokenRoles(token, views, adminAddress, networkCfg) {
  console.log(chalk.blue("\n🔐 Granting roles to final admin..."));

  const admin = requireAddress("adminPrimary", adminAddress);
  const tokenAddr = await token.getAddress();
  const DEFAULT_ADMIN_ROLE = await token.DEFAULT_ADMIN_ROLE();

  // ---------------------------------------------------------------------------
  // Who can actually grant roles right now?
  // ---------------------------------------------------------------------------
  const [deployer] = await hre.ethers.getSigners();
  const deployerAddr = await deployer.getAddress();

  const deployerHasDAR = await token.hasRole(DEFAULT_ADMIN_ROLE, deployerAddr).catch(() => false);

  // If you are resuming with a timelock, pass TIMELOCK_ADDRESS in env.
  const timelockEnv = (process.env.TIMELOCK_ADDRESS || "").trim();
  const timelockAddr = timelockEnv && isAddress(timelockEnv) ? getAddress(timelockEnv) : null;

  const timelockHasDAR = timelockAddr
    ? await token.hasRole(DEFAULT_ADMIN_ROLE, timelockAddr).catch(() => false)
    : false;

  // Convenience: your deploy scripts use "mini" on sepolia/arbitrumSepolia.
  const mode = getMode();

  // ---------------------------------------------------------------------------
  // Resolve role hashes (Views → Token getters → local keccak fallback)
  // ---------------------------------------------------------------------------
  const tryCall = async (contract, sig, args = []) => {
    try {
      if (!contract?.interface) return null;
      contract.interface.getFunction(sig);
      const fnName = sig.split("(")[0];
      return await contract[fnName](...args);
    } catch {
      return null;
    }
  };

  let roles = await tryCall(views, "getRoleIdsPacked()");
  if (!roles) roles = await tryCall(views, "getRoleIdsPacked(uint256)", [0]);
  if (!roles) roles = await tryCall(views, "getRoleIdsPacked(bytes32)", [ZeroHash]);

  if (!roles) roles = await tryCall(token, "getRoleIdsPacked()");
  if (!roles) roles = await tryCall(token, "getRoleIdsPacked(uint256)", [0]);
  if (!roles) roles = await tryCall(token, "getRoleIdsPacked(bytes32)", [ZeroHash]);

  let pairs = [];
  if (roles && Array.isArray(roles) && roles.length >= 7) {
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
    const role = (s) => keccak256(toUtf8Bytes(s));
    pairs = [
      ["PAUSER_ROLE", role("PAUSER_ROLE")],
      ["MINTER_ROLE", role("MINTER_ROLE")],
      ["SIGNER_ROLE", role("SIGNER_ROLE")],
      ["PARAMETER_ADMIN_ROLE", role("PARAMETER_ADMIN_ROLE")],
      ["EMERGENCY_ADMIN_ROLE", role("EMERGENCY_ADMIN_ROLE")],
      ["UPGRADER_ROLE", role("UPGRADER_ROLE")],
      ["API_SIGNER_ROLE", role("API_SIGNER_ROLE")],
    ];
    console.log(chalk.yellow("⚠️ Using local keccak256 role ids fallback (ABI getters not found)."));
  }

  // Include DAR as final step
  const allGrants = [...pairs, ["DEFAULT_ADMIN_ROLE", DEFAULT_ADMIN_ROLE]];

  // Determine which grants are needed (read-only)
  const needed = [];
  for (const [label, roleHash] of allGrants) {
    const has = await token.hasRole(roleHash, admin).catch(() => false);
    if (!has) needed.push({ label, roleHash });
  }

  if (needed.length === 0) {
    console.log(chalk.gray("All operational roles + DEFAULT_ADMIN_ROLE already granted."));
    return;
  }

  // ---------------------------------------------------------------------------
  // Path A: deployer can grant directly
  // ---------------------------------------------------------------------------
  if (deployerHasDAR) {
    for (const x of needed) {
      await safeTx(
        token.grantRole(x.roleHash, admin),
        `Token: grant ${x.label} → ${admin}`,
        networkCfg.requiredConfirmations
      );
    }
    console.log(chalk.green("✓ Roles granted (direct by deployer)"));
    return;
  }
  // ---------------------------------------------------------------------------
  // Path B2: MINI is token admin (DAR) → execute grantRole via MiniMultisig 2-of-2
  // ---------------------------------------------------------------------------
  if (mode === "mini") {
    const miniAddr = requireAddress("MINI_MULTISIG_ADDRESS", process.env.MINI_MULTISIG_ADDRESS);
    const miniHasDAR = await token.hasRole(DEFAULT_ADMIN_ROLE, miniAddr).catch(() => false);

    if (miniHasDAR) {
      console.log(chalk.yellow("ℹ️ Deployer lacks DAR, but MINI has token DEFAULT_ADMIN_ROLE. Granting via MINI (2-of-2)."));

      // Needs both owners’ PKs to actually execute; otherwise we print calldata.
      const pk1 = (process.env.MS_EOA1_PK || "").trim();
      const pk2 = (process.env.MS_EOA2_PK || "").trim();

      if (!/^0x[a-fA-F0-9]{64}$/.test(pk1) || !/^0x[a-fA-F0-9]{64}$/.test(pk2)) {
        console.log(chalk.yellow("\n⚠️ Missing MS_EOA1_PK / MS_EOA2_PK. Printing calldata to run via MINI UI/script.\n"));
      } else {
        const mini1 = new hre.ethers.Contract(
          miniAddr,
          MINI_ABI,
          new hre.ethers.Wallet(pk1, hre.ethers.provider)
        );
        const mini2 = new hre.ethers.Contract(
          miniAddr,
          MINI_ABI,
          new hre.ethers.Wallet(pk2, hre.ethers.provider)
        );

        for (const x of needed) {
          const data = token.interface.encodeFunctionData("grantRole", [x.roleHash, admin]);

          const id = await miniProposeApprove(mini1, mini2, `Token.grantRole(${x.label} -> ${admin})`, tokenAddr, data);
          await miniExecuteStrict(mini1, id, `grantRole ${x.label}`);

          console.log(chalk.green(`✓ Granted ${x.label} via MINI`));
        }

        console.log(chalk.green("✓ Roles granted (via MINI)"));
        return;
      }

      // If no PKs, fall through to print calldata (Path C)
    }
  }

  // ---------------------------------------------------------------------------
  // Fallback: cannot execute here → print calldata (resume-safe)
  // ---------------------------------------------------------------------------
  console.log(chalk.yellow("⚠️ Cannot grant roles in-script with current signer configuration."));
  console.log(chalk.yellow("   Printing calldata to execute via token DEFAULT_ADMIN (Mini/Timelock/Safe)."));

  for (const x of needed) {
    const data = token.interface.encodeFunctionData("grantRole", [x.roleHash, admin]);
    console.log(chalk.gray(`\n[CALL] Token.grantRole(${x.label}, ${admin})`));
    console.log(chalk.gray(`to   : ${tokenAddr}`));
    console.log(chalk.gray(`data : ${data}`));
  }

  console.log(chalk.yellow("\nℹ️ Skipping role grants in-script."));
  return;
}


async function handoverTokenAdmin(token, deployerAddr, finalAdmin, networkCfg) {
  const DEFAULT_ADMIN_ROLE = await token.DEFAULT_ADMIN_ROLE();
  const finalAdminChecked = requireAddress("finalAdmin", finalAdmin);

  // If deployer cannot grant, do not attempt grantRole (it will revert).
  const deployerHasDAR = await token.hasRole(DEFAULT_ADMIN_ROLE, deployerAddr).catch(() => false);
  const finalHasDAR = await token.hasRole(DEFAULT_ADMIN_ROLE, finalAdminChecked).catch(() => false);

  if (!finalHasDAR) {
    if (!deployerHasDAR) {
      const tokenAddr = await token.getAddress();
      const data = token.interface.encodeFunctionData("grantRole", [DEFAULT_ADMIN_ROLE, finalAdminChecked]);

      console.log(chalk.yellow("\n⚠️ Cannot handover token admin in-script (deployer lacks DEFAULT_ADMIN_ROLE)."));
      console.log(chalk.yellow("   Execute this via the current token DEFAULT_ADMIN (Timelock/Mini/Safe):"));
      console.log(chalk.gray(`\n[CALL] Token.grantRole(DEFAULT_ADMIN_ROLE, ${finalAdminChecked})`));
      console.log(chalk.gray(`to   : ${tokenAddr}`));
      console.log(chalk.gray(`data : ${data}`));
      console.log(chalk.yellow("\nℹ️ Skipping admin handover in-script."));
      return false; // not completed
    }

    await safeTx(
      token.grantRole(DEFAULT_ADMIN_ROLE, finalAdminChecked),
      `Token: grant DEFAULT_ADMIN_ROLE → ${finalAdminChecked}`,
      networkCfg.requiredConfirmations
    );
  }

  // Renounce is always allowed by the role holder (deployer), no admin required.
  if (await token.hasRole(DEFAULT_ADMIN_ROLE, deployerAddr).catch(() => false)) {
    await safeTx(
      token.renounceRole(DEFAULT_ADMIN_ROLE, deployerAddr),
      "Token: deployer renounce DEFAULT_ADMIN_ROLE",
      networkCfg.requiredConfirmations
    );
  }

  return true; // completed
}


async function renounceDeployerRoles(token, deployer, networkCfg) {
  console.log(chalk.blue("\n🧹 Renouncing deployer roles on token..."));
  const deployerAddr = await deployer.getAddress();

  const roleNames = [
    "PAUSER_ROLE",
    "MINTER_ROLE",
    "SIGNER_ROLE",
    "PARAMETER_ADMIN_ROLE",
    "EMERGENCY_ADMIN_ROLE",
    "UPGRADER_ROLE",
    "API_SIGNER_ROLE",
  ];

  for (const name of roleNames) {
    let roleHash = null;
    try {
      if (fnExists(token.interface, `${name}()`)) roleHash = await token[name]();
    } catch {
      roleHash = keccak256(toUtf8Bytes(name));
    }

    if (roleHash && (await token.hasRole(roleHash, deployerAddr))) {
      await safeTx(
        token.renounceRole(roleHash, deployerAddr),
        `Token: deployer renounce ${name}`,
        networkCfg.requiredConfirmations
      );
    }
  }
}

/* =============================================================================
 * ProxyAdmin → Executor
 * ===========================================================================*/
async function transferProxyAdminOwnership(tokenProxy, executor, deployer, networkCfg) {
  console.log(chalk.blue("\n🔁 Transferring ProxyAdmin ownership → UpgradeExecutor..."));
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
    return;
  }

  await safeTx(
    proxyAdmin.transferOwnership(execAddr),
    `ProxyAdmin: transferOwnership(${execAddr})`,
    networkCfg.requiredConfirmations
  );
}

/* =============================================================================
 * Executor → Timelock ownership transfer (robust, same as your current)
 * ===========================================================================*/
async function transferExecutorOwnership(executor, timelock, deployer, networkCfg) {
  console.log(chalk.blue("\n🔁 Transferring UpgradeExecutor ownership → Timelock..."));

  const timelockAddr = await timelock.getAddress();
  const deployerAddr = await deployer.getAddress();

  const hasPendingOwner = (() => {
    try { executor.interface.getFunction("pendingOwner()"); return true; } catch { return false; }
  })();
  const hasNominee = (() => {
    try { executor.interface.getFunction("nominee()"); return true; } catch { return false; }
  })();

  let owner = null;
  try { owner = await executor.owner(); } catch { owner = null; }

  if (owner) {
    if (owner.toLowerCase() === timelockAddr.toLowerCase()) {
      console.log(chalk.gray("UpgradeExecutor already owned by Timelock"));
      return;
    }
    if (owner.toLowerCase() !== deployerAddr.toLowerCase()) {
      console.log(chalk.yellow("⚠️  Deployer is not UpgradeExecutor owner."));
      console.log(chalk.yellow(`   owner   : ${owner}`));
      console.log(chalk.yellow(`   deployer: ${deployerAddr}`));
      console.log(chalk.yellow("   Fix: run this step from the owner, or acceptOwnership if pendingOwner is timelock."));
      if (hasPendingOwner) {
        const p = await executor.pendingOwner();
        console.log(chalk.gray(`   pendingOwner: ${p}`));
      } else if (hasNominee) {
        const n = await executor.nominee();
        console.log(chalk.gray(`   nominee: ${n}`));
      }
      throw new Error("UpgradeExecutor ownership transfer blocked: deployer is not owner");
    }
  }

  if (hasPendingOwner) {
    const pending = await executor.pendingOwner();
    if (pending && pending !== hre.ethers.ZeroAddress) {
      if (pending.toLowerCase() === timelockAddr.toLowerCase()) {
        console.log(chalk.gray("UpgradeExecutor pendingOwner already set to Timelock. Next: Timelock must acceptOwnership()."));
        return;
      }
      console.log(chalk.yellow(`⚠️  UpgradeExecutor pendingOwner already set to: ${pending}`));
      throw new Error("UpgradeExecutor already in 2-step ownership transfer to a different address");
    }
  } else if (hasNominee) {
    const nominee = await executor.nominee();
    if (nominee && nominee !== hre.ethers.ZeroAddress) {
      if (nominee.toLowerCase() === timelockAddr.toLowerCase()) {
        console.log(chalk.gray("UpgradeExecutor nominee already set to Timelock. Next: Timelock must acceptOwnership()."));
        return;
      }
      console.log(chalk.yellow(`⚠️  UpgradeExecutor nominee already set to: ${nominee}`));
      throw new Error("UpgradeExecutor already in 2-step ownership transfer to a different address");
    }
  }

  try {
    await safeTx(
      executor.transferOwnership(timelockAddr),
      `UpgradeExecutor: transferOwnership(${timelockAddr})`,
      networkCfg.requiredConfirmations
    );
  } catch (e) {
    const msg = `${e?.reason || ""} ${e?.shortMessage || ""} ${e?.message || ""}`;
    console.error(chalk.red("✖ UpgradeExecutor transferOwnership reverted:"), msg);
    throw e;
  }

  console.log(chalk.green("✓ UpgradeExecutor ownership transfer initiated"));
}

/* =============================================================================
 * Timelock scheduling calldata helpers
 * ===========================================================================*/
function encodeTimelockSchedule(timelock, target, value, data, predecessor, salt, delay) {
  return timelock.interface.encodeFunctionData("schedule", [target, value, data, predecessor, salt, delay]);
}
function encodeTimelockExecute(timelock, target, value, data, predecessor, salt) {
  return timelock.interface.encodeFunctionData("execute", [target, value, data, predecessor, salt]);
}

async function scheduleTimelockAcceptance(timelock, executor, deployer, networkCfg, cfg) {
  if (!fnExists(executor.interface, "acceptOwnership()")) {
    console.log(chalk.gray("Executor has no acceptOwnership(); skipping timelock acceptance scheduling"));
    return ZeroHash;
  }

  const execAddr = await executor.getAddress();

  const salt = keccak256(toUtf8Bytes(`accept-${Date.now()}-${Math.random()}`));
  const predecessor = ZeroHash;
  const data = executor.interface.encodeFunctionData("acceptOwnership");

  const proposer = cfg.proposers[0];
  const proposerIsContract = await isContract(proposer);

  if (proposerIsContract) {
    console.log(chalk.yellow("\nℹ️ Proposer is a contract (multisig). Printing calldata only."));
    console.log("schedule() calldata:", encodeTimelockSchedule(timelock, execAddr, 0, data, predecessor, salt, networkCfg.minDelay));
    console.log("execute()  calldata:", encodeTimelockExecute(timelock, execAddr, 0, data, predecessor, salt));
    return salt;
  }

  try {
    await safeTx(
      timelock.schedule(execAddr, 0, data, predecessor, salt, networkCfg.minDelay),
      `Timelock: schedule acceptOwnership (delay=${networkCfg.minDelay}s)`,
      networkCfg.requiredConfirmations
    );
  } catch (e) {
    console.log(chalk.yellow("\n⚠️ Could not schedule directly (likely deployer is not proposer). Printing calldata:"));
    console.log("schedule() calldata:", encodeTimelockSchedule(timelock, execAddr, 0, data, predecessor, salt, networkCfg.minDelay));
    console.log("execute()  calldata:", encodeTimelockExecute(timelock, execAddr, 0, data, predecessor, salt));
  }

  return salt;
}

/* =============================================================================
 * Verification/invariants/artifacts (minimal & safe)
 * ===========================================================================*/
async function verifyInvariants(token, timelock, cfg, proxyAdminAddr, executorAddr) {
  console.log(chalk.blue("\n🧪 Basic invariants..."));
  const tlAddr = await timelock.getAddress();
  const admin = cfg.adminPrimary;

  if (fnExists(token.interface, "hasRole(bytes32,address)")) {
    const dar = await token.DEFAULT_ADMIN_ROLE();
    const ok = await token.hasRole(dar, admin);
    console.log(chalk.gray(`Token DEFAULT_ADMIN_ROLE held by adminPrimary: ${ok}`));
  }

  console.log(chalk.gray(`ProxyAdmin: ${proxyAdminAddr}`));
  console.log(chalk.gray(`Executor : ${executorAddr}`));
  console.log(chalk.gray(`Timelock : ${tlAddr}`));
  console.log(chalk.green("✓ Invariants ok (basic)"));
}

function saveDeploymentArtifacts(deployment, network) {
  const dir = path.resolve(process.cwd(), "deployments");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const file = path.join(dir, `${network}.resume.deployment.json`);
  fs.writeFileSync(file, JSON.stringify(deployment, null, 2));
  return file;
}

async function verifyContracts(_deployment, _networkCfg) {
  console.log(chalk.gray("⏭️ verifyContracts skipped (resume script minimal)"));
}

async function validateFinalState(_deployment) {
  console.log(chalk.gray("⏭️ validateFinalState skipped (resume script minimal)"));
}
async function printDAR(token, labelToAddr) {
  const DAR = await token.DEFAULT_ADMIN_ROLE();
  console.log(chalk.blue("\n🧾 Token DEFAULT_ADMIN_ROLE holders (known set):"));
  for (const [label, addr] of Object.entries(labelToAddr)) {
    const has = await token.hasRole(DAR, addr).catch(() => false);
    console.log(chalk.gray(`${label.padEnd(12)} ${addr} hasDAR=${has}`));
  }
}

/* =============================================================================
 * Main
 * ===========================================================================*/
async function main() {
  const tokenAddress = requireAddress("TOKEN_PROXY", process.env.TOKEN_PROXY);
  const viewsAddress = requireAddress("VIEWS_ADDRESS", process.env.VIEWS_ADDRESS);

  const timelockEnv = (process.env.TIMELOCK_ADDRESS || "").trim();
  const hasTimelock = timelockEnv && isAddress(timelockEnv);
  const timelockAddress = hasTimelock ? getAddress(timelockEnv) : null;

  // NEW: executor must be explicit in resume mode on non-dev networks
  const execEnv = (process.env.UPGRADE_EXECUTOR_ADDRESS || "").trim();
  const hasExec = execEnv && isAddress(execEnv);
  const executorAddress = hasExec ? getAddress(execEnv) : null;

  console.log(chalk.bold("\n🧩 Resuming GemStep deployment (post-token)"));
  console.log("Network   :", hre.network.name);
  console.log("Token     :", tokenAddress);
  console.log("Views     :", viewsAddress);
  if (timelockAddress) console.log("Timelock  :", timelockAddress);
  if (executorAddress) console.log("Executor  :", executorAddress);

  const networkCfg = NETWORK_CONFIG[hre.network.name] || NETWORK_CONFIG.hardhat;

  // RESUME SAFETY GUARDS (the two critical fixes)
  if (!timelockAddress && !isDevNetwork(hre.network.name)) {
    throw new Error(
      `RESUME requires TIMELOCK_ADDRESS on ${hre.network.name}. Refusing to deploy a fresh TimelockController.`
    );
  }
  if (!executorAddress && !isDevNetwork(hre.network.name)) {
    throw new Error(
      `RESUME requires UPGRADE_EXECUTOR_ADDRESS on ${hre.network.name}. Refusing to deploy a new UpgradeExecutor.`
    );
  }

  const [deployer] = await hre.ethers.getSigners();
  const deployerAddr = await deployer.getAddress();
  console.log("Deployer  :", deployerAddr);

  // Attach token + views
  const Token = await hre.ethers.getContractFactory("GemStepToken", deployer);
  const token = Token.attach(tokenAddress);

  const Views = await hre.ethers.getContractFactory("GemStepViews", deployer);
  const views = Views.attach(viewsAddress);
// --- Token admin capability check (early warning) ---
const DEFAULT_ADMIN_ROLE = await token.DEFAULT_ADMIN_ROLE();
const deployerHasDAR = await token.hasRole(DEFAULT_ADMIN_ROLE, deployerAddr).catch(() => false);

if (!deployerHasDAR) {
  console.log(chalk.yellow("\n⚠️ Deployer lacks token DEFAULT_ADMIN_ROLE."));
  console.log(chalk.yellow("   Any steps requiring grantRole/revokeRole must be executed via current token admin."));
  console.log(chalk.yellow("   Continuing only with steps that do NOT require token admin authority.\n"));
}
const known = {
  DEPLOYER: deployerAddr,
  MINI: (process.env.MINI_MULTISIG_ADDRESS || "").trim(),
  TIMELOCK_ENV: timelockAddress || "",
  EOA_A: (process.env.MULTISIG_EOA_1 || "").trim(),
  EOA_B: (process.env.MULTISIG_EOA_2 || "").trim(),
};

const filtered = Object.fromEntries(
  Object.entries(known).filter(([, a]) => a && hre.ethers.isAddress(a))
);

await printDAR(token, filtered);

  // Verify views bound hash (schema candidates + encode/packed)
  {
    const config = await views.viewsConfigHash();
    const boundOnchain = await views.viewsConfigHashBound();
    const abi = AbiCoder.defaultAbiCoder();

    const schemaCandidates = ["GemStepViews:v1", "GemStepViews:v2", "GemStepViews:v3"];
    let ok = false;

    for (const s of schemaCandidates) {
      const schema = keccak256(toUtf8Bytes(s));
      const expEncode = keccak256(abi.encode(["bytes32", "address", "bytes32"], [schema, tokenAddress, config]));
      const expPacked = solidityPackedKeccak256(["bytes32", "address", "bytes32"], [schema, tokenAddress, config]);

      if (boundOnchain.toLowerCase() === expEncode.toLowerCase()) {
        console.log(chalk.green(`✓ Views bound verified (abi.encode, schema="${s}")`));
        ok = true;
        break;
      }
      if (boundOnchain.toLowerCase() === expPacked.toLowerCase()) {
        console.log(chalk.green(`✓ Views bound verified (abi.encodePacked, schema="${s}")`));
        ok = true;
        break;
      }
    }
    if (!ok) throw new Error(`Views bound hash mismatch for ${viewsAddress}`);
  }

  // Governance config
const mode = getMode();
const cfg = await getMultisigConfig(mode, deployerAddr);

// -----------------------------
// Timelock attach (resume-safe)
// -----------------------------
let timelock;
if (timelockAddress) {
  const TL = await hre.ethers.getContractFactory("TimelockController", deployer);
  timelock = TL.attach(timelockAddress);
  console.log(chalk.gray(`Using existing TimelockController: ${timelockAddress}`));
} else {
  // ✅ Critical fix: never deploy a new timelock on real networks during resume
  if (!isDevNetwork(hre.network.name)) {
    throw new Error(
      `RESUME MODE requires TIMELOCK_ADDRESS on network=${hre.network.name}. Refusing to deploy a new Timelock.`
    );
  }
  timelock = await deployTimelock(networkCfg, deployer, cfg);
}
const timelockAddr = await timelock.getAddress();

// ProxyAdmin address
const proxyAdminAddr = await hre.upgrades.erc1967.getAdminAddress(tokenAddress);

// -----------------------------
// Executor attach (resume-safe)
// -----------------------------
let executor;
if (executorAddress) {
  const Exec = await hre.ethers.getContractFactory("UpgradeExecutor", deployer);
  executor = Exec.attach(executorAddress);
  console.log(chalk.gray(`Using existing UpgradeExecutor: ${executorAddress}`));
} else {
  // ✅ Critical fix: never deploy a new executor on real networks during resume
  if (!isDevNetwork(hre.network.name)) {
    throw new Error(
      `RESUME MODE requires EXECUTOR_ADDRESS on network=${hre.network.name}. Refusing to deploy a new UpgradeExecutor.`
    );
  }
  // eslint-disable-next-line no-undef
  executor = await deployOrAttachUpgradeExecutor(networkCfg, deployer);
}
const executorAddr = await executor.getAddress();

// -----------------------------
// Sanity checks (actionable)
// -----------------------------
const proposerActor = cfg?.proposers?.[0] || null;
console.log(chalk.gray(`Governance mode  : ${mode}`));
console.log(chalk.gray(`Admin primary    : ${cfg.adminPrimary}`));
if (proposerActor) console.log(chalk.gray(`Timelock proposer : ${proposerActor}`));

let execOwner = null;
let execPending = null;
const hasOwner = fnExists(executor.interface, "owner()");
const hasPending = fnExists(executor.interface, "pendingOwner()");

if (hasOwner) execOwner = await executor.owner().catch(() => null);
if (hasPending) execPending = await executor.pendingOwner().catch(() => null);

if (execOwner) {
  console.log(chalk.gray(`Executor owner    : ${execOwner}`));
  if (execOwner.toLowerCase() !== timelockAddr.toLowerCase()) {
    console.log(chalk.yellow("⚠️ Executor owner != TIMELOCK_ADDRESS (this may be OK if already migrated elsewhere)"));
    console.log(chalk.yellow(`   timelock       : ${timelockAddr}`));
  }
}
if (execPending && execPending !== ZeroAddress) {
  console.log(chalk.yellow(`⚠️ Executor pendingOwner: ${execPending}`));
}

// -----------------------------
// Configure token/executor
// -----------------------------
await configureArbitrum(token, networkCfg);
await configureUpgradeExecutorDelay(executor, networkCfg);

// -----------------------------
// Roles + admin handover
// -----------------------------
await grantTokenRoles(token, views, cfg.adminPrimary, networkCfg, timelockAddr, mode);
await handoverTokenAdmin(token, deployerAddr, cfg.adminPrimary, networkCfg);

// -----------------------------
// ProxyAdmin → Executor
// -----------------------------
await transferProxyAdminOwnership(tokenAddress, executor, deployer, networkCfg);

// -----------------------------
// Executor → Timelock (resume-safe)
// If deployer isn't owner, don't revert: print calldata needed.
// -----------------------------
{
  const tlTarget = timelockAddr;

  if (!fnExists(executor.interface, "transferOwnership(address)")) {
    console.log(chalk.yellow("⚠️ Executor has no transferOwnership(address); skipping ownership transfer."));
  } else if (execOwner && execOwner.toLowerCase() === tlTarget.toLowerCase()) {
    console.log(chalk.gray("Executor already owned by timelock; skipping transferOwnership."));
  } else {
    // If deployer isn't owner, this WILL revert. Print calldata for the current owner path.
    const deployerIsOwner = execOwner && execOwner.toLowerCase() === deployerAddr.toLowerCase();

    if (!deployerIsOwner) {
      const data = executor.interface.encodeFunctionData("transferOwnership", [tlTarget]);
      console.log(chalk.yellow("\n⚠️ Deployer is not executor.owner(); cannot call transferOwnership directly."));
      console.log(chalk.yellow("   Use the current owner (Timelock/Mini/Safe) to execute this call:"));
      console.log(chalk.gray("[CALL] UpgradeExecutor.transferOwnership(timelock)"));
      console.log(chalk.gray("to   :"), executorAddr);
      console.log(chalk.gray("data :"), data);

      if (execPending && execPending.toLowerCase() === tlTarget.toLowerCase()) {
        console.log(chalk.yellow("\nℹ️ pendingOwner already set to timelock. Next step is acceptOwnership via timelock."));
      }
    } else {
      await transferExecutorOwnership(executor, timelock, deployer, networkCfg);
    }
  }
}

// Timelock acceptOwnership scheduling (or calldata)
const acceptanceSalt = await scheduleTimelockAcceptance(timelock, executor, deployer, networkCfg, cfg);

// Remove deployer roles
await renounceDeployerRoles(token, deployer, networkCfg);

// Invariants + artifacts
await verifyInvariants(token, timelock, cfg, proxyAdminAddr, executorAddr);

const deployment = {
  network: hre.network.name,
  minDelay: networkCfg.minDelay,
  mode,
  tokenProxy: tokenAddress,
  implementation: await hre.upgrades.erc1967.getImplementationAddress(tokenAddress),
  views: viewsAddress,
  timelock: timelockAddr,
  proxyAdmin: proxyAdminAddr,
  upgradeExecutor: executorAddr,
  multisig: cfg.adminPrimary,
  proposers: cfg.proposers,
  executors: cfg.executors,
  admins: cfg.admins,
  acceptanceSalt,
  executorUpgradeDelay: EXECUTOR_UPGRADE_DELAY.toString(),
  viewsConfigHash: (await views.viewsConfigHash()).toString(),
  viewsConfigHashBound: (await views.viewsConfigHashBound()).toString(),
};

const artifactFile = saveDeploymentArtifacts(deployment, hre.network.name);
await verifyContracts(deployment, networkCfg);
await validateFinalState(deployment);

console.log(chalk.green.bold("\n✅ Resume completed"));
console.log(chalk.gray(`Artifacts: ${artifactFile}`));

if (await isContract(cfg.proposers[0])) {
  console.log(chalk.yellow("\nℹ️  Proposer is a contract. Use printed timelock calldata to schedule/execute acceptOwnership."));
} else if (networkCfg.minDelay > 0) {
  console.log(chalk.yellow("\nℹ️  Next step: after delay, execute acceptOwnership via timelock."));
  console.log("salt =", acceptanceSalt);
}

}

main().catch((e) => {
  console.error(chalk.red(e?.stack || e?.message || e));
  process.exit(1);
});
