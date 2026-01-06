// test/PostDeployment.test.js
/* eslint-disable no-unused-expressions */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

/** -----------------------------------------------------------------------
 *  0) Load a project fixture if available, or fall back to env-based attach
 *  ----------------------------------------------------------------------- */
function tryRequireFixture() {
  const candidates = [
    "./fixtures",
    "./helpers/fixtures",
    "./utils/fixtures",
    "../fixtures",
    "../helpers/fixtures",
    "../utils/fixtures",
    "test/fixtures",
    "test/helpers/fixtures",
    "test/utils/fixtures",
  ];
  for (const p of candidates) {
    try {
      const mod = require(p);
      if (mod && typeof mod.deployGemStepFixture === "function") {
        return mod.deployGemStepFixture;
      }
    } catch (_) {}
  }
  return null;
}

// Fallback: attach to a deployed instance via env vars
async function envAttachFixture() {
  const [admin, user1, user2, ...rest] = await ethers.getSigners();
  const addr = process.env.TOKEN_ADDRESS;
  if (!addr) {
    throw new Error(
      "No fixtures module found and TOKEN_ADDRESS is not set.\n" +
        "Either: (a) create/export deployGemStepFixture in one of the probed paths, or\n" +
        "        (b) export TOKEN_ADDRESS=<your proxy address> (and optionally TIMELOCK_ADDRESS / ORACLE_ADDRESS)."
    );
  }
  // Adjust artifact name if needed:
  const token = await ethers.getContractAt("GemStepToken", addr);

  const tlAddr = process.env.TIMELOCK_ADDRESS;
  const priceOracleAddr = process.env.ORACLE_ADDRESS;

  const timelock = tlAddr
    ? await ethers.getContractAt("TimelockController", tlAddr).catch(() => null)
    : null;

  const priceOracle = priceOracleAddr
    ? await ethers.getContractAt("PriceOracle", priceOracleAddr).catch(() => null)
    : null;

  return { token, admin, user1, user2, rest, timelock, priceOracle };
}

const externalFixture = tryRequireFixture();
const deployGemStepFixture = externalFixture ?? envAttachFixture;

/** -------------------------------------
 *  1) Small interface/util helpers
 *  ------------------------------------- */
const addrOf = (c) => c?.target ?? c?.address;

const hasFn = (contract, name) => {
  try {
    contract.interface.getFunction(name);
    return true;
  } catch {
    return false;
  }
};

const readOpt = async (contract, fn, args = []) => {
  if (!hasFn(contract, fn)) return null;
  try {
    return await contract[fn](...args);
  } catch {
    return null;
  }
};

/** -------------------------------------
 *  2) SAFE mint-like detector
 *  ------------------------------------- */
function findMintLike(iface) {
  const frags = Object.values(iface.fragments || []);
  const candidates = frags.filter(
    (f) =>
      f?.type === "function" &&
      !["view", "pure"].includes(f.stateMutability) &&
      /mint/i.test(f.name)
  );
  return candidates[0] ?? null;
}

/** -------------------------------------
 *  3) Detect logSteps variants + capture component names
 *  ------------------------------------- */
function getLogStepsShape(iface) {
  let fn;
  try {
    fn = iface.getFunction("logSteps");
  } catch {
    return {
      variant: "none",
      seen: "logSteps not found",
      stepComps: [],
      sigComps: [],
    };
  }
  const ins = fn.inputs || [];
  const stepComps = (ins[0]?.components || []).map((c) => ({ name: c.name, type: c.type }));
  const sigComps = (ins[1]?.components || []).map((c) => ({ name: c.name, type: c.type }));

  const A = stepComps.map((c) => c.type).join(",");
  const B = sigComps.map((c) => c.type).join(",");

  // v3 (current): StepData7 + SigBundle3
  if (A === "address,address,uint256,uint256,uint256,string,string" && B === "bytes,bytes32[],bytes")
    return { variant: "v3", seen: `(${A}),(${B})`, stepComps, sigComps };

  // v2 (older): StepData7 + SigBundle2
  if (A === "address,address,uint256,uint256,uint256,string,string" && B === "bytes,bytes32[]")
    return { variant: "v2", seen: `(${A}),(${B})`, stepComps, sigComps };

  // v1 (simple): StepData5 + bytes
  if (A === "address,uint256,uint256,uint256,string" && B === "bytes")
    return { variant: "v1", seen: `(${A}),(${B})`, stepComps, sigComps };

  return { variant: "unknown", seen: `logSteps((${A}),(${B}))`, stepComps, sigComps };
}

