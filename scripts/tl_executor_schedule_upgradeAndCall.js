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
  "function getTx(uint256 id) view returns (address target, uint256 value, bool executed, uint8 approvals, bytes data)",
  "function isApproved(uint256 id, address owner) view returns (bool)"
];

// UpgradeExecutor surface we are calling THROUGH the timelock (AndCall version)
const EXECUTOR_ABI = [
  "function owner() view returns (address)",
  "function upgradeDelay() view returns (uint256)",
  "function scheduleUpgradeAndCall(address proxyAdmin,address proxy,address implementation,bytes data)",
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

  if (!/^https?:\/\//.test(L2_RPC)) throw new Error("ARBITRUM_SEPOLIA_RPC_URL missing");
  if (![TL,MINI,EX,PA,PX,IM].every(isAddr)) throw new Error("One of TL/MINI/EXECUTOR/PROXY_ADMIN/PROXY/NEW_IMPL invalid");
  if (!/^0x[0-9a-fA-F]{64}$/.test(PK1) || !/^0x[0-9a-fA-F]{64}$/.test(PK2)) throw new Error("MS_EOA1_PK / MS_EOA2_PK missing");

  const l2 = new ethers.JsonRpcProvider(L2_RPC);
  const w1 = new ethers.Wallet(PK1, l2);
  const w2 = new ethers.Wallet(PK2, l2);

  const tl   = new ethers.Contract(TL, TL_ABI, w1);
  const mini = new ethers.Contract(MINI, MINI_ABI, w1);
  const exec = new ethers.Contract(EX, EXECUTOR_ABI, w1);

  const CALLDATA = "0x"; // no initializer; still use upgradeAndCall

  console.log("=== TIMELOCK → EXECUTOR.scheduleUpgradeAndCall(..., data=0x) via MINI ===");
  console.log("Timelock :", TL);
  console.log("Mini     :", MINI);
  console.log("Executor :", EX);
  console.log("ProxyAdm :", PA);
  console.log("Proxy    :", PX);
  console.log("New Impl :", IM);
  console.log("Data     :", CALLDATA);
  console.log("EOA1     :", await w1.getAddress());

  // ---- Role checks on Timelock ----
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

  // Optional: show executor owner/delay
  const exOwner = await exec.owner().catch(()=>ethers.ZeroAddress);
  const upDelay = await exec.upgradeDelay().catch(()=>0n);
  console.log("\n[Executor info]");
  console.log("owner       :", exOwner);
  console.log("upgradeDelay:", upDelay.toString(), "(seconds)");

  // ---- Build calldata and opId ----
  const exIface = new ethers.Interface(EXECUTOR_ABI);
  const inner   = exIface.encodeFunctionData("scheduleUpgradeAndCall", [PA, PX, IM, CALLDATA]);

  const predecessor = ethers.ZeroHash;
  const value = 0n;
  const salt = ethers.keccak256(
    ethers.toUtf8Bytes(`SCHED_UAC:${EX.toLowerCase()}:${PX.toLowerCase()}:${IM.toLowerCase()}`)
  );

  const opId = await tl.hashOperation(EX, value, inner, predecessor, salt);
  console.log("\noperationId:", opId);

  // ---- DRY-RUN: simulate calling executor.scheduleUpgradeAndCall AS IF FROM TIMELOCK ----
  console.log("\n[Dryrun] eth_call from TL → executor.scheduleUpgradeAndCall…");
  const dry = await ethCallFrom(l2, TL, EX, inner);
  if (!dry.ok) {
    console.error("Dryrun REVERTED:", dry.error);
    throw new Error("Dry-run failed: executor.scheduleUpgradeAndCall would revert when Timelock executes it.");
  }
  console.log("Dryrun OK.");

  // ---- SCHEDULE via Mini ----
  const isAlready = await tl.isOperation(opId);
  if (!isAlready) {
    console.log("\nScheduling operation via Mini…");
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
    console.log("✓ Timelock.schedule() executed via Mini");
  } else {
    console.log("\nℹ️ Operation already scheduled; skipping schedule.");
  }

  // ---- Wait until ready ----
  process.stdout.write("Waiting for Timelock op to be ready");
  for (;;) {
    if (await tl.isOperationReady(opId)) break;
    process.stdout.write(".");
    await sleep(2000);
  }
  console.log("\nReady.");

  // ---- EXECUTE via Mini (or direct if open) ----
  if (await tl.isOperationDone(opId)) {
    console.log("ℹ️ Already executed; skipping execute.");
    return;
  }

  const execCalldata = tl.interface.encodeFunctionData("execute", [
    EX, value, inner, predecessor, salt
  ]);

  if (executorOpen) {
    console.log("\nTimelock executor is OPEN → executing directly from EOA1…");
    await (await tl.connect(w1).execute(EX, value, inner, predecessor, salt)).wait();
    console.log("✓ Timelock.execute() done (direct)");
  } else {
    console.log("\nTimelock executor is MINI → executing via Mini…");

    // Precheck: simulate TL.execute from MINI (msg.sender = MINI)
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

  console.log("\n✅ Executor.scheduleUpgradeAndCall has been called by Timelock (data=0x).");
  console.log("Next step: wait upgradeDelay then run tl_executor_execute_upgradeAndCall.js");
}

main().catch(e => {
  console.error("❌ tl_executor_schedule_upgradeAndCall failed:", e?.reason || e?.shortMessage || e?.message || e);
  process.exit(1);
});
