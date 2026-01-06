const { ethers } = require("hardhat");

async function main() {
  // Make sure these environment variables are set in your .env file
  if (!process.env.TIMELOCK_ADDRESS || !process.env.EXECUTOR_ADDRESS || 
      !process.env.PROXY_ADMIN_ADDRESS || !process.env.PROXY_ADDRESS) {
    throw new Error("Missing required environment variables");
  }

  const tl = await ethers.getContractAt(
    ["function hashOperation(address,uint256,bytes,bytes32,bytes32) view returns (bytes32)",
     "function isOperation(bytes32) view returns (bool)",
     "function isOperationReady(bytes32) view returns (bool)",
     "function isOperationDone(bytes32) view returns (bool)"],
    process.env.TIMELOCK_ADDRESS
  );
  
  const exec = await ethers.getContractAt(
    ["function scheduleUpgrade(address,address,address)",
     "function executeUpgrade(address,address,address)"],
    process.env.EXECUTOR_ADDRESS
  );

  // Replace <NEW_IMPL_ADDR> with your actual new implementation address
  const NEW_IMPL_ADDR = "0x..."; // REPLACE WITH ACTUAL ADDRESS
  
  // Build the exact calldata & salts you used
  const iface = exec.interface;
  const scheduleData = iface.encodeFunctionData("scheduleUpgrade", [
    process.env.PROXY_ADMIN_ADDRESS, 
    process.env.PROXY_ADDRESS, 
    NEW_IMPL_ADDR
  ]);
  const executeData = iface.encodeFunctionData("executeUpgrade", [
    process.env.PROXY_ADMIN_ADDRESS, 
    process.env.PROXY_ADDRESS, 
    NEW_IMPL_ADDR
  ]);
  
  const schedSalt = ethers.keccak256(
    ethers.toUtf8Bytes(`sched:${process.env.PROXY_ADDRESS.toLowerCase()}:${NEW_IMPL_ADDR.toLowerCase()}`)
  );
  const execSalt = ethers.keccak256(
    ethers.toUtf8Bytes(`exec:${process.env.PROXY_ADDRESS.toLowerCase()}:${NEW_IMPL_ADDR.toLowerCase()}`)
  );

  const pred = ethers.ZeroHash;
  const val = 0n;

  console.log("Calculating operation IDs... - checkRPC.js:50");
  
  // Operation IDs
  const opIdSched = await tl.hashOperation(process.env.EXECUTOR_ADDRESS, val, scheduleData, pred, schedSalt);
  const opIdExec = await tl.hashOperation(process.env.EXECUTOR_ADDRESS, val, executeData, pred, execSalt);

  console.log("Schedule Operation ID: - checkRPC.js:56", opIdSched);
  console.log("Execute Operation ID: - checkRPC.js:57", opIdExec);

  console.log("\nChecking schedule operation status: - checkRPC.js:59");
  console.log("isOperation: - checkRPC.js:60", await tl.isOperation(opIdSched));
  console.log("isOperationReady: - checkRPC.js:61", await tl.isOperationReady(opIdSched));
  console.log("isOperationDone: - checkRPC.js:62", await tl.isOperationDone(opIdSched));

  console.log("\nChecking execute operation status: - checkRPC.js:64");
  console.log("isOperation: - checkRPC.js:65", await tl.isOperation(opIdExec));
  console.log("isOperationReady: - checkRPC.js:66", await tl.isOperationReady(opIdExec));
  console.log("isOperationDone: - checkRPC.js:67", await tl.isOperationDone(opIdExec));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});