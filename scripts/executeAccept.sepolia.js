// scripts/executeAccept.sepolia.js
// Usage examples:
//
// 1) Schedule only (recommended first):
//    node scripts/executeAccept.sepolia.js --file .\deployments\sepolia-latest.json --step schedule
//
// 2) Execute only (after delay has passed):
//    node scripts/executeAccept.sepolia.js --file deployments/sepolia-latest.json --step execute
//
// 3) End-to-end (schedule, then wait for ETA, then execute):
//    node scripts/executeAccept.sepolia.js --network sepolia --file deployments/sepolia-latest.json --step both --wait
//
// Signers (2-of-2 owners) via env (any of these names work):
//   MS_EOA1_PK / MULTISIG_EOA_1_PK
//   MS_EOA2_PK / MULTISIG_EOA_2_PK
//
// If not set (e.g. localhost), it will fall back to the first 2 local accounts.
//

/* eslint-disable no-console */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;
const chalk = require("chalk");

/**
 * ──────────────────────────────────────────────────────────────────────────────
 * 1) ABIs (keep all; the script auto-detects which your MiniMultisig exposes)
 * ──────────────────────────────────────────────────────────────────────────────
 */
const TL_ABI = [
  "function MIN_DELAY() view returns (uint256)",
  "function PROPOSER_ROLE() view returns (bytes32)",
  "function EXECUTOR_ROLE() view returns (bytes32)",
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function getMinDelay() view returns (uint256)",

  "function hashOperation(address target,uint256 value,bytes data,bytes32 predecessor,bytes32 salt) view returns (bytes32)",
  "function isOperation(bytes32 id) view returns (bool)",
  "function isOperationReady(bytes32 id) view returns (bool)",
  "function isOperationDone(bytes32 id) view returns (bool)",

  // schedule / execute signatures we'll feed via the multisig:
  "function schedule(address target,uint256 value,bytes data,bytes32 predecessor,bytes32 salt,uint256 delay)",
  "function execute(address target,uint256 value,bytes data,bytes32 predecessor,bytes32 salt)"
];

/** Common MiniMultisig 2-of-2 flavors we'll *try* in this order. */
const MINI_ABIS = [
  // Your contract's interface (add this as the first option)
  [
    "function owner1() view returns (address)",
    "function owner2() view returns (address)",
    "function txCount() view returns (uint256)",
    "function propose(address target, uint256 value, bytes data) returns (uint256 id)",
    "function approve(uint256 id)",
    "function execute(uint256 id) returns (bool ok, bytes memory ret)",
    "function getTx(uint256 id) view returns (address target, uint256 value, bool executed, uint8 approvals, bytes memory data)",
    "function isApproved(uint256 id, address owner) view returns (bool)"
  ],
  // A) EIP-712 style with value + nonce + two signatures
  [
    "function ownerA() view returns (address)",
    "function ownerB() view returns (address)",
    "function nonce() view returns (uint256)",
    "function DOMAIN_SEPARATOR() view returns (bytes32)",
    "function execute(address to,uint256 value,bytes data,uint256 nonce,bytes sigA,bytes sigB)"
  ],
  // B) EIP-712 style without value argument
  [
    "function ownerA() view returns (address)",
    "function ownerB() view returns (address)",
    "function nonce() view returns (uint256)",
    "function DOMAIN_SEPARATOR() view returns (bytes32)",
    "function execute(address to,bytes data,uint256 nonce,bytes sigA,bytes sigB)"
  ],
  // C) On-chain two-step (submit -> confirm -> exec)
  [
    "function ownerA() view returns (address)",
    "function ownerB() view returns (address)",
    "function submit(address to,uint256 value,bytes data) returns (uint256)",
    "function confirm(uint256 txId)",
    "function execute(uint256 txId)"
  ],
  // D) Owner-gated direct forward (msg.sender must be A or B)
  [
    "function ownerA() view returns (address)",
    "function ownerB() view returns (address)",
    "function forward(address to,uint256 value,bytes data)"
  ]
];

/**
 * ──────────────────────────────────────────────────────────────────────────────
 * 2) CLI parsing (PowerShell-friendly)
 * ──────────────────────────────────────────────────────────────────────────────
 */
function parseArgs(argv) {
  const args = { file: null, step: "schedule", wait: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file" || a === "-f") args.file = argv[++i];
    else if (a === "--step") args.step = (argv[++i] || "").toLowerCase(); // schedule|execute|both
    else if (a === "--wait") args.wait = true;
  }
  if (!args.file) {
    throw new Error("Missing --file <deployment-json>");
  }
  if (!["schedule", "execute", "both"].includes(args.step)) {
    throw new Error("--step must be schedule|execute|both");
  }
  return args;
}

