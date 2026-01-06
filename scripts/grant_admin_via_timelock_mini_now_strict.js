/* eslint-disable no-console */
require("dotenv").config();
const hre = require("hardhat");
const { ethers } = hre;

function isAddr(x){ return /^0x[a-fA-F0-9]{40}$/.test(x||""); }
function isHex32(x){ return /^0x[a-fA-F0-9]{64}$/.test(x||""); }
const sleep = (ms)=>new Promise(r=>setTimeout(r, ms));
async function waitSecs(s,label){ if(!s) return; console.log(`⏳ waiting ${s}s ${label||""} - grant_admin_via_timelock_mini_now_strict.js:9`); await sleep(Number(s)*1000); }

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
  "function isOperationDone(bytes32) view returns (bool)"
];

const MINI_ABI = [
  "function txCount() view returns (uint256)",
  "function propose(address target,uint256 value,bytes data) returns (uint256)",
  "function approve(uint256 id)",
  "function execute(uint256 id) returns (bool ok, bytes ret)",
  "function getTx(uint256 id) view returns (address target,uint256 value,bool executed,uint8 approvals,bytes data)"
];

const TOKEN_ACL_ABI = [
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function grantRole(bytes32,address)"
];

async function miniProposeApprove(mini1, mini2, label, to, data) {
  const nextId = await mini1.txCount();
  console.log(`→ [MINI] propose ${label} (nextId=${nextId}) - grant_admin_via_timelock_mini_now_strict.js:40`);
  await (await mini1.propose(to, 0, data)).wait();

  let meta = await mini1.getTx(nextId);
  console.log(`[MINI] stored target=${meta.target} approvals=${meta.approvals} executed=${meta.executed} - grant_admin_via_timelock_mini_now_strict.js:44`);
  if (meta.approvals < 2) {
    console.log(`[MINI] approve id=${nextId} via owner2 - grant_admin_via_timelock_mini_now_strict.js:46`);
    await (await mini2.approve(nextId)).wait();
    meta = await mini1.getTx(nextId);
  }
  return nextId;
}

async function miniExecuteStrict(mini1, id, label) {
  // Preflight the *inner* call outcome:
  try {
    const [ok, ret] = await mini1.execute.staticCall(id);
    if (!ok) {
      const reason = tryDecodeRevert(ret) || "inner call returned ok=false";
      throw new Error(`[MINI ${label}] inner call would fail: ${reason}`);
    }
  } catch (e) {
    const msg = e?.reason || e?.shortMessage || e?.message || String(e);
    throw new Error(`[MINI ${label}] execute.staticCall reverted: ${msg}`);
  }

  const tx = await mini1.execute(id);
  const rc = await tx.wait();
  console.log(`✓ [MINI] execute id=${id} tx=${rc.hash} - grant_admin_via_timelock_mini_now_strict.js:68`);
  if (rc.status !== 1n && rc.status !== 1) {
    throw new Error(`[MINI ${label}] tx reverted (status=${rc.status})`);
  }
}

function tryDecodeRevert(ret) {
  if (!ret || ret.length < 4) return "";
  const sel = ret.slice(0, 10).toLowerCase();
  // Error(string)
  if (sel === "0x08c379a0" && ret.length >= 10+64*2) {
    try {
      const iface = new ethers.Interface(["error Error(string)"]);
      const [msg] = iface.decodeErrorResult("Error", ret);
      return String(msg);
    } catch {}
  }
  return "";
}

