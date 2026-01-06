require("dotenv").config();
const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  
  console.log("Deploying TimelockController with account:", deployer.address);
  console.log("Account balance:", (await deployer.provider.getBalance(deployer.address)).toString());

  // Timelock configuration
  const MIN_DELAY = 3600; // 1 hours
  const PROPOSERS = [deployer.address]; // You as proposer initially
  const EXECUTORS = [ethers.ZeroAddress]; // Anyone can execute
  const ADMIN = deployer.address; // You as admin initially

  console.log("Configuration:");
  console.log("  Min Delay:", MIN_DELAY, "seconds (1 hours)");
  console.log("  Proposers:", PROPOSERS);
  console.log("  Executors:", EXECUTORS, "(anyone)");
  console.log("  Admin:", ADMIN);

  // Deploy Timelock
  const Timelock = await ethers.getContractFactory("TimelockController");
  const timelock = await Timelock.deploy(MIN_DELAY, PROPOSERS, EXECUTORS, ADMIN);
  
  console.log("⏳ Deploying Timelock...");
  await timelock.waitForDeployment();
  
  const address = await timelock.getAddress();
  console.log("✅ TimelockController deployed to:", address);
  console.log("📝 Transaction:", timelock.deploymentTransaction().hash);

  // Verify on Etherscan (optional)
  console.log("\n💡 To verify on Etherscan, run:");
  console.log(`npx hardhat verify --network sepolia ${address} ${MIN_DELAY} "[${PROPOSERS}]" "[${EXECUTORS}]" "${ADMIN}"`);

  // Save to .env
  console.log("\n🔄 Add this to your .env file:");
  console.log(`L1_TIMELOCK=${address}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});