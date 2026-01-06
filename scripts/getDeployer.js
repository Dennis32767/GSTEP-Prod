// utils/getDeployer.js
const hre = require("hardhat");
const chalk = require("chalk");
const { ethers } = hre; // v6
const { formatUnits } = ethers;

async function getDeployer() {
  // 1) Prefer explicit private key (mainnet/testnets)
  if (process.env.DEPLOYER_PRIVATE_KEY) {
    try {
      console.log(chalk.blue("ℹ️  Using deployer from DEPLOYER_PRIVATE_KEY"));
      const wallet = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, ethers.provider);

      // Check balance on non-local networks
      if (!["localhost", "hardhat"].includes(hre.network.name)) {
        const bal = await wallet.getBalance();
        if (bal === 0n) {
          throw new Error("Deployer account has zero balance");
        }
        console.log(chalk.gray(`   Address: ${wallet.address}`));
        console.log(chalk.gray(`   Balance: ${formatUnits(bal, 18)} ETH`));
      }
      return wallet;
    } catch (err) {
      throw new Error(`Failed to initialize deployer from private key: ${err.message}`);
    }
  }

  // 2) Local networks: first signer
  if (["localhost", "hardhat"].includes(hre.network.name)) {
    console.log(chalk.blue("ℹ️  Using first signer for local network"));
    const signers = await ethers.getSigners();
    if (signers.length === 0) throw new Error("No signers available");
    return signers[0];
  }

  // 3) Non-local with DEPLOYER_ADDRESS: verify first signer matches
  if (process.env.DEPLOYER_ADDRESS) {
    try {
      console.log(chalk.blue(`ℹ️  Validating deployer address: ${process.env.DEPLOYER_ADDRESS}`));
      const [signer] = await ethers.getSigners();
      if (!signer) throw new Error("No signers available");

      const expected = process.env.DEPLOYER_ADDRESS.toLowerCase();
      const actual = (signer.address || (await signer.getAddress())).toLowerCase();

      if (actual !== expected) {
        throw new Error(
          `Configured deployer address (${expected}) does not match local signer (${actual})`
        );
      }

      const bal = await signer.getBalance();
      console.log(chalk.gray(`   Address: ${signer.address || (await signer.getAddress())}`));
      console.log(chalk.gray(`   Balance: ${formatUnits(bal, 18)} ETH`));
      return signer;
    } catch (err) {
      throw new Error(`Deployer validation failed: ${err.message}`);
    }
  }

  // 4) Fallback: first signer with warnings
  console.log(chalk.yellow("⚠️  No deployer specified, using first available signer"));
  const signers = await ethers.getSigners();
  if (signers.length === 0) throw new Error("No signers available");
  const signer = signers[0];

  if (!["localhost", "hardhat"].includes(hre.network.name)) {
    console.log(chalk.yellow("⚠️  WARNING: Using first signer on a non-local network"));
    console.log(chalk.yellow("    Set DEPLOYER_PRIVATE_KEY or DEPLOYER_ADDRESS for safety."));
  }

  return signer;
}

module.exports = { getDeployer };
