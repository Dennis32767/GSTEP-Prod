// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "../core/GemStepCore.sol";
import "../interfaces/IERC1271Upgradeable.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "@openzeppelin/contracts-upgradeable/utils/cryptography/ECDSAUpgradeable.sol";
import "../libs/GemStepTokenLib.sol";

abstract contract GS_StepsAndVerification is GemStepCore {
    using ECDSAUpgradeable for bytes32;

    // ========= External entry ========= //
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

        unchecked { nonces[data.user] = data.nonce + 1; }
    }

    // ========= Validation ========= //
    function _validateStepData(StepSubmission calldata data) internal view {
        require(!paused(), "Contract paused");
        require(block.timestamp >= suspendedUntil[data.user], "Account suspended");
        require(data.beneficiary != address(0), "Invalid beneficiary");
        require(data.steps > 0, "No steps provided");
        require(data.deadline > block.timestamp, "Signature expired");
        require(data.deadline - block.timestamp <= signatureValidityPeriod, "Deadline too far");
        require(data.steps <= stepLimit, "Step limit exceeded");
        require(bytes(data.source).length > 0, "Empty source");
        require(validSources[data.source], "Invalid source");
        require(bytes(data.version).length > 0, "Empty version");
        require(bytes(data.version).length <= MAX_VERSION_LENGTH, "Version too long");

        // Payload version validation (allowlist + deprecation window)
        string memory norm = _normalizeVersion(data.version);
        bytes32 h = keccak256(bytes(norm));
        require(supportedPayloadVersions[h], "Unsupported payload version");
        uint256 dep = payloadVersionDeprecatesAt[h];
        require(dep == 0 || block.timestamp < dep, "Payload version deprecated");
    }

    // ========= EIP-712 Step digest (kept behavior, fewer bytes via lib) ========= //
    function _stepDigest(StepSubmission calldata data) internal view returns (bytes32) {
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
        return GemStepTokenLib.eip712TypedDataHash(_domainSeparatorV4(), structHash);
    }

    // ========= Verification & replay ========= //
    function _processVerification(
    StepSubmission calldata data,
    VerificationData calldata verification
) internal {
    address user = data.user;

    SourceConfig storage config = sourceConfigs[data.source];
    bool needsProof = config.requiresProof;
    bool needsAtt  = config.requiresAttestation;

    // --- Merkle proof (if any) ---
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
        unchecked { config.userNonce[user] = pnonce + 1; }
    }

    // --- Device attestation (nonce-bound if required) ---
    if (needsAtt) {
        _verifyAttestationAndReplay(data, verification.attestation);
    }

    // --- Build digest and verify signature ---
    bytes32 digest = _stepDigest(data);
    address recovered = digest.recover(verification.signature);

    if (isTrustedAPI[msg.sender]) {
        // API path: recovered must hold API_SIGNER_ROLE
        require(hasRole(API_SIGNER_ROLE, recovered), "Unauthorized API signer");
    } else {
        // User/contract path
        if (user.code.length > 0) {
            require(trustedERC1271Contracts[user], "Untrusted ERC1271 contract");
            require(
                IERC1271Upgradeable(user).isValidSignature(digest, verification.signature) == 0x1626ba7e,
                "Invalid contract signature"
            );
            require(!used1271Digests[user][digest], "ERC1271 digest already used");
            used1271Digests[user][digest] = true;
        } else {
            if (!hasRole(API_SIGNER_ROLE, recovered)) {
                require(recovered == user, "Signer must be user");
            }
        }
    }

    // ✅ IMPORTANT FIX:
    // Enforce daily cap + min interval for BOTH user and trusted API calls.
    // _applyFraudPrevention already skips stake checks for isTrustedAPI[msg.sender].
    _applyFraudPrevention(user, data.steps, data.source);

    // ✅ IMPORTANT FIX:
    // Always update daily totals + lastSubmission so repeats get blocked.
    // (We’ll make anomaly penalties optional for trusted API in the next drop-in.)
    _recordSubmissionAndAnomaly(user, data.steps, data.source);

    // Replay protection for (digest, signature) pair
    bytes32 sigHash = keccak256(abi.encodePacked(digest, verification.signature));
    require(!usedSignatures[sigHash], "Signature reused");
    usedSignatures[sigHash] = true;
    signatureExpiry[sigHash] = data.deadline + 1;
}

    // ========= Attestation & replay (merged helpers) ========= //
    function _verifyAttestationAndReplay(
        StepSubmission calldata data,
        bytes calldata attestationBlob
    ) internal {
        (address device, uint256 timestamp, string memory attVersion, bytes memory sig) =
            abi.decode(attestationBlob, (address, uint256, string, bytes));

        require(bytes(attVersion).length > 0 && bytes(attVersion).length <= MAX_VERSION_LENGTH, "Bad attest version");

        string memory normAtt = _normalizeVersion(attVersion);
        bytes32 vHash = keccak256(bytes(normAtt));
        require(supportedAttestationVersions[vHash], "Unsupported attestation version");

        uint256 dep = attestationVersionDeprecatesAt[vHash];
        require(dep == 0 || block.timestamp < dep, "Attestation version deprecated");
        require(trustedDevices[device], "Untrusted device");
        require(block.timestamp - timestamp < 1 hours, "Stale attestation");

        // Build struct hash once, depending on whether nonce binding is required
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
            // Legacy one-time-per-device replay guard
            bytes32 attestHashLegacy = _hashTypedDataV4(structHash);
            bytes32 replayKey = keccak256(abi.encodePacked(device, attestHashLegacy));
            require(!usedAttestations[replayKey], "Attestation reused");
            usedAttestations[replayKey] = true;
        }

        bytes32 attestHash = _hashTypedDataV4(structHash);
        require(device == attestHash.recover(sig), "Invalid attestation");
    }

    // ========= Rewards ========= //
    function _updateUserStateAndReward(StepSubmission calldata data) internal {
        lastSource[data.user] = data.source;
        totalSteps[data.user] += data.steps;

        uint256 reward = data.steps * rewardRate;
        require(reward >= MIN_REWARD_AMOUNT, "Reward too small");
        // overflow already checked by solidity ^0.8 on multiplication; no need for extra guard

        _mintWithCap(data.beneficiary, reward);

        // Emit normalized version for consistency in analytics
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
