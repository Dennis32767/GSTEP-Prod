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

// Minimal token ABI: role checks + configureSource
const TOKEN_ABI = [
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function DEFAULT_ADMIN_ROLE() pure returns (bytes32)",
  "function configureSource(string source, bool requiresProof, bool requiresAttestation) external"
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAddr = (a) => /^0x[a-fA-F0-9]{40}$/.test((a || "").trim());

async function ethCallFrom(provider, from, to, data) {
  try {
    const res = await provider.call({ from, to, data });
    return { ok: true, returndata: res };
  } catch (e) {
    const msg = e?.shortMessage || e?.message || "call reverted";
    return { ok: false, error: msg, raw: e };
  }
}

// Your canonical source config list
const SOURCES = [
  ["basicapp",        false, false], // simple mobile app
  ["mobileapp",       false, false], // alt basic source
  ["googlefit",       false, false],
  ["fitbit",          false, false],
  ["applehealth",     false, false],
  ["corporatetracker",false, false],
  ["medicaldevice",   false, true],  // high-security device, needs attestation
  ["wearablepremium", false, true],
  ["fitnessplatform", true,  false], // batch platform, proof only
  ["enterprise",      true,  false],
  ["premiumtracker",  true,  true],  // max security: proof + attestation
];

async function main() {
  const L2_RPC = (process.env.ARBITRUM_SEPOLIA_RPC_URL || "").trim();
  const TL     = (process.env.ARB_SEPOLIA_TIMELOCK || "").trim();
  const MINI   = (process.env.MINI_MULTISIG || "").trim();
  const L2TOK  = (process.env.L2_TOKEN_PROXY || "").trim();
  const PK1    = (process.env.MS_EOA1_PK || "").trim();
  const PK2    = (process.env.MS_EOA2_PK || "").trim();

  if (!/^https?:\/\//.test(L2_RPC)) throw new Error("ARBITRUM_SEPOLIA_RPC_URL missing");
  if (![TL, MINI, L2TOK].every(isAddr)) throw new Error("One of TL/MINI/L2_TOKEN_PROXY invalid");
  if (!/^0x[0-9a-fA-F]{64}$/.test(PK1) || !/^0x[0-9a-fA-F]{64}$/.test(PK2)) {
    throw new Error("MS_EOA1_PK / MS_EOA2_PK missing/invalid");
  }

  const l2 = new ethers.JsonRpcProvider(L2_RPC);
  const w1 = new ethers.Wallet(PK1, l2); // owner 1
  const w2 = new ethers.Wallet(PK2, l2); // owner 2

  const tl   = new ethers.Contract(TL, TL_ABI, w1);
  const mini = new ethers.Contract(MINI, MINI_ABI, w1);
  const tok  = new ethers.Contract(L2TOK, TOKEN_ABI, w1);

  console.log("=== CONFIGURE GEMSTEP SOURCES VIA L2 TIMELOCK ===");
  console.log("Network   : arbitrumSepolia");
  console.log("Timelock  :", TL);
  console.log("Mini      :", MINI);
  console.log("L2 token  :", L2TOK);
  console.log("Owner1    :", await w1.getAddress());
  console.log("Owner2    :", await w2.getAddress());

  // --- Timelock role checks ---
  const PROPOSER_ROLE = await tl.PROPOSER_ROLE();
  const EXECUTOR_ROLE = await tl.EXECUTOR_ROLE();
  const proposerIsMini = await tl.hasRole(PROPOSER_ROLE, MINI);
  const executorIsMini = await tl.hasRole(EXECUTOR_ROLE, MINI);
  const executorOpen   = await tl.hasRole(EXECUTOR_ROLE, ethers.ZeroAddress);
  const minDelay       = await tl.getMinDelay();

  console.log("\n[Timelock roles]");
  console.log("proposer(mini):", proposerIsMini);
  console.log("executor(mini):", executorIsMini);
  console.log("executor(open):", executorOpen);
  console.log("minDelay     :", minDelay.toString(), "seconds");

  if (!proposerIsMini) {
    throw new Error("MiniMultisig is NOT a PROPOSER on Timelock. Grant PROPOSER_ROLE first.");
  }

  // --- Token role check: does TL have PARAMETER_ADMIN_ROLE? ---
  const PARAM_ROLE = ethers.id("PARAMETER_ADMIN_ROLE");
  const DEFAULT_ADMIN_ROLE = await tok.DEFAULT_ADMIN_ROLE();
  const tlIsParamAdmin = await tok.hasRole(PARAM_ROLE, TL);
  const tlIsDefaultAdmin = await tok.hasRole(DEFAULT_ADMIN_ROLE, TL);

  console.log("\n[Token roles]");
  console.log("PARAMETER_ADMIN_ROLE        :", PARAM_ROLE);
  console.log("TL has PARAMETER_ADMIN_ROLE :", tlIsParamAdmin);
  console.log("TL has DEFAULT_ADMIN_ROLE   :", tlIsDefaultAdmin);

  if (!tlIsParamAdmin) {
    throw new Error(
      "Timelock does NOT have PARAMETER_ADMIN_ROLE on the L2 token. " +
      "Grant PARAMETER_ADMIN_ROLE(TL) from your deployment/admin path first."
    );
  }

  const tokIface = new ethers.Interface(TOKEN_ABI);

  // === MAIN LOOP: one Timelock op per source ===
  for (const [source, requiresProof, requiresAtt] of SOURCES) {
    console.log("\n--------------------------------------------------");
    console.log(`Configuring source: "${source}" (proof=${requiresProof}, att=${requiresAtt})`);

    // Build call data: token.configureSource(source, requiresProof, requiresAtt)
    const data = tokIface.encodeFunctionData("configureSource", [
      source,
      requiresProof,
      requiresAtt,
    ]);

    const predecessor = ethers.ZeroHash;
    const value = 0n;
    const salt = ethers.keccak256(
      ethers.toUtf8Bytes(`CONFIG_SOURCE:${source.toLowerCase()}`)
    );

    const opId = await tl.hashOperation(L2TOK, value, data, predecessor, salt);
    console.log("operationId:", opId);
    console.log("salt       :", salt);

    // ---- Dry-run: simulate call as Timelock ----
    console.log("\n[Dryrun] eth_call from TL to token.configureSource…");
    const dry = await ethCallFrom(l2, TL, L2TOK, data);
    if (!dry.ok) {
      console.error("Dryrun REVERTED. Reason:", dry.error);
      console.error("⚠️  Skipping this source; fix roles / preconditions then retry.");
      continue;
    } else {
      console.log("Dryrun OK – call would succeed when executed by TL.");
    }

    // ---- SCHEDULE via Mini ----
    const already = await tl.isOperation(opId);
    if (!already) {
      console.log("\n[Schedule] via MiniMultisig");

      const schedCalldata = tl.interface.encodeFunctionData("schedule", [
        L2TOK,
        value,
        data,
        predecessor,
        salt,
        minDelay,
      ]);

      console.log("Proposing schedule() from owner1…");
      const tx1 = await mini.propose(TL, 0, schedCalldata);
      console.log("  tx hash:", tx1.hash);
      await tx1.wait();

      const id = await mini.txCount();
      console.log("Mini tx id:", id.toString(), "- approving with owner2…");
      await mini.connect(w2).approve(id);
      await sleep(500);

      const t1 = await mini.getTx(id);
      console.log("Mini tx state → target:", t1.target, "approvals:", t1.approvals, "executed:", t1.executed);

      console.log("Executing schedule() via Mini (owner1)…");
      const ex1 = await mini.execute(id);
      console.log("  execute tx:", ex1.hash);
      await ex1.wait();
      console.log("✓ schedule() submitted via Mini.");
    } else {
      console.log("\nℹ️ Operation already exists on TL; skipping schedule.");
    }

    // ---- Wait until ready ----
    process.stdout.write("Waiting for operation to be ready");
    for (;;) {
      const ready = await tl.isOperationReady(opId);
      const done  = await tl.isOperationDone(opId);
      if (done) {
        console.log("\nℹ️ Operation already done; skipping execute.");
        break;
      }
      if (ready) {
        console.log("\nReady.");
        break;
      }
      process.stdout.write(".");
      await sleep(2000);
    }

    // ---- EXECUTE (open or via Mini) ----
    const execCalldata = tl.interface.encodeFunctionData("execute", [
      L2TOK,
      value,
      data,
      predecessor,
      salt,
    ]);

    if (await tl.isOperationDone(opId)) {
      console.log("ℹ️ Already executed; move to next source.");
      continue;
    }

    console.log("\n[Execute] configureSource via Timelock");
    try {
      if (executorOpen) {
        console.log("Executor is OPEN. Executing directly from owner1…");
        const tx = await tl.connect(w1).execute(L2TOK, value, data, predecessor, salt);
        console.log("  tx hash:", tx.hash);
        await tx.wait();
        console.log("✓ execute() done (direct EOA).");
      } else if (executorIsMini) {
        console.log("Executor is MINI. Executing via Mini…");

        const tx2 = await mini.propose(TL, 0, execCalldata);
        console.log("  propose tx:", tx2.hash);
        await tx2.wait();
        const id2 = await mini.txCount();

        await mini.connect(w2).approve(id2);
        await sleep(500);
        const t2 = await mini.getTx(id2);
        console.log(
          "Mini exec tx → target:",
          t2.target,
          "approvals:",
          t2.approvals,
          "executed:",
          t2.executed
        );

        console.log("[Precheck] eth_call TL.execute from MINI (should succeed)...");
        const pre = await ethCallFrom(l2, MINI, TL, execCalldata);
        if (!pre.ok) {
          console.error("Precheck REVERTED (from MINI). Reason:", pre.error);
          throw new Error("Precheck failed; TL.execute would revert. Aborting before Mini.execute.");
        }

        const ex2 = await mini.execute(id2);
        console.log("  mini.execute tx:", ex2.hash);
        await ex2.wait();
        console.log("✓ execute() done via Mini.");
      } else {
        throw new Error(
          "No permission to execute: Timelock EXECUTOR_ROLE is neither OPEN nor granted to Mini."
        );
      }
    } catch (e) {
      console.error("❌ execute flow failed:", e?.reason || e?.shortMessage || e?.message || e);
      const isOp    = await tl.isOperation(opId).catch(() => false);
      const isReady = await tl.isOperationReady(opId).catch(() => false);
      const isDone  = await tl.isOperationDone(opId).catch(() => false);
      console.log("State: isOp=", isOp, "isReady=", isReady, "isDone=", isDone);
      throw e;
    }

    console.log(`✅ configureSource("${source}", ${requiresProof}, ${requiresAtt}) applied via TL.`);
  }

  console.log("\n🎉 All source configuration operations processed.");
}

main().catch((e) => {
  console.error("❌ configure_sources_via_l2_timelock failed:", e);
  process.exit(1);
});
