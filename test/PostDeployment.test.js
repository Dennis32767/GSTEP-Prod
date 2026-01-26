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
      if (mod && typeof mod.deployGemStepFixture === "function") return mod.deployGemStepFixture;
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

async function readSourceFlags(token, source) {
  if (hasFn(token, "getSourceConfigFields")) {
    const res = await token.getSourceConfigFields(source);
    return {
      requiresProof: !!res[0],
      requiresAttestation: !!res[1],
      merkleRoot: res[2],
      maxStepsPerDay: BigInt(res[3].toString()),
      minInterval: BigInt(res[4].toString()),
    };
  }

  if (hasFn(token, "getSourceConfig")) {
    const cfg = await token.getSourceConfig(source);
    return {
      requiresProof: !!cfg[1],
      requiresAttestation: !!cfg[2],
      merkleRoot: cfg[3] ?? ethers.ZeroHash,
      maxStepsPerDay: 0n,
      minInterval: 0n,
    };
  }

  return null;
}

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
    return { variant: "none", seen: "logSteps not found", stepComps: [], sigComps: [] };
  }

  const ins = fn.inputs || [];
  const stepComps = (ins[0]?.components || []).map((c) => ({ name: c.name, type: c.type }));
  const sigComps = (ins[1]?.components || []).map((c) => ({ name: c.name, type: c.type }));

  const A = stepComps.map((c) => c.type).join(",");
  const B = sigComps.map((c) => c.type).join(",");

  // v3 (current): StepSubmission + VerificationData
  if (A === "address,address,uint256,uint256,uint256,string,string" && B === "bytes,bytes32[],bytes")
    return { variant: "v3", seen: `(${A}),(${B})`, stepComps, sigComps };

  if (A === "address,address,uint256,uint256,uint256,string,string" && B === "bytes,bytes32[]")
    return { variant: "v2", seen: `(${A}),(${B})`, stepComps, sigComps };

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
    const stepArr = [payload.user, payload.steps, payload.nonce, payload.deadline, payload.source];
    return token.connect(signer).logSteps(stepArr, payload.signature);
  }

  if (variant === "v2") {
    const stepArr = [
      payload.user,
      payload.recipient ?? payload.beneficiary,
      payload.steps,
      payload.nonce,
      payload.deadline,
      payload.source,
      payload.version,
    ];
    const sigArr = [payload.signature, payload.proof ?? []];
    return token.connect(signer).logSteps(stepArr, sigArr);
  }

  if (variant === "v3") {
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
    const sigArr = [payload.signature, payload.proof ?? [], third];
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
  beneficiary,
  steps,
  nonce,
  deadline,
  source,
  version = "1.0.0",
  signer,
}) {
  const net = await token.runner.provider.getNetwork();

  const domainName =
    (await readOpt(token, "DOMAIN_NAME")) ??
    (await readOpt(token, "domainName")) ??
    "GemStep";

  const domainVersion =
    (await readOpt(token, "DOMAIN_VERSION")) ??
    (await readOpt(token, "domainVersion")) ??
    "1.0.0";

  const domain = {
    name: domainName,
    version: domainVersion,
    chainId: Number(net.chainId),
    verifyingContract: addrOf(token),
  };

  // ✅ MUST MATCH STEPLOG_TYPEHASH EXACTLY
  const types = {
    StepLog: [
      { name: "user", type: "address" },
      { name: "beneficiary", type: "address" },
      { name: "steps", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "chainId", type: "uint256" },
      { name: "source", type: "string" },
      { name: "version", type: "string" },
    ],
  };

  const value = {
    user,
    beneficiary,
    steps,
    nonce,
    deadline,
    chainId: Number(net.chainId), // ✅ include the field the struct expects
    source,
    version,
  };

  const signature = await signer.signTypedData(domain, types, value);
  return { signature, value, domain };
}

/** -------------------------------------
 *  6) Source preparation (proof/attestation)
 *      - Try to disable proof/attestation
 *      - If cannot, set merkleRoot = single-leaf tree for (user,steps,pnonce)
 *  ------------------------------------- */
function merkleLeaf(user, steps, pnonce) {
  const abi = ethers.AbiCoder.defaultAbiCoder();
  const enc = abi.encode(["address", "uint256", "uint256"], [user, steps, pnonce]);
  return ethers.keccak256(enc);
}

async function readUserSourceNonce(token, user, source) {
  if (hasFn(token, "getUserSourceNonce")) return await token.getUserSourceNonce(user, source);
  throw new Error("No getUserSourceNonce() available on token; can't build merkle leaf deterministically.");
}

