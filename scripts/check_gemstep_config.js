/* eslint-disable no-console */
require("dotenv").config();
const { ethers } = require("ethers");

const TOKEN_ABI = [
  // Domain
  "function DOMAIN_NAME() view returns (string)",
  "function DOMAIN_VERSION() view returns (string)",

  // Core params
  "function getCoreParams() external view returns (uint256 burnFee, uint256 rewardRate, uint256 stepLimit, uint256 signatureValidityPeriod)",
  "function getStakeParams() external view returns (uint256 stakePerStep, uint256 lastAdjustTs, bool locked)",
  "function getStakeConstants() external pure returns (uint256 minStakePerStep, uint256 maxStakePerStep, uint256 adjustCooldown)",

  // Sources / views
  "function isSourceValid(string source) external view returns (bool)",
  "function getSourceConfig(string source) external view returns (bool requiresProof, bool requiresAttestation, bytes32 merkleRoot, uint256 maxStepsPerDay, uint256 minInterval)",
  "function getUserSourceStats(address user, string source) external view returns (uint256 lastTs, uint256 dailyTotal, uint256 dayIndex)",
  "function getUserCoreStatus(address user) external view returns (uint256 stepAverageScaled, uint256 flaggedCount, uint256 suspendedUntilTs, uint256 stakedTokens, bool apiTrusted, uint256 firstSubmissionTs)",

  // Versions
  "function getPayloadVersionInfo(bytes32 v) external view returns (bool supported, uint256 deprecatesAt)"
];

// Canonical list of sources you care about
const SOURCES = [
  "fitbit",
  "googlefit",
  "applehealth",
  "basicapp",
  "mobileapp",
  "corporatetracker",
  "medicaldevice",
  "wearablepremium",
  "fitnessplatform",
  "enterprise",
  "premiumtracker",
  "direct"
];

const isAddr = (a) => /^0x[a-fA-F0-9]{40}$/.test((a || "").trim());

function fmtTs(ts) {
  const n = Number(ts);
  if (!n) return "0 (never)";
  return `${n} (${new Date(n * 1000).toISOString()})`;
}

function fmtTokens(wei) {
  try {
    return `${ethers.formatEther(wei)} ETH (${wei.toString()} wei)`;
  } catch {
    return wei.toString();
  }
}

