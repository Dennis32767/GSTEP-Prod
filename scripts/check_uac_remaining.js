/* eslint-disable no-console */
require("dotenv").config();
const { ethers } = require("hardhat");

// ---- Minimal ABIs ----
const TL_ABI = [
  "function getMinDelay() view returns (uint256)",
  "function hashOperation(address,uint256,bytes,bytes32,bytes32) view returns (bytes32)",
  "function isOperation(bytes32) view returns (bool)",
  "function isOperationReady(bytes32) view returns (bool)",
  "function isOperationDone(bytes32) view returns (bool)",
  // Many OpenZeppelin Timelocks expose this:
  "function getTimestamp(bytes32) view returns (uint256)"
];

const EXEC_ABI = [
  "function upgradeDelay() view returns (uint256)",
  // Some executors store keyed timestamps:
  "function scheduledUpgrades(bytes32) view returns (uint256)",
  "function scheduledUpgradesWithData(bytes32) view returns (uint256)",
  "function scheduleUpgradeAndCall(address,address,address,bytes)",
  "function executeUpgradeAndCall(address,address,address,bytes)"
];

// ---- Helpers ----
function isAddr(a){ try { ethers.getAddress(a); return true; } catch { return false; } }
function nowSec() { return BigInt(Math.floor(Date.now() / 1000)); }
function fmtSecs(s) {
  s = Number(s);
  if (s <= 0) return "0s";
  const d = Math.floor(s / 86400); s -= d*86400;
  const h = Math.floor(s / 3600);  s -= h*3600;
  const m = Math.floor(s / 60);    s -= m*60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s) parts.push(`${s}s`);
  return parts.join(" ");
}
function toUTC(ts) {
  if (!ts || ts === 0n) return "-";
  const d = new Date(Number(ts) * 1000);
  return d.toISOString().replace(".000Z", "Z");
}
function keccak(b){ return ethers.keccak256(b); }
function fBool(x){ return !!x; }

function saltQueue(proxy, impl, initData) {
  const ih = keccak(initData);
  return keccak(ethers.toUtf8Bytes(`queue:${proxy.toLowerCase()}:${impl.toLowerCase()}:${ih}`));
}
function saltFinal(proxy, impl, initData) {
  const ih = keccak(initData);
  return keccak(ethers.toUtf8Bytes(`exec:${proxy.toLowerCase()}:${impl.toLowerCase()}:${ih}`));
}

async function readExecReadyAt(exec, keyWithData) {
  // prefer scheduledUpgradesWithData if present
  if (exec.interface.getFunction("scheduledUpgradesWithData")) {
    try { return await exec.scheduledUpgradesWithData(keyWithData); } catch {}
  }
  if (exec.interface.getFunction("scheduledUpgrades")) {
    try { return await exec.scheduledUpgrades(keyWithData); } catch {}
  }
  return 0n;
}