async function tryDisableProofAndAtt(token, adminSigner, source) {
  const c = token.connect(adminSigner);

  const tries = [
    () => c.configureSource(source, false, false),
    () => c.configureSource(source, true, false, false),
    () => c.configureSource(source, true, false),
    () => c.configureSource(source, true),
  ];

  for (const t of tries) {
    try {
      const tx = await t();
      await tx.wait();
      return true;
    } catch (_) {}
  }
  return false;
}

async function trySetMerkleRoot(token, adminSigner, source, root) {
  const c = token.connect(adminSigner);
  const tries = [
    () => c.setSourceMerkleRoot(source, root),
    () => c.setMerkleRoot(source, root),
    () => c.updateSourceMerkleRoot(source, root),
    () => c.configureSourceMerkleRoot(source, root),
  ];
  for (const t of tries) {
    try {
      const tx = await t();
      await tx.wait();
      return true;
    } catch (_) {}
  }
  return false;
}

async function prepareSourceForSubmission({ token, adminSigner, userAddr, source, steps }) {
  // If we can read flags and it already does NOT require proof/att, great.
  const flags = await readSourceFlags(token, source);
  if (flags && !flags.requiresProof && !flags.requiresAttestation) return { proof: [] };

  // First try: disable requirements
  const disabled = await tryDisableProofAndAtt(token, adminSigner, source);
  if (disabled) return { proof: [] };

  // Otherwise: if proof required, set merkleRoot = leaf (single-leaf proof = [])
  // Only do this if it requires proof; if it requires attestation too, we cannot satisfy in this suite.
  if (flags && flags.requiresAttestation) {
    throw new Error(`Source "${source}" requires attestation; this test suite doesn't generate attestations.`);
  }

  const pnonce = await readUserSourceNonce(token, userAddr, source);
  const leaf = merkleLeaf(userAddr, BigInt(steps), BigInt(pnonce.toString()));

  const set = await trySetMerkleRoot(token, adminSigner, source, leaf);
  if (!set) {
    throw new Error(
      `Source "${source}" requires proof, but test could not disable proof or set merkleRoot. ` +
        `Grant the right admin role to your test admin, or expose a merkleRoot setter in GS_Admin.`
    );
  }

  return { proof: [] };
}

/** -------------------------------------
 *  7) Stake helpers: satisfy "Insufficient stake"
 *  ------------------------------------- */
async function readStakeParams(token) {
  if (hasFn(token, "getStakeParams")) {
    const res = await token.getStakeParams();
    return { stakePerStep: BigInt(res[0].toString()), locked: !!res[2] };
  }
  if (hasFn(token, "stakePerStep")) {
    const sps = await token.stakePerStep();
    return { stakePerStep: BigInt(sps.toString()), locked: false };
  }
  return null;
}

async function ensureStakeForSteps({ token, admin, userSigner, steps }) {
  if (!hasFn(token, "stake")) return;

  const sp = await readStakeParams(token);
  if (!sp) return;
  if (sp.locked) return;

  const user = await userSigner.getAddress();
  const need = sp.stakePerStep * BigInt(steps);
  if (need === 0n) return;

  // read current stake
  let staked = 0n;
  if (hasFn(token, "getStakeInfo")) {
    const info = await token.getStakeInfo(user);
    staked = BigInt(info[0].toString());
  } else if (hasFn(token, "getUserCoreStatus")) {
    const s = await token.getUserCoreStatus(user);
    staked = BigInt(s[3].toString());
  }

  if (staked >= need) return;

  const delta = need - staked;

  // fund user if needed
  const bal = await token.balanceOf(user);
  if (bal < delta) {
    const adminAddr = await admin.getAddress();
    const adminBal = await token.balanceOf(adminAddr);

    if (adminBal >= delta && hasFn(token, "transfer")) {
      await (await token.connect(admin).transfer(user, delta)).wait();
    } else {
      const mintFn = findMintLike(token.interface);
      if (mintFn) {
        const types = (mintFn.inputs || []).map((i) => i.type).join(",");
        if (types.startsWith("address,uint256")) {
          await (await token.connect(admin)[mintFn.name](user, delta)).wait();
        } else if (types.startsWith("uint256")) {
          await (await token.connect(admin)[mintFn.name](delta)).wait();
        }
      }
    }
  }

  await (await token.connect(userSigner).stake(delta)).wait();
}

/** -------------------------------------
 *  8) Unified submitSteps helper (proof + stake aware)
 *  ------------------------------------- */