/**
 * ──────────────────────────────────────────────────────────────────────────────
 * 3) Helpers
 * ──────────────────────────────────────────────────────────────────────────────
 */
const toHex = (v) => (typeof v === "string" && v.startsWith("0x") ? v : ethers.hexlify(v));

async function delay(ms) {
  await new Promise((res) => setTimeout(res, ms));
}

async function loadMiniContract(address) {
  for (const abi of MINI_ABIS) {
    const c = new ethers.Contract(address, abi, (await ethers.getSigners())[0] || (await ethers.provider.getSigner?.()));
    try {
      // Probe a function (owner1 first, then ownerA as fallback), if it exists call succeeds
      await c.owner1?.().catch(() => {});
      await c.ownerA?.().catch(() => {});
      return { contract: c, abi };
    } catch {
      // try next abi flavor
    }
  }
  // Last resort: bind the richest ABI so we can at least read owner1/owner2 if present
  return { contract: new ethers.Contract(address, MINI_ABIS[0], (await ethers.getSigners())[0]), abi: MINI_ABIS[0] };
}

function ownersFromEnv() {
  const pk1 = (process.env.MS_EOA1_PK || process.env.MULTISIG_EOA_1_PK || "").trim();
  const pk2 = (process.env.MS_EOA2_PK || process.env.MULTISIG_EOA_2_PK || "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk1) || !/^0x[0-9a-fA-F]{64}$/.test(pk2)) {
    throw new Error("Need at least two signers (set MS_EOA1_PK / MS_EOA2_PK as 0x + 64 hex).");
  }
  const w1 = new ethers.Wallet(pk1, ethers.provider);
  const w2 = new ethers.Wallet(pk2, ethers.provider);
  return { w1, w2 };
}

/** EIP-712 helpers (best guess for common MiniMultisig2of2 impls). */
function eip712Data_exec_withValue(miniAddr, chainId, to, value, data, nonce) {
  const domain = { name: "MiniMultisig2of2", version: "1", chainId, verifyingContract: miniAddr };
  const types = {
    Execute: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "nonce", type: "uint256" }
    ]
  };
  const message = { to, value, data, nonce };
  return { domain, types, message, primaryType: "Execute" };
}
function eip712Data_exec_noValue(miniAddr, chainId, to, data, nonce) {
  const domain = { name: "MiniMultisig2of2", version: "1", chainId, verifyingContract: miniAddr };
  const types = {
    Execute: [
      { name: "to", type: "address" },
      { name: "data", type: "bytes" },
      { name: "nonce", type: "uint256" }
    ]
  };
  const message = { to, data, nonce };
  return { domain, types, message, primaryType: "Execute" };
}

/**
 * ──────────────────────────────────────────────────────────────────────────────
 * 4) Main
 * ──────────────────────────────────────────────────────────────────────────────
 */
