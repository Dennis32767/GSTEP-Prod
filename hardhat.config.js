// hardhat.config.js
/* eslint-disable no-console */

require("@nomicfoundation/hardhat-toolbox");
require("@openzeppelin/hardhat-upgrades");
require("hardhat-gas-reporter");
require("solidity-coverage");
require("hardhat-contract-sizer");
require("dotenv").config();

/* ========================= helpers ========================= */
const normalizePK = (pk) => (pk && !pk.startsWith("0x") ? `0x${pk}` : pk);

const envBool = (v, def) =>
  v == null ? def : !["0", "false", "no", "off"].includes(String(v).toLowerCase());

const envInt = (v, def) => {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : def;
};

const warnMissing = (label, val) => {
  if (!val) console.warn(`⚠️  Missing env for ${label}`);
  return val || "";
};

/* ---- PK validation helpers (prevents HH8 on placeholders) ---- */
const isHex32 = (v) => /^0x[0-9a-fA-F]{64}$/.test(v || "");
const pickPK = (label, v) => {
  const pk = normalizePK(v);
  if (!pk) return undefined; // unset OK
  if (!isHex32(pk)) {
    console.warn(`⚠️  ${label} looks invalid (need 0x + 64 hex). Ignoring it.`);
    return undefined;
  }
  return pk;
};

const accArr = (pk) => (pk ? [pk] : []);

/* =================== mode detection =================== */
const IS_COVERAGE =
  process.argv.includes("coverage") ||
  String(process.env.SOLIDITY_COVERAGE || "").toLowerCase() === "1" ||
  String(process.env.COVERAGE || "").toLowerCase() === "1";

