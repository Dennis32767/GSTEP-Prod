// scripts/grantRole.toTimelock.js
/* eslint-disable no-console */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;

/**
 * Usage:
 *   node scripts/grantRole.toTimelock.js --file deployments/arbitrumSepolia-latest.json
 *   [optional overrides]
 *     --token 0x...            # L2 token proxy address
 *     --timelock 0x...         # L2 timelock address
 *
 * Requires:
 *   MS_EOA1_PK = 0x<64-hex>    # EOA that currently holds DEFAULT_ADMIN_ROLE on the token
 *
 * This script grants DEFAULT_ADMIN_ROLE (0x00) to the Timelock so the TL can call setL1Governance().
 * You can revoke afterwards for least privilege.
 */

function parseArgs(argv) {
  const out = { file: null, token: null, timelock: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file" || a === "-f") out.file = argv[++i];
    else if (a === "--token") out.token = (argv[++i] || "").trim();
    else if (a === "--timelock") out.timelock = (argv[++i] || "").trim();
  }
  if (!out.file) throw new Error("Missing --file <deployment-json>");
  return out;
}

function isAddr(x) { return /^0x[a-fA-F0-9]{40}$/.test(x || ""); }

async function main() {
  const { file, token, timelock } = parseArgs(process.argv);
  const j = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), file), "utf8"));

  // Pull from JSON unless overridden
  const TOKEN = (token || j.contracts?.tokenProxy || j.contracts?.token || j.contracts?.proxy || "").trim();
  const TL    = (timelock || j.contracts?.timelock || "").trim();

  if (!isAddr(TOKEN))    throw new Error("Missing/invalid token proxy address (override with --token)");
  if (!isAddr(TL))       throw new Error("Missing/invalid timelock address (override with --timelock)");

  const pk = (process.env.MS_EOA1_PK || "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error("MS_EOA1_PK missing/invalid (need 0x + 64 hex).");

  const signer = new ethers.Wallet(pk, ethers.provider);

  // Minimal ABI: AccessControl bits we need
  const TOKEN_ABI = [
    "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
    "function hasRole(bytes32,address) view returns (bool)",
    "function grantRole(bytes32,address)",
  ];

  const tokenC = new ethers.Contract(TOKEN, TOKEN_ABI, signer);
  const DAR    = await tokenC.DEFAULT_ADMIN_ROLE();

  // Verify signer can actually grant (has DEFAULT_ADMIN_ROLE)
  const signerAddr = await signer.getAddress();
  const signerHasDAR = await tokenC.hasRole(DAR, signerAddr);
  if (!signerHasDAR) {
    throw new Error(`Signer ${signerAddr} does NOT have DEFAULT_ADMIN_ROLE on ${TOKEN}. Use the correct admin EOA.`);
  }

  // If TL already has it, exit cleanly
  const tlHas = await tokenC.hasRole(DAR, TL);
  console.log(`Timelock has DEFAULT_ADMIN_ROLE: ${tlHas} - grantRole.toTimelock.js:72`);
  if (tlHas) {
    console.log("✅ No action needed. - grantRole.toTimelock.js:74");
    return;
  }

  console.log(`🔐 Granting DEFAULT_ADMIN_ROLE to Timelock ${TL} on token ${TOKEN} ... - grantRole.toTimelock.js:78`);
  const tx = await tokenC.grantRole(DAR, TL, { gasLimit: 200_000 });
  const rc = await tx.wait();
  console.log("✅ Granted. tx: - grantRole.toTimelock.js:81", tx.hash, "status:", rc.status);

  const nowHas = await tokenC.hasRole(DAR, TL);
  console.log("Timelock has DEFAULT_ADMIN_ROLE now: - grantRole.toTimelock.js:84", nowHas);
  if (!nowHas) throw new Error("Grant appears to have failed. Check the transaction on-chain.");
}

main().catch((e) => {
  console.error("❌ grantRole.toTimelock failed: - grantRole.toTimelock.js:89", e.reason || e.shortMessage || e.message || e);
  process.exit(1);
});