async function main() {
  const { file, step, wait } = parseArgs(process.argv);
  const network = hre.network.name;
  console.log(chalk.gray(`[ms-accept] network=${network} file=${file} step=${step}`));

  const fullPath = path.resolve(process.cwd(), file);
  const j = JSON.parse(fs.readFileSync(fullPath, "utf8"));

  const miniAddr = j.contracts?.miniMultisig || j.configuration?.proposers?.[0];
  const tlAddr = j.contracts?.timelock;
  const execAddr = j.contracts?.upgradeExecutor;
  const scheduleData = j.configuration?.tlScheduleCalldata;
  const executeData  = j.configuration?.tlExecuteCalldata;

  if (!miniAddr || !tlAddr || !execAddr || !scheduleData || !executeData) {
    throw new Error("Deployment JSON missing required fields (miniMultisig, timelock, upgradeExecutor, tl*Calldata).");
  }

  console.log("Using:");
  console.log("  - MiniMultisig :", miniAddr);
  console.log("  - Timelock     :", tlAddr);
  console.log("  - Exec Target  :", execAddr);
  console.log("  - JSON         :", fullPath);

  // Bind contracts
  const tl = new ethers.Contract(tlAddr, TL_ABI, (await ethers.getSigners())[0]);
  const { contract: mini, abi: pickedAbi } = await loadMiniContract(miniAddr);

  // Owners (on-chain vs .env)
  let on1, on2;
  try {
    on1 = await mini.owner1?.() || await mini.ownerA?.();
    on2 = await mini.owner2?.() || await mini.ownerB?.();
  } catch {}
  const { w1, w2 } = ownersFromEnv();
  console.log("Owners:");
  if (on1 && on2) {
    console.log("  - Owner 1:", on1);
    console.log("  - Owner 2:", on2);
  }
  console.log("  - Env EOA1:", await w1.getAddress());
  console.log("  - Env EOA2:", await w2.getAddress());

  if (on1 && (on1.toLowerCase() !== (await w1.getAddress()).toLowerCase()) && (on1.toLowerCase() !== (await w2.getAddress()).toLowerCase())) {
    console.log(chalk.yellow("⚠️  Env keys don't match on-chain owner1 — check MS_EOA*_PK values."));
  }
  if (on2 && (on2.toLowerCase() !== (await w1.getAddress()).toLowerCase()) && (on2.toLowerCase() !== (await w2.getAddress()).toLowerCase())) {
    console.log(chalk.yellow("⚠️  Env keys don't match on-chain owner2 — check MS_EOA*_PK values."));
  }

  // Timelock preflight
  const PROPOSER_ROLE = await tl.PROPOSER_ROLE();
  const EXECUTOR_ROLE = await tl.EXECUTOR_ROLE();
  const hasProp = await tl.hasRole(PROPOSER_ROLE, miniAddr);
  const hasExec = await tl.hasRole(EXECUTOR_ROLE, miniAddr);
  const minDelay = (await tl.getMinDelay?.()) ?? (await tl.MIN_DELAY?.());
  console.log(`Timelock: proposer(mini)=${hasProp} executor(mini)=${hasExec} minDelay=${minDelay}`);

  if (!hasProp) throw new Error("MiniMultisig is not a PROPOSER on Timelock.");
  if (!hasExec) console.log(chalk.yellow("⚠️  MiniMultisig is not an EXECUTOR (ok for schedule step)."));

  // Decode schedule params from JSON calldata (sanity & opId)
  const tlIface = new ethers.Interface(TL_ABI);
  const decodedSched = tlIface.decodeFunctionData("schedule", scheduleData);
  const [target, value, data, predecessor, salt, delay] = decodedSched;
  const opId = await tl.hashOperation(target, value, data, predecessor, salt);

  console.log("Operation:");
  console.log("  - target:", target);
  console.log("  - value :", value.toString());
  console.log("  - pred  :", predecessor);
  console.log("  - salt  :", salt);
  console.log("  - delay :", delay.toString());
  console.log("  - id    :", opId);
  console.log(`  - status: isOp=${await tl.isOperation(opId)} ready=${await tl.isOperationReady(opId)} done=${await tl.isOperationDone(opId)}`);

  if (step === "schedule" || step === "both") {
    if (await tl.isOperation(opId)) {
      console.log(chalk.yellow("ℹ️  Timelock indicates this operation is ALREADY scheduled. Skipping schedule."));
    } else {
      await tryMultisigCall({
        mini,
        pickedAbi,
        w1,
        w2,
        to: tlAddr,
        value: 0n,
        data: scheduleData
      });
      console.log(chalk.green("✓ schedule() submitted via MiniMultisig"));
    }
  }

  if (step === "both" && wait) {
    // crude wait loop until ready
    console.log(chalk.gray("⏳ Waiting until operation is ready..."));
    for (;;) {
      if (await tl.isOperationReady(opId)) break;
      process.stdout.write(".");
      await delay(10000);
    }
    console.log("\nReady.");
  }

  if (step === "execute" || step === "both") {
    if (await tl.isOperationDone(opId)) {
      console.log(chalk.yellow("ℹ️  Operation already executed. Skipping execute."));
    } else if (!(await tl.isOperationReady(opId))) {
      throw new Error("Operation not ready yet (minDelay not elapsed).");
    } else {
      await tryMultisigCall({
        mini,
        pickedAbi,
        w1,
        w2,
        to: tlAddr,
        value: 0n,
        data: executeData
      });
      console.log(chalk.green("✓ execute() submitted via MiniMultisig"));
    }
  }

  console.log(chalk.green("✔ Done."));
}

/**
 * Try calling the MiniMultisig using several common patterns.
 * Throws if all patterns fail.
 */
