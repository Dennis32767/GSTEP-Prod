/* eslint-disable no-undef */
const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * Minimal ABI that only declares your custom errors.
 * Add/remove error signatures to match your Solidity exactly.
 */
const ERROR_ABI = [
  "error InvalidNonce()",
  "error SignatureExpired()",
  "error StepLimitExceeded()",
  "error EmergencyDelayNotPassed()",
  "error UnsupportedVersion()",
  "error CallerNotUserOrApi()",
  "error CooldownActive()",
  "error StakeParamsLocked()",
  "error StakeOutOfBounds()",
  "error SignerMustBeUser()",
  "error Unauthorized()",
];

/**
 * Build a "decoder contract" at the same address as `token` but with the error ABI
 * so chai/ethers can decode custom errors in prod builds.
 *
 * NOTE: We return a Contract wired with the **same runner** (signer/provider) as `token`.
 */
async function withErrorDecoder(token) {
  return new ethers.Contract(await token.getAddress(), ERROR_ABI, token.runner);
}

/** Alias for convenience if you prefer this name in your tests. */
async function mkErrorDecoderAt(token) {
  return withErrorDecoder(token);
}

/**
 * Universal revert assertion:
 *  1) Try custom error (prod / dev)
 *  2) Fallback to revert string (dev with revertStrings=default)
 *  3) Optionally accept bare `revert` if:
 *       - process.env.ALLOW_GENERIC_REVERTS === "1"
 *       - or SOLIDITY_COVERAGE is set (coverage sometimes strips reasons)
 *
 * Usage:
 *   const err = await withErrorDecoder(token);
 *   await expectRevert(tx, err, "InvalidNonce", "Invalid nonce");
 */
async function expectRevert(txPromise, decoder, customErrorName, fallbackReason) {
  const allowGeneric =
    process.env.ALLOW_GENERIC_REVERTS === "1" ||
    process.env.SOLIDITY_COVERAGE === "1" ||
    process.env.SOLIDITY_COVERAGE === "true";

  // 1) custom error path
  try {
    await expect(txPromise).to.be.revertedWithCustomError(decoder, customErrorName);
    return;
  } catch (_) {}

  // 2) legacy revert string path
  try {
    await expect(txPromise).to.be.revertedWith(fallbackReason);
    return;
  } catch (_) {}

  // 3) bare revert fallback (optional)
  if (allowGeneric) {
    await expect(txPromise).to.be.reverted;
    return;
  }

  // If all failed, surface a clear message
  throw new Error(
    `Expected revert didn't match either path. Tried custom error "${customErrorName}" ` +
    `then string "${fallbackReason}". Set ALLOW_GENERIC_REVERTS=1 (or run under solidity-coverage) to accept plain reverts.`
  );
}

module.exports = {
  ERROR_ABI,
  withErrorDecoder,
  mkErrorDecoderAt,   // alias
  expectRevert,
};