const SIZE_ONLY = (process.env.SIZE_ONLY || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const IS_SIZE_MODE = SIZE_ONLY.length > 0;

if (IS_COVERAGE) {
  // Prevent accidental remote net selection during coverage
  delete process.env.HARDHAT_NETWORK;
}

const BUILD_PROFILE = (process.env.BUILD_PROFILE || "dev").toLowerCase();
const IS_PROD = BUILD_PROFILE === "prod";

/* =================== build knobs =================== */
// Defaults:
// - coverage: runs=1, viaIR off, yul off, keep revert strings
// - prod/size: runs=50 (bytecode closer to deploy reality)
// - dev: runs=200 (faster deploys / good enough)
const DEFAULT_RUNS = IS_COVERAGE ? 1 : IS_PROD || IS_SIZE_MODE ? 50 : 200;
const OPTIMIZER_RUNS = envInt(process.env.OPTIMIZER_RUNS, DEFAULT_RUNS);

// IMPORTANT for solidity-coverage stability: viaIR MUST be false.
const USE_IR = IS_COVERAGE ? false : envBool(process.env.USE_IR, true);

// Yul default ON for non-coverage; if viaIR is ON, yul is effectively ON
const RAW_YUL = envBool(process.env.YUL, true);
const YUL = IS_COVERAGE ? false : RAW_YUL;
const EFFECTIVE_YUL = USE_IR ? true : YUL;

const YUL_STEPS = process.env.YUL_STEPS || "";
const EVM_VERSION = (process.env.EVM_VERSION || "shanghai").toLowerCase();

const PRINT_BUILD = envBool(process.env.PRINT_BUILD, false);

/* =================== network resolution =================== */
const getCliNetwork = () => {
  const i = process.argv.indexOf("--network");
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  const nArg = process.argv.find((a) => a.startsWith("--network="));
  if (nArg) return nArg.split("=")[1];
  return null;
};

const CLI_NETWORK = IS_COVERAGE ? null : getCliNetwork();
if (CLI_NETWORK) process.env.HARDHAT_NETWORK = CLI_NETWORK;

const TARGET_NET = (process.env.HARDHAT_NETWORK || "hardhat").toLowerCase();
const IS_LOCAL = TARGET_NET === "hardhat" || TARGET_NET === "localhost";

/* =================== revert string policy =================== */
// Never strip in coverage.
// Strip in prod non-local + size mode (deploy-accurate sizing).
const STRIP_REVERTS = (() => {
  if (process.env.STRIP_REVERTS != null) {
    const v = String(process.env.STRIP_REVERTS).toLowerCase();
    return !["0", "false", "no", "off"].includes(v);
  }
  if (IS_COVERAGE) return false;
  if (IS_SIZE_MODE) return true;
  return IS_PROD && !IS_LOCAL;
})();

/* =================== Solidity settings =================== */
const SOLC_SETTINGS = {
  optimizer: {
    enabled: true,
    runs: OPTIMIZER_RUNS,
    details: {
      yul: EFFECTIVE_YUL,
      ...(EFFECTIVE_YUL && YUL_STEPS ? { yulDetails: { optimizerSteps: YUL_STEPS } } : {}),
    },
  },
  viaIR: USE_IR, // forced false during coverage
  metadata: { bytecodeHash: "none" },
  evmVersion: EVM_VERSION,
  debug: {
    revertStrings: IS_COVERAGE ? "default" : STRIP_REVERTS ? "strip" : "default",
  },
};

if (PRINT_BUILD) {
  const bannerNetwork = IS_COVERAGE
    ? "hardhat"
    : CLI_NETWORK || process.env.HARDHAT_NETWORK || "hardhat";

  console.log(
    `[Build] profile=${IS_PROD ? "prod" : IS_SIZE_MODE ? "size" : "dev"}${
      IS_COVERAGE ? " (coverage)" : ""
    } runs=${OPTIMIZER_RUNS} viaIR=${USE_IR ? "on" : "off"} yul=${
      EFFECTIVE_YUL ? "true" : "false"
    } yulSteps=${EFFECTIVE_YUL && YUL_STEPS ? `(custom:${YUL_STEPS.length} chars)` : "(default)"} evm=${EVM_VERSION} coverage=${
      IS_COVERAGE ? "on" : "off"
    } network=${bannerNetwork} strip=${STRIP_REVERTS ? "on" : "off"}`
  );
}

/* =================== env: RPCs & keys =================== */
const {
  SEPOLIA_RPC_URL,
  ARBITRUM_SEPOLIA_RPC_URL,
  ARBITRUM_ONE_RPC_URL,
  MAINNET_RPC_URL,

  L1_TEST_PK,
  L2_TEST_PK,
  L1_PROD_PK,
  L2_PROD_PK,

  ETHERSCAN_API_KEY,
  ARBISCAN_API_KEY,
} = process.env;

const PKS = {
  L1_TEST: pickPK("L1_TEST_PK", L1_TEST_PK),
  L1_PROD: pickPK("L1_PROD_PK", L1_PROD_PK),
  L2_TEST: pickPK("L2_TEST_PK", L2_TEST_PK),
  L2_PROD: pickPK("L2_PROD_PK", L2_PROD_PK),
};

/* =================== networks =================== */
/**
 * Mapping:
 * - sepolia (L1 test)            → L1_TEST_PK
 * - arbitrumSepolia (L2 test)    → L2_TEST_PK
 * - arbitrumOne (L2 prod)        → L2_PROD_PK
 * - mainnet (L1 prod)            → L1_PROD_PK
 *
 * Also provide TitleCase aliases to match existing scripts:
 * - EthSepolia, ArbitrumSepolia, ArbitrumOne
 */
const networks = {
  hardhat: {
    chainId: 31337,
    allowUnlimitedContractSize: true,
    mining: { auto: true, interval: 0 },
  },
  localhost: { chainId: 31337, url: "http://127.0.0.1:8545" },

  sepolia: {
    url: warnMissing("SEPOLIA_RPC_URL", SEPOLIA_RPC_URL),
    chainId: 11155111,
    accounts: accArr(PKS.L1_TEST),
    gas: "auto",
    gasPrice: "auto",
    gasMultiplier: 1.2,
    timeout: 120000,
  },
  EthSepolia: {
    url: warnMissing("SEPOLIA_RPC_URL", SEPOLIA_RPC_URL),
    chainId: 11155111,
    accounts: accArr(PKS.L1_TEST),
    gas: "auto",
    gasPrice: "auto",
    gasMultiplier: 1.2,
    timeout: 120000,
  },

  arbitrumSepolia: {
    url: warnMissing("ARBITRUM_SEPOLIA_RPC_URL", ARBITRUM_SEPOLIA_RPC_URL),
    chainId: 421614,
    accounts: accArr(PKS.L2_TEST),
    gas: "auto",
    gasPrice: "auto",
    gasMultiplier: 1.0,
    timeout: 120000,
  },
  ArbitrumSepolia: {
    url: warnMissing("ARBITRUM_SEPOLIA_RPC_URL", ARBITRUM_SEPOLIA_RPC_URL),
    chainId: 421614,
    accounts: accArr(PKS.L2_TEST),
    gas: "auto",
    gasPrice: "auto",
    gasMultiplier: 1.0,
    timeout: 120000,
  },

  arbitrumOne: {
    url: warnMissing("ARBITRUM_ONE_RPC_URL", ARBITRUM_ONE_RPC_URL),
    chainId: 42161,
    accounts: accArr(PKS.L2_PROD),
    gas: "auto",
    gasPrice: "auto",
    timeout: 120000,
  },
  ArbitrumOne: {
    url: warnMissing("ARBITRUM_ONE_RPC_URL", ARBITRUM_ONE_RPC_URL),
    chainId: 42161,
    accounts: accArr(PKS.L2_PROD),
    gas: "auto",
    gasPrice: "auto",
    timeout: 120000,
  },

  mainnet: {
    url: warnMissing("MAINNET_RPC_URL", MAINNET_RPC_URL),
    chainId: 1,
    accounts: accArr(PKS.L1_PROD),
    gas: "auto",
    gasPrice: "auto",
    timeout: 120000,
  },
};

/* =================== etherscan / sourcify =================== */
const etherscan = {
  apiKey: {
    mainnet: ETHERSCAN_API_KEY || "",
    sepolia: ETHERSCAN_API_KEY || "",
    arbitrumOne: ARBISCAN_API_KEY || "",
    arbitrumSepolia: ARBISCAN_API_KEY || "",
  },
  customChains: [
    {
      network: "arbitrumSepolia",
      chainId: 421614,
      urls: {
        apiURL: "https://api-sepolia.arbiscan.io/api",
        browserURL: "https://sepolia.arbiscan.io",
      },
    },
    {
      network: "arbitrumOne",
      chainId: 42161,
      urls: {
        apiURL: "https://api.arbiscan.io/api",
        browserURL: "https://arbiscan.io",
      },
    },
  ],
};

// Optional but nice: don’t fail verify due to missing api keys on local runs
const hasAnyExplorerKey = Boolean(ETHERSCAN_API_KEY || ARBISCAN_API_KEY);

module.exports = {
  defaultNetwork: "hardhat",
  networks,

  solidity: {
    version: "0.8.30",
    settings: SOLC_SETTINGS,
  },

  etherscan,

  // Hardhat toolbox already includes mocha/chai matchers. Keep timeout generous.
  mocha: { timeout: IS_COVERAGE ? 400000 : 200000 },

  gasReporter: {
    enabled: envBool(process.env.REPORT_GAS, true), // default ON; turn off when needed
    currency: "USD",
    coinmarketcap: process.env.COINMARKETCAP_API_KEY || undefined,
  },

  contractSizer: {
    alphaSort: true,
    runOnCompile: true,
    disambiguatePaths: true,
    except: [".*Mock$", ".*Test$", ".*/_mocks/.*"],
    ...(IS_SIZE_MODE ? { only: SIZE_ONLY } : {}),
  },

  // Optional: make verify less annoying if keys are missing (doesn't affect deployments)
  verify: hasAnyExplorerKey
    ? undefined
    : {
        etherscan: {
          apiKey: "",
        },
      },

  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};