async function tryMultisigCall({ mini, pickedAbi, w1, w2, to, value, data }) {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const miniAddr = await mini.getAddress();

  // Helper to broadcast tx from owner-1 (cheapest path to avoid msg.sender restrictions)
  const miniA = mini.connect(w1);

  // Detect nonce (if present)
  let nonce = null;
  if (mini.nonce) {
    try { nonce = await mini.nonce(); } catch {}
  }
  if (nonce !== null) console.log("MiniMultisig nonce:", nonce.toString());

  // E) Your contract's propose/approve/execute pattern
  if (mini.interface.getFunction("propose(address,uint256,bytes)") &&
      mini.interface.getFunction("approve(uint256)") &&
      mini.interface.getFunction("execute(uint256)")) {
    console.log("→ Trying propose/approve/execute pattern");
    try {
      // First owner proposes (auto-approves)
      const tx1 = await miniA.propose(to, value, data, { gasLimit: 800_000 });
      const rc1 = await tx1.wait();
      
      // Extract txId from event logs
      let txId = 0;
      const iface = mini.interface;
      for (const log of rc1.logs || []) {
        try {
          const parsed = iface.parseLog(log);
          if (parsed?.name === "Proposed") {
            txId = parsed.args.id;
            break;
          }
        } catch {}
      }
      
      if (txId === 0) {
        // Fallback: use current txCount
        txId = await mini.txCount();
      }
      
      console.log("Proposed tx ID:", txId.toString());
      
      // Second owner approves
      await delay(2000); // brief delay
      const tx2 = await mini.connect(w2).approve(txId, { gasLimit: 300_000 });
      await tx2.wait();
      console.log("Second owner approved");
      
      // Execute (can be done by any owner)
      await delay(2000);
      const tx3 = await miniA.execute(txId, { gasLimit: 500_000 });
      await tx3.wait();
      console.log("Executed");
      return;
    } catch (e) {
      console.log(chalk.yellow("  ✗ failed (propose/approve/execute)"), e.reason || e.shortMessage || e.message);
    }
  }

  // A) execute(address,uint256,bytes,uint256,bytes,bytes) — EIP-712 two-sig
  if (mini.interface.getFunction("execute(address,uint256,bytes,uint256,bytes,bytes)") && nonce !== null) {
    console.log("→ Trying EIP-712 (with value) execute(...)");
    const { domain, types, message } = eip712Data_exec_withValue(miniAddr, chainId, to, value, data, nonce);
    const sigA = await w1.signTypedData(domain, types, message);
    const sigB = await w2.signTypedData(domain, types, message);
    try {
      const tx = await miniA.execute(to, value, data, nonce, sigA, sigB, { gasLimit: 800_000 });
      await tx.wait();
      return;
    } catch (e) {
      console.log(chalk.yellow("  ✗ failed (with value)"), e.reason || e.shortMessage || e.message);
    }
  }

  // B) execute(address,bytes,uint256,bytes,bytes) — EIP-712 two-sig (no value)
  if (mini.interface.getFunction("execute(address,bytes,uint256,bytes,bytes)") && nonce !== null) {
    console.log("→ Trying EIP-712 (no value) execute(...)");
    const { domain, types, message } = eip712Data_exec_noValue(miniAddr, chainId, to, data, nonce);
    const sigA = await w1.signTypedData(domain, types, message);
    const sigB = await w2.signTypedData(domain, types, message);
    try {
      const tx = await miniA.execute(to, data, nonce, sigA, sigB, { gasLimit: 800_000 });
      await tx.wait();
      return;
    } catch (e) {
      console.log(chalk.yellow("  ✗ failed (no value)"), e.reason || e.shortMessage || e.message);
    }
  }

  // C) On-chain two-step submit/confirm/execute
  if (mini.interface.getFunction("submit(address,uint256,bytes)") &&
      mini.interface.getFunction("confirm(uint256)") &&
      mini.interface.getFunction("execute(uint256)")) {
    console.log("→ Trying on-chain 2-step submit/confirm/execute");
    try {
      const tx1 = await miniA.submit(to, value, data, { gasLimit: 800_000 });
      const rc1 = await tx1.wait();
      // Assume event contains txId, or derive from a public var; fallback to reading a counter if present.
      const txId = rc1.logs?.length ? parseInt(rc1.logs[0].data) || 0 : 0;
      await (mini.connect(w2)).confirm(txId, { gasLimit: 300_000 });
      await miniA.execute(txId, { gasLimit: 500_000 });
      return;
    } catch (e) {
      console.log(chalk.yellow("  ✗ failed (2-step)"), e.reason || e.shortMessage || e.message);
    }
  }

  // D) Owner-gated forward(to,value,data) (msg.sender must be ownerA/ownerB)
  if (mini.interface.getFunction("forward(address,uint256,bytes)")) {
    console.log("→ Trying owner-gated forward(to,value,data)");
    try {
      const tx = await miniA.forward(to, value, data, { gasLimit: 800_000 });
      await tx.wait();
      return;
    } catch (e) {
      console.log(chalk.yellow("  ✗ failed (forward)"), e.reason || e.shortMessage || e.message);
    }
  }

  // If we got here, your MiniMultisig function shape is different.
  console.log(chalk.red("All multisig call strategies failed."));
  console.log("ABI we auto-picked:", pickedAbi.map((f) => (typeof f === "string" ? f : f.format())));
  console.log("Tips:");
  console.log(" - If your MiniMultisig uses a different method name/signature,");
  console.log("   add it near the top of this script in MINI_ABIS and re-run.");
  console.log(" - If it expects a different EIP-712 domain or struct, tweak eip712Data_* builders.");
  throw new Error("Multisig call failed. See tips above.");
}

main().catch((e) => {
  console.error("❌ ms-accept failed:", e.reason || e.shortMessage || e.message || e);
  process.exit(1);
});