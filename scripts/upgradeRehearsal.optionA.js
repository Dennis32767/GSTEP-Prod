// scripts/upgradeRehearsal.optionA.js
// Rehearsal: Timelock → UpgradeExecutor → ProxyAdmin (atomic upgradeAndCall)
// Uses addresses from the latest deployments/localhost-deployment-*.json

const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");

const ZERO_BYTES32 = ethers.ZeroHash;
const IMPL_SLOT  = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

function loadLatestDeployment(dir = "deployments") {
  const files = fs.readdirSync(dir).filter(f => /^localhost-deployment-\d+\.json$/.test(f));
  if (!files.length) throw new Error("No localhost deployment json found in /deployments");
  const latest = files
    .map(f => ({ f, t: Number(f.match(/(\d+)\.json$/)[1]) }))
    .sort((a,b)=>b.t-a.t)[0].f;
  const full = path.join(dir, latest);
  return { file: full, json: JSON.parse(fs.readFileSync(full, "utf8")) };
}

async function readSlotAddr(proxy, slot) {
  const raw = await ethers.provider.getStorage(proxy, slot);
  return ethers.getAddress("0x" + raw.slice(26));
}
async function readTLDelay(tl) {
  try { return await tl.getFunction("getMinDelay")(); } catch {}
  try { return await tl.getFunction("minDelay")(); }   catch {}
  return 60n;
}
function makeSalt(label = "") {
  return ethers.keccak256(ethers.toUtf8Bytes(label || `${Date.now()}-${Math.random()}`));
}

async function main() {
  const { file, json } = loadLatestDeployment();
  const ADDR = {
    TokenProxy: json.contracts.tokenProxy,
    Timelock:   json.contracts.timelock,
    ProxyAdmin: json.contracts.proxyAdmin,
    Executor:   json.contracts.upgradeExecutor,
  };

  console.log("Using deployment file:", file);
  console.log("Addresses:", ADDR);

  // Sanity: wiring on chain
  const adminSlot = await readSlotAddr(ADDR.TokenProxy, ADMIN_SLOT);
  const implSlot  = await readSlotAddr(ADDR.TokenProxy, IMPL_SLOT);
  console.log("Proxy admin (slot):", adminSlot);
  console.log("Proxy impl  (slot):", implSlot);
  if (adminSlot.toLowerCase() !== ADDR.ProxyAdmin.toLowerCase()) {
    throw new Error(`ProxyAdmin mismatch. slot=${adminSlot} json=${ADDR.ProxyAdmin}`);
  }

  const [_, multisig] = await ethers.getSigners(); // #2 is your multisig on HH

  const tl   = await ethers.getContractAt("TimelockController", ADDR.Timelock, multisig);
  const exec = await ethers.getContractAt("UpgradeExecutor",   ADDR.Executor, multisig);

  // Deploy a V2 implementation with an initializer and version() checks
  const V2 = await ethers.getContractFactory("GemStepTokenV2Mock", multisig);
  const v2 = await V2.deploy(); await v2.waitForDeployment();
  const newImpl = await v2.getAddress();
  console.log("New V2 impl:", newImpl);

  // Encode initializer (non-empty data is REQUIRED by your executor/tests)
  const initCalldata = V2.interface.encodeFunctionData("initializeV2");

  const tlDelayBn = await readTLDelay(tl);
  const tlDelay   = Number(tlDelayBn);
  const exDelay   = Number(await exec.upgradeDelay());
  console.log("Timelock delay:", tlDelay, "s | Executor delay:", exDelay, "s");

  // ------- Step 1: scheduleUpgradeAndCall via Timelock -------
  const schedData = exec.interface.encodeFunctionData(
    "scheduleUpgradeAndCall",
    [ADDR.ProxyAdmin, ADDR.TokenProxy, newImpl, initCalldata]
  );
  const salt1 = makeSalt("sched-uac");
  await (await tl.schedule(ADDR.Executor, 0, schedData, ZERO_BYTES32, salt1, tlDelayBn)).wait();
  await ethers.provider.send("evm_increaseTime", [tlDelay + 1]); await ethers.provider.send("evm_mine", []);
  await (await tl.execute(ADDR.Executor, 0, schedData, ZERO_BYTES32, salt1)).wait();
  console.log("✓ [TL] scheduleUpgradeAndCall executed");

  if (exDelay > 0) {
    await ethers.provider.send("evm_increaseTime", [exDelay + 1]); await ethers.provider.send("evm_mine", []);
  }

  // ------- Step 2: executeUpgradeAndCall via Timelock -------
  const execData = exec.interface.encodeFunctionData(
    "executeUpgradeAndCall",
    [ADDR.ProxyAdmin, ADDR.TokenProxy, newImpl, initCalldata]
  );
  const salt2 = makeSalt("exec-uac");
  await (await tl.schedule(ADDR.Executor, 0, execData, ZERO_BYTES32, salt2, tlDelayBn)).wait();
  await ethers.provider.send("evm_increaseTime", [tlDelay + 1]); await ethers.provider.send("evm_mine", []);
  const tx = await tl.execute(ADDR.Executor, 0, execData, ZERO_BYTES32, salt2);
  const rcpt = await tx.wait();
  console.log("✓ [TL] executeUpgradeAndCall tx:", rcpt.hash);

  // Verify: impl changed & initializer ran
  const afterImpl = await readSlotAddr(ADDR.TokenProxy, IMPL_SLOT);
  console.log("After impl:", afterImpl);
  if (afterImpl.toLowerCase() !== newImpl.toLowerCase()) {
    throw new Error("Upgrade did not take effect (impl mismatch).");
  }

  const tokenV2 = await ethers.getContractAt("GemStepTokenV2Mock", ADDR.TokenProxy, multisig);
  console.log("Proxy.version():", await tokenV2.version()); // expect 2
  console.log("✓ Upgrade rehearsal (Option A) complete.");
}

main().catch(e => { console.error(e); process.exit(1); });