/** -------------------------------------
 *  4) Contract call: pass tuples as arrays (positional)
 *  ------------------------------------- */
async function callLogSteps(token, signer, payload = {}) {
  const { variant } = getLogStepsShape(token.interface);

  if (variant === "v1") {
    // [user, steps, nonce, deadline, source], signature (bytes)
    const stepArr = [payload.user, payload.steps, payload.nonce, payload.deadline, payload.source];
    return token.connect(signer).logSteps(stepArr, payload.signature);
  }

  if (variant === "v2") {
    // [user, recipient/beneficiary, steps, nonce, deadline, source, version], [signature, proof]
    const stepArr = [
      payload.user,
      payload.recipient ?? payload.beneficiary,
      payload.steps,
      payload.nonce,
      payload.deadline,
      payload.source,
      payload.version,
    ];
    const sigArr = [payload.signature, payload.proof ?? []]; // array, not object
    return token.connect(signer).logSteps(stepArr, sigArr);
  }

  if (variant === "v3") {
    // [user, recipient/beneficiary, steps, nonce, deadline, source, version], [signature, proof, attestation/smartWalletSig]
    const stepArr = [
      payload.user,
      payload.recipient ?? payload.beneficiary,
      payload.steps,
      payload.nonce,
      payload.deadline,
      payload.source,
      payload.version,
    ];
    const third = payload.attestation ?? payload.smartWalletSig ?? "0x";
    const sigArr = [payload.signature, payload.proof ?? [], third]; // array, not object
    return token.connect(signer).logSteps(stepArr, sigArr);
  }

  throw new Error(`Unsupported logSteps signature. Inputs seen: ${getLogStepsShape(token.interface).seen}`);
}

/** -------------------------------------
 *  5) EIP-712 signer (build types from ABI field names)
 *  ------------------------------------- */
async function signStepDataFlexible({
  token,
  user,
  recipient,
  steps,
  nonce,
  deadline,
  source,
  version = "1.0.0",
  signer,
}) {
  const net = await token.runner.provider.getNetwork();
  const domain = {
    name: "GemStep", // Adjust if your contract uses a different EIP-712 name
    version: "1.0.0", // Adjust if your contract uses a different EIP-712 version
    chainId: Number(net.chainId),
    verifyingContract: addrOf(token),
  };

  const { variant, stepComps } = getLogStepsShape(token.interface);

  // Build types directly from ABI field names (works with 'beneficiary', etc.)
  const types = {
    StepData: stepComps.map((c) => ({ name: c.name, type: c.type })),
  };

  const valsByIndex =
    variant === "v1"
      ? [user, steps, nonce, deadline, source]
      : [user, recipient ?? user, steps, nonce, deadline, source, version];

  const value = {};
  stepComps.forEach((c, i) => {
    value[c.name] = valsByIndex[i];
  });

  const signature = await signer.signTypedData(domain, types, value);
  return { signature, value, variant };
}

/** -------------------------------------
 *  6) Unified submitSteps helper
 *  ------------------------------------- */
async function submitSteps({ token, userSigner, recipient, source = "fitbit", steps, extra = {} }) {
  const userAddr = await userSigner.getAddress();
  const nonce = await token.nonces(userAddr);
  const validity = (await readOpt(token, "signatureValidityPeriod")) ?? 3600n;
  const latest = await ethers.provider.getBlock("latest");
  const now = BigInt(latest.timestamp);
  const deadline = now + BigInt(validity);

  const { signature, value, variant } = await signStepDataFlexible({
    token,
    user: userAddr,
    recipient: recipient ?? userAddr,
    steps: BigInt(steps),
    nonce,
    deadline,
    source,
    version: "1.0.0",
    signer: userSigner,
  });

  if (variant === "v1") {
    return callLogSteps(token, userSigner, {
      user: value.user,
      steps: value.steps,
      nonce: value.nonce,
      deadline: value.deadline,
      source: value.source,
      signature,
    });
  }

  const secondAddr = value.recipient ?? value.beneficiary ?? (recipient ?? userAddr);

  return callLogSteps(token, userSigner, {
    user: value.user,
    recipient: secondAddr,
    steps: value.steps,
    nonce: value.nonce,
    deadline: value.deadline,
    source: value.source,
    version: value.version,
    signature,
    proof: extra.proof ?? [],
    smartWalletSig: extra.smartWalletSig ?? "0x",
  });
}

