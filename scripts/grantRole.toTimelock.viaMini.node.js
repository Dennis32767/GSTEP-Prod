// scripts/grantRole.toTimelock.viaMini.node.js
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

const TOKEN_ABI = [
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role, address who) view returns (bool)",
  "function grantRole(bytes32 role, address who)"
];

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
  const miniC1  = new ethers.Contract(MINI, MINI_ABI, w1);
  const miniC2  = miniC1.connect(w2);

  const DAR = await tokenRO.DEFAULT_ADMIN_ROLE();

  const miniHasDAR = await tokenRO.hasRole(DAR, MINI);
  if (!miniHasDAR) throw new Error("MiniMultisig does NOT have DEFAULT_ADMIN_ROLE on token");

  const tlHas = await tokenRO.hasRole(DAR, TL);
  console.log("Timelock has DEFAULT_ADMIN_ROLE:", tlHas);
  if (tlHas) {
    console.log("No action needed.");
    return;
  }

  const iface = new ethers.Interface(TOKEN_ABI);
  const data = iface.encodeFunctionData("grantRole", [DAR, TL]);

  console.log("Proposing Mini tx: token.grantRole(DAR, timelock)...");
  const txP = await miniC1.propose(TOKEN, 0, data);
  await txP.wait();

  const id = await miniC1.txCount();
  console.log("Mini tx id:", id.toString());

  const owner2 = await w2.getAddress();
  const approved2 = await miniC1.isApproved(id, owner2).catch(() => false);
  if (!approved2) {
    const txA = await miniC2.approve(id);
    await txA.wait();
    console.log("Approved by owner2.");
  } else {
    console.log("Owner2 already approved.");
  }

  await sleep(500);

  const t = await miniC1.getTx(id);
  console.log("Tx state:", { target: t.target, approvals: t.approvals, executed: t.executed });

  const txE = await miniC1.execute(id);
  const rc = await txE.wait();
  console.log("Executed. tx:", txE.hash, "status:", rc.status);

  const nowHas = await tokenRO.hasRole(DAR, TL);
  console.log("Timelock has DEFAULT_ADMIN_ROLE now:", nowHas);
  if (!nowHas) throw new Error("Grant did not apply. Check token/proxy + mini tx.");
  console.log("SUCCESS: Timelock granted DEFAULT_ADMIN_ROLE via Mini.");
}

main().catch((e) => {
  console.error("grantRole.toTimelock.viaMini.node failed:", e?.reason || e?.shortMessage || e?.message || e);
  process.exit(1);
});
