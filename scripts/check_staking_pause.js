/* eslint-disable no-console */
require("dotenv").config();
const { ethers } = require("ethers");

/**
 * check_staking_pause.js
 *
 * Reads the latest StakingPauseSet(bool) event from the L2 token and prints current stakingPaused state.
 *
 * Usage:
 *   node scripts/check_staking_pause.js
 *   node scripts/check_staking_pause.js --from <blockNumber>     # optional start block
 *   node scripts/check_staking_pause.js --latest <N>             # scan last N blocks (default 50_000)
 *
 * Env:
 *   ARBITRUM_SEPOLIA_RPC_URL
 *   L2_TOKEN_PROXY
 *
 * Notes:
 * - This does NOT require a public getter for stakingPaused.
 * - It infers the latest state from the most recent StakingPauseSet event.
 */

function parseArgs(argv) {
  const out = { from: null, latest: 50000 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from") out.from = Number(argv[++i]);
    else if (a === "--latest") out.latest = Number(argv[++i]);
  }
  return out;
}

async function main() {
  const { from, latest } = parseArgs(process.argv);

  const L2_RPC = (process.env.ARBITRUM_SEPOLIA_RPC_URL || "").trim();
  const L2_TOK = (process.env.L2_TOKEN_PROXY || "").trim();

  if (!/^https?:\/\//.test(L2_RPC)) throw new Error("ARBITRUM_SEPOLIA_RPC_URL missing/invalid");
  if (!/^0x[a-fA-F0-9]{40}$/.test(L2_TOK)) throw new Error("L2_TOKEN_PROXY missing/invalid");

  const l2 = new ethers.JsonRpcProvider(L2_RPC);

  console.log("=== CHECK L2 STAKING PAUSE (event-derived) ===");
  console.log("L2 Token :", L2_TOK);

  // Minimal ABI: event + (optional) paused() for context
  const ABI = [
    "event StakingPauseSet(bool paused)",
    "function paused() view returns (bool)"
  ];
  const token = new ethers.Contract(L2_TOK, ABI, l2);

  // Determine scan range
  const tip = await l2.getBlockNumber();
  const fromBlock =
    Number.isFinite(from) && from !== null
      ? from
      : Math.max(0, tip - (Number.isFinite(latest) ? latest : 50000));

  console.log("Tip block :", tip);
  console.log("Scan from :", fromBlock);
  console.log("Scan to   :", tip);

  // Query logs for StakingPauseSet
  const filter = token.filters.StakingPauseSet();
  const logs = await token.queryFilter(filter, fromBlock, tip);

  if (!logs.length) {
    console.log("\n⚠️ No StakingPauseSet events found in scanned range.");
    console.log("   If this is a fresh deployment, try:");
    console.log(`   node scripts/check_staking_pause.js --latest ${Math.min(tip, 250000)}`);
    console.log("   Or pass an older explicit start block with --from <block>.");
    return;
  }

  const last = logs[logs.length - 1];
  const pausedStaking = last.args?.paused;

  // Also show full token pause state (OZ Pausable) if available
  const pausedToken = await token.paused().catch(() => null);

  console.log("\n✅ Latest StakingPauseSet found:");
  console.log("  stakingPaused :", pausedStaking);
  console.log("  token paused() :", pausedToken === null ? "(unavailable)" : pausedToken);
  console.log("  blockNumber   :", last.blockNumber);
  console.log("  txHash        :", last.transactionHash);

  // Print a few recent events for context
  const tail = logs.slice(Math.max(0, logs.length - 5));
  console.log("\nRecent StakingPauseSet events (last up to 5):");
  for (const e of tail) {
    console.log(
      `  - block ${e.blockNumber} | stakingPaused=${e.args?.paused} | tx=${e.transactionHash}`
    );
  }
}

main().catch((e) => {
  console.error("❌ failed:", e.reason || e.shortMessage || e.message || e);
  process.exit(1);
});
