/* eslint-disable no-console */
require("dotenv").config();
const { ethers } = require("ethers");

const TOKEN_ABI = [
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "function getRoleIds() view returns (bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function grantRole(bytes32 role, address account)"
];

const isAddr = (a) => /^0x[a-fA-F0-9]{40}$/.test((a || "").trim());

async function main() {
  const L2_RPC        = (process.env.ARBITRUM_SEPOLIA_RPC_URL || "").trim();
  const L2TOK         = (process.env.L2_TOKEN_PROXY || "").trim();
  const ADMIN_PK      = (process.env.MS_EOA1_PK || "").trim();   // must hold DEFAULT_ADMIN_ROLE
  const PROJECT_WALLET= (process.env.PROJECT_WALLET || "").trim(); // relayer / API signer EOA

  if (!/^https?:\/\//.test(L2_RPC))  throw new Error("ARBITRUM_SEPOLIA_RPC_URL missing/invalid");
  if (!isAddr(L2TOK))                throw new Error("L2_TOKEN_PROXY missing/invalid");
  if (!isAddr(PROJECT_WALLET))       throw new Error("PROJECT_WALLET missing/invalid");
  if (!/^0x[0-9a-fA-F]{64}$/.test(ADMIN_PK)) {
    throw new Error("MS_EOA1_PK missing/invalid – must be DEFAULT_ADMIN_ROLE holder (0x + 64 hex)");
  }

  const l2    = new ethers.JsonRpcProvider(L2_RPC);
  const admin = new ethers.Wallet(ADMIN_PK, l2);
  const token = new ethers.Contract(L2TOK, TOKEN_ABI, admin);

  console.log("=== GRANT API_SIGNER_ROLE TO PROJECT WALLET ===");
  console.log("Network        : arbitrumSepolia");
  console.log("Token          :", L2TOK);
  console.log("Admin signer   :", await admin.getAddress());
  console.log("Project wallet :", PROJECT_WALLET);

  // Pull canonical role ids from contract (same pattern as your TL script)
  const DEFAULT_ADMIN_ROLE = await token.DEFAULT_ADMIN_ROLE();
  const roleIds = await token.getRoleIds();
  // comment from earlier: [PAUSER, MINTER, SIGNER, PARAMETER_ADMIN, EMERGENCY_ADMIN, UPGRADER, API_SIGNER]
  const API_SIGNER_ROLE = roleIds[6];

  const hasDefault = await token.hasRole(DEFAULT_ADMIN_ROLE, admin.address);
  const hasApiRole = await token.hasRole(API_SIGNER_ROLE, admin.address);

  console.log("\n[Role check]");
  console.log("DEFAULT_ADMIN_ROLE          :", DEFAULT_ADMIN_ROLE);
  console.log("API_SIGNER_ROLE (real hash) :", API_SIGNER_ROLE);
  console.log("Signer has DEFAULT_ADMIN?   :", hasDefault);
  console.log("Signer has API_SIGNER?      :", hasApiRole);

  if (!hasDefault) {
    throw new Error(
      "Signer does NOT have DEFAULT_ADMIN_ROLE. " +
      "MS_EOA1_PK must be your initial admin / multisig owner that controls roles."
    );
  }

  const projHasApiBefore = await token.hasRole(API_SIGNER_ROLE, PROJECT_WALLET);
  console.log("Project wallet has API_SIGNER_ROLE (before):", projHasApiBefore);
  if (projHasApiBefore) {
    console.log("ℹ️ Already granted; nothing to do.");
    return;
  }

  console.log(`\n→ Granting API_SIGNER_ROLE to PROJECT_WALLET ${PROJECT_WALLET}…`);
  const tx = await token.grantRole(API_SIGNER_ROLE, PROJECT_WALLET);
  console.log("Grant tx:", tx.hash);
  const rc = await tx.wait();
  console.log("✓ Included in block:", rc.blockNumber);

  const projHasApiAfter = await token.hasRole(API_SIGNER_ROLE, PROJECT_WALLET);
  console.log("Project wallet has API_SIGNER_ROLE (after):", projHasApiAfter);

  if (projHasApiAfter) {
    console.log("✅ Success. PROJECT_WALLET is now a valid API_SIGNER.");
  } else {
    console.log("⚠️ Role not visible yet; inspect the tx.");
  }
}

main().catch((e) => {
  console.error("❌ grant_api_signer_to_project_wallet failed:", e);
  process.exit(1);
});
