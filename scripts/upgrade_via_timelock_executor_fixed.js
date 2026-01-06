// scripts/upgrade_via_timelock_executor_fixed.js
/* eslint-disable no-console */
require("dotenv").config();
const hre = require("hardhat");
const chalk = require("chalk");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitSecsOnLive(secs, label) {
  if (!secs || secs <= 0n) return;
  console.log(`⏳ waiting ${secs}s ${label || ""}`);
  await sleep(Number(secs) * 1000);
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
  "function propose(address target, uint256 value, bytes data) returns (uint256 id)",
  "function approve(uint256 id)",
  "function execute(uint256 id) returns (bool ok, bytes ret)",
  "function getTx(uint256 id) view returns (address target, uint256 value, bool executed, uint8 approvals, bytes data)",
];

async function main() {
  const {
    PROXY_ADDRESS,
    PROXY_ADMIN_ADDRESS,
    EXECUTOR_ADDRESS,
    TIMELOCK_ADDRESS,
    MINI_MULTISIG,
    MS_EOA1_PK,
    MS_EOA2_PK,

    // Implementation selection
    IMPL_FACTORY_NAME,  // e.g. "GemStepTokenV2" (default) or "GemStepToken"
    NEW_IMPL_ADDRESS,   // optional: pre-deployed impl addr

    // Optional initializer (choose ONE of these approaches)
    INIT_DATA,          // raw 0x bytes (preferred if you have it already)
    INIT_SIG,           // e.g. "initializeV2()" or "initialize(address,uint256)"
    INIT_ARGS_JSON,     // e.g. '["0xAdmin","12345"]'
  } = process.env;

  const bad = [];
  const isAddr = (a) => { try { return !!hre.ethers.getAddress(a); } catch { return false; } };
  if (!isAddr(PROXY_ADDRESS))       bad.push("PROXY_ADDRESS");
  if (!isAddr(PROXY_ADMIN_ADDRESS)) bad.push("PROXY_ADMIN_ADDRESS");
  if (!isAddr(EXECUTOR_ADDRESS))    bad.push("EXECUTOR_ADDRESS");
  if (!isAddr(TIMELOCK_ADDRESS))    bad.push("TIMELOCK_ADDRESS");
  if (!isAddr(MINI_MULTISIG))       bad.push("MINI_MULTISIG");
  if (!/^0x[0-9a-fA-F]{64}$/.test((MS_EOA1_PK || "").trim())) bad.push("MS_EOA1_PK");
  if (!/^0x[0-9a-fA-F]{64}$/.test((MS_EOA2_PK || "").trim())) bad.push("MS_EOA2_PK");
  if (bad.length) throw new Error("Missing/invalid env(s): " + bad.join(", "));

  const net = hre.network.name;
  const [sender] = await hre.ethers.getSigners();
  console.log(chalk.bold(`\n🚀 Upgrade via Timelock → UpgradeExecutor on ${net}`));
  console.log(`sender      : ${sender.address}`);
  console.log(`proxy       : ${PROXY_ADDRESS}`);
  console.log(`proxyAdmin  : ${PROXY_ADMIN_ADDRESS}`);
  console.log(`executor    : ${EXECUTOR_ADDRESS}`);
  console.log(`timelock    : ${TIMELOCK_ADDRESS}`);
  console.log(`mini        : ${MINI_MULTISIG}`);

  // 1) Build/validate impl
  const implFactoryName = (IMPL_FACTORY_NAME || "GemStepTokenV2").trim();
  const ImplFactory = await hre.ethers.getContractFactory(implFactoryName);
  await hre.upgrades.validateUpgrade(PROXY_ADDRESS, ImplFactory, { kind: "transparent" });

  let newImplAddr = (NEW_IMPL_ADDRESS || "").trim();
  if (newImplAddr) {
    if (!isAddr(newImplAddr)) throw new Error("NEW_IMPL_ADDRESS invalid");
    console.log(chalk.green(`Using provided implementation: ${newImplAddr}`));
  } else {
    newImplAddr = await hre.upgrades.prepareUpgrade(PROXY_ADDRESS, ImplFactory, { kind: "transparent" });
    console.log(chalk.green(`New implementation prepared: ${newImplAddr}`));
  }

  // 2) Contracts
  const timelock   = await hre.ethers.getContractAt(TL_ABI, TIMELOCK_ADDRESS, sender);
  const executor   = await hre.ethers.getContractAt("UpgradeExecutor", EXECUTOR_ADDRESS, sender);
  const proxyAdmin = await hre.ethers.getContractAt(
    "contracts/Interfaces/IProxyAdmin.sol:IProxyAdmin",
    PROXY_ADMIN_ADDRESS,
    sender
  );

  // Wiring sanity
  const execOwner = (await executor.owner()).toLowerCase();
  const paOwner   = (await proxyAdmin.owner()).toLowerCase();
  if (execOwner !== TIMELOCK_ADDRESS.toLowerCase()) {
    throw new Error(`Timelock must own UpgradeExecutor. executor.owner()=${execOwner}`);
  }
  if (paOwner !== EXECUTOR_ADDRESS.toLowerCase()) {
    throw new Error(`UpgradeExecutor must own ProxyAdmin. proxyAdmin.owner()=${paOwner}`);
  }

  // 3) Delays & TL roles
  const minDelay = await timelock.getMinDelay();
  const exDelay  = await executor.upgradeDelay();
  console.log(`Timelock delay: ${minDelay}s | Executor delay: ${exDelay}s`);

  const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
  const EXECUTOR_ROLE = await timelock.EXECUTOR_ROLE();
  const hasProposerSender = await timelock.hasRole(PROPOSER_ROLE, sender.address);
  const hasProposerMini   = await timelock.hasRole(PROPOSER_ROLE, MINI_MULTISIG);
  const hasExecMini       = await timelock.hasRole(EXECUTOR_ROLE, MINI_MULTISIG);
  console.log("\n=== Timelock role snapshot ===");
  console.log("sender has PROPOSER_ROLE :", hasProposerSender);
  console.log("mini   has PROPOSER_ROLE :", hasProposerMini);
  console.log("mini   has EXECUTOR_ROLE :", hasExecMini);

  // 4) Build initData (supports raw bytes or signature + args)
  let initData = "0x";
  const raw = (INIT_DATA || "").trim();
  const sig = (INIT_SIG || "").trim();
  const argsJson = (INIT_ARGS_JSON || "").trim();

  if (raw && raw !== "0x") {
    if (!/^0x[0-9a-fA-F]*$/.test(raw)) throw new Error("INIT_DATA must be 0x-hex");
    initData = raw;
  } else if (sig) {
    const fn = sig.slice(0, sig.indexOf("("));
    const iface = new hre.ethers.Interface([`function ${sig}`]);
    const args = argsJson ? JSON.parse(argsJson) : [];
    initData = iface.encodeFunctionData(fn, args);
  }
  const withInit = initData !== "0x";
  console.log(`Initializer: ${withInit ? `present (${(initData.length - 2) / 2} bytes)` : "none"}`);

  // 5) Encode executor calls (choose method based on withInit) + deterministic salts (include init hash)
  const methodSched = withInit ? "scheduleUpgradeAndCall" : "scheduleUpgrade";
  const methodExec  = withInit ? "executeUpgradeAndCall"  : "executeUpgrade";

  const scheduleData = executor.interface.encodeFunctionData(methodSched, [
    PROXY_ADMIN_ADDRESS, PROXY_ADDRESS, newImplAddr, ...(withInit ? [initData] : []),
  ]);
  const executeData  = executor.interface.encodeFunctionData(methodExec, [
    PROXY_ADMIN_ADDRESS, PROXY_ADDRESS, newImplAddr, ...(withInit ? [initData] : []),
  ]);

  const initHash = hre.ethers.keccak256(initData);
  const schedSalt = hre.ethers.keccak256(
    hre.ethers.toUtf8Bytes(`sched:${PROXY_ADDRESS.toLowerCase()}:${newImplAddr.toLowerCase()}:${initHash}`)
  );
  const execSalt  = hre.ethers.keccak256(
    hre.ethers.toUtf8Bytes(`exec:${PROXY_ADDRESS.toLowerCase()}:${newImplAddr.toLowerCase()}:${initHash}`)
  );

  const pred = hre.ethers.ZeroHash;
  const val  = 0n;

  // helper: propose/approve/execute via Mini for a given target+data
  const w1 = new hre.ethers.Wallet(MS_EOA1_PK, sender.provider);
  const w2 = new hre.ethers.Wallet(MS_EOA2_PK, sender.provider);
  const mini = new hre.ethers.Contract(MINI_MULTISIG, MINI_ABI, w1);
  async function viaMini(target, data, label) {
    console.log(`→ Mini.propose ${label}…`);
    const tx1 = await mini.propose(target, 0, data);
    await tx1.wait();
    const id = await mini.txCount();
    await (mini.connect(w2)).approve(id);
    await sleep(400);
    const ex = await (mini.connect(w1)).execute(id);
    await ex.wait();
    console.log(`✓ Mini executed ${label}`);
  }

  // 6) Dry-run the schedule call
  const okSchedule = await sender.provider
    .call({ from: TIMELOCK_ADDRESS, to: EXECUTOR_ADDRESS, data: scheduleData })
    .then(() => true)
    .catch(() => false);
  if (!okSchedule) throw new Error("Dry-run failed: schedule* would revert");

  // === STEP 1: schedule > execute of schedule* ===
  console.log(`\n=== Step 1: schedule > execute of ${methodSched} ===`);
  const schedDataTL = timelock.interface.encodeFunctionData("schedule", [EXECUTOR_ADDRESS, val, scheduleData, pred, schedSalt, minDelay]);
  const execSchedTL = timelock.interface.encodeFunctionData("execute",  [EXECUTOR_ADDRESS, val, scheduleData, pred, schedSalt]);

  if (hasProposerSender) {
    console.log("Sender can propose directly via TL.schedule()");
    try {
      const tx = await timelock.schedule(EXECUTOR_ADDRESS, val, scheduleData, pred, schedSalt, minDelay);
      await tx.wait();
      console.log("🗓️  scheduled (TL)");
    } catch (e) {
      console.log("ℹ️ TL.schedule may already exist with same salt; continuing…");
    }
  } else if (hasProposerMini) {
    console.log("Sender cannot propose; using Mini to schedule on TL");
    await viaMini(TIMELOCK_ADDRESS, schedDataTL, `TL.schedule(${methodSched})`);
  } else {
    throw new Error("Neither sender nor Mini has PROPOSER_ROLE on Timelock");
  }

  // Wait TL delay then execute schedule*
  if (/^(hardhat|localhost)$/.test(net)) {
    await hre.network.provider.send("evm_increaseTime", [Number(minDelay)]);
    await hre.network.provider.send("evm_mine");
  } else {
    await waitSecsOnLive(minDelay, "(TL before schedule*)");
  }

  if (hasExecMini) {
    console.log(`Executing ${methodSched} via Mini → TL.execute()`);
    await viaMini(TIMELOCK_ADDRESS, execSchedTL, `TL.execute(${methodSched})`);
  } else {
    console.log("Executing schedule* directly from sender (TL must be openexec)");
    const ex1 = await timelock.execute(EXECUTOR_ADDRESS, val, scheduleData, pred, schedSalt);
    await ex1.wait();
    console.log("✓ TL.execute(schedule*)");
  }
  console.log(`Executor delay started: ${exDelay}s`);

  // === STEP 2: schedule > execute of execute* ===
  console.log(`\n=== Step 2: schedule > execute of ${methodExec} ===`);
  const schedExecTL = timelock.interface.encodeFunctionData("schedule", [EXECUTOR_ADDRESS, val, executeData, pred, execSalt, minDelay]);
  const execExecTL  = timelock.interface.encodeFunctionData("execute",  [EXECUTOR_ADDRESS, val, executeData, pred, execSalt]);

  if (hasProposerSender) {
    try {
      const tx2 = await timelock.schedule(EXECUTOR_ADDRESS, val, executeData, pred, execSalt, minDelay);
      await tx2.wait();
      console.log("🗓️  scheduled (TL) execute*");
    } catch {
      console.log("ℹ️ TL.schedule(execute*) may already be set; continuing…");
    }
  } else {
    await viaMini(TIMELOCK_ADDRESS, schedExecTL, `TL.schedule(${methodExec})`);
  }

  // Must satisfy BOTH waits (executor delay & TL delay)
  if (/^(hardhat|localhost)$/.test(net)) {
    const waitSec = Number(minDelay > exDelay ? minDelay : exDelay);
    await hre.network.provider.send("evm_increaseTime", [waitSec]);
    await hre.network.provider.send("evm_mine");
  } else {
    await waitSecsOnLive(exDelay, "(executor upgradeDelay)");
    await waitSecsOnLive(minDelay, "(TL before execute*)");
  }

  if (hasExecMini) {
    console.log(`Executing ${methodExec} via Mini → TL.execute()`);
    await viaMini(TIMELOCK_ADDRESS, execExecTL, `TL.execute(${methodExec})`);
  } else {
    const ex2 = await timelock.execute(EXECUTOR_ADDRESS, val, executeData, pred, execSalt);
    await ex2.wait();
    console.log("✓ TL.execute(execute*)");
  }

  // 7) Verify new implementation
  const implAfter = await hre.upgrades.erc1967.getImplementationAddress(PROXY_ADDRESS);
  console.log(`impl after : ${implAfter}`);
  if (implAfter.toLowerCase() !== newImplAddr.toLowerCase()) {
    throw new Error("Upgrade did not take effect");
  }

  console.log(chalk.bold.green("\n🎉 Upgrade complete via Timelock → UpgradeExecutor (Mini path supported)"));
}

main().catch((e) => { console.error(e); process.exit(1); });
