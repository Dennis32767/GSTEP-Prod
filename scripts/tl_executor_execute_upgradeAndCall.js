/* eslint-disable no-console */
require("dotenv").config();
const { ethers } = require("ethers");

const TL_ABI = [
  "function PROPOSER_ROLE() view returns (bytes32)",
  "function EXECUTOR_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function getMinDelay() view returns (uint256)",
  "function hashOperation(address target,uint256 value,bytes data,bytes32 predecessor,bytes32 salt) view returns (bytes32)",
  "function isOperation(bytes32 id) view returns (bool)",
  "function isOperationReady(bytes32 id) view returns (bool)",
  "function isOperationDone(bytes32 id) view returns (bool)",
  "function schedule(address target,uint256 value,bytes data,bytes32 predecessor,bytes32 salt,uint256 delay)",
  "function execute(address target,uint256 value,bytes data,bytes32 predecessor,bytes32 salt)"
];

const MINI_ABI = [
  "function txCount() view returns (uint256)",
  "function propose(address target, uint256 value, bytes data) returns (uint256 id)",
  "function approve(uint256 id)",
  "function execute(uint256 id) returns (bool ok, bytes ret)",
  "function getTx(uint256 id) view returns (address target, uint256 value, bool executed, uint8 approvals, bytes data)"
];

// UpgradeExecutor ABI (AndCall version)
const EXECUTOR_ABI = [
  "function owner() view returns (address)",
  "function upgradeDelay() view returns (uint256)",
  "function executeUpgradeAndCall(address proxyAdmin,address proxy,address implementation,bytes data)",
  "function isUpgradeReady(address proxyAdmin,address proxy,address implementation) view returns (bool)"
];

const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const isAddr = (a)=>/^0x[a-fA-F0-9]{40}$/.test((a||"").trim());

async function ethCallFrom(provider, from, to, data) {
  try {
    const res = await provider.call({ from, to, data });
    return { ok: true, returndata: res };
  } catch (e) {
    const msg = e?.shortMessage || e?.reason || e?.message || "call reverted";
    return { ok: false, error: msg, raw: e };
  }
}

