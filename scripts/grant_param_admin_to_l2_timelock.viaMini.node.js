/* eslint-disable no-console */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

function parseArgs(argv) {
  const out = { file: null, token: null, timelock: null, mini: null, id: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file" || a === "-f") out.file = argv[++i];
    else if (a === "--token") out.token = (argv[++i] || "").trim();
    else if (a === "--timelock") out.timelock = (argv[++i] || "").trim();
    else if (a === "--mini") out.mini = (argv[++i] || "").trim();
    else if (a === "--id") out.id = (argv[++i] || "").trim();
  }
  if (!out.file) throw new Error("Missing --file <deployment-json>");
  return out;
}

function isAddr(x) {
  return /^0x[a-fA-F0-9]{40}$/.test((x || "").trim());
}
function pickAddr(...vals) {
  for (const v of vals) {
    const s = (v || "").toString().trim();
    if (isAddr(s)) return s;
  }
  return "";
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const MINI_ABI = [
  "function txCount() view returns (uint256)",
  "function propose(address target, uint256 value, bytes data) returns (uint256 id)",
  "function approve(uint256 id)",
  "function execute(uint256 id) returns (bool ok, bytes ret)",
  "function getTx(uint256 id) view returns (address target, uint256 value, bool executed, uint8 approvals, bytes data)",
  "function isApproved(uint256 id, address owner) view returns (bool)"
];

const TOKEN_ABI = [
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role, address who) view returns (bool)",
  "function grantRole(bytes32 role, address who)"
];

