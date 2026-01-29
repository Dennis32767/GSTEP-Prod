/* eslint-disable no-console */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

/**
 * revoke_param_admin_from_timelock.viaMini.js
 *
 * Usage:
 *   node scripts/revoke_param_admin_from_timelock.viaMini.js --file deployments/arbitrumSepolia-latest.json
 *
 * Resume/execute a pending tx:
 *   node scripts/revoke_param_admin_from_timelock.viaMini.js --file deployments/arbitrumSepolia-latest.json --id 22
 *
 * Optional overrides:
 *   --token 0x...
 *   --timelock 0x...
 *   --mini 0x...
 */

function parseArgs(argv) {
  const out = { file: null, token: null, timelock: null, mini: null, id: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file" || a === "-f") out.file = argv[++i];
    else if (a === "--token") out.token = (argv[++i] || "").trim();
    else if (a === "--timelock") out.timelock = (argv[++i] || "").trim();
    else if (a === "--mini") out.mini = (argv[++i] || "").trim();
    else if (a === "--id") out.id = BigInt(argv[++i]);
  }
  if (!out.file) throw new Error("Missing --file <deployment-json>");
  return out;
}

function isAddr(x) {
  return /^0x[a-fA-F0-9]{40}$/.test((x || "").trim());
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
  "function isApproved(uint256 id, address owner) view returns (bool)",
];

const TOKEN_ABI = [
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role, address who) view returns (bool)",
  "function grantRole(bytes32 role, address who)",
  "function revokeRole(bytes32 role, address who)",
];

