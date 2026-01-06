/* eslint-disable no-console */
require("dotenv").config();
const { ethers } = require("ethers");

function isAddr(a){ return /^0x[a-fA-F0-9]{40}$/.test((a||"").trim()); }
function toAddrFromSlot(hex32){
  // last 20 bytes
  return ethers.getAddress("0x" + hex32.slice(26));
}

async function main() {
  const RPC   = (process.env.ARBITRUM_SEPOLIA_RPC_URL || "").trim();
  const PROXY = (process.env.PROXY_ADDRESS || "").trim();
  const PAENV = (process.env.PROXY_ADMIN_ADDRESS || "").trim();

  if (!/^https?:\/\//.test(RPC)) throw new Error("ARBITRUM_SEPOLIA_RPC_URL missing/invalid");
  if (!isAddr(PROXY)) throw new Error("PROXY_ADDRESS missing/invalid");
  if (PAENV && !isAddr(PAENV)) throw new Error("PROXY_ADMIN_ADDRESS invalid");

  const p = new ethers.JsonRpcProvider(RPC);

  // ERC1967 slots:
  // admin slot = bytes32(uint256(keccak256('eip1967.proxy.admin')) - 1)
  // impl  slot = bytes32(uint256(keccak256('eip1967.proxy.implementation')) - 1)
  const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
  const IMPL_SLOT  = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

  const adminRaw = await p.getStorage(PROXY, ADMIN_SLOT);
  const implRaw  = await p.getStorage(PROXY, IMPL_SLOT);

  const admin = toAddrFromSlot(adminRaw);
  const impl  = toAddrFromSlot(implRaw);

  console.log("Proxy          :", PROXY);
  console.log("ERC1967 admin  :", admin);
  console.log("ERC1967 impl   :", impl);

  if (PAENV) {
    console.log("Env ProxyAdmin :", ethers.getAddress(PAENV));
    console.log("Admin matches env?:", admin.toLowerCase() === PAENV.toLowerCase());
  } else {
    console.log("Env ProxyAdmin : (not set)");
  }
}

main().catch((e)=>{ console.error("❌ check_proxy_slots failed:", e?.shortMessage || e?.message || e); process.exit(1); });
