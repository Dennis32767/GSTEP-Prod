// scripts/validate.js
// Usage: npx hardhat run scripts/validate.js --network <network>
const { ethers, upgrades, artifacts, network } = require("hardhat");

// ethers v5/v6 compatibility helpers
async function waitForDeploy(instance) {
  if (typeof instance.waitForDeployment === "function") {
    await instance.waitForDeployment(); // ethers v6
  } else if (typeof instance.deployed === "function") {
    await instance.deployed();          // ethers v5
  } else {
    await instance.deployTransaction?.wait?.(1);
  }
}

async function getAddress(instance) {
  if (typeof instance.getAddress === "function") {
    return await instance.getAddress(); // ethers v6
  }
  return instance.address;              // ethers v5
}

// Deploy a library by fully-qualified name or simple name if unique
async function deployLibrary(fqnOrName) {
  const Factory = await ethers.getContractFactory(fqnOrName);
  const lib = await Factory.deploy();
  await waitForDeploy(lib);
  const addr = await getAddress(lib);
  console.log(`✅ ${fqnOrName} deployed at: ${addr}`);
  return addr;
}

async function main() {
  console.log(`\n== Validate GemStepToken implementation on ${network.name} ==\n`);

  // 1) Read artifact to discover required libraries
  const art = await artifacts.readArtifact("GemStepToken");
  // linkReferences: { [sourceName]: { [libName]: Array<{ length, start }> } }
  const linkRefs = art.linkReferences || {};
  const requiredLibs = [];

  for (const sourceName of Object.keys(linkRefs)) {
    for (const libName of Object.keys(linkRefs[sourceName])) {
      // Use fully-qualified name to avoid ambiguity
      requiredLibs.push(`${sourceName}:${libName}`);
    }
  }

  if (requiredLibs.length === 0) {
    console.log("ℹ️ GemStepToken does not require any external libraries.");
  } else {
    console.log("🔗 Libraries required by GemStepToken:");
    requiredLibs.forEach((x) => console.log("  -", x));
  }

  // 2) Deploy only the required libraries and build the linking map
  // Hardhat expects the libraries map with keys matching the artifact requirements.
  const librariesMap = {};
  for (const fqn of requiredLibs) {
    const [source, libName] = fqn.split(":");
    // Deploy by FQN if available, else fallback to simple name
    const addr = await deployLibrary(fqn);
    // Use the fully-qualified key that Hardhat asked for in the error message
    librariesMap[`${source}:${libName}`] = addr;
  }

  // 3) Build factory for GemStepToken with the exact libraries map
const GemStepToken = await ethers.getContractFactory("GemStepToken", {
  libraries: librariesMap,
});

// 4) Validate the implementation for the proxy kind you use
await upgrades.validateImplementation(GemStepToken, {
  kind: "transparent",
  unsafeAllowLinkedLibraries: true,
});
console.log("\n🎉 Implementation validation passed!");
  if (Object.keys(librariesMap).length) {
    console.log("Linked libraries:");
    console.table(librariesMap);
  }
  console.log("");
}

main().catch((err) => {
  console.error("❌ Validation failed:");
  console.error(err);
  process.exit(1);
});
