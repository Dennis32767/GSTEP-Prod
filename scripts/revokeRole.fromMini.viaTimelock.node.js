// scripts/revokeRole.fromMini.viaTimelock.node.js
/* eslint-disable no-console */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

function parseArgs(argv) {
  const out = { file: null, token: null, timelock: null, mini: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file" || a === "-f") out.file = argv[++i];
    else if (a === "--token") out.token = (argv[++i] || "").trim();
    else if (a === "--timelock") out.timelock = (argv[++i] || "").trim();
    else if (a === "--mini") out.mini = (argv[++i] || "").trim();
  }
  if (!out.file) throw new Error("Missing --file <deployment-json>");
  return out;
}
function isAddr(x) { return /^0x[a-fA-F0-9]{40}$/.test((x || "").trim()); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const MINI_ABI = [
  "function txCount() view returns (uint256)",
  "function propose(address target, uint256 value, bytes data) returns (uint256 id)",
  "function approve(uint256 id)",
  "function execute(uint256 id) returns (bool ok, bytes ret)",
  "function getTx(uint256 id) view returns (address target, uint256 value, bool executed, uint8 approvals, bytes data)",
  "function isApproved(uint256 id, address owner) view returns (bool)"
];

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

const TOKEN_ABI = [
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role, address who) view returns (bool)",
  "function revokeRole(bytes32 role, address who)"
];

