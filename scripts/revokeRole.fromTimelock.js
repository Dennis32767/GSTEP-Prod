// scripts/revokeRole.fromTimelock.js
/* eslint-disable no-console */
require("dotenv").config();
const hre = require("hardhat");
const { ethers } = hre;

/**
 * .env required:
 *   L2_TOKEN_PROXY=0x...        # L2 token proxy
 *   L2_TIMELOCK=0x...     # L2 Timelock
 *   MS_EOA1_PK=0x<64-hex>   # EOA that currently has DEFAULT_ADMIN_ROLE
 *
 * Usage:
 *   npx hardhat run --network arbitrumSepolia scripts/revokeRole.fromTimelock.js
 */

function isAddr(x) {
  return /^0x[a-fA-F0-9]{40}$/.test(x || "");
}

async function main() {
  const TOKEN = (process.env.L2_TOKEN_PROXY || "").trim();
  const TL    = (process.env.L2_TIMELOCK || "").trim();
  const PK    = (process.env.MS_EOA1_PK || "").trim();

  if (!isAddr(TOKEN)) throw new Error("Missing/invalid L2_TOKEN_PROXY in .env");
  if (!isAddr(TL))    throw new Error("Missing/invalid L2_TIMELOCK in .env");
  if (!/^0x[0-9a-fA-F]{64}$/.test(PK)) {
    throw new Error("MS_EOA1_PK missing/invalid (need 0x + 64 hex)");
  }

  console.log("Network       : - revokeRole.fromTimelock.js:32", hre.network.name);
  console.log("Token (proxy) : - revokeRole.fromTimelock.js:33", TOKEN);
  console.log("Timelock      : - revokeRole.fromTimelock.js:34", TL);

  const signer = new ethers.Wallet(PK, ethers.provider);
  console.log("Signer        : - revokeRole.fromTimelock.js:37", await signer.getAddress());

  // Minimal AccessControl ABI
  const ABI = [
    "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
    "function hasRole(bytes32,address) view returns (bool)",
    "function revokeRole(bytes32,address)"
  ];

  const token = new ethers.Contract(TOKEN, ABI, signer);
  const DAR   = await token.DEFAULT_ADMIN_ROLE();

  // Sanity: signer must hold DAR to revoke from others
  const signerHasDAR = await token.hasRole(DAR, await signer.getAddress());
  console.log("Signer has DEFAULT_ADMIN_ROLE: - revokeRole.fromTimelock.js:51", signerHasDAR);
  if (!signerHasDAR) {
    throw new Error("Signer does not hold DEFAULT_ADMIN_ROLE on the token; cannot revoke.");
  }

  // If TL already lacks DAR, nothing to do
  const tlHasDAR = await token.hasRole(DAR, TL);
  console.log("Timelock has DEFAULT_ADMIN_ROLE: - revokeRole.fromTimelock.js:58", tlHasDAR);
  if (!tlHasDAR) {
    console.log("✅ Timelock already lacks DEFAULT_ADMIN_ROLE. Nothing to revoke. - revokeRole.fromTimelock.js:60");
    return;
  }

  console.log("🔐 Revoking DEFAULT_ADMIN_ROLE from Timelock… - revokeRole.fromTimelock.js:64");
  const tx = await token.revokeRole(DAR, TL, { gasLimit: 200_000 });
  console.log("tx: - revokeRole.fromTimelock.js:66", tx.hash);
  const rc = await tx.wait();
  console.log("status: - revokeRole.fromTimelock.js:68", rc.status);

  const after = await token.hasRole(DAR, TL);
  console.log("Timelock has DEFAULT_ADMIN_ROLE (post): - revokeRole.fromTimelock.js:71", after);

  if (!after) {
    console.log("✅ Revoked successfully. - revokeRole.fromTimelock.js:74");
  } else {
    throw new Error("Revoke did not take effect. Check the transaction on-chain.");
  }
}

main().catch((e) => {
  console.error("❌ revokeRole.fromTimelock failed: - revokeRole.fromTimelock.js:81", e.reason || e.shortMessage || e.message || e);
  process.exit(1);
});
