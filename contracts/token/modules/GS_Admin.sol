// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "../core/GemStepCore.sol";

abstract contract GS_Admin is GemStepCore {
    // --------- small helper to avoid repeating normalize+hash ---------
    function _normHash(string calldata v) internal pure returns (string memory norm, bytes32 h) {
        norm = _normalizeVersion(v);
        h = keccak256(bytes(norm));
    }

    // --------- local helper to keep the same revert string ---------
    function _checkVersionLen(string calldata v) private pure {
        uint256 l = bytes(v).length;
        require(l > 0 && l <= MAX_VERSION_LENGTH, "Bad version");
    }

    // ================= Version Helpers & Admin ================= //

    function addSupportedPayloadVersion(string calldata version)
        external
        onlyRole(PARAMETER_ADMIN_ROLE)
    {
        _checkVersionLen(version);
        (string memory norm, bytes32 h) = _normHash(version);
        supportedPayloadVersions[h] = true;
        emit PayloadVersionAdded(norm);
    }

    function deprecatePayloadVersion(string calldata version, uint256 when)
        external
        onlyRole(PARAMETER_ADMIN_ROLE)
    {
        (string memory norm, bytes32 h) = _normHash(version);
        require(supportedPayloadVersions[h], "Version not supported");
        payloadVersionDeprecatesAt[h] = when;
        emit PayloadVersionDeprecated(norm, when);
    }

    // Legacy wrapper kept for compatibility; still enables attestation version.
    function addSupportedVersion(string calldata version)
        external
        onlyRole(PARAMETER_ADMIN_ROLE)
    {
        _addSupportedAttestationVersion(version);
        emit VersionAdded(version);
    }

    function addSupportedAttestationVersion(string calldata version)
        external
        onlyRole(PARAMETER_ADMIN_ROLE)
    {
        _addSupportedAttestationVersion(version);
    }

    function _addSupportedAttestationVersion(string calldata version) internal {
        _checkVersionLen(version);
        (string memory norm, bytes32 h) = _normHash(version);
        supportedAttestationVersions[h] = true;
        // Default: enforce nonce-binding unless explicitly relaxed later
        attestationRequiresNonce[h] = true;
        emit AttestationVersionAdded(norm);
    }

    function deprecateAttestationVersion(string calldata version, uint256 when)
        external
        onlyRole(PARAMETER_ADMIN_ROLE)
    {
        (string memory norm, bytes32 h) = _normHash(version);
        require(supportedAttestationVersions[h], "Attest ver not supported");
        attestationVersionDeprecatesAt[h] = when;
        emit AttestationVersionDeprecated(norm, when);
    }

    function setAttestationNonceRequired(string calldata version, bool required)
    external
    onlyRole(PARAMETER_ADMIN_ROLE)
    {
    (string memory norm, bytes32 h) = _normHash(version);
    require(supportedAttestationVersions[h], "Attest ver not supported");
    attestationRequiresNonce[h] = required;
    emit AttestationNonceRequirementSet(norm, required);
    }

    function setAnomalyThreshold(uint256 newThreshold) external onlyRole(PARAMETER_ADMIN_ROLE) {
    require(newThreshold >= 2 && newThreshold <= 10, "bad threshold");
    uint256 old = anomalyThreshold;
    anomalyThreshold = newThreshold;
    emit ParameterUpdated("anomalyThreshold", old, newThreshold);
    }

    // ================= Admin (misc) ================= //

    function configureSource(
        string calldata source,
        bool requiresProof,
        bool requiresAttestation
    ) external onlyRole(PARAMETER_ADMIN_ROLE) {
        _configureSource(source, requiresProof, requiresAttestation);
    }

    function addTrustedDevice(address device) external onlyRole(PARAMETER_ADMIN_ROLE) {
        require(device != address(0), "Invalid device address");
        trustedDevices[device] = true;
        emit TrustedDeviceAdded(device);
    }

    function setTrustedAPI(address api, bool trusted) external onlyRole(PARAMETER_ADMIN_ROLE) {
        require(api != address(0), "Invalid API address");
        isTrustedAPI[api] = trusted;
        emit TrustedAPISet(api, trusted);
    }

    function setSourceMerkleRoot(string calldata source, bytes32 root)
        external
        onlyRole(PARAMETER_ADMIN_ROLE)
    {
        require(validSources[source], "Invalid source");
        sourceConfigs[source].merkleRoot = root;
    }

    function setPriceOracle(address newOracle) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newOracle != address(0), "Invalid oracle");
        priceOracle = newOracle;
        emit OracleUpdated(newOracle);
    }

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

    function batchAddSources(string[] calldata sources) external onlyRole(PARAMETER_ADMIN_ROLE) {
        uint256 len = sources.length;
        require(len <= MAX_BATCH_SOURCES, "Exceeds max batch size");
        for (uint256 i; i < len; ) {
            _addValidSource(sources[i]);
            unchecked { ++i; }
        }
    }

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
    function setMultisig(address m) external onlyRole(DEFAULT_ADMIN_ROLE) {
    require(m != address(0), "Invalid multisig");
    multisig = m;
    emit MultisigSet(m);
}

function setTrusted1271(address contractAddr, bool trusted)
    external
    onlyRole(DEFAULT_ADMIN_ROLE)
{
    require(contractAddr != address(0), "Invalid 1271 addr");
    trustedERC1271Contracts[contractAddr] = trusted;
    emit Trusted1271Set(contractAddr, trusted);
}

    // ================= Internal helpers ================= //

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

    function _addValidSource(string memory source) internal {
        require(
            hasRole(PARAMETER_ADMIN_ROLE, msg.sender) || msg.sender == address(this),
            "Unauthorized"
        );

        bytes memory b = bytes(source);
        uint256 len = b.length;
        require(len >= MIN_SOURCE_LENGTH, "Source too short");
        require(len <= MAX_SOURCE_LENGTH, "Source too long");
        require(!validSources[source], "Source already exists");

        // inline alnum check (keeps code small vs separate function)
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

    // External wrappers (compat)
    function addSource(string calldata source) external onlyRole(PARAMETER_ADMIN_ROLE) {
        _addValidSource(source);
    }

    function removeSource(string calldata source) external onlyRole(PARAMETER_ADMIN_ROLE) {
        require(validSources[source], "Source not registered");
        validSources[source] = false;
        emit SourceRemoved(source);
    }
}
