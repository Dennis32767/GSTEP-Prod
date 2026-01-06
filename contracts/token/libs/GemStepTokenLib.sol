// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title GemStepTokenLib
/// @notice Pure helpers for EIP-712 typed-data hashes used by GemStep.
/// @dev Marked `internal` so there is NO external library linking required.
library GemStepTokenLib {
    /// @notice EIP-712 typed data digest = keccak256("\x19\x01" || domainSeparator || structHash)
    function eip712TypedDataHash(bytes32 domainSeparator, bytes32 structHash)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    /// @notice StepLog struct hash:
    /// keccak256(abi.encode(STEPLOG_TYPEHASH, user, beneficiary, steps, nonce, deadline, chainId, keccak256(source), keccak256(version)))
    function stepStructHash(
        bytes32 steplogTypehash,
        address user,
        address beneficiary,
        uint256 steps,
        uint256 nonce,
        uint256 deadline,
        uint256 chainId,
        bytes32 sourceHash,   // keccak256(bytes(source))
        bytes32 versionHash   // keccak256(bytes(normalizedVersion))
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                steplogTypehash,
                user,
                beneficiary,
                steps,
                nonce,
                deadline,
                chainId,
                sourceHash,
                versionHash
            )
        );
    }

    /// @notice Attestation V1 struct hash:
    /// keccak256(abi.encode(ATTESTATION_TYPEHASH, user, steps, timestamp, vHash))
    function attestationV1StructHash(
        bytes32 attestTypehash,
        address user,
        uint256 steps,
        uint256 timestamp,
        bytes32 vHash           // keccak256(bytes(normalizedAttVersion))
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                attestTypehash,
                user,
                steps,
                timestamp,
                vHash
            )
        );
    }

    /// @notice Attestation V2 (nonce-bound) struct hash:
    /// keccak256(abi.encode(ATTESTATION_V2_TYPEHASH, user, steps, timestamp, vHash, userNonce))
    function attestationV2StructHash(
        bytes32 attestV2Typehash,
        address user,
        uint256 steps,
        uint256 timestamp,
        bytes32 vHash,
        uint256 userNonce
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                attestV2Typehash,
                user,
                steps,
                timestamp,
                vHash,
                userNonce
            )
        );
    }
}
