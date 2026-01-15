// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "../core/GemStepCore.sol";

/// @title GS_Admin
/// @notice Administrative module for versions, sources, signers, oracle/treasury, and governance wiring.
/// @dev
///  - Drop-in replacement aligned with GemStepCore semantics:
///    - No fee-on-transfer (handled in GemStepCore/_update)
///    - Mint split (treasury/burn) handled in minting module (not here)
///    - Supply/cap constants live in GemStepStorage
///  - Implements the {_configureSource} hook declared in {GemStepCore}.
///  - Uses hashed/normalized versions to avoid "1.0" vs "1.0.0" allowlist drift.
abstract contract GS_Admin is GemStepCore {
    /* =============================================================
                               VERSION HELPERS
       ============================================================= */

    /// @notice Normalize a version string and compute its keccak256 hash.
    /// @param v Version string.
    /// @return norm Normalized version string (e.g., "1.0" => "1.0.0").
    /// @return h keccak256 hash of the normalized string.
    /// @dev Small helper to avoid repeating normalize+hash patterns.
    function _normHash(string calldata v) internal pure returns (string memory norm, bytes32 h) {
        norm = _normalizeVersion(v);
        h = keccak256(bytes(norm));
    }

    /// @notice Validate version string length to enforce {MAX_VERSION_LENGTH}.
    /// @param v Version string.
    /// @dev Reverts with the canonical "Bad version" message to preserve compatibility.
    function _checkVersionLen(string calldata v) private pure {
        uint256 l = bytes(v).length;
        require(l > 0 && l <= MAX_VERSION_LENGTH, "Bad version");
    }

    /* =============================================================
                        PAYLOAD VERSION ADMINISTRATION
       ============================================================= */

    /// @notice Add a supported payload version (normalized) to the allowlist.
    /// @param version Version string (e.g., "1.0.0" or "1.0").
    /// @dev Requires {PARAMETER_ADMIN_ROLE}.
    function addSupportedPayloadVersion(string calldata version)
        external
        onlyRole(PARAMETER_ADMIN_ROLE)
    {
        _checkVersionLen(version);
        (string memory norm, bytes32 h) = _normHash(version);
        supportedPayloadVersions[h] = true;
        emit PayloadVersionAdded(norm);
    }

    /// @notice Schedule deprecation time for a payload version (does not remove allowlist bit).
    /// @param version Version string.
    /// @param when Unix timestamp after which the version is considered deprecated by consumers.
    /// @dev Requires {PARAMETER_ADMIN_ROLE}.
    function deprecatePayloadVersion(string calldata version, uint256 when)
        external
        onlyRole(PARAMETER_ADMIN_ROLE)
    {
        (string memory norm, bytes32 h) = _normHash(version);
        require(supportedPayloadVersions[h], "Version not supported");
        payloadVersionDeprecatesAt[h] = when;
        emit PayloadVersionDeprecated(norm, when);
    }

    /* =============================================================
                      ATTESTATION VERSION ADMINISTRATION
       ============================================================= */

    /// @notice Legacy wrapper kept for compatibility; enables an attestation version.
    /// @param version Version string.
    /// @dev Requires {PARAMETER_ADMIN_ROLE}. Emits legacy {VersionAdded} event.
    function addSupportedVersion(string calldata version)
        external
        onlyRole(PARAMETER_ADMIN_ROLE)
    {
        _addSupportedAttestationVersion(version);
        emit VersionAdded(version);
    }

    /// @notice Add a supported attestation version (normalized) to the allowlist.
    /// @param version Version string.
    /// @dev Requires {PARAMETER_ADMIN_ROLE}.
    function addSupportedAttestationVersion(string calldata version)
        external
        onlyRole(PARAMETER_ADMIN_ROLE)
    {
        _addSupportedAttestationVersion(version);
    }

    /// @notice Internal worker to add a supported attestation version.
    /// @param version Version string.
    /// @dev
    ///  - Sets {attestationRequiresNonce[h]} to true by default (nonce-binding enforced).
    ///  - Emits {AttestationVersionAdded} for the normalized version.
    function _addSupportedAttestationVersion(string calldata version) internal {
        _checkVersionLen(version);
        (string memory norm, bytes32 h) = _normHash(version);

        supportedAttestationVersions[h] = true;
        attestationRequiresNonce[h] = true;

        emit AttestationVersionAdded(norm);
    }

    /// @notice Schedule deprecation time for an attestation version.
    /// @param version Version string.
    /// @param when Unix timestamp after which the version is considered deprecated by consumers.
    /// @dev Requires {PARAMETER_ADMIN_ROLE}.
    function deprecateAttestationVersion(string calldata version, uint256 when)
        external
        onlyRole(PARAMETER_ADMIN_ROLE)
    {
        (string memory norm, bytes32 h) = _normHash(version);
        require(supportedAttestationVersions[h], "Attest ver not supported");
        attestationVersionDeprecatesAt[h] = when;
        emit AttestationVersionDeprecated(norm, when);
    }

    /// @notice Set whether nonce-binding is required for a particular attestation version.
    /// @param version Version string.
    /// @param required True to enforce nonce-binding; false to relax it.
    /// @dev Requires {PARAMETER_ADMIN_ROLE}.
    function setAttestationNonceRequired(string calldata version, bool required)
        external
        onlyRole(PARAMETER_ADMIN_ROLE)
    {
        (string memory norm, bytes32 h) = _normHash(version);
        require(supportedAttestationVersions[h], "Attest ver not supported");
        attestationRequiresNonce[h] = required;
        emit AttestationNonceRequirementSet(norm, required);
    }

    /* =============================================================
                           ANOMALY / THRESHOLDS
       ============================================================= */

    /// @notice Update anomaly threshold used by anomaly/fraud module(s).
    /// @param newThreshold New threshold (bounded).
    /// @dev Requires {PARAMETER_ADMIN_ROLE}.
    function setAnomalyThreshold(uint256 newThreshold)
        external
        onlyRole(PARAMETER_ADMIN_ROLE)
    {
        require(newThreshold >= 2 && newThreshold <= 10, "bad threshold");
        uint256 old = anomalyThreshold;
        anomalyThreshold = newThreshold;
        emit ParameterUpdated("anomalyThreshold", old, newThreshold);
    }

    /* =============================================================
                            SOURCE ADMINISTRATION
       ============================================================= */

    /// @notice Configure an existing/known source with proof/attestation requirements.
    /// @param source Source key.
    /// @param requiresProof Whether proof is required.
    /// @param requiresAttestation Whether attestation is required.
    /// @dev Requires {PARAMETER_ADMIN_ROLE}. Delegates to {_configureSource}.
    function configureSource(
        string calldata source,
        bool requiresProof,
        bool requiresAttestation
    ) external onlyRole(PARAMETER_ADMIN_ROLE) {
        _configureSource(source, requiresProof, requiresAttestation);
    }

    /// @notice Add a new source key to the registry (alphanumeric only; length bounded).
    /// @param source Source key.
    /// @dev Requires {PARAMETER_ADMIN_ROLE}.
    function addSource(string calldata source) external onlyRole(PARAMETER_ADMIN_ROLE) {
        _addValidSource(source);
    }

    /// @notice Remove (disable) a registered source.
    /// @param source Source key.
    /// @dev Requires {PARAMETER_ADMIN_ROLE}. Does not delete config; only disables validity.
    function removeSource(string calldata source) external onlyRole(PARAMETER_ADMIN_ROLE) {
        require(validSources[source], "Source not registered");
        validSources[source] = false;
        emit SourceRemoved(source);
    }

    /// @notice Set the Merkle root used for a given source (if source supports proof schemes).
    /// @param source Source key.
    /// @param root Merkle root.
    /// @dev Requires {PARAMETER_ADMIN_ROLE}.
    function setSourceMerkleRoot(string calldata source, bytes32 root)
        external
        onlyRole(PARAMETER_ADMIN_ROLE)
    {
        require(validSources[source], "Invalid source");
        sourceConfigs[source].merkleRoot = root;
        emit SourceMerkleRootSet(source, root);
    }

    /* =============================================================
                           TRUST / AUTHZ HELPERS
       ============================================================= */

    /// @notice Trust an on-device signer/device address (used by client auth flows).
    /// @param device Device address.
    /// @dev Requires {PARAMETER_ADMIN_ROLE}.
    function addTrustedDevice(address device) external onlyRole(PARAMETER_ADMIN_ROLE) {
        require(device != address(0), "Invalid device address");
        trustedDevices[device] = true;
        emit TrustedDeviceAdded(device);
    }

    /// @notice Mark an API address as trusted/untrusted.
    /// @param api API address.
    /// @param trusted True to trust; false to untrust.
    /// @dev Requires {PARAMETER_ADMIN_ROLE}.
    function setTrustedAPI(address api, bool trusted) external onlyRole(PARAMETER_ADMIN_ROLE) {
        require(api != address(0), "Invalid API address");
        isTrustedAPI[api] = trusted;
        emit TrustedAPISet(api, trusted);
    }

    /// @notice Trust or untrust an ERC-1271 contract wallet for signature validation flows.
    /// @param contractAddr Contract wallet address.
    /// @param trusted True to trust; false to untrust.
    /// @dev Requires {DEFAULT_ADMIN_ROLE}.
    function setTrusted1271(address contractAddr, bool trusted)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        require(contractAddr != address(0), "Invalid 1271 addr");
        trustedERC1271Contracts[contractAddr] = trusted;
        emit Trusted1271Set(contractAddr, trusted);
    }

    /* =============================================================
                          ORACLE / TREASURY ADMIN
       ============================================================= */

    /// @notice Update the price oracle address.
    /// @param newOracle New oracle address.
    /// @dev Requires {DEFAULT_ADMIN_ROLE}.
    function setPriceOracle(address newOracle) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newOracle != address(0), "Invalid oracle");
        priceOracle = newOracle;
        emit OracleUpdated(newOracle);
    }

    /// @notice Update the treasury address.
    /// @param t New treasury address.
    /// @dev Requires {DEFAULT_ADMIN_ROLE}.
    function setTreasury(address t) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(t != address(0), "Invalid treasury");
        treasury = t;
        emit TreasurySet(t);
    }

    /* =============================================================
                              SIGNER MANAGEMENT
       ============================================================= */

    /// @notice Batch revoke SIGNER_ROLE from addresses.
    /// @param signers Signer addresses.
    /// @dev Requires {DEFAULT_ADMIN_ROLE}. Bounded by {MAX_BATCH_SIGNERS}.
    function batchRemoveSigners(address[] calldata signers) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 len = signers.length;
        require(len <= MAX_BATCH_SIGNERS, "Exceeds max batch size");

        for (uint256 i; i < len; ) {
            address s = signers[i];
            require(hasRole(SIGNER_ROLE, s), "Not a signer");
            _revokeRole(SIGNER_ROLE, s);
            emit SignerRemoved(s);
            unchecked { ++i; }
        }
    }

    /// @notice Batch grant SIGNER_ROLE to addresses.
    /// @param signers Signer addresses.
    /// @dev Requires {DEFAULT_ADMIN_ROLE}. Bounded by {MAX_BATCH_SIGNERS}.
    function batchAddSigners(address[] calldata signers) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 len = signers.length;
        require(len <= MAX_BATCH_SIGNERS, "Exceeds max batch size");

        for (uint256 i; i < len; ) {
            address s = signers[i];
            require(s != address(0), "Invalid signer");
            require(!hasRole(SIGNER_ROLE, s), "Already signer");
            _grantRole(SIGNER_ROLE, s);
            emit SignerAdded(s);
            unchecked { ++i; }
        }
    }

    /* =============================================================
                              SOURCE BATCHING
       ============================================================= */

    /// @notice Batch add sources using the same validation rules as {addSource}.
    /// @param sources Source keys.
    /// @dev Requires {PARAMETER_ADMIN_ROLE}. Bounded by {MAX_BATCH_SOURCES}.
    function batchAddSources(string[] calldata sources) external onlyRole(PARAMETER_ADMIN_ROLE) {
        uint256 len = sources.length;
        require(len <= MAX_BATCH_SOURCES, "Exceeds max batch size");

        for (uint256 i; i < len; ) {
            _addValidSource(sources[i]);
            unchecked { ++i; }
        }
    }

    /* =============================================================
                        SIGNATURE CACHE MAINTENANCE
       ============================================================= */

    /// @notice Clear used-signature cache entries that are expired.
    /// @param sigHashes Signature hashes to check/clear.
    /// @dev
    ///  - Requires {PARAMETER_ADMIN_ROLE}.
    ///  - Bounded by {MAX_SIGNATURE_CLEARANCE}.
    ///  - Only clears entries where expiry != 0 and expiry < block.timestamp.
    function clearExpiredSignatures(bytes32[] calldata sigHashes)
        external
        onlyRole(PARAMETER_ADMIN_ROLE)
    {
        uint256 len = sigHashes.length;
        require(len <= MAX_SIGNATURE_CLEARANCE, "Exceeds max clearance batch");

        uint256 nowTs = block.timestamp;
        for (uint256 i; i < len; ) {
            bytes32 h = sigHashes[i];
            uint256 exp = signatureExpiry[h];
            if (exp != 0 && exp < nowTs) {
                delete usedSignatures[h];
                delete signatureExpiry[h];
                emit SignatureCleared(h);
            }
            unchecked { ++i; }
        }
    }

    /* =============================================================
                            GOVERNANCE / MULTISIG
       ============================================================= */

    /// @notice Transfer key admin roles from {initialAdmin} to {multisig} (one-time).
    /// @dev
    ///  - Requires {DEFAULT_ADMIN_ROLE}.
    ///  - Callable only by {initialAdmin}.
    ///  - Sets {adminRoleTransferred} to prevent re-entry.
    ///  - Revokes a fixed list of roles from {initialAdmin} then grants DEFAULT_ADMIN_ROLE to {multisig}.
    function transferAdminRoles() external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(msg.sender == initialAdmin, "Only initial admin");
        require(!adminRoleTransferred, "Already transferred");
        require(multisig != address(0), "Multisig not set");

        bytes32[7] memory roles = [
            DEFAULT_ADMIN_ROLE,
            PAUSER_ROLE,
            MINTER_ROLE,
            SIGNER_ROLE,
            PARAMETER_ADMIN_ROLE,
            EMERGENCY_ADMIN_ROLE,
            UPGRADER_ROLE
        ];

        for (uint256 i; i < roles.length; ) {
            _revokeRole(roles[i], initialAdmin);
            unchecked { ++i; }
        }

        _grantRole(DEFAULT_ADMIN_ROLE, multisig);

        adminRoleTransferred = true;
        emit AdminRolesTransferred(multisig);
    }

    /// @notice Set the multisig address used as the governance sink.
    /// @param m Multisig address.
    /// @dev Requires {DEFAULT_ADMIN_ROLE}.
    function setMultisig(address m) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(m != address(0), "Invalid multisig");
        multisig = m;
        emit MultisigSet(m);
    }

    /* =============================================================
                      INTERNAL HELPERS (SOURCE REGISTRY)
       ============================================================= */

    /// @inheritdoc GemStepCore
    /// @dev
    ///  - Marks the source as valid and writes its config defaults:
    ///    - merkleRoot = 0
    ///    - maxStepsPerDay = MAX_STEPS_PER_DAY
    ///    - minInterval  = MIN_SUBMISSION_INTERVAL
    ///  - Emits {SourceConfigured}.
    function _configureSource(
        string memory source,
        bool requiresProof,
        bool requiresAttestation
    ) internal override {
        validSources[source] = true;

        SourceConfig storage config = sourceConfigs[source];
        config.requiresProof = requiresProof;
        config.requiresAttestation = requiresAttestation;
        config.merkleRoot = bytes32(0);
        config.maxStepsPerDay = MAX_STEPS_PER_DAY;
        config.minInterval = MIN_SUBMISSION_INTERVAL;

        emit SourceConfigured(source, requiresProof, requiresAttestation);
    }

    /// @notice Add a new source key after validation.
    /// @param source Source key.
    /// @dev
    ///  - Authorized if caller has {PARAMETER_ADMIN_ROLE} OR is the contract itself
    ///    (enables timelock/self-calls if you route through governance).
    ///  - Enforces [MIN_SOURCE_LENGTH, MAX_SOURCE_LENGTH] and alphanumeric-only characters.
    ///  - Sets {validSources[source]} to true and emits {SourceAdded}.
    function _addValidSource(string calldata source) internal {
        require(
            hasRole(PARAMETER_ADMIN_ROLE, msg.sender) || msg.sender == address(this),
            "Unauthorized"
        );

        bytes memory b = bytes(source);
        uint256 len = b.length;

        require(len >= MIN_SOURCE_LENGTH, "Source too short");
        require(len <= MAX_SOURCE_LENGTH, "Source too long");
        require(!validSources[source], "Source already exists");

        for (uint256 i; i < len; ) {
            bytes1 c = b[i];
            bool ok =
                (c >= 0x61 && c <= 0x7A) || // a-z
                (c >= 0x41 && c <= 0x5A) || // A-Z
                (c >= 0x30 && c <= 0x39);   // 0-9
            require(ok, "Invalid source characters");
            unchecked { ++i; }
        }

        validSources[source] = true;
        emit SourceAdded(source);
    }
}
