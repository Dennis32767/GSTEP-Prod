// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "../core/GemStepCore.sol";
import "../interfaces/IERC1271Upgradeable.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "@openzeppelin/contracts-upgradeable/utils/cryptography/ECDSAUpgradeable.sol";
import "../libs/GemStepTokenLib.sol";

/// @title GS_StepsAndVerification
/// @notice Step submission entrypoint and verification pipeline (EIP-712 signatures, optional merkle proof,
///         optional device attestation, replay protection) with reward minting.
/// @dev
///  - External entry: {logSteps}
///  - Validates:
///      - caller authorization (user or trusted API)
///      - nonce sequencing
///      - payload fields (deadline, step limits, source validity, payload version allowlist/deprecation)
///  - Verification:
///      - optional merkle proof per-source (nonce tracked per-user within source config)
///      - optional device attestation (versioned; optionally nonce-bound; supports legacy replay guard)
///      - EIP-712 signature validation:
///          - API path: recovered signer must have {API_SIGNER_ROLE}
///          - User path:
///              - EOA: signer must be user OR (optionally) an API_SIGNER_ROLE key
///              - Contract wallet: ERC-1271 validation gated by {trustedERC1271Contracts}
///  - Fraud controls:
///      - Calls {_applyFraudPrevention} for BOTH user and trusted API calls
///      - Calls {_recordSubmissionAndAnomaly} for BOTH paths (penalties may be skipped in module for API)
///  - Replay protection:
///      - per-(digest, signature) hash cache with expiry tracking
///      - per-user digest cache for ERC-1271 wallets
///      - per-leaf cache for merkle leaves
abstract contract GS_StepsAndVerification is GemStepCore {
    using ECDSAUpgradeable for bytes32;

    /* =============================================================
                               EXTERNAL ENTRY
       ============================================================= */

    /// @notice Submit steps for verification and mint reward to beneficiary.
    /// @param data Step submission payload (user, beneficiary, steps, nonce, deadline, chainId, source, version).
    /// @param verification Verification bundle (signature, optional merkle proof, optional attestation blob).
    /// @dev
    ///  - Reentrancy guarded.
    ///  - Blocked while paused.
    ///  - Requires caller to be the user OR a trusted API relayer.
    ///  - Requires `data.nonce` equals current `nonces[data.user]` and increments after success.
    function logSteps(
        StepSubmission calldata data,
        VerificationData calldata verification
    ) external nonReentrant whenNotPaused {
        require(
            isTrustedAPI[msg.sender] || msg.sender == data.user,
            "Caller must be user or trusted API"
        );
        require(data.nonce == nonces[data.user], "Invalid nonce");

        _validateStepData(data);
        _processVerification(data, verification);
        _updateUserStateAndReward(data);

        unchecked {
            nonces[data.user] = data.nonce + 1;
        }
    }

    /* =============================================================
                                 VALIDATION
       ============================================================= */

    /// @notice Validate step submission fields and payload version allowlist/deprecation.
    /// @param data Step submission payload.
    /// @dev Reverts with descriptive messages used by tests/clients.
    function _validateStepData(StepSubmission calldata data) internal view {
        require(!paused(), "Contract paused");
        require(block.timestamp >= suspendedUntil[data.user], "Account suspended");

        require(data.beneficiary != address(0), "Invalid beneficiary");
        require(data.steps > 0, "No steps provided");

        require(data.deadline > block.timestamp, "Signature expired");
        require(
            data.deadline - block.timestamp <= signatureValidityPeriod,
            "Deadline too far"
        );

        require(data.steps <= stepLimit, "Step limit exceeded");

        require(bytes(data.source).length > 0, "Empty source");
        require(validSources[data.source], "Invalid source");

        require(bytes(data.version).length > 0, "Empty version");
        require(bytes(data.version).length <= MAX_VERSION_LENGTH, "Version too long");

        // Payload version allowlist + deprecation window.
        string memory norm = _normalizeVersion(data.version);
        bytes32 h = keccak256(bytes(norm));
        require(supportedPayloadVersions[h], "Unsupported payload version");

        uint256 dep = payloadVersionDeprecatesAt[h];
        require(dep == 0 || block.timestamp < dep, "Payload version deprecated");
    }

    /* =============================================================
                         EIP-712 STEP DIGEST (LIB)
       ============================================================= */

    /// @notice Compute the EIP-712 digest for a step submission.
    /// @param data Step submission payload.
    /// @return digest Typed-data digest that must be signed/validated.
    /// @dev Uses {GemStepTokenLib} to reduce bytecode and preserve behavior.
    function _stepDigest(StepSubmission calldata data) internal view returns (bytes32 digest) {
        string memory normPayload = _normalizeVersion(data.version);

        bytes32 structHash = GemStepTokenLib.stepStructHash(
            STEPLOG_TYPEHASH,
            data.user,
            data.beneficiary,
            data.steps,
            data.nonce,
            data.deadline,
            block.chainid,
            keccak256(bytes(data.source)),
            keccak256(bytes(normPayload))
        );

        digest = GemStepTokenLib.eip712TypedDataHash(_domainSeparatorV4(), structHash);
    }

    /* =============================================================
                         VERIFICATION + REPLAY GUARDS
       ============================================================= */

    /// @notice Validate proof/attestation/signature, then apply fraud & replay protection.
    /// @param data Step submission payload.
    /// @param verification Verification bundle.
    /// @dev
    ///  - Merkle proof:
    ///      - leaf = keccak256(abi.encode(user, steps, per-user nonce))
    ///      - leaf must be unused; nonce increments on success
    ///  - Attestation:
    ///      - version allowlist + optional nonce-binding + device trust + freshness
    ///  - Signature:
    ///      - API path: signer must have {API_SIGNER_ROLE}
    ///      - User path:
    ///          - ERC1271 contract wallets supported if trusted
    ///          - EOAs: signer must be user unless signer holds {API_SIGNER_ROLE}
    ///  - Fraud & anomaly hooks are applied for both user and API callers.
    ///  - Signature replay protection via (digest, signature) hash.
    function _processVerification(
        StepSubmission calldata data,
        VerificationData calldata verification
    ) internal {
        address user = data.user;

        SourceConfig storage config = sourceConfigs[data.source];
        bool needsProof = config.requiresProof;
        bool needsAtt = config.requiresAttestation;

        /* -------------------------- Merkle proof -------------------------- */
        if (needsProof) {
            require(verification.proof.length <= MAX_PROOF_LENGTH, "Proof too long");

            uint256 pnonce = config.userNonce[user];
            bytes32 leaf = keccak256(abi.encode(user, data.steps, pnonce));

            require(!usedLeaves[leaf], "Leaf already used");
            usedLeaves[leaf] = true;

            require(
                MerkleProof.verifyCalldata(verification.proof, config.merkleRoot, leaf),
                "Invalid proof"
            );

            unchecked {
                config.userNonce[user] = pnonce + 1;
            }
        }

        /* ------------------------ Device attestation ---------------------- */
        if (needsAtt) {
            _verifyAttestationAndReplay(data, verification.attestation);
        }

        /* ---------------------- EIP-712 signature check ------------------- */
        bytes32 digest = _stepDigest(data);
        address recovered = digest.recover(verification.signature);

        if (isTrustedAPI[msg.sender]) {
            // API path: recovered signer must hold API_SIGNER_ROLE.
            require(hasRole(API_SIGNER_ROLE, recovered), "Unauthorized API signer");
        } else {
            // User/contract path
            if (user.code.length > 0) {
                // ERC-1271 contract wallet path
                require(trustedERC1271Contracts[user], "Untrusted ERC1271 contract");
                require(
                    IERC1271Upgradeable(user).isValidSignature(digest, verification.signature) ==
                        0x1626ba7e,
                    "Invalid contract signature"
                );

                require(!used1271Digests[user][digest], "ERC1271 digest already used");
                used1271Digests[user][digest] = true;
            } else {
                // EOA path:
                // If recovered is an API signer key, allow it; otherwise recovered must equal user.
                if (!hasRole(API_SIGNER_ROLE, recovered)) {
                    require(recovered == user, "Signer must be user");
                }
            }
        }

        /* ---------------------- Fraud prevention hooks -------------------- */
        // Enforce daily cap + min interval for BOTH user and trusted API calls.
        // The fraud module can skip stake checks for trusted API.
        _applyFraudPrevention(user, data.steps, data.source);

        // Always record timing and daily totals. Fraud module may skip penalties for trusted API.
        _recordSubmissionAndAnomaly(user, data.steps, data.source);

        /* -------------------- Replay protection (sig hash) ---------------- */
        bytes32 sigHash = keccak256(abi.encodePacked(digest, verification.signature));
        require(!usedSignatures[sigHash], "Signature reused");

        usedSignatures[sigHash] = true;
        // Keep expiry slightly past deadline for batch cleanup convenience.
        signatureExpiry[sigHash] = data.deadline + 1;
    }

    /* =============================================================
                      ATTESTATION VALIDATION + REPLAY
       ============================================================= */

    /// @notice Verify a device attestation, enforce allowlist/deprecation, and apply legacy replay guard.
    /// @param data Step submission payload.
    /// @param attestationBlob ABI-encoded (device, timestamp, version, signature).
    /// @dev
    ///  - Attestation freshness window is hard-coded to 1 hour here.
    ///  - If {attestationRequiresNonce[vHash]} is true, uses ATTESTATION_V2_TYPEHASH
    ///    and binds to {data.nonce}.
    ///  - If nonce-binding is not required, uses legacy replay guard keyed by (device, typedHash).
    function _verifyAttestationAndReplay(
        StepSubmission calldata data,
        bytes calldata attestationBlob
    ) internal {
        (address device, uint256 timestamp, string memory attVersion, bytes memory sig) =
            abi.decode(attestationBlob, (address, uint256, string, bytes));

        require(
            bytes(attVersion).length > 0 && bytes(attVersion).length <= MAX_VERSION_LENGTH,
            "Bad attest version"
        );

        string memory normAtt = _normalizeVersion(attVersion);
        bytes32 vHash = keccak256(bytes(normAtt));
        require(supportedAttestationVersions[vHash], "Unsupported attestation version");

        uint256 dep = attestationVersionDeprecatesAt[vHash];
        require(dep == 0 || block.timestamp < dep, "Attestation version deprecated");

        require(trustedDevices[device], "Untrusted device");
        require(block.timestamp - timestamp < 1 hours, "Stale attestation");

        // Build struct hash once, depending on whether nonce binding is required.
        bytes32 structHash;
        if (attestationRequiresNonce[vHash]) {
            structHash = keccak256(
                abi.encode(
                    ATTESTATION_V2_TYPEHASH,
                    data.user,
                    data.steps,
                    timestamp,
                    vHash,
                    data.nonce
                )
            );
        } else {
            structHash = keccak256(
                abi.encode(
                    ATTESTATION_TYPEHASH,
                    data.user,
                    data.steps,
                    timestamp,
                    vHash
                )
            );

            // Legacy: one-time-per-device replay guard
            bytes32 attestHashLegacy = _hashTypedDataV4(structHash);
            bytes32 replayKey = keccak256(abi.encodePacked(device, attestHashLegacy));
            require(!usedAttestations[replayKey], "Attestation reused");
            usedAttestations[replayKey] = true;
        }

        bytes32 attestHash = _hashTypedDataV4(structHash);
        require(device == attestHash.recover(sig), "Invalid attestation");
    }

    /* =============================================================
                                REWARDS
       ============================================================= */

    /// @notice Update per-user tracking state and mint rewards to beneficiary.
    /// @param data Step submission payload.
    /// @dev
    ///  - Updates last source and cumulative step counter.
    ///  - Enforces minimum submission size via {MIN_STEPS}.
    ///  - reward = steps * rewardRate, minted via {_mintWithCap}.
    ///  - Emits {RewardClaimed} with normalized payload version for analytics consistency.
    function _updateUserStateAndReward(StepSubmission calldata data) internal {
        lastSource[data.user] = data.source;
        totalSteps[data.user] += data.steps;

        // Minimum viable submission guard (allows 1-step submissions if MIN_STEPS == 1).
        require(data.steps >= MIN_STEPS, "Steps below minimum");

        uint256 reward = data.steps * rewardRate;
        _mintWithCap(data.beneficiary, reward);

        string memory normPayload = _normalizeVersion(data.version);
        emit RewardClaimed(
            data.user,
            data.beneficiary,
            data.steps,
            reward,
            block.timestamp,
            data.source,
            normPayload
        );
    }
}