async function main() {
  const {
    TIMELOCK_ADDRESS,
    MINI_MULTISIG,
    PROXY_ADDRESS,          // token proxy (GemStepToken proxy)
    PROXY_ADMIN_ADDRESS,    // ProxyAdmin
    MS_EOA1_PK,
    MS_EOA2_PK,
  } = process.env;

  const bad=[];
  if(!isAddr(TIMELOCK_ADDRESS)) bad.push("TIMELOCK_ADDRESS");
  if(!isAddr(MINI_MULTISIG)) bad.push("MINI_MULTISIG");
  if(!isAddr(PROXY_ADDRESS)) bad.push("PROXY_ADDRESS");
  if(!isAddr(PROXY_ADMIN_ADDRESS)) bad.push("PROXY_ADMIN_ADDRESS");
  if(!isHex32(MS_EOA1_PK)) bad.push("MS_EOA1_PK");
  if(!isHex32(MS_EOA2_PK)) bad.push("MS_EOA2_PK");
  if (bad.length) throw new Error("Missing/invalid env(s): "+bad.join(", "));

  const [sender] = await ethers.getSigners();
  const tl   = await ethers.getContractAt(TL_ABI, TIMELOCK_ADDRESS, sender);
  const mini1 = new ethers.Contract(MINI_MULTISIG, MINI_ABI, new ethers.Wallet(MS_EOA1_PK, ethers.provider));
  const mini2 = new ethers.Contract(MINI_MULTISIG, MINI_ABI, new ethers.Wallet(MS_EOA2_PK, ethers.provider));
  const token = new ethers.Contract(PROXY_ADDRESS, TOKEN_ACL_ABI, sender);

  console.log(`Grant DEFAULT_ADMIN_ROLE → ProxyAdmin (via TL+Mini) on ${hre.network.name} - grant_admin_via_timelock_mini_now_strict.js:113`);
  console.log("token(proxy): - grant_admin_via_timelock_mini_now_strict.js:114", PROXY_ADDRESS);
  console.log("ProxyAdmin  : - grant_admin_via_timelock_mini_now_strict.js:115", PROXY_ADMIN_ADDRESS);
  console.log("Timelock    : - grant_admin_via_timelock_mini_now_strict.js:116", TIMELOCK_ADDRESS);
  console.log("Mini        : - grant_admin_via_timelock_mini_now_strict.js:117", MINI_MULTISIG);

  // Roles sanity
  const PROPOSER_ROLE = await tl.PROPOSER_ROLE();
  const EXECUTOR_ROLE = await tl.EXECUTOR_ROLE();
  const miniHasProp = await tl.hasRole(PROPOSER_ROLE, MINI_MULTISIG);
  const miniHasExec = await tl.hasRole(EXECUTOR_ROLE, MINI_MULTISIG);
  console.log(`TL roles → mini PROPOSER=${miniHasProp} EXECUTOR=${miniHasExec} - grant_admin_via_timelock_mini_now_strict.js:124`);
  if (!miniHasProp) throw new Error("Mini lacks PROPOSER_ROLE on Timelock");
  if (!miniHasExec) throw new Error("Mini lacks EXECUTOR_ROLE on Timelock (or TL not open-exec)");

  const DAR = await token.DEFAULT_ADMIN_ROLE();
  const tlHasDAR = await token.hasRole(DAR, TIMELOCK_ADDRESS);
  const paHasDAR = await token.hasRole(DAR, PROXY_ADMIN_ADDRESS);
  console.log("Timelock has DEFAULT_ADMIN_ROLE on token? - grant_admin_via_timelock_mini_now_strict.js:131", tlHasDAR);
  console.log("Current: ProxyAdmin has DEFAULT_ADMIN_ROLE on token? - grant_admin_via_timelock_mini_now_strict.js:132", paHasDAR);
  if (!tlHasDAR) throw new Error("Timelock lacks DEFAULT_ADMIN_ROLE on token. Grant that first (your earlier script).");
  if (paHasDAR) { console.log("✅ No action needed. - grant_admin_via_timelock_mini_now_strict.js:134"); return; }

  const minDelay = await tl.getMinDelay();
  console.log("TL minDelay: - grant_admin_via_timelock_mini_now_strict.js:137", minDelay.toString(), "s");

  // Build calldata for token.grantRole(DAR, PROXY_ADMIN_ADDRESS)
  const grantData = token.interface.encodeFunctionData("grantRole", [DAR, PROXY_ADMIN_ADDRESS]);

  // Operation id and TL calldata
  const pred = ethers.ZeroHash;
  const value = 0n;
  const salt = ethers.keccak256(ethers.toUtf8Bytes(`grant:${PROXY_ADDRESS.toLowerCase()}:${PROXY_ADMIN_ADDRESS.toLowerCase()}:${Date.now()}:${Math.random()}`));

  const tlIface = new ethers.Interface(TL_ABI);
  const schedDataTL = tlIface.encodeFunctionData("schedule", [PROXY_ADDRESS, value, grantData, pred, salt, minDelay]);
  const execDataTL  = tlIface.encodeFunctionData("execute",  [PROXY_ADDRESS, value, grantData, pred, salt]);

  const opId = await tl.hashOperation(PROXY_ADDRESS, value, grantData, pred, salt);

  // === Schedule via Mini (strict) ===
  // Preflight Timelock.schedule as if from Mini (eth_call)
  const preSched = await ethers.provider.call({ from: MINI_MULTISIG, to: TIMELOCK_ADDRESS, data: schedDataTL }).then(()=>true).catch(e=>{
    console.log("❌ Preflight schedule reverted: - grant_admin_via_timelock_mini_now_strict.js:156", e?.reason||e?.shortMessage||e?.message||e);
    return false;
  });
  if (!preSched) throw new Error("TL.schedule(grantRole) preflight failed from MINI");

  // Propose + Approve
  const idSched = await miniProposeApprove(mini1, mini2, "TL.schedule(grantRole)", TIMELOCK_ADDRESS, schedDataTL);

  // Execute (strict: inner call must succeed)
  await miniExecuteStrict(mini1, idSched, "schedule(grantRole)");

  // Confirm it actually scheduled
  const existsAfter = await tl.isOperation(opId);
  const readyAfter  = await tl.isOperationReady(opId);
  const doneAfter   = await tl.isOperationDone(opId);
  console.log("TL.grantRole op (after schedule): - grant_admin_via_timelock_mini_now_strict.js:171", { exists: existsAfter, ready: readyAfter, done: doneAfter });
  if (!existsAfter) {
    throw new Error("Timelock op DOES NOT EXIST after schedule — inner call likely failed in Mini. (This script would have thrown earlier; recheck addresses.)");
  }

  // Wait TL delay if needed
  if (!readyAfter) {
    await waitSecs(minDelay, "TL minDelay before executing grantRole");
  }

  // === Execute via Mini (strict) ===
  const preExec = await ethers.provider.call({ from: MINI_MULTISIG, to: TIMELOCK_ADDRESS, data: execDataTL }).then(()=>true).catch(e=>{
    console.log("❌ Preflight execute reverted: - grant_admin_via_timelock_mini_now_strict.js:183", e?.reason||e?.shortMessage||e?.message||e);
    return false;
  });
  if (!preExec) throw new Error("TL.execute(grantRole) preflight failed from MINI (not ready or inner revert)");

  const idExec = await miniProposeApprove(mini1, mini2, "TL.execute(grantRole)", TIMELOCK_ADDRESS, execDataTL);
  await miniExecuteStrict(mini1, idExec, "execute(grantRole)");

  // Verify final
  const paHasDARAfter = await token.hasRole(DAR, PROXY_ADMIN_ADDRESS);
  console.log("ProxyAdmin has DEFAULT_ADMIN_ROLE now? - grant_admin_via_timelock_mini_now_strict.js:193", paHasDARAfter);
  if (!paHasDARAfter) throw new Error("Grant did not take effect.");
  console.log("🎉 Grant succeeded. - grant_admin_via_timelock_mini_now_strict.js:195");
}

main().catch((e) => { console.error(e); process.exit(1); });
