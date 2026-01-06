// scripts/cleanRebuild.js
const fs = require("fs");
const { execSync } = require("child_process");
const path = require("path");

function rimraf(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`🗑️ Removed ${dir}`);
  }
}

async function main() {
  const root = path.resolve(__dirname, "..");

  // Remove build outputs
  rimraf(path.join(root, "artifacts"));
  rimraf(path.join(root, "cache"));

  // Run hardhat compile
  console.log("🔄 Rebuilding project...");
  execSync("npx hardhat compile", { stdio: "inherit" });

  console.log("✅ Rebuild complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
