/* eslint-disable no-console */
require("dotenv").config();
const hre = require("hardhat");
const { ethers } = hre;
const { parseUnits } = ethers;

// ---------- helpers ----------
const isAddr = (a) => /^0x[a-fA-F0-9]{40}$/.test((a || "").trim());
const asWei = (v, unit = "wei") => {
  // Allow raw wei numbers (string) or e.g. "0.0001 ether", "1 gwei"
  if (!v) return null;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return BigInt(s); // raw wei string
  const [num, u] = s.split(/\s+/);
  return parseUnits(num, (u || unit).toLowerCase());
};

function chainInfo(chainId) {
  // Add more networks here if you’ll use them
  switch (Number(chainId)) {
    case 11155111: // Sepolia (Ethereum L1 testnet)
      return {
        name: "sepolia",
        // Arbitrum Sepolia L1 Delayed Inbox (from your history)
        defaultInbox: "0xaAe29B0366299461418F5324a79Afc425BE5ae21",
        isProd: false,
      };
    case 1: // Ethereum mainnet
      return {
        name: "mainnet",
        // Arbitrum One L1 Delayed Inbox
        defaultInbox: "0x4Dbd4fc535Ac27206064B68FfCf827b0A60BAB3f",
        isProd: true,
      };
    default:
      // Fallback for local/hardhat
      return {
        name: hre.network.name,
        defaultInbox: process.env.ARB_INBOX_FALLBACK || "0x0000000000000000000000000000000000000000",
        isProd: false,
      };
  }
}

function getGasConfig({ isProd }) {
  // Allow env overrides; otherwise use safe testnet defaults.
  // On mainnet (isProd), we REQUIRE explicit values to avoid surprises.
  const envSub = process.env.MAX_SUBMISSION_COST; // e.g. "0.0002 ether" or raw wei
  const envGas = process.env.L2_GAS_LIMIT;        // e.g. "1200000"
  const envFee = process.env.MAX_FEE_PER_GAS;     // e.g. "0.5 gwei" or raw wei

  if (isProd) {
    if (!envSub || !envGas || !envFee) {
      throw new Error(
        "On mainnet you must provide MAX_SUBMISSION_COST, L2_GAS_LIMIT, MAX_FEE_PER_GAS (e.g. MAX_SUBMISSION_COST='0.002 ether', L2_GAS_LIMIT=1500000, MAX_FEE_PER_GAS='0.2 gwei')."
      );
    }
  }

  const maxSubmissionCost =
    asWei(envSub, "wei") ?? asWei("0.0001 ether"); // testnet default
  const gasLimit =
    envGas ? BigInt(envGas) : 1_200_000n;          // testnet default
  const maxFeePerGas =
    asWei(envFee, "wei") ?? asWei("1 gwei");       // testnet default

  if (gasLimit <= 100_000n) {
    console.warn("⚠️  L2_GAS_LIMIT seems very low; typical values are 800k–2M depending on your call.");
  }
  return { maxSubmissionCost, gasLimit, maxFeePerGas };
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  const info = chainInfo(net.chainId);

  const OWNER    = (process.env.NEW_L1_OWNER || process.env.DEPLOYER_EOA || "").trim();
  const INBOX    = (process.env.ARB_INBOX_ADDR || process.env.ARB_SEPOLIA_INBOX_ADDR || info.defaultInbox).trim();
  const L2TARGET = (process.env.L2_TOKEN_PROXY || process.env.L2_EXECUTOR_ADDR || "").trim();
  const REFUNDL2 = (process.env.L2_REFUND_ADDR || "").trim();

  if (!isAddr(OWNER))    throw new Error("NEW_L1_OWNER/DEPLOYER_EOA not set/invalid");
  if (!isAddr(INBOX))    throw new Error("ARB_INBOX_ADDR/ARB_SEPOLIA_INBOX_ADDR not set/invalid");
  if (!isAddr(L2TARGET)) throw new Error("L2_TOKEN_PROXY or L2_EXECUTOR_ADDR not set/invalid");
  if (!isAddr(REFUNDL2)) throw new Error("L2_REFUND_ADDR not set/invalid");

  const gasCfg = getGasConfig(info);

  console.log("Network :", info.name, `(chainId=${net.chainId})`);
  console.log("Deployer:", deployer.address);
  console.log("Owner   :", OWNER);
  console.log("Inbox   :", INBOX);
  console.log("L2Target:", L2TARGET);
  console.log("RefundL2:", REFUNDL2);
  console.log("GasCfg  :",
    `maxSubmissionCost=${gasCfg.maxSubmissionCost.toString()} wei,`,
    `gasLimit=${gasCfg.gasLimit.toString()},`,
    `maxFeePerGas=${gasCfg.maxFeePerGas.toString()} wei`
  );

  const F = await ethers.getContractFactory("CrossChainGovernanceL1");

  // NOTE: constructor(
  //   address initialOwner,
  //   address inbox_,
  //   address l2Target_,
  //   address refundL2_,
  //   GasConfig memory cfg
  // )
  const c = await F.deploy(
    OWNER,
    INBOX,
    L2TARGET,
    REFUNDL2,
    {
      maxSubmissionCost: gasCfg.maxSubmissionCost,
      gasLimit:          gasCfg.gasLimit,
      maxFeePerGas:      gasCfg.maxFeePerGas,
    }
  );
  const rcpt = await c.deploymentTransaction().wait(1);
  if (rcpt.status !== 1) throw new Error("Deployment txn failed");

  const addr = await c.getAddress();
  console.log(`\n✅ Deployed CrossChainGovernanceL1 at: ${addr}`);
  console.log("➡️  Save this as L1_GOVERNANCE_ADDR in your .env");

  // Optional: verify on Etherscan if configured
  if (process.env.VERIFY === "1") {
    try {
      await hre.run("verify:verify", {
        address: addr,
        constructorArguments: [
          OWNER,
          INBOX,
          L2TARGET,
          REFUNDL2,
          {
            maxSubmissionCost: gasCfg.maxSubmissionCost,
            gasLimit:          gasCfg.gasLimit,
            maxFeePerGas:      gasCfg.maxFeePerGas,
          },
        ],
      });
      console.log("🔎 Verified on Etherscan.");
    } catch (e) {
      console.log("⚠️  Verify skipped/failed:", e.message || e);
    }
  }

  // Print a ready-to-use “quote” call for your scripts
  const iface = F.interface;
  const sampleData = iface.encodeFunctionData("sendPause()"); // any small payload for fee sanity
  console.log("\nℹ️  Example quote call (off-chain):");
  console.log(`   await l1Gov.quoteRetryable("${sampleData}", 0);`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