async function main() {
  const L2_RPC = (process.env.ARBITRUM_SEPOLIA_RPC_URL || "").trim();
  const TL     = (process.env.ARB_SEPOLIA_TIMELOCK || "").trim();
  const MINI   = (process.env.MINI_MULTISIG || "").trim();
  const EX     = (process.env.EXECUTOR_ADDRESS || "").trim();
  const PA     = (process.env.PROXY_ADMIN_ADDRESS || "").trim();
  const PX     = (process.env.PROXY_ADDRESS || "").trim();
  const IM     = (process.env.NEW_IMPL || process.env.NEW_IMPL_ADDRESS || "").trim();
  const PK1    = (process.env.MS_EOA1_PK || "").trim();
  const PK2    = (process.env.MS_EOA2_PK || "").trim();

  // must match what you scheduled earlier (your log shows bytes arg empty)
  const INIT_DATA = (process.env.INIT_DATA || "0x").trim();

  if (!/^https?:\/\//.test(L2_RPC)) throw new Error("ARBITRUM_SEPOLIA_RPC_URL missing");
  if (![TL,MINI,EX,PA,PX,IM].every(isAddr)) throw new Error("One of TL/MINI/EXECUTOR/PROXY_ADMIN/PROXY/NEW_IMPL invalid");
  if (!/^0x[0-9a-fA-F]{64}$/.test(PK1) || !/^0x[0-9a-fA-F]{64}$/.test(PK2)) throw new Error("MS_EOA1_PK / MS_EOA2_PK missing");
  if (!/^0x([0-9a-fA-F]{2})*$/.test(INIT_DATA)) throw new Error("INIT_DATA must be hex bytes (0x...)");

  const l2 = new ethers.JsonRpcProvider(L2_RPC);
  const w1 = new ethers.Wallet(PK1, l2);
  const w2 = new ethers.Wallet(PK2, l2);

  const tl   = new ethers.Contract(TL, TL_ABI, w1);
  const mini = new ethers.Contract(MINI, MINI_ABI, w1);
  const exec = new ethers.Contract(EX, EXECUTOR_ABI, w1);

  console.log("=== TIMELOCK → EXECUTOR.executeUpgradeAndCall(...) via MINI (SCHEDULE+EXECUTE) ===");
  console.log("Timelock :", TL);
  console.log("Mini     :", MINI);
  console.log("Executor :", EX);
  console.log("ProxyAdm :", PA);
  console.log("Proxy    :", PX);
  console.log("New Impl :", IM);
  console.log("INIT_DATA:", INIT_DATA === "0x" ? "(empty)" : INIT_DATA);
  console.log("EOA1     :", await w1.getAddress());

  // Timelock role checks
  const PROPOSER_ROLE  = await tl.PROPOSER_ROLE();
  const EXECUTOR_ROLE  = await tl.EXECUTOR_ROLE();
  const proposerIsMini = await tl.hasRole(PROPOSER_ROLE, MINI);
  const executorIsMini = await tl.hasRole(EXECUTOR_ROLE, MINI);
  const executorOpen   = await tl.hasRole(EXECUTOR_ROLE, ethers.ZeroAddress);
  const minDelay       = await tl.getMinDelay();

  console.log("\n[Timelock roles]");
  console.log("proposer(mini):", proposerIsMini);
  console.log("executor(mini):", executorIsMini);
  console.log("executor(open):", executorOpen);
  console.log("minDelay      :", minDelay.toString());

  if (!proposerIsMini) throw new Error("MiniMultisig is NOT a PROPOSER on Timelock.");
  if (!(executorOpen || executorIsMini)) throw new Error("Timelock EXECUTOR_ROLE is neither OPEN nor granted to Mini.");

  // Executor readiness (best-effort gate)
  const ready = await exec.isUpgradeReady(PA, PX, IM).catch(()=>null);
  console.log("\nExecutor says upgrade ready?:", ready);
  if (ready === false) {
    throw new Error("Executor reports NOT ready. Wait until upgradeDelay has passed (or check schedule inputs).");
  }

  // Build inner calldata for executor.executeUpgradeAndCall
  const exIface = new ethers.Interface(EXECUTOR_ABI);
  const inner   = exIface.encodeFunctionData("executeUpgradeAndCall", [PA, PX, IM, INIT_DATA]);

  const predecessor = ethers.ZeroHash;
  const value = 0n;

  // IMPORTANT: this is a NEW timelock op for EXECUTE phase
  // Keep it deterministic (no INIT_DATA in label unless you always want it included)
  const salt = ethers.keccak256(
    ethers.toUtf8Bytes(`EXEC_UAC:${EX.toLowerCase()}:${PX.toLowerCase()}:${IM.toLowerCase()}`)
  );

  const opId = await tl.hashOperation(EX, value, inner, predecessor, salt);
  console.log("\noperationId:", opId);

// 1) dryrun the *actual* ProxyAdmin call the executor will make: upgradeAndCall(proxy, impl, data)
console.log("\n[Dryrun A] eth_call from EXECUTOR → ProxyAdmin.upgradeAndCall(PROXY, NEW_IMPL, INIT_DATA) …");

const paIface = new ethers.Interface([
  "function upgradeAndCall(address proxy, address implementation, bytes data) external payable"
]);

const uacCalldata = paIface.encodeFunctionData("upgradeAndCall", [PX, IM, INIT_DATA]);

const dryA = await ethCallFrom(l2, EX, PA, uacCalldata);
if (!dryA.ok) {
  console.error("Dryrun A REVERTED:", dryA.error);
  throw new Error("ProxyAdmin.upgradeAndCall is reverting. Fix this before Timelock execution.");
}
console.log("Dryrun A OK.");

  // --- schedule this EXEC op on the timelock (via Mini) ---
  if (!(await tl.isOperation(opId))) {
    console.log("\nScheduling EXEC_UAC operation via Mini…");
    const schedCalldata = tl.interface.encodeFunctionData("schedule", [
      EX, value, inner, predecessor, salt, minDelay
    ]);

    await (await mini.propose(TL, 0, schedCalldata)).wait();
    const id = await mini.txCount();
    await (mini.connect(w2)).approve(id);
    await sleep(500);

    const t = await mini.getTx(id);
    console.log("mini.schedule tx => target:", t.target, "approvals:", t.approvals, "executed:", t.executed);

    await (await (mini.connect(w1)).execute(id)).wait();
    console.log("✓ Timelock.schedule() done via Mini");
  } else {
    console.log("\nℹ️ EXEC_UAC op already scheduled; skipping schedule.");
  }

  // wait ready (minDelay)
  process.stdout.write("Waiting for Timelock op to be ready");
  while (!(await tl.isOperationReady(opId))) {
    process.stdout.write(".");
    await sleep(2000);
  }
  console.log("\nReady.");

  if (await tl.isOperationDone(opId)) {
    console.log("ℹ️ Already executed; exiting.");
    return;
  }

  // execute (via Mini)
  const execCalldata = tl.interface.encodeFunctionData("execute", [
    EX, value, inner, predecessor, salt
  ]);

  if (executorOpen) {
    console.log("\nExecuting directly (Timelock EXECUTOR_ROLE open) …");
    await (await tl.connect(w1).execute(EX, value, inner, predecessor, salt)).wait();
    console.log("✓ Timelock.execute() done (direct)");
  } else {
    console.log("\nExecuting via Mini…");
    const pre = await ethCallFrom(l2, MINI, TL, execCalldata);
    if (!pre.ok) throw new Error(`Precheck failed (TL.execute from MINI would revert): ${pre.error}`);

    await (await mini.propose(TL, 0, execCalldata)).wait();
    const id2 = await mini.txCount();
    await (mini.connect(w2)).approve(id2);
    await sleep(500);

    const t2 = await mini.getTx(id2);
    console.log("mini.execute tx => target:", t2.target, "approvals:", t2.approvals, "executed:", t2.executed);

    await (await (mini.connect(w1)).execute(id2)).wait();
    console.log("✓ Timelock.execute() done via Mini");
  }

  console.log("\n✅ executeUpgradeAndCall executed via Timelock.");
  console.log("Now run: node scripts/check_proxy_slots.js (impl should change).");
}

main().catch(e => {
  console.error("❌ tl_executor_schedule_execute_upgradeAndCall failed:", e?.reason || e?.shortMessage || e?.message || e);
  process.exit(1);
});