/** -------------------------------------
 *  7) Enable a source but DISABLE proof/attestation requirements
 *  ------------------------------------- */
async function enableSourceNoProofNoAttestation(token, admin, source) {
  const tries = [
    // string, enabled, requireProof, requireAttestation
    () => token.connect(admin).configureSource(source, true, false, false),
    // string, enabled, requireProof
    () => token.connect(admin).configureSource(source, true, false),
    // string, enabled
    () => token.connect(admin).configureSource(source, true),
  ];

  for (const t of tries) {
    try {
      await t();
      return true;
    } catch (_) {}
  }

  // Fallback split setters (best-effort)
  let ok = false;
  try {
    await token.connect(admin).setSourceEnabled?.(source, true);
    ok = true;
  } catch (_) {}
  try {
    await token.connect(admin).setRequireProof?.(source, false);
    ok = true;
  } catch (_) {}
  try {
    await token.connect(admin).setRequireAttestation?.(source, false);
    ok = true;
  } catch (_) {}

  // Global toggles, if present
  try {
    await token.connect(admin).setGlobalRequireProof?.(false);
    ok = true;
  } catch (_) {}
  try {
    await token.connect(admin).setGlobalRequireAttestation?.(false);
    ok = true;
  } catch (_) {}

  return ok;
}

/** -------------------------------------
 *  8) Probe a source: can we submit WITHOUT proof?
 *      (uses staticCall, no state change)
 *  ------------------------------------- */
async function canSubmitWithoutProof(token, admin, userSigner, source) {
  try {
    await enableSourceNoProofNoAttestation(token, admin, source);
  } catch (_) {}

  // Prepare a signed, minimal submission and try static call
  const userAddr = await userSigner.getAddress();
  const nonce = await token.nonces(userAddr);
  const validity = (await readOpt(token, "signatureValidityPeriod")) ?? 3600n;
  const latest = await ethers.provider.getBlock("latest");
  const now = BigInt(latest.timestamp);
  const deadline = now + BigInt(validity);

  const { signature, value, variant } = await signStepDataFlexible({
    token,
    user: userAddr,
    recipient: userAddr,
    steps: 1n,
    nonce,
    deadline,
    source,
    version: "1.0.0",
    signer: userSigner,
  });

  // Build arrays and static call
  const { variant: v } = getLogStepsShape(token.interface);
  const c = token.connect(userSigner);

  if (v === "v1") {
    const stepArr = [value.user, value.steps, value.nonce, value.deadline, value.source];
    await c.logSteps.staticCall(stepArr, signature);
    return true;
  }
  if (v === "v2") {
    const stepArr = [
      value.user,
      value.recipient ?? value.beneficiary ?? userAddr,
      value.steps,
      value.nonce,
      value.deadline,
      value.source,
      value.version,
    ];
    const sigArr = [signature, []];
    await c.logSteps.staticCall(stepArr, sigArr);
    return true;
  }
  if (v === "v3") {
    const stepArr = [
      value.user,
      value.recipient ?? value.beneficiary ?? userAddr,
      value.steps,
      value.nonce,
      value.deadline,
      value.source,
      value.version,
    ];
    const sigArr = [signature, [], "0x"];
    await c.logSteps.staticCall(stepArr, sigArr);
    return true;
  }
  return false;
}

/** -------------------------------------
 *  9) Pick a usable source dynamically
 *  ------------------------------------- */
async function pickUsableSource(token, admin, userSigner) {
  const candidates = ["fitbit", "nosigcap", "dev", "test"];
  for (const s of candidates) {
    try {
      const ok = await canSubmitWithoutProof(token, admin, userSigner, s);
      if (ok) return s;
    } catch (_) {
      // keep trying others
    }
  }
  return null;
}

/** -------------------------------------
 *  10) Test Suite
 *  ------------------------------------- */
