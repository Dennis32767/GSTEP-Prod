// scripts/grantRole.toProxyAdmin.js
/* eslint-disable no-console */
const { ethers } = require("hardhat");

const ZERO_ROLE = ethers.ZeroHash; // DEFAULT_ADMIN_ROLE

async function main() {
  const fs = require("fs");
  const path = require("path");

  // Load your latest deployment file (adjust if needed)
  const file = "deployments/localhost-deployment-1758811007214.json";
  const d = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));

  const tokenProxy   = d.contracts.tokenProxy || d.contracts.TokenProxy || d.contracts.token || d.contracts.proxy;
  const proxyAdmin   = d.contracts.proxyAdmin || d.contracts.ProxyAdmin;
  if (!tokenProxy || !proxyAdmin) throw new Error("Missing tokenProxy/proxyAdmin in deployment JSON");

  console.log("TokenProxy:", tokenProxy);
  console.log("ProxyAdmin:", proxyAdmin);

  const token = await ethers.getContractAt("GemStepToken", tokenProxy);

  // Who can grant? Try a few local signers and pick one that already has DEFAULT_ADMIN_ROLE
  const signers = await ethers.getSigners();
  let granter;
  for (const s of signers) {
    try {
      if (await token.hasRole(ZERO_ROLE, s.address)) { granter = s; break; }
    } catch {}
  }
  if (!granter) {
    // Fallback: if token is Ownable, try owner()
    try {
      const owner = await token.owner();
      granter = signers.find(s => s.address.toLowerCase() === owner.toLowerCase());
    } catch {}
  }
  if (!granter) throw new Error("No signer with DEFAULT_ADMIN_ROLE (or owner) found to grant role.");

  const already = await token.hasRole(ZERO_ROLE, proxyAdmin);
  if (already) {
    console.log("✅ ProxyAdmin already has DEFAULT_ADMIN_ROLE on the token.");
    return;
  }

  console.log(`Granting DEFAULT_ADMIN_ROLE to ProxyAdmin from ${granter.address} ...`);
  const tx = await token.connect(granter).grantRole(ZERO_ROLE, proxyAdmin);
  await tx.wait();
  console.log("✅ Granted. Tx:", tx.hash);
}

main().catch((e) => { console.error(e); process.exit(1); });