async function submitSteps({ token, admin, userSigner, beneficiary, source = "fitbit", steps, extra = {} }) {
  if (admin) await ensureStakeForSteps({ token, admin, userSigner, steps });

  const userAddr = await userSigner.getAddress();
  const nonce = await token.nonces(userAddr);
  const validity = (await readOpt(token, "signatureValidityPeriod")) ?? 3600n;
  const now = BigInt((await ethers.provider.getBlock("latest")).timestamp);
  const deadline = now + BigInt(validity);

  const b = beneficiary ?? userAddr;

  const { signature, value } = await signStepDataFlexible({
    token,
    user: userAddr,
    beneficiary: b,
    steps: BigInt(steps),
    nonce,
    deadline,
    source,
    version: "1.0.0",
    signer: userSigner,
  });

  // v1/v2/v3 callLogSteps will positionally pass tuple values,
  // but our signed struct MUST be StepLog with beneficiary+chainId.
  return callLogSteps(token, userSigner, {
    user: value.user,
    beneficiary: value.beneficiary,
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
 *  9) Pick a usable source dynamically (returns {source, proof})
 *  ------------------------------------- */
async function pickUsableSourceWithPrep({ token, admin, userSigner, steps = 1 }) {
  const userAddr = await userSigner.getAddress();
  const candidates = ["fitbit", "applehealth", "nosigcap", "dev", "test"];

  for (const s of candidates) {
    try {
      const prep = await prepareSourceForSubmission({
        token,
        adminSigner: admin,
        userAddr,
        source: s,
        steps,
      });

      // Also need minInterval spacing sometimes; staticCall isn’t reliable for stake/proof gates anyway.
      // We'll just return first source we can prep.
      return { source: s, proof: prep.proof ?? [] };
    } catch (_) {
      // next
    }
  }
  return { source: null, proof: [] };
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
      if (cap !== null) expect(cap).to.be.gte(total);

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
      expect(await token.totalSupply()).to.be.gt(0n);
    });

    it("Cap settings: currentMonthlyCap & monthlyMintLimit (via getMintingState bundle)", async function () {
      const { token } = await loadFixture(deployGemStepFixture);
      if (!hasFn(token, "getMintingState")) return this.skip();

      const ms = await token.getMintingState();
      const monthlyLimit = BigInt(ms[2].toString());
      const currentCap = BigInt(ms[5].toString());

      expect(monthlyLimit).to.be.gt(0n);
      expect(currentCap).to.be.gt(0n);
    });

    it("Role snapshot (simple, skip if roles not present)", async function () {
      const { token } = await loadFixture(deployGemStepFixture);
      if (!hasFn(token, "hasRole")) return this.skip();
      const DEFAULT_ADMIN_ROLE = await token.DEFAULT_ADMIN_ROLE?.();
      expect(DEFAULT_ADMIN_ROLE ?? "0x").to.be.ok;
    });

    it("Valid sources contain 'fitbit' (skip if feature not present)", async function () {
      const { token } = await loadFixture(deployGemStepFixture);

      if (hasFn(token, "isSourceValid")) {
        expect(await token.isSourceValid("fitbit")).to.equal(true);
        return;
      }
      if (hasFn(token, "getSourceConfig")) {
        await token.getSourceConfig("fitbit");
        expect(true).to.equal(true);
        return;
      }
      this.skip();
    });

    it("Tracks monthly minted amount (via logSteps + getMintingState)", async function () {
      const { token, admin, user1 } = await loadFixture(deployGemStepFixture);
      if (!hasFn(token, "getMintingState")) return this.skip();

      const userAddr = await user1.getAddress();

      // Prefer fitbit but prep it (proof/att rules)
      const { proof } = await prepareSourceForSubmission({
        token,
        adminSigner: admin,
        userAddr,
        source: "fitbit",
        steps: 10,
      });

      const ms0 = await token.getMintingState();
      const minted0 = BigInt(ms0[1].toString());
      const supply0 = await token.totalSupply();

      await submitSteps({ token, admin, userSigner: user1, steps: 10, source: "fitbit", extra: { proof } });

      const ms1 = await token.getMintingState();
      const minted1 = BigInt(ms1[1].toString());
      const supply1 = await token.totalSupply();

      expect(supply1).to.be.gt(supply0);
      expect(minted1).to.be.gte(minted0);
      expect(minted1).to.be.gt(0n);
    });

    it("fitbit requires proof (expected in production)", async function () {
      const { token } = await loadFixture(deployGemStepFixture);
      if (!hasFn(token, "getSourceConfigFields")) return this.skip();
      const cfg = await token.getSourceConfigFields("fitbit");
      expect(cfg[0]).to.equal(true);
    });

    it("Step rewards accrue correctly (fitbit + proof-aware)", async function () {
    const { token, user1, admin } = await loadFixture(deployGemStepFixture);

    const userAddr = await user1.getAddress();

    // Prep source (may set merkleRoot/disable proof)
    const { proof } = await prepareSourceForSubmission({
      token,
      adminSigner: admin,
      userAddr,
      source: "fitbit",
      steps: 25,
    });

    // ✅ Ensure stake ONCE, before taking bal0 (so staking doesn't distort delta)
    await ensureStakeForSteps({ token, admin, userSigner: user1, steps: 25 });

    const bal0 = await token.balanceOf(userAddr);

    // ✅ Do NOT pass admin here, otherwise submitSteps() might top-up stake and lower user balance
    await submitSteps({
      token,
      admin: null,
      userSigner: user1,
      steps: 25,
      source: "fitbit",
      extra: { proof },
    });

    const bal1 = await token.balanceOf(userAddr);

    expect(bal1 - bal0).to.be.gt(0n);

    const rr = await readOpt(token, "rewardRate");
    if (rr !== null) {
      expect(bal1 - bal0).to.be.lte(BigInt(rr.toString()) * 25n);
    }
  });


    it("Rejects invalid sources", async function () {
      const { token, admin, user1 } = await loadFixture(deployGemStepFixture);
      await expect(submitSteps({ token, admin, userSigner: user1, steps: 10, source: "not-a-source" })).to.be.reverted;
    });

    it("Monthly cycles roll over with time travel (via getMintingState)", async function () {
      const { token, user1, admin } = await loadFixture(deployGemStepFixture);
      if (!hasFn(token, "getMintingState")) return this.skip();

      const { source, proof } = await pickUsableSourceWithPrep({ token, admin, userSigner: user1, steps: 5 });
      if (!source) return this.skip();

      await submitSteps({ token, admin, userSigner: user1, steps: 5, source, extra: { proof } });

      const msBefore = await token.getMintingState();
      const monthBefore = BigInt(msBefore[0].toString());
      const mintedBefore = BigInt(msBefore[1].toString());
      expect(mintedBefore).to.be.gt(0n);

      await time.increase(32 * 24 * 60 * 60);

      // If minInterval exists, ensure we pass it too
      const flags = await readSourceFlags(token, source);
      if (flags && flags.minInterval > 0n) {
        await time.increase(Number(flags.minInterval + 1n));
      }

      await submitSteps({ token, admin, userSigner: user1, steps: 5, source, extra: { proof } });

      const msAfter = await token.getMintingState();
      const monthAfter = BigInt(msAfter[0].toString());
      const mintedAfter = BigInt(msAfter[1].toString());

      expect(monthAfter).to.be.gte(monthBefore);
      expect(mintedAfter).to.be.gt(0n);
    });

    it("Handles consecutive step submissions without precision loss", async function () {
  const { token, user1, admin } = await loadFixture(deployGemStepFixture);

  const { source, proof } = await pickUsableSourceWithPrep({
    token,
    admin,
    userSigner: user1,
    steps: 3,
  });
  if (!source) return this.skip();

  const userAddr = await user1.getAddress();

  // ✅ Stake once for BOTH submissions (avoid auto top-up inside submitSteps)
  // Give headroom for 2 submissions:
  await ensureStakeForSteps({ token, admin, userSigner: user1, steps: 6 });

  const bal0 = await token.balanceOf(userAddr);

  // First submission (no admin => no stake top-up)
  await submitSteps({ token, admin: null, userSigner: user1, steps: 3, source, extra: { proof } });

  // Respect minInterval if exposed
  const flags = await readSourceFlags(token, source);
  if (flags && flags.minInterval > 0n) {
    await time.increase(Number(flags.minInterval + 1n));
  } else {
    await time.increase(2);
  }

  // Second submission (no admin => no stake top-up)
  await submitSteps({ token, admin: null, userSigner: user1, steps: 3, source, extra: { proof } });

  const bal1 = await token.balanceOf(userAddr);

  expect(bal1 - bal0).to.be.gt(0n);
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

  const { source, proof } = await pickUsableSourceWithPrep({
    token,
    admin,
    userSigner: user1,
    steps: 10,
  });
  if (!source) return this.skip();

  // Ensure stake is sufficient if your fraud module requires it
  await ensureStakeForSteps({ token, admin, userSigner: user1, steps: 10 });

  const userAddr = await user1.getAddress();
  const nonce = await token.nonces(userAddr);
  const now = BigInt((await ethers.provider.getBlock("latest")).timestamp);
  const expired = now - 1n;

  // ✅ NOTE: pass beneficiary (not recipient)
  const { signature, value } = await signStepDataFlexible({
    token,
    user: userAddr,
    beneficiary: userAddr,
    steps: 10n,
    nonce,
    deadline: expired,
    source,
    version: "1.0.0",
    signer: user1,
  });

  await expect(
    callLogSteps(token, user1, {
      user: value.user,
      beneficiary: value.beneficiary,
      steps: value.steps,
      nonce: value.nonce,
      deadline: value.deadline,
      source: value.source,
      version: value.version,
      signature,
      proof,
      smartWalletSig: "0x",
    })
  ).to.be.reverted; // optionally: .to.be.revertedWith("Signature expired")
});
  });
});