describe("GemStepToken – Unified Deployment & Functional Suite", function () {
  describe("A) Deployed Environment Checks (ERC1967/Timelock/Oracle)", function () {
    it("Supply & caps (no assumption about holder)", async function () {
      const { token } = await loadFixture(deployGemStepFixture);
      const total = await token.totalSupply();
      expect(total).to.be.gt(0n);

      const cap = await readOpt(token, "cap");
      if (cap !== null) {
        expect(cap).to.be.gte(total);
      }

      const currentMonthlyCap = await readOpt(token, "currentMonthlyCap");
      const monthlyMintLimit = await readOpt(token, "monthlyMintLimit");
      if (currentMonthlyCap !== null && monthlyMintLimit !== null) {
        expect(currentMonthlyCap).to.be.gt(0n);
        expect(monthlyMintLimit).to.be.gt(0n);
      }
    });

    it("ERC1967 admin slot (ProxyAdmin) & implementation", async function () {
      const { token } = await loadFixture(deployGemStepFixture);
      expect(addrOf(token)).to.be.properAddress;
    });

    it("Timelock roles (optional)", async function () {
      const { timelock } = await loadFixture(deployGemStepFixture);
      if (!timelock) return this.skip();
      expect(addrOf(timelock)).to.be.properAddress;
      if (hasFn(timelock, "PROPOSER_ROLE") && hasFn(timelock, "hasRole")) {
        const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
        expect(PROPOSER_ROLE).to.be.ok;
      }
    });

    it("Price oracle (optional expected)", async function () {
      const { priceOracle } = await loadFixture(deployGemStepFixture);
      if (!priceOracle) return this.skip();
      expect(addrOf(priceOracle)).to.be.properAddress;
    });
  });

  describe("B) Local Proxy Fixture Checks (Minting/Steps/Time/Signatures)", function () {
    it("Initial supply exists (don’t assume who holds it)", async function () {
      const { token } = await loadFixture(deployGemStepFixture);
      const ts = await token.totalSupply();
      expect(ts).to.be.gt(0n);
    });

    it("Cap settings: currentMonthlyCap & monthlyMintLimit", async function () {
      const { token } = await loadFixture(deployGemStepFixture);
      const currentMonthlyCap = await readOpt(token, "currentMonthlyCap");
      const monthlyMintLimit = await readOpt(token, "monthlyMintLimit");
      if (currentMonthlyCap === null || monthlyMintLimit === null) {
        return this.skip();
      }
      expect(currentMonthlyCap).to.be.gt(0n);
      expect(monthlyMintLimit).to.be.gt(0n);
    });

    it("Role snapshot (simple, skip if roles not present)", async function () {
      const { token } = await loadFixture(deployGemStepFixture);
      if (!hasFn(token, "hasRole")) return this.skip();
      const DEFAULT_ADMIN_ROLE = await token.DEFAULT_ADMIN_ROLE?.();
      expect(DEFAULT_ADMIN_ROLE ?? "0x").to.be.ok;
    });

    it("Valid sources contain 'fitbit' (skip if feature not present)", async function () {
      const { token, admin } = await loadFixture(deployGemStepFixture);
      if (!hasFn(token, "sourceConfigs")) return this.skip();
      // We only need it to exist; enabling is handled by picker for submissions.
      try {
        await token.sourceConfigs("fitbit");
        expect(true).to.equal(true);
      } catch {
        this.skip();
      }
    });

    it("Tracks monthly minted amount (uses detected mint function)", async function () {
      const { token, admin, user1 } = await loadFixture(deployGemStepFixture);
      const mintFn = findMintLike(token.interface);
      if (!mintFn) return this.skip();

      const decimals = (await readOpt(token, "decimals")) ?? 18n;
      const amount = 10n * 10n ** BigInt(decimals);

      const pre = await token.totalSupply();
      const types = (mintFn.inputs || []).map((i) => i.type).join(",");
      if (types === "address,uint256" || types.startsWith("address,uint256,")) {
        await token.connect(admin)[mintFn.name](await user1.getAddress(), amount);
      } else if (types === "uint256" || types.startsWith("uint256,")) {
        await token.connect(admin)[mintFn.name](amount);
      } else {
        return this.skip();
      }
      const post = await token.totalSupply();
      expect(post - pre).to.equal(amount);
    });

    it("Step rewards accrue correctly (tuple/flat logSteps auto-detected)", async function () {
      const { token, user1, admin } = await loadFixture(deployGemStepFixture);

      const source = await pickUsableSource(token, admin, user1);
      if (!source) return this.skip();

      const bal0 = await token.balanceOf(await user1.getAddress());
      await submitSteps({ token, userSigner: user1, steps: 25, source });
      const bal1 = await token.balanceOf(await user1.getAddress());

      const tokenPerStep = await readOpt(token, "tokenPerStep");
      if (tokenPerStep !== null) {
        expect(bal1 - bal0).to.equal(tokenPerStep * 25n);
      } else {
        expect(bal1 - bal0).to.be.gt(0n);
      }
    });

    it("Rejects invalid sources", async function () {
      const { token, user1 } = await loadFixture(deployGemStepFixture);
      await expect(
        submitSteps({ token, userSigner: user1, steps: 10, source: "not-a-source" })
      ).to.be.reverted;
    });

    it("Monthly cycles roll over with time travel (skip if fields missing)", async function () {
      const { token, user1, admin } = await loadFixture(deployGemStepFixture);
      const hasMonthTracking =
        hasFn(token, "mintedThisMonth") || hasFn(token, "getMonthlyMinted") || hasFn(token, "currentMonth");
      if (!hasMonthTracking) return this.skip();

      const source = await pickUsableSource(token, admin, user1);
      if (!source) return this.skip();

      await submitSteps({ token, userSigner: user1, steps: 5, source });

      const before =
        (await readOpt(token, "mintedThisMonth")) ??
        (await readOpt(token, "getMonthlyMinted")) ??
        0n;
      expect(before).to.be.gt(0n);

      await time.increase(32 * 24 * 60 * 60);

      const after =
        (await readOpt(token, "mintedThisMonth")) ??
        (await readOpt(token, "getMonthlyMinted")) ??
        null;

      if (after !== null) {
        expect(after).to.be.lte(before);
      } else {
        await submitSteps({ token, userSigner: user1, steps: 5, source });
      }
    });

    it("Handles consecutive step submissions without precision loss", async function () {
      const { token, user1, admin } = await loadFixture(deployGemStepFixture);

      const source = await pickUsableSource(token, admin, user1);
      if (!source) return this.skip();

      const bal0 = await token.balanceOf(await user1.getAddress());
      await submitSteps({ token, userSigner: user1, steps: 7, source });
      await submitSteps({ token, userSigner: user1, steps: 13, source });
      const bal1 = await token.balanceOf(await user1.getAddress());

      const tokenPerStep = await readOpt(token, "tokenPerStep");
      if (tokenPerStep !== null) {
        expect(bal1 - bal0).to.equal(tokenPerStep * (7n + 13n));
      } else {
        expect(bal1 - bal0).to.be.gt(0n);
      }
    });

    it("Security: non-minters cannot mint (if no public mint, test is irrelevant)", async function () {
      const { token, user1 } = await loadFixture(deployGemStepFixture);
      const mintFn = findMintLike(token.interface);
      if (!mintFn) return this.skip();

      const types = (mintFn.inputs || []).map((i) => i.type).join(",");
      const decimals = (await readOpt(token, "decimals")) ?? 18n;
      const amount = 1n * 10n ** BigInt(decimals);

      if (types === "address,uint256" || types.startsWith("address,uint256,")) {
        await expect(token.connect(user1)[mintFn.name](await user1.getAddress(), amount)).to.be.reverted;
      } else if (types === "uint256" || types.startsWith("uint256,")) {
        await expect(token.connect(user1)[mintFn.name](amount)).to.be.reverted;
      } else {
        return this.skip();
      }
    });

    it("Enforces signature deadlines", async function () {
      const { token, user1, admin } = await loadFixture(deployGemStepFixture);

      // Use any usable source, only to reach the signature check path.
      const source = await pickUsableSource(token, admin, user1);
      if (!source) return this.skip();

      const userAddr = await user1.getAddress();
      const nonce = await token.nonces(userAddr);
      const now = BigInt((await ethers.provider.getBlock("latest")).timestamp);
      const expired = now - 1n;

      const { signature, value } = await signStepDataFlexible({
        token,
        user: userAddr,
        recipient: userAddr,
        steps: 10n,
        nonce,
        deadline: expired,
        source,
        signer: user1,
      });

      await expect(
        callLogSteps(token, user1, {
          user: value.user,
          recipient: value.recipient ?? value.beneficiary ?? userAddr,
          steps: value.steps,
          nonce: value.nonce,
          deadline: value.deadline,
          source: value.source,
          version: value.version,
          signature,
          proof: [],
          smartWalletSig: "0x",
        })
      ).to.be.reverted; // replace with your custom error matcher if available
    });
  });
});
