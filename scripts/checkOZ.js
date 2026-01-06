// scripts/checkOZ.js
const path = require("path");
const fs = require("fs");

function ok(msg){ console.log("\x1b[32m%s\x1b[0m", "✓ " + msg); }
function warn(msg){ console.log("\x1b[33m%s\x1b[0m", "⚠ " + msg); }
function fail(msg){ console.error("\x1b[31m%s\x1b[0m", "✗ " + msg); process.exit(1); }

try {
  const ozPkgPath = require.resolve("@openzeppelin/contracts/package.json");
  const ozDir = path.dirname(ozPkgPath);
  const ozPkg = require(ozPkgPath);
  ok(`@openzeppelin/contracts version ${ozPkg.version} at ${ozDir}`);

  // Check TimelockController path (OZ v5)
  const tlRel = "governance/TimelockController.sol";
  const tlAbs = path.join(ozDir, tlRel);
  if (fs.existsSync(tlAbs)) {
    ok(`Found ${tlRel}`);
  } else {
    fail(`Missing ${tlRel} inside @openzeppelin/contracts ${ozPkg.version}`);
  }

  // Sanity check: Upgrades package aligns to 5.x
  const ozUpPkgPath = require.resolve("@openzeppelin/contracts-upgradeable/package.json");
  const ozUpPkg = require(ozUpPkgPath);
  ok(`@openzeppelin/contracts-upgradeable version ${ozUpPkg.version}`);

  // Light warning if major versions differ
  if (String(ozPkg.version).split(".")[0] !== String(ozUpPkg.version).split(".")[0]) {
    warn("Major versions of @openzeppelin/contracts and -upgradeable differ. This can be OK, but keep an eye on imports.");
  }

  ok("OZ check complete");
  process.exit(0);
} catch (e) {
  fail(e && e.message ? e.message : String(e));
}