async function main() {
  const args = parseArgs(process.argv);
  const abs = path.resolve(process.cwd(), args.file);
  const j = JSON.parse(fs.readFileSync(abs, "utf8"));

  // Your JSON (from what you pasted) is flat: tokenProxy/timelock/multisig
  const TOKEN = pickAddr(args.token, j.tokenProxy, j.contracts?.tokenProxy, j.token, j.contracts?.token);
  const TL    = pickAddr(args.timelock, j.timelock, j.contracts?.timelock);
  const MINI  = pickAddr(args.mini, j.multisig, j.miniMultisig, j.contracts?.multisig, j.contracts?.miniMultisig);

  if (!isAddr(TOKEN)) throw new Error("Missing/invalid token proxy address (use --token)");
  if (!isAddr(TL))    throw new Error("Missing/invalid timelock address (use --timelock)");
  if (!isAddr(MINI))  throw new Error("Missing/invalid MiniMultisig address (use --mini)");

  const rpc = (process.env.ARBITRUM_SEPOLIA_RPC_URL || "").trim();
  if (!/^https?:\/\//.test(rpc)) throw new Error("ARBITRUM_SEPOLIA_RPC_URL missing/invalid");

  const pk1 = (process.env.MS_EOA1_PK || "").trim();
  const pk2 = (process.env.MS_EOA2_PK || "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk1) || !/^0x[0-9a-fA-F]{64}$/.test(pk2)) {
    throw new Error("MS_EOA1_PK / MS_EOA2_PK missing/invalid (need 0x + 64 hex).");
  }

  const provider = new ethers.JsonRpcProvider(rpc);
  const w1 = new ethers.Wallet(pk1, provider);
  const w2 = new ethers.Wallet(pk2, provider);

  const a1 = await w1.getAddress();
  const a2 = await w2.getAddress();

  console.log("=== GRANT PARAMETER_ADMIN_ROLE TO TIMELOCK via MINI (L2) ===");
  console.log("deployment file:", abs);
  console.log("TOKEN:", TOKEN);
  console.log("TL   :", TL);
  console.log("MINI :", MINI);
  console.log("EOA1 :", a1);
  console.log("EOA2 :", a2);

  const tokenRO = new ethers.Contract(TOKEN, TOKEN_ABI, provider);
  const mini1 = new ethers.Contract(MINI, MINI_ABI, w1);
  const mini2 = mini1.connect(w2);

  // Role hash MUST match GemStepStorage: keccak256("PARAMETER_ADMIN_ROLE")
  const PARAM_ROLE = ethers.id("PARAMETER_ADMIN_ROLE");

  const tlHasBefore = await tokenRO.hasRole(PARAM_ROLE, TL);
  console.log("\nTimelock has PARAMETER_ADMIN_ROLE (before):", tlHasBefore);
  if (tlHasBefore) {
    console.log("✅ Already granted; nothing to do.");
    return;
  }

  const DAR = await tokenRO.DEFAULT_ADMIN_ROLE();
  const miniHasDAR = await tokenRO.hasRole(DAR, MINI);
  console.log("Mini has DEFAULT_ADMIN_ROLE on token:", miniHasDAR);
  if (!miniHasDAR) throw new Error("Mini does NOT have DEFAULT_ADMIN_ROLE on token; cannot grant.");

  const iface = new ethers.Interface(TOKEN_ABI);
  const callData = iface.encodeFunctionData("grantRole", [PARAM_ROLE, TL]);

  // Determine which tx id to work with.
  // Your mini reports txCount=22 and getTx(22) exists => use txCount() directly as latest id.
  let idToUse;
  if (args.id) {
    idToUse = BigInt(args.id);
    console.log("\nUsing forced --id:", idToUse.toString());
  } else {
    idToUse = BigInt(await mini1.txCount());
    console.log("\nMini txCount (latest id):", idToUse.toString());
  }

  // Load the tx at that id.
  let txInfo = await mini1.getTx(idToUse).catch(() => null);

  // If latest tx is not our grantRole call, propose a new one and use the new id.
  const matches =
    txInfo &&
    txInfo.target.toLowerCase() === TOKEN.toLowerCase() &&
    txInfo.value === 0n &&
    txInfo.executed === false &&
    (txInfo.data || "0x").toLowerCase() === callData.toLowerCase();

  if (!matches) {
    console.log("\nLatest tx is not our pending grantRole. Proposing a new tx...");
    const before = await mini1.txCount();
    const txP = await mini1.propose(TOKEN, 0, callData);
    console.log("Propose tx hash:", txP.hash);
    await txP.wait();

    const after = await mini1.txCount();
    console.log("txCount before/after:", before.toString(), "->", after.toString());
    idToUse = BigInt(after);

    txInfo = await mini1.getTx(idToUse);
  } else {
    console.log("\nFound matching pending grantRole at id:", idToUse.toString());
  }

  console.log("\n[Mini tx]", {
    id: idToUse.toString(),
    target: txInfo.target,
    value: txInfo.value.toString(),
    executed: txInfo.executed,
    approvals: txInfo.approvals.toString(),
    dataLen: (txInfo.data || "0x").length
  });

  // Approve with EOA2 if needed
  const approved2 = await mini1.isApproved(idToUse, a2).catch(() => false);
  console.log("Owner2 isApproved:", approved2);

  if (!approved2) {
    console.log("Approving with owner2...");
    const txA = await mini2.approve(idToUse);
    console.log("Approve tx hash:", txA.hash);
    await txA.wait();
    console.log("✓ Approved by owner2.");
  } else {
    console.log("Owner2 already approved.");
  }

  await sleep(500);

  const txInfo2 = await mini1.getTx(idToUse);
  console.log("\n[Mini tx after approve]", {
    approvals: txInfo2.approvals.toString(),
    executed: txInfo2.executed
  });

  console.log("\nExecuting via Mini (owner1)...");
  const txE = await mini1.execute(idToUse);
  console.log("Execute tx hash:", txE.hash);
  const rcE = await txE.wait();
  console.log("Execute status:", rcE.status);

  const tlHasAfter = await tokenRO.hasRole(PARAM_ROLE, TL);
  console.log("\nTimelock has PARAMETER_ADMIN_ROLE (after):", tlHasAfter);
  if (!tlHasAfter) throw new Error("Grant did not apply. Check that TOKEN is the proxy and Mini.execute succeeded.");

  console.log("✅ SUCCESS. Now re-run: node scripts/configure_sources_via_l2_timelock.js");
}

main().catch((e) => {
  console.error("❌ grant_param_admin_to_l2_timelock.viaMini failed:", e?.reason || e?.shortMessage || e?.message || e);
  process.exit(1);
});
