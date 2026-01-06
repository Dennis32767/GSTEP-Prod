// scripts/grant_param_admin_to_l2_timelock.js
/* eslint-disable no-console */
require("dotenv").config();
const { ethers } = require("ethers");

const TOKEN_ABI = [
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "function getRoleIds() view returns (bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function grantRole(bytes32 role, address account)"
];

const isAddr = (a)=>/^0x[a-fA-F0-9]{40}$/.test((a||"").trim());

async function main() {
  const L2_RPC   = (process.env.ARBITRUM_SEPOLIA_RPC_URL || "").trim();
  const L2TOK    = (process.env.L2_TOKEN_PROXY || "").trim();
  const TL       = (process.env.ARB_SEPOLIA_TIMELOCK || "").trim();
  const ADMIN_PK = (process.env.MS_EOA1_PK || "").trim(); // MULTISIG_EOA_1 private key

  if (!/^https?:\/\//.test(L2_RPC))  throw new Error("ARBITRUM_SEPOLIA_RPC_URL missing/invalid");
  if (!isAddr(L2TOK))               throw new Error("L2_TOKEN_PROXY missing/invalid");
  if (!isAddr(TL))                  throw new Error("ARB_SEPOLIA_TIMELOCK missing/invalid");
  if (!/^0x[0-9a-fA-F]{64}$/.test(ADMIN_PK)) {
    throw new Error("MS_EOA1_PK missing/invalid – must be MULTISIG_EOA_1 private key (0x + 64 hex)");
  }

  const l2    = new ethers.JsonRpcProvider(L2_RPC);
  const admin = new ethers.Wallet(ADMIN_PK, l2);
  const token = new ethers.Contract(L2TOK, TOKEN_ABI, admin);

  console.log("=== GRANT PARAMETER_ADMIN_ROLE TO L2 TIMELOCK (REAL ROLE HASH) ===");
  console.log("Network     : arbitrumSepolia");
  console.log("Token       :", L2TOK);
  console.log("Timelock    :", TL);
  console.log("Admin signer:", await admin.getAddress());

  const DEFAULT_ADMIN_ROLE = await token.DEFAULT_ADMIN_ROLE();
  const roleIds = await token.getRoleIds(); // [PAUSER, MINTER, SIGNER, PARAMETER_ADMIN, EMERGENCY_ADMIN, UPGRADER, API_SIGNER]
  const PARAMETER_ADMIN_ROLE = roleIds[3];

  const hasDefault = await token.hasRole(DEFAULT_ADMIN_ROLE, admin.address);
  const hasParam   = await token.hasRole(PARAMETER_ADMIN_ROLE, admin.address);

  console.log("\n[Role check]");
  console.log("DEFAULT_ADMIN_ROLE           :", DEFAULT_ADMIN_ROLE);
  console.log("PARAMETER_ADMIN_ROLE (real)  :", PARAMETER_ADMIN_ROLE);
  console.log("Signer has DEFAULT_ADMIN_ROLE:", hasDefault);
  console.log("Signer has PARAMETER_ADMIN?  :", hasParam);

  if (!hasDefault) {
    throw new Error("Signer does NOT have DEFAULT_ADMIN_ROLE. MS_EOA1_PK must be MULTISIG_EOA_1 (adminPrimary).");
  }

  const tlHasParamBefore = await token.hasRole(PARAMETER_ADMIN_ROLE, TL);
  console.log("Timelock has PARAMETER_ADMIN_ROLE (before):", tlHasParamBefore);
  if (tlHasParamBefore) {
    console.log("ℹ️ Already granted; nothing to do.");
    return;
  }

  console.log(`\n→ Granting REAL PARAMETER_ADMIN_ROLE to Timelock ${TL}…`);
  const tx = await token.grantRole(PARAMETER_ADMIN_ROLE, TL);
  console.log("Grant tx:", tx.hash);
  const rc = await tx.wait();
  console.log("✓ Included in block:", rc.blockNumber);

  const tlHasParamAfter = await token.hasRole(PARAMETER_ADMIN_ROLE, TL);
  console.log("Timelock has PARAMETER_ADMIN_ROLE (after):", tlHasParamAfter);

  if (tlHasParamAfter) {
    console.log("✅ Success. Re-run: node scripts/configure_sources_via_l2_timelock.js");
  } else {
    console.log("⚠️ Role not visible yet; inspect the tx.");
  }
}

main().catch((e) => {
  console.error("❌ grant_param_admin_to_l2_timelock (real hash) failed:", e);
  process.exit(1);
});
