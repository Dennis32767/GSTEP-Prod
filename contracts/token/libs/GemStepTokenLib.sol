// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title GemStepTokenLib
/// @notice Pure helpers for EIP-712 typed-data hashes used by GemStep.
/// @dev Marked `internal` so there is NO external library linking required.
///      This library only performs hashing; it does not validate signatures.
///      All functions are `pure` and deterministic.
///
///      Pattern:
///      - Build a structHash with `abi.encode(typehash, ...)`
///      - Convert to a typed-data digest using EIP-712 prefix + domain separator:
///        keccak256("\x19\x01" || domainSeparator || structHash)
library GemStepTokenLib {
    /*//////////////////////////////////////////////////////////////////////////
                                  EIP-712 DIGEST
    //////////////////////////////////////////////////////////////////////////*/

    /// @notice Compute EIP-712 typed data digest:
    ///         `keccak256("\x19\x01" || domainSeparator || structHash)`.
    /// @param domainSeparator EIP-712 domain separator (typically `_domainSeparatorV4()`).
    /// @param structHash      Hash of the encoded typed struct.
    /// @return digest         Typed-data digest for signing/recovery.
    function eip712TypedDataHash(bytes32 domainSeparator, bytes32 structHash)
        internal
        pure
        returns (bytes32 digest)
    {
        // EIP-712: 0x1901 prefix + domainSeparator + structHash
        digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    /*//////////////////////////////////////////////////////////////////////////
                                 STEPLOG STRUCT HASH
    //////////////////////////////////////////////////////////////////////////*/

    /// @notice Compute StepLog struct hash:
    ///         `keccak256(abi.encode(STEPLOG_TYPEHASH, user, beneficiary, steps, nonce, deadline, chainId, sourceHash, versionHash))`.
    /// @dev `sourceHash` and `versionHash` MUST be pre-hashed as:
    ///      - sourceHash  = keccak256(bytes(source))
    ///      - versionHash = keccak256(bytes(normalizedVersion))
    ///      so that dynamic strings are represented as bytes32 in the struct hash.
    ///
    /// @param steplogTypehash EIP-712 typehash for StepLog.
    /// @param user            User address (subject of steps).
    /// @param beneficiary     Reward recipient.
    /// @param steps           Steps submitted.
    /// @param nonce           Per-user nonce (anti-replay).
    /// @param deadline        Signature expiry timestamp.
    /// @param chainId         Chain id included in the payload struct.
    /// @param sourceHash      keccak256(bytes(source)).
    /// @param versionHash     keccak256(bytes(normalizedVersion)).
    /// @return structHash     Hash of the encoded StepLog struct.
    function stepStructHash(
        bytes32 steplogTypehash,
        address user,
        address beneficiary,
        uint256 steps,
        uint256 nonce,
        uint256 deadline,
        uint256 chainId,
        bytes32 sourceHash,
        bytes32 versionHash
    ) internal pure returns (bytes32 structHash) {
        structHash = keccak256(
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

    /*//////////////////////////////////////////////////////////////////////////
                              ATTESTATION V1 STRUCT HASH
    //////////////////////////////////////////////////////////////////////////*/

    /// @notice Compute Attestation V1 struct hash:
    ///         `keccak256(abi.encode(ATTESTATION_TYPEHASH, user, steps, timestamp, vHash))`.
    /// @dev `vHash` should be `keccak256(bytes(normalizedAttVersion))` and is passed
    ///      as a fixed bytes32 to avoid dynamic string encoding in the struct.
    /// @param attestTypehash  EIP-712 typehash for legacy Attestation (no nonce binding).
    /// @param user            Attested user.
    /// @param steps           Attested steps.
    /// @param timestamp       Attestation timestamp (device-side).
    /// @param vHash           keccak256(bytes(normalizedAttVersion)).
    /// @return structHash     Hash of the encoded Attestation V1 struct.
    function attestationV1StructHash(
        bytes32 attestTypehash,
        address user,
        uint256 steps,
        uint256 timestamp,
        bytes32 vHash
    ) internal pure returns (bytes32 structHash) {
        structHash = keccak256(
            abi.encode(
                attestTypehash,
                user,
                steps,
                timestamp,
                vHash
            )
        );
    }

    /*//////////////////////////////////////////////////////////////////////////
                           ATTESTATION V2 STRUCT HASH (NONCE-BOUND)
    //////////////////////////////////////////////////////////////////////////*/

    /// @notice Compute Attestation V2 (nonce-bound) struct hash:
    ///         `keccak256(abi.encode(ATTESTATION_V2_TYPEHASH, user, steps, timestamp, vHash, userNonce))`.
    /// @dev V2 adds `userNonce` binding to prevent replay across sessions/chains.
    /// @param attestV2Typehash EIP-712 typehash for Attestation V2 (nonce-bound).
    /// @param user             Attested user.
    /// @param steps            Attested steps.
    /// @param timestamp        Attestation timestamp (device-side).
    /// @param vHash            keccak256(bytes(normalizedAttVersion)).
    /// @param userNonce        User nonce bound into the attestation payload.
    /// @return structHash      Hash of the encoded Attestation V2 struct.
    function attestationV2StructHash(
        bytes32 attestV2Typehash,
        address user,
        uint256 steps,
        uint256 timestamp,
        bytes32 vHash,
        uint256 userNonce
    ) internal pure returns (bytes32 structHash) {
        structHash = keccak256(
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
