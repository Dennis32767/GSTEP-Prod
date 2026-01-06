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

// Minimal token ABI to check roles and read current governor
const TOKEN_ABI = [
  "function DEFAULT_ADMIN_ROLE() pure returns (bytes32)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function getL1Governance() view returns (address)",
  "function setL1Governance(address)"
];

const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const isAddr = (a)=>/^0x[a-fA-F0-9]{40}$/.test((a||"").trim());

async function ethCallFrom(provider, from, to, data) {
  try {
    const res = await provider.call({ from, to, data });
    return { ok: true, returndata: res };
  } catch (e) {
    // Try to surface revert reason if present
    const msg = e?.shortMessage || e?.message || "call reverted";
    return { ok: false, error: msg, raw: e };
  }
}

async function main() {
  const L2_RPC = (process.env.ARBITRUM_SEPOLIA_RPC_URL || "").trim();
  const TL     = (process.env.ARB_SEPOLIA_TIMELOCK || "").trim();
  const MINI   = (process.env.MINI_MULTISIG || "").trim();
  const L2TOK  = (process.env.L2_TOKEN_PROXY || "").trim();
  const L1GOV  = (process.env.L1_GOVERNANCE_ADDR || "").trim();
  const PK1    = (process.env.MS_EOA1_PK || "").trim();
  const PK2    = (process.env.MS_EOA2_PK || "").trim();

  if (!/^https?:\/\//.test(L2_RPC)) throw new Error("ARBITRUM_SEPOLIA_RPC_URL missing");
  if (![TL,MINI,L2TOK,L1GOV].every(isAddr)) throw new Error("One of TL/MINI/L2_TOKEN_PROXY/L1_GOVERNANCE_ADDR invalid");
  if (!/^0x[0-9a-fA-F]{64}$/.test(PK1) || !/^0x[0-9a-fA-F]{64}$/.test(PK2)) throw new Error("MS_EOA1_PK / MS_EOA2_PK missing");

  const l2 = new ethers.JsonRpcProvider(L2_RPC);
  const w1 = new ethers.Wallet(PK1, l2);
  const w2 = new ethers.Wallet(PK2, l2);

  const tl   = new ethers.Contract(TL, TL_ABI, w1);
  const mini = new ethers.Contract(MINI, MINI_ABI, w1);
  const tok  = new ethers.Contract(L2TOK, TOKEN_ABI, w1);

  console.log("Timelock:  TL - link_l2_set_governor.js:70", TL);
  console.log("Mini    :  MINI - link_l2_set_governor.js:71", MINI);
  console.log("L2 token:  TOK - link_l2_set_governor.js:72", L2TOK);
  console.log("New L1G :  L1G - link_l2_set_governor.js:73", L1GOV);

  // ---- Role checks on Timelock ----
  const PROPOSER_ROLE = await tl.PROPOSER_ROLE();
  const EXECUTOR_ROLE = await tl.EXECUTOR_ROLE();
  const proposerIsMini = await tl.hasRole(PROPOSER_ROLE, MINI);
  const executorIsMini = await tl.hasRole(EXECUTOR_ROLE, MINI);
  const executorOpen   = await tl.hasRole(EXECUTOR_ROLE, ethers.ZeroAddress);
  const minDelay       = await tl.getMinDelay();

  console.log("\n[Timelock roles] - link_l2_set_governor.js:83");
  console.log("proposer(mini): - link_l2_set_governor.js:84", proposerIsMini);
  console.log("executor(mini): - link_l2_set_governor.js:85", executorIsMini);
  console.log("executor(open): - link_l2_set_governor.js:86", executorOpen);
  console.log("minDelay      : - link_l2_set_governor.js:87", minDelay.toString());

  if (!proposerIsMini) {
    throw new Error("MiniMultisig is NOT a PROPOSER on Timelock. Grant PROPOSER_ROLE first.");
  }

  // ---- Role checks on TOKEN (this is what often bites!) ----
  const DEFAULT_ADMIN_ROLE = await tok.DEFAULT_ADMIN_ROLE();
  const tlIsAdminOnToken   = await tok.hasRole(DEFAULT_ADMIN_ROLE, TL);
  const currentGov         = await tok.getL1Governance().catch(()=>ethers.ZeroAddress);

  console.log("\n[Token roles & state] - link_l2_set_governor.js:98");
  console.log("TL has DEFAULT_ADMIN_ROLE on token: - link_l2_set_governor.js:99", tlIsAdminOnToken);
  console.log("getL1Governance() current         : - link_l2_set_governor.js:100", currentGov);

  if (!tlIsAdminOnToken) {
    throw new Error(
      "Timelock does NOT have DEFAULT_ADMIN_ROLE on the L2 token. " +
      "Grant the role to Timelock (or set Timelock as DEFAULT_ADMIN_ROLE) before executing."
    );
  }

  // ---- Build calldata and opId ----
  const gsIface = new ethers.Interface(TOKEN_ABI);
  const data = gsIface.encodeFunctionData("setL1Governance", [L1GOV]);
  const predecessor = ethers.ZeroHash;
  const value = 0n;
  const salt = ethers.keccak256(ethers.toUtf8Bytes(`SET_L1_GOV:${L2TOK.toLowerCase()}:${L1GOV.toLowerCase()}`));
  const opId = await tl.hashOperation(L2TOK, value, data, predecessor, salt);
  console.log("\noperationId: - link_l2_set_governor.js:116", opId);

  // ---- DRY-RUN: simulate the target call *as if from the Timelock* (pure eth_call) ----
  console.log("\n[Dryrun] eth_call from TL to token.setL1Governance… - link_l2_set_governor.js:119");
  const dry = await ethCallFrom(l2, TL, L2TOK, data);
  if (!dry.ok) {
    console.error("Dryrun REVERTED. Underlying reason (best effort): - link_l2_set_governor.js:122");
    console.error(dry.error);
    throw new Error(
      "Dry-run failed. The actual target call would revert during Timelock execution. " +
      "Fix roles / target preconditions before proceeding."
    );
  } else {
    console.log("Dryrun OK (call would succeed when executed by TL). - link_l2_set_governor.js:129");
  }

  // ---- SCHEDULE via Mini ----
  const isAlready = await tl.isOperation(opId);
  if (!isAlready) {
    console.log("\nScheduling via Mini… - link_l2_set_governor.js:135");
    const schedCalldata = tl.interface.encodeFunctionData("schedule", [
      L2TOK, value, data, predecessor, salt, minDelay
    ]);

    const tx1 = await mini.propose(TL, 0, schedCalldata);
    await tx1.wait();

    const id = await mini.txCount();
    await (mini.connect(w2)).approve(id);
    await sleep(500);

    const { target, approvals, executed } = await mini.getTx(id);
    console.log("mini.schedule tx => target: - link_l2_set_governor.js:148", target, "approvals:", approvals, "executed:", executed);

    const ex1 = await (mini.connect(w1)).execute(id);
    await ex1.wait();
    console.log("✓ schedule() submitted via Mini - link_l2_set_governor.js:152");
  } else {
    console.log("\nℹ️ Operation already scheduled; skipping schedule. - link_l2_set_governor.js:154");
  }

  // ---- Wait until ready ----
  process.stdout.write("Waiting ready - link_l2_set_governor.js:158");
  for (;;) {
    if (await tl.isOperationReady(opId)) break;
    process.stdout.write(". - link_l2_set_governor.js:161");
    await sleep(2000);
  }
  console.log("\nReady. - link_l2_set_governor.js:164");

  // ---- EXECUTE (open → direct; else via Mini) ----
  const execCalldata = tl.interface.encodeFunctionData("execute", [
    L2TOK, value, data, predecessor, salt
  ]);

  if (await tl.isOperationDone(opId)) {
    console.log("ℹ️ Already executed; skipping execute. - link_l2_set_governor.js:172");
  } else {
    try {
      if (executorOpen) {
        console.log("\nExecutor is OPEN. Executing directly from EOA1… - link_l2_set_governor.js:176");
        const tx = await tl.connect(w1).execute(L2TOK, value, data, predecessor, salt);
        await tx.wait();
        console.log("✓ execute() done (direct EOA) - link_l2_set_governor.js:179");
      } else if (executorIsMini) {
        console.log("\nExecutor is MINI. Executing via Mini… - link_l2_set_governor.js:181");
        const tx2 = await mini.propose(TL, 0, execCalldata);
        await tx2.wait();
        const id2 = await mini.txCount();

        await (mini.connect(w2)).approve(id2);
        await sleep(500);
        const t2 = await mini.getTx(id2);
        console.log("mini.execute tx => target: - link_l2_set_governor.js:189", t2.target, "approvals:", t2.approvals, "executed:", t2.executed);

        // EXTRA PRECHECK: simulate TL.execute *from MINI* (so msg.sender = MINI)
        console.log("[Precheck] eth_call TL.execute from MINI (should succeed)... - link_l2_set_governor.js:192");
        const pre = await ethCallFrom(l2, MINI, TL, execCalldata);
        if (!pre.ok) {
          console.error("Precheck REVERTED (from MINI). Reason: - link_l2_set_governor.js:195", pre.error);
          throw new Error("Precheck failed; TL.execute would revert. Aborting before Mini.execute.");
        }

        const ex2 = await (mini.connect(w1)).execute(id2);
        await ex2.wait();
        console.log("✓ execute() done via Mini - link_l2_set_governor.js:201");
      } else {
        throw new Error("No permission to execute: Timelock EXECUTOR_ROLE is neither OPEN nor granted to Mini.");
      }
    } catch (e) {
      console.error("❌ execute flow failed: - link_l2_set_governor.js:206", e?.reason || e?.shortMessage || e?.message || e);
      const isOp     = await tl.isOperation(opId).catch(()=>false);
      const isReady  = await tl.isOperationReady(opId).catch(()=>false);
      const isDone   = await tl.isOperationDone(opId).catch(()=>false);
      console.log("State: isOp= - link_l2_set_governor.js:210", isOp, "isReady=", isReady, "isDone=", isDone);
      throw e;
    }
  }

  // ---- Verify (best effort) ----
  try {
    const after = await tok.getL1Governance();
    console.log("\ngetL1Governance() after: - link_l2_set_governor.js:218", after);
    if (after.toLowerCase() === L1GOV.toLowerCase()) {
      console.log("✅ setL1Governance completed. - link_l2_set_governor.js:220");
    } else {
      console.log("⚠ Link may not have applied yet. Check tx. - link_l2_set_governor.js:222");
    }
  } catch {
    console.log("ℹ️ Could not read getL1Governance(); check ABI or proxy. - link_l2_set_governor.js:225");
  }
}

main().catch(e => {
  console.error("❌ link failed: - link_l2_set_governor.js:230", e);
  process.exit(1);
});