// eth_call helper to simulate "msg.sender = from"
async function ethCallFrom(provider, from, to, data) {
  try {
    const res = await provider.call({ from, to, data });
    return { ok: true, returndata: res };
  } catch (e) {
    const msg = e?.shortMessage || e?.message || "call reverted";
    return { ok: false, error: msg, raw: e };
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const abs = path.resolve(process.cwd(), args.file);
  const j = JSON.parse(fs.readFileSync(abs, "utf8"));

  const TOKEN = (args.token || j.contracts?.tokenProxy || j.contracts?.token || j.contracts?.proxy || "").trim();
  const TL    = (args.timelock || j.contracts?.timelock || "").trim();
  const MINI  = (args.mini || j.contracts?.miniMultisig || j.contracts?.mini || j.contracts?.multisig || "").trim();

  if (!isAddr(TOKEN)) throw new Error("Missing/invalid token proxy address (use --token)");
  if (!isAddr(TL))    throw new Error("Missing/invalid timelock address (use --timelock)");
  if (!isAddr(MINI))  throw new Error("Missing/invalid MiniMultisig address (use --mini)");

  const rpc = (process.env.ARBITRUM_SEPOLIA_RPC_URL || "").trim();
  if (!/^https?:\/\//.test(rpc)) throw new Error("ARBITRUM_SEPOLIA_RPC_URL missing");

  const pk1 = (process.env.MS_EOA1_PK || "").trim();
  const pk2 = (process.env.MS_EOA2_PK || "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk1) || !/^0x[0-9a-fA-F]{64}$/.test(pk2)) {
    throw new Error("MS_EOA1_PK / MS_EOA2_PK missing/invalid (need 0x + 64 hex).");
  }

  const provider = new ethers.JsonRpcProvider(rpc);
  const w1 = new ethers.Wallet(pk1, provider);
  const w2 = new ethers.Wallet(pk2, provider);

  console.log("[Using]");
  console.log("file  :", abs);
  console.log("TOKEN :", TOKEN);
  console.log("TL    :", TL);
  console.log("MINI  :", MINI);
  console.log("EOA1  :", await w1.getAddress());
  console.log("EOA2  :", await w2.getAddress());

  const tokenRO = new ethers.Contract(TOKEN, TOKEN_ABI, provider);
  const tlRO    = new ethers.Contract(TL, TL_ABI, provider);
  const tlIface = new ethers.Interface(TL_ABI);

  const miniC1  = new ethers.Contract(MINI, MINI_ABI, w1);
  const miniC2  = miniC1.connect(w2);

  const DAR = await tokenRO.DEFAULT_ADMIN_ROLE();

  // Preconditions
  const tlHasDAR = await tokenRO.hasRole(DAR, TL);
  const miniHasDAR = await tokenRO.hasRole(DAR, MINI);

  console.log("\n[Precheck]");
  console.log("Timelock has DAR:", tlHasDAR);
  console.log("Mini has DAR    :", miniHasDAR);

  if (!tlHasDAR) throw new Error("Timelock does NOT have DEFAULT_ADMIN_ROLE on token. Abort.");
  if (!miniHasDAR) {
    console.log("✅ Mini already does NOT have DAR. Nothing to revoke.");
    return;
  }

  // TL must allow MINI as proposer/executor (based on your setup)
  const PROPOSER_ROLE = await tlRO.PROPOSER_ROLE();
  const EXECUTOR_ROLE = await tlRO.EXECUTOR_ROLE();
  const proposerIsMini = await tlRO.hasRole(PROPOSER_ROLE, MINI);
  const executorIsMini = await tlRO.hasRole(EXECUTOR_ROLE, MINI);
  if (!proposerIsMini) throw new Error("Mini is not PROPOSER on Timelock.");
  if (!executorIsMini) throw new Error("Mini is not EXECUTOR on Timelock (and executor is not open).");

  const minDelay = await tlRO.getMinDelay();

  // Build token call: revokeRole(DAR, MINI)
  const tokenIface = new ethers.Interface(TOKEN_ABI);
  const tokenCallData = tokenIface.encodeFunctionData("revokeRole", [DAR, MINI]);

  // Timelock op params
  const predecessor = ethers.ZeroHash;
  const value = 0n;
  const salt = ethers.keccak256(
    ethers.toUtf8Bytes(`REVOKE_DAR_FROM_MINI:${TOKEN.toLowerCase()}:${MINI.toLowerCase()}`)
  );

  const opId = await tlRO.hashOperation(TOKEN, value, tokenCallData, predecessor, salt);
  console.log("\noperationId:", opId);

  // Dryrun: simulate token call as if from TL
  console.log("\n[Dryrun] eth_call from TL to token.revokeRole(DAR, MINI)...");
  const dry = await ethCallFrom(provider, TL, TOKEN, tokenCallData);
  if (!dry.ok) {
    console.error("Dryrun reverted:", dry.error);
    throw new Error("Dryrun failed. Timelock->token revokeRole would revert.");
  }
  console.log("Dryrun OK.");

  // --- Schedule through TL (via Mini) ---
  const already = await tlRO.isOperation(opId);
  if (!already) {
    console.log("\nScheduling revoke via Mini -> Timelock.schedule()...");
    const schedCalldata = tlIface.encodeFunctionData("schedule", [
      TOKEN, value, tokenCallData, predecessor, salt, minDelay
    ]);

    const txP = await miniC1.propose(TL, 0, schedCalldata);
    await txP.wait();

    const id = await miniC1.txCount();
    console.log("Mini schedule tx id:", id.toString());

    const owner2 = await w2.getAddress();
    const approved2 = await miniC1.isApproved(id, owner2).catch(() => false);
    if (!approved2) {
      const txA = await miniC2.approve(id);
      await txA.wait();
      console.log("Approved by owner2.");
    }

    await sleep(500);
    const t = await miniC1.getTx(id);
    console.log("Tx state:", { target: t.target, approvals: t.approvals, executed: t.executed });

    const txE = await miniC1.execute(id);
    const rc = await txE.wait();
    console.log("Scheduled. tx:", txE.hash, "status:", rc.status);
  } else {
    console.log("\nℹ️ Operation already scheduled; skipping schedule.");
  }

  // Wait until ready
  process.stdout.write("Waiting ready");
  for (;;) {
    if (await tlRO.isOperationReady(opId)) break;
    process.stdout.write(".");
    await sleep(2000);
  }
  console.log("\nReady.");

  // --- Execute through TL (via Mini) ---
  if (await tlRO.isOperationDone(opId)) {
    console.log("ℹ️ Already executed; skipping execute.");
  } else {
    console.log("\nExecuting revoke via Mini -> Timelock.execute()...");
    const execCalldata = tlIface.encodeFunctionData("execute", [
      TOKEN, value, tokenCallData, predecessor, salt
    ]);

    // Precheck: simulate TL.execute from MINI (msg.sender = MINI)
    const pre = await ethCallFrom(provider, MINI, TL, execCalldata);
    if (!pre.ok) {
      console.error("Precheck reverted:", pre.error);
      throw new Error("Precheck failed; TL.execute would revert.");
    }

    const txP2 = await miniC1.propose(TL, 0, execCalldata);
    await txP2.wait();

    const id2 = await miniC1.txCount();
    console.log("Mini execute tx id:", id2.toString());

    const owner2 = await w2.getAddress();
    const approved2b = await miniC1.isApproved(id2, owner2).catch(() => false);
    if (!approved2b) {
      const txA2 = await miniC2.approve(id2);
      await txA2.wait();
      console.log("Approved by owner2.");
    }

    await sleep(500);
    const t2 = await miniC1.getTx(id2);
    console.log("Tx state:", { target: t2.target, approvals: t2.approvals, executed: t2.executed });

    const txE2 = await miniC1.execute(id2);
    const rc2 = await txE2.wait();
    console.log("Executed. tx:", txE2.hash, "status:", rc2.status);
  }

  // Verify
  const miniAfter = await tokenRO.hasRole(DAR, MINI);
  const tlAfter = await tokenRO.hasRole(DAR, TL);
  console.log("\n[Verify]");
  console.log("Mini has DAR after:", miniAfter);
  console.log("TL has DAR after  :", tlAfter);

  if (miniAfter) throw new Error("Revoke did not apply; Mini still has DAR.");
  if (!tlAfter) throw new Error("Unexpected: Timelock lost DAR.");
  console.log("✅ SUCCESS: revoked DEFAULT_ADMIN_ROLE from Mini via Timelock.");
}

main().catch((e) => {
  console.error("revokeRole.fromMini.viaTimelock.node failed:", e?.reason || e?.shortMessage || e?.message || e);
  process.exit(1);
});