async function main() {
  const {
    TIMELOCK_ADDRESS,
    EXECUTOR_ADDRESS,
    PROXY_ADMIN_ADDRESS,
    PROXY_ADDRESS,
    NEW_IMPL_ADDRESS,
    INIT_FUNC,        // e.g. "initializeV2()"
    INIT_CALLDATA,    // or raw bytes
    QUEUE_SALT,       // optional override 0x + 64 hex
    EXECUTE_SALT,     // optional override 0x + 64 hex
    // extras
    JSON_OUTPUT       // set to "1" to print JSON only
  } = process.env;

  const bad = [];
  if (!isAddr(TIMELOCK_ADDRESS))     bad.push("TIMELOCK_ADDRESS");
  if (!isAddr(EXECUTOR_ADDRESS))     bad.push("EXECUTOR_ADDRESS");
  if (!isAddr(PROXY_ADMIN_ADDRESS))  bad.push("PROXY_ADMIN_ADDRESS");
  if (!isAddr(PROXY_ADDRESS))        bad.push("PROXY_ADDRESS");
  if (!isAddr(NEW_IMPL_ADDRESS))     bad.push("NEW_IMPL_ADDRESS");
  if (bad.length) throw new Error("Missing/invalid env(s): " + bad.join(", "));

  // Build init calldata
  let initData = (INIT_CALLDATA || "").trim();
  if (!initData) {
    const fn = (INIT_FUNC || "initialize()").trim();
    const iface = new ethers.Interface([`function ${fn}`]);
    const nameOnly = fn.slice(0, fn.indexOf("("));
    initData = iface.encodeFunctionData(nameOnly, []);
  }
  if (!/^0x[0-9a-fA-F]*$/.test(initData)) throw new Error("INIT_CALLDATA must be 0x-prefixed hex");

  const [signer] = await ethers.getSigners();
  const tl   = await ethers.getContractAt(TL_ABI,   TIMELOCK_ADDRESS, signer);
  const exec = await ethers.getContractAt(EXEC_ABI, EXECUTOR_ADDRESS, signer);

  // Encode the exact payloads used for TL scheduling
  const eI = new ethers.Interface(EXEC_ABI);
  const dataQueue = eI.encodeFunctionData(
    "scheduleUpgradeAndCall",
    [PROXY_ADMIN_ADDRESS, PROXY_ADDRESS, NEW_IMPL_ADDRESS, initData]
  );
  const dataFinal = eI.encodeFunctionData(
    "executeUpgradeAndCall",
    [PROXY_ADMIN_ADDRESS, PROXY_ADDRESS, NEW_IMPL_ADDRESS, initData]
  );

  const pred  = ethers.ZeroHash;
  const value = 0n;

  // Salts (override or deterministic)
  const qSalt = (QUEUE_SALT && /^0x[0-9a-fA-F]{64}$/.test(QUEUE_SALT)) ? QUEUE_SALT
              : saltQueue(PROXY_ADDRESS, NEW_IMPL_ADDRESS, initData);
  const eSalt = (EXECUTE_SALT && /^0x[0-9a-fA-F]{64}$/.test(EXECUTE_SALT)) ? EXECUTE_SALT
              : saltFinal(PROXY_ADDRESS, NEW_IMPL_ADDRESS, initData);

  // Timelock opIds
  const opQueue = await tl.hashOperation(EXECUTOR_ADDRESS, value, dataQueue, pred, qSalt);
  const opFinal = await tl.hashOperation(EXECUTOR_ADDRESS, value, dataFinal, pred, eSalt);

  // Bulk reads
  const [
    minDelay,
    qExists, qReady, qDone,
    fExists, fReady, fDone,
    upgDelay
  ] = await Promise.all([
    tl.getMinDelay(),
    tl.isOperation(opQueue), tl.isOperationReady(opQueue), tl.isOperationDone(opQueue),
    tl.isOperation(opFinal), tl.isOperationReady(opFinal), tl.isOperationDone(opFinal),
    exec.upgradeDelay()
  ]);

  // Timelock timestamps (getTimestamp may not exist on some forks; guard)
  let qTs = 0n, fTs = 0n;
  try { qTs = await tl.getTimestamp(opQueue); } catch {}
  try { fTs = await tl.getTimestamp(opFinal); } catch {}

  // Executor key (with data)
  const execKeyWithData = keccak(ethers.AbiCoder.defaultAbiCoder().encode(
    ["address","address","address","bytes"],
    [PROXY_ADMIN_ADDRESS, PROXY_ADDRESS, NEW_IMPL_ADDRESS, initData]
  ));
  const execReadyAt = await readExecReadyAt(exec, execKeyWithData);

  // Interpret TL timestamps: 0 = not scheduled; 1 = done; >1 = readyAt
  function tlStatus(exists, ready, done, ts) {
    const state = done ? "done" : (exists ? (ready ? "ready" : "waiting") : "absent");
    let readyAt = 0n;
    if (ts === 1n) readyAt = 0n;        // done sentinel
    else if (ts > 1n) readyAt = ts;
    return { state, readyAt };
  }
  const q = tlStatus(fBool(qExists), fBool(qReady), fBool(qDone), qTs);
  const f = tlStatus(fBool(fExists), fBool(fReady), fBool(fDone), fTs);

  // Remaining computations
  const now = nowSec();
  const rem = (ts) => ts > 0n ? (ts > now ? ts - now : 0n) : 0n;
  const qRemain       = rem(q.readyAt);
  const fRemainTL     = rem(f.readyAt);
  const fRemainExec   = rem(execReadyAt);
  const fRemainOverall= fRemainTL > fRemainExec ? fRemainTL : fRemainExec;

  if (JSON_OUTPUT === "1") {
    console.log(JSON.stringify({
      proxy: PROXY_ADDRESS,
      implementation: NEW_IMPL_ADDRESS,
      initSelector: initData.slice(0,10),
      initData,
      timelock: {
        address: TIMELOCK_ADDRESS,
        minDelay: minDelay.toString(),
        queue: { opId: opQueue, salt: qSalt, state: q.state, readyAt: q.readyAt.toString(), readyAtUTC: toUTC(q.readyAt), remaining: qRemain.toString() },
        final:  { opId: opFinal, salt: eSalt, state: f.state, readyAt: f.readyAt.toString(), readyAtUTC: toUTC(f.readyAt), remaining: fRemainTL.toString() },
      },
      executor: {
        address: EXECUTOR_ADDRESS,
        delay: upgDelay.toString(),
        keyWithData: execKeyWithData,
        readyAt: execReadyAt.toString(),
        readyAtUTC: toUTC(execReadyAt),
        remaining: fRemainExec.toString(),
      },
      overallRemaining: fRemainOverall.toString(),
    }, null, 2));
    return;
  }

  // Pretty print
  console.log("\n=== upgradeAndCall  Remaining Time Check === - check_uac_remaining.js:200");
  console.log("Proxy          : - check_uac_remaining.js:201", PROXY_ADDRESS);
  console.log("Implementation : - check_uac_remaining.js:202", NEW_IMPL_ADDRESS);
  console.log("Init selector  : - check_uac_remaining.js:203", initData.slice(0,10));
  console.log("Init bytes     : - check_uac_remaining.js:204", `${initData.slice(0,66)}${initData.length>66?'…':''}`);
  console.log("");
  console.log("Timelock       : - check_uac_remaining.js:206", TIMELOCK_ADDRESS, `(minDelay=${minDelay}s)`);
  console.log("Queue opId   : - check_uac_remaining.js:207", opQueue);
  console.log("Queue salt   : - check_uac_remaining.js:208", qSalt);
  console.log("Queue state  : - check_uac_remaining.js:209", q.state);
  console.log("Queue ready  : - check_uac_remaining.js:210", q.readyAt.toString(), toUTC(q.readyAt), "| remain:", fmtSecs(Number(qRemain)));
  console.log("");
  console.log("Final opId   : - check_uac_remaining.js:212", opFinal);
  console.log("Final salt   : - check_uac_remaining.js:213", eSalt);
  console.log("Final state  : - check_uac_remaining.js:214", f.state);
  console.log("Final TL     : - check_uac_remaining.js:215", f.readyAt.toString(), toUTC(f.readyAt), "| remain:", fmtSecs(Number(fRemainTL)));
  console.log("");
  console.log("Executor       : - check_uac_remaining.js:217", EXECUTOR_ADDRESS, `(delay=${upgDelay}s)`);
  console.log("Key (with data): - check_uac_remaining.js:218", execKeyWithData);
  console.log("Exec ready   : - check_uac_remaining.js:219", execReadyAt.toString(), toUTC(execReadyAt), "| remain:", fmtSecs(Number(fRemainExec)));
  console.log("");
  console.log("➡ Overall remaining (must be 0 to run final): - check_uac_remaining.js:221", fmtSecs(Number(fRemainOverall)));
}

main().catch((e) => { console.error(e); process.exit(1); });
