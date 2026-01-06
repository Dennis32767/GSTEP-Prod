require('dotenv').config();
const hre = require("hardhat");
const chalk = require("chalk");
const { isAddress } = hre.ethers;

async function validateEnvironment() {
  const errors = [];
  const warnings = [];
  const requiredVars = {
    DEPLOYER_ADDRESS: {
      validate: val => isAddress(val),
      errorMsg: "Must be a valid Ethereum address"
    },
    MULTISIG_ADDRESS: {
      validate: val => isAddress(val),
      errorMsg: "Must be a valid Ethereum address"
    },
    PROXY_ADDRESS: {
      required: false,
      validate: val => isAddress(val),
      errorMsg: "Must be a valid Ethereum address"
    },
    TIMELOCK_ADDRESS: {
      required: false,
      validate: val => isAddress(val),
      errorMsg: "Must be a valid Ethereum address"
    }
  };

  const optionalVars = {
    RPC_URL: {
      validate: val => val.startsWith("http"),
      warningMsg: "Should be a valid HTTP/HTTPS URL"
    },
    ETHERSCAN_API_KEY: {
      warningMsg: "Required for contract verification"
    },
    DEFENDER_API_KEY: {
      warningMsg: "Required for Defender Relayer support"
    },
    DEFENDER_API_SECRET: {
      warningMsg: "Required for Defender Relayer support"
    }
  };

  // Validate required variables
  for (const [varName, config] of Object.entries(requiredVars)) {
    if (!process.env[varName] && config.required !== false) {
      errors.push(`Missing required variable: ${varName}`);
      continue;
    }

    if (process.env[varName] && config.validate && !config.validate(process.env[varName])) {
      errors.push(`${varName}: ${config.errorMsg}`);
    }
  }

  // Validate optional variables
  for (const [varName, config] of Object.entries(optionalVars)) {
    if (process.env[varName]) {
      if (config.validate && !config.validate(process.env[varName])) {
        warnings.push(`${varName}: ${config.warningMsg}`);
      }
    } else if (config.warningMsg) {
      warnings.push(`Missing ${varName}: ${config.warningMsg}`);
    }
  }

  // Special validation cases
  if (process.env.DEPLOYER_ADDRESS && process.env.MULTISIG_ADDRESS) {
    if (process.env.DEPLOYER_ADDRESS.toLowerCase() === 
        process.env.MULTISIG_ADDRESS.toLowerCase()) {
      warnings.push("DEPLOYER_ADDRESS and MULTISIG_ADDRESS are the same");
    }
  }

  if (process.env.DEFENDER_API_KEY && !process.env.DEFENDER_API_SECRET) {
    errors.push("DEFENDER_API_KEY provided but missing DEFENDER_API_SECRET");
  }

  // Output results
  if (warnings.length > 0) {
    console.log(chalk.yellow("\n⚠️  Configuration Warnings:"));
    warnings.forEach(warning => console.log(chalk.yellow(`  - ${warning}`)));
  }

  if (errors.length > 0) {
    console.error(chalk.red("\n❌ Configuration Errors:"));
    errors.forEach(error => console.error(chalk.red(`  - ${error}`)));
    throw new Error("Invalid environment configuration");
  }

  // Network-specific validation
  if (!['localhost', 'hardhat'].includes(hre.network.name)) {
    if (!process.env.RPC_URL) {
      throw new Error("RPC_URL is required for live networks");
    }

    if (hre.network.name === 'mainnet' && !process.env.ETHERSCAN_API_KEY) {
      warnings.push("ETHERSCAN_API_KEY recommended for mainnet deployments");
    }
  }

  console.log(chalk.green("\n✓ Environment configuration validated"));
  return true;
}

module.exports = { 
  validateEnvironment,
  // Expose for testing
  _private: { requiredVars, optionalVars } 
};