async function main() {
  const args = parseArgs(process.argv);
  const abs = path.resolve(process.cwd(), args.file);
  const j = JSON.parse(fs.readFileSync(abs, "utf8"));

  // Read from the JSON you showed (top-level keys), plus common fallbacks
  const TOKEN = (args.token || j.tokenProxy || j.contracts?.tokenProxy || j.contracts?.token || "").trim();
  const TL = (args.timelock || j.timelock || j.contracts?.timelock || "").trim();
  const MINI = (args.mini || j.multisig || j.contracts?.multisig || j.contracts?.miniMultisig || "").trim();

  if (!isAddr(TOKEN)) throw new Error("Missing/invalid token proxy address (use --token)");
  if (!isAddr(TL)) throw new Error("Missing/invalid timelock address (use --timelock)");
  if (!isAddr(MINI)) throw new Error("Missing/invalid MiniMultisig address (use --mini)");

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

  const tokenRO = new ethers.Contract(TOKEN, TOKEN_ABI, provider);
  const mini1 = new ethers.Contract(MINI, MINI_ABI, w1);
  const mini2 = mini1.connect(w2);

  console.log("=== REVOKE PARAMETER_ADMIN_ROLE FROM TIMELOCK via MINI (L2) ===");
  console.log("deployment file:", abs);
  console.log("TOKEN:", TOKEN);
  console.log("TL   :", TL);
  console.log("MINI :", MINI);
  console.log("EOA1 :", await w1.getAddress());
  console.log("EOA2 :", await w2.getAddress());

  // Matches your GemStepStorage constant: keccak256("PARAMETER_ADMIN_ROLE")
  const PARAM_ROLE = ethers.id("PARAMETER_ADMIN_ROLE");

  const tlHasBefore = await tokenRO.hasRole(PARAM_ROLE, TL);
  console.log("\nTimelock has PARAMETER_ADMIN_ROLE (before):", tlHasBefore);
  if (!tlHasBefore) {
    console.log("✅ Nothing to do (TL already does not have the role).");
    return;
  }

  const DAR = await tokenRO.DEFAULT_ADMIN_ROLE();
  const miniHasDAR = await tokenRO.hasRole(DAR, MINI);
  console.log("Mini has DEFAULT_ADMIN_ROLE on token:", miniHasDAR);
  if (!miniHasDAR) {
    throw new Error("Mini does NOT have DEFAULT_ADMIN_ROLE on token; cannot revokeRole.");
  }

  const iface = new ethers.Interface(TOKEN_ABI);
  const data = iface.encodeFunctionData("revokeRole", [PARAM_ROLE, TL]);

  // If user provided --id, operate on that existing pending tx
  if (args.id !== null) {
    const id = args.id;
    console.log("\nUsing forced --id:", id.toString());

    const txInfo = await mini1.getTx(id);
    console.log("\n[Mini tx]", {
      id: id.toString(),
      target: txInfo[0],
      value: txInfo[1].toString(),
      executed: txInfo[2],
      approvals: txInfo[3].toString(),
      dataLen: txInfo[4].length,
    });

    if (txInfo[2]) {
      console.log("ℹ️ Already executed; checking role state...");
      const tlHas = await tokenRO.hasRole(PARAM_ROLE, TL);
      console.log("Timelock has PARAMETER_ADMIN_ROLE now:", tlHas);
      return;
    }

    // approve by owner2 if needed
    const owner2 = await w2.getAddress();
    const approved2 = await mini1.isApproved(id, owner2).catch(() => false);
    console.log("Owner2 isApproved:", approved2);
    if (!approved2) {
      console.log("Approving with owner2...");
      const txA = await mini2.approve(id);
      console.log("Approve tx hash:", txA.hash);
      await txA.wait();
      console.log("✓ Approved by owner2.");
    }

    await sleep(500);
    const after = await mini1.getTx(id);
    console.log("\n[Mini tx after approve]", {
      approvals: after[3].toString(),
      executed: after[2],
    });

    console.log("\nExecuting via Mini (owner1)...");
    const txE = await mini1.execute(id);
    console.log("Execute tx hash:", txE.hash);
    const rc = await txE.wait();
    console.log("Execute status:", rc.status);

    const tlHasAfter = await tokenRO.hasRole(PARAM_ROLE, TL);
    console.log("\nTimelock has PARAMETER_ADMIN_ROLE (after):", tlHasAfter);
    if (tlHasAfter) throw new Error("Role still present after execute; inspect tx.");
    console.log("✅ SUCCESS. PARAMETER_ADMIN_ROLE removed from Timelock.");
    return;
  }

  // Otherwise propose a new tx
  console.log("\nProposing Mini tx: token.revokeRole(PARAMETER_ADMIN_ROLE, timelock) ...");
  let id;
  try {
    id = await mini1.propose.staticCall(TOKEN, 0, data);
  } catch {
    // Some multisigs don’t support staticCall for propose cleanly; fallback to reading txCount after.
    id = null;
  }

  const txP = await mini1.propose(TOKEN, 0, data);
  console.log("Propose tx hash:", txP.hash);
  await txP.wait();

  if (id === null) {
    // On your MiniMultisig, txCount() returns the latest id index
    const n = await mini1.txCount();
    id = n; // same pattern you used earlier where txCount was the “current id”
  }

  console.log("Mini tx id:", id.toString());

  const owner2 = await w2.getAddress();
  const approved2 = await mini1.isApproved(id, owner2).catch(() => false);
  if (!approved2) {
    console.log("Approving with owner2...");
    const txA = await mini2.approve(id);
    console.log("Approve tx hash:", txA.hash);
    await txA.wait();
    console.log("✓ Approved by owner2.");
  } else {
    console.log("Owner2 already approved.");
  }

  await sleep(500);
  const t = await mini1.getTx(id);
  console.log("\n[Mini tx]", {
    id: id.toString(),
    target: t[0],
    value: t[1].toString(),
    executed: t[2],
    approvals: t[3].toString(),
    dataLen: t[4].length,
  });

  console.log("\nExecuting via Mini (owner1)...");
  const txE = await mini1.execute(id);
  console.log("Execute tx hash:", txE.hash);
  const rc = await txE.wait();
  console.log("Execute status:", rc.status);

  const tlHasAfter = await tokenRO.hasRole(PARAM_ROLE, TL);
  console.log("\nTimelock has PARAMETER_ADMIN_ROLE (after):", tlHasAfter);
  if (tlHasAfter) throw new Error("Role still present after execute; inspect tx.");
  console.log("✅ SUCCESS. PARAMETER_ADMIN_ROLE removed from Timelock.");
}

main().catch((e) => {
  console.error("❌ revoke_param_admin_from_timelock.viaMini failed:", e?.reason || e?.shortMessage || e?.message || e);
  process.exit(1);
});