async function main() {
  const RPC = (process.env.ARBITRUM_SEPOLIA_RPC_URL || process.env.L2_RPC_URL || "").trim();
  const TOKEN = (process.env.L2_TOKEN_PROXY || "").trim();
  const CHECK_USER = (process.env.CHECK_USER || "").trim();   // optional
  const CHECK_API  = (process.env.CHECK_API  || "").trim();   // optional

  if (!/^https?:\/\//.test(RPC)) {
    throw new Error("ARBITRUM_SEPOLIA_RPC_URL or L2_RPC_URL missing/invalid");
  }
  if (!isAddr(TOKEN)) {
    throw new Error("L2_TOKEN_PROXY missing/invalid");
  }
  if (CHECK_USER && !isAddr(CHECK_USER)) {
    throw new Error("CHECK_USER is not a valid address");
  }
  if (CHECK_API && !isAddr(CHECK_API)) {
    throw new Error("CHECK_API is not a valid address");
  }

  const provider = new ethers.JsonRpcProvider(RPC);
  const token = new ethers.Contract(TOKEN, TOKEN_ABI, provider);

  console.log("=== GEMSTEP CONFIG CHECK ===");
  const net = await provider.getNetwork();
  console.log("Network :", net.name, `(${net.chainId})`);
  console.log("Token   :", TOKEN);
  console.log("");

  // ---- Domain ----
  const [dName, dVer] = await Promise.all([
    token.DOMAIN_NAME(),
    token.DOMAIN_VERSION()
  ]);

  console.log("[EIP-712 Domain]");
  console.log("name   :", dName);
  console.log("version:", dVer);
  console.log("");

  // ---- Core params ----
  const [coreParams, stakeParams, stakeConst] = await Promise.all([
    token.getCoreParams(),
    token.getStakeParams(),
    token.getStakeConstants()
  ]);

  const [burnFee, rewardRate, stepLimit, sigValidity] = coreParams;
  const [stakePerStep, lastAdjustTs, locked] = stakeParams;
  const [minStakePerStep, maxStakePerStep, adjustCooldown] = stakeConst;

  console.log("[Core Params]");
  console.log("burnFee                  :", burnFee.toString(), "% of transfer (PERCENTAGE_BASE=100)");
  console.log("rewardRate               :", rewardRate.toString(), "(tokens per step, 18 decimals)");
  console.log("stepLimit                :", stepLimit.toString(), "(max steps per submission)");
  console.log("signatureValidityPeriod  :", sigValidity.toString(), "seconds");
  console.log("");

  console.log("[Stake Params]");
  console.log("currentStakePerStep      :", fmtTokens(stakePerStep));
  console.log("lastStakeAdjustment      :", fmtTokens(lastAdjustTs));
  console.log("stakeParamsLocked        :", locked);
  console.log("minStakePerStep          :", fmtTokens(minStakePerStep));
  console.log("maxStakePerStep          :", fmtTokens(maxStakePerStep));
  console.log("stakeAdjustCooldown      :", `${adjustCooldown.toString()} sec`);
  console.log("");

  // ---- Version info for "1.0.0" ----
  const vNorm = "1.0.0";
  const vHash = ethers.keccak256(ethers.toUtf8Bytes(vNorm));
  const [vSupported, vDeprecatesAt] = await token.getPayloadVersionInfo(vHash);

  console.log("[Payload Version]");
  console.log("version string           :", vNorm);
  console.log("hash                     :", vHash);
  console.log("supported                :", vSupported);
  console.log("deprecatesAt             :", fmtTs(vDeprecatesAt));
  console.log("");

  // ---- Sources ----
  console.log("[Sources]");
  for (const src of SOURCES) {
    let valid = false;
    try {
      valid = await token.isSourceValid(src);
    } catch (e) {
      console.log(`  ${src}: error calling isSourceValid →`, e?.shortMessage || e?.message || e);
      continue;
    }

    if (!valid) {
      console.log(`  ${src} → NOT REGISTERED`);
      continue;
    }

    const [requiresProof, requiresAtt, merkleRoot, maxStepsPerDay, minInterval] =
      await token.getSourceConfig(src);

    console.log(`  ${src} → valid`);
    console.log(`      requiresProof      : ${requiresProof}`);
    console.log(`      requiresAttestation: ${requiresAtt}`);
    console.log(`      merkleRoot         : ${merkleRoot}`);
    console.log(`      maxStepsPerDay     : ${maxStepsPerDay.toString()}`);
    console.log(`      minInterval        : ${minInterval.toString()} sec (~${Math.round(Number(minInterval) / 60)} min)`);
  }
  console.log("");

  // ---- User / API status ----
  if (CHECK_USER) {
    console.log("[User Core Status]");
    const [avgScaled, flagged, suspendUntil, stakedTokens, apiTrusted, firstTs] =
      await token.getUserCoreStatus(CHECK_USER);

    console.log("user                     :", CHECK_USER);
    console.log("stepAverageScaled        :", avgScaled.toString());
    console.log("flaggedSubmissions       :", flagged.toString());
    console.log("suspendedUntil           :", fmtTs(suspendUntil));
    console.log("stakedTokens                :", fmtTokens(stakedTokens));
    console.log("apiTrusted (isTrustedAPI):", apiTrusted);
    console.log("firstSubmissionTs        :", fmtTs(firstTs));

    // Optional: show per-source stats for the main ones
    for (const src of ["googlefit", "fitbit", "applehealth", "direct"]) {
      const valid = await token.isSourceValid(src).catch(() => false);
      if (!valid) continue;
      const [lastTs, dailyTotal, dayIndex] = await token.getUserSourceStats(
        CHECK_USER,
        src
      );
      console.log(`  [${src}] lastTs=${fmtTs(lastTs)}, dailyTotal=${dailyTotal.toString()}, dayIndex=${dayIndex.toString()}`);
    }

    console.log("");
  }

  if (CHECK_API) {
    console.log("[API Signer Core Status]");
    const [avgScaled, flagged, suspendUntil, stakedTokens, apiTrusted, firstTs] =
      await token.getUserCoreStatus(CHECK_API);

    console.log("api address              :", CHECK_API);
    console.log("stepAverageScaled        :", avgScaled.toString());
    console.log("flaggedSubmissions       :", flagged.toString());
    console.log("suspendedUntil           :", fmtTs(suspendUntil));
    console.log("stakedTokens                :", fmtTokens(stakedTokens));
    console.log("apiTrusted (isTrustedAPI):", apiTrusted);
    console.log("firstSubmissionTs        :", fmtTs(firstTs));
    console.log("");
  }

  console.log("✅ GemStep on-chain config check complete.");
}

main().catch((e) => {
  console.error("❌ check_gemstep_config failed:", e);
  process.exit(1);
});
