/* eslint-disable no-console */
require("dotenv").config();
const hre = require("hardhat");
const { ethers } = hre;

(async () => {
  const L2_TOKEN = "0xF06c092d10BD0c8E6f6e05022Da69C0e03b67709";
  const L1_GOV   = "0x0cb65afE69d22B98e48B88617E92e1a41D1c05Fe";
  const PK       = (process.env.MS_EOA1_PK || process.env.L2_ADMIN_PK || "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(PK)) throw new Error("MS_EOA1_PK (L2 admin) missing/invalid");

  const MASK  = (1n<<160n)-1n;
  const OFF   = 0x1111000000000000000000000000000000001111n;
  const alias = ethers.getAddress("0x"+(((BigInt(L1_GOV)&MASK)+OFF)&MASK).toString(16).padStart(40,"0"));

  console.log("alias(L1_GOV): - grant-pauser-alias.js:16", alias);

  const token = await ethers.getContractAt([
    "function hasRole(bytes32,address) view returns (bool)",
    "function grantRole(bytes32,address)"
  ], L2_TOKEN);

  const admin = new ethers.Wallet(PK, ethers.provider);
  console.log("admin signer: - grant-pauser-alias.js:24", await admin.getAddress());

  const DEFAULT_ADMIN_ROLE = "0x" + "00".repeat(32);
  const PAUSER_ROLE_ID     = ethers.id("PAUSER_ROLE");

  const isAdmin = await token.hasRole(DEFAULT_ADMIN_ROLE, await admin.getAddress());
  if (!isAdmin) throw new Error("Signer is not DEFAULT_ADMIN_ROLE on token");

  const has = await token.hasRole(PAUSER_ROLE_ID, alias);
  console.log("has PAUSER (before): - grant-pauser-alias.js:33", has);
  if (!has) {
    const tx = await token.connect(admin).grantRole(PAUSER_ROLE_ID, alias);
    console.log("grant tx: - grant-pauser-alias.js:36", tx.hash);
    await tx.wait();
  }
  console.log("has PAUSER (after): - grant-pauser-alias.js:39", await token.hasRole(PAUSER_ROLE_ID, alias));
})().catch(e => { console.error(e); process.exit(1); });
