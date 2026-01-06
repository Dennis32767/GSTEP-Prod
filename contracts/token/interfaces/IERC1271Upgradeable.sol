// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title ERC-1271 (Upgradeable-friendly) interface
/// @dev Standard interface for signature validation by smart contract wallets.
/// Return values:
///  - 0x1626ba7e => signature is valid
///  - 0xffffffff => signature is invalid
interface IERC1271Upgradeable {
    /// @notice Validate a hash/signature pair.
    /// @param hash      Keccak256 of the signed data (EIP-191 / EIP-712 digest).
    /// @param signature Signature byte array associated with 'hash'.
    /// @return magicValue 0x1626ba7e if valid, 0xffffffff otherwise.
    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4 magicValue);

    /// @notice (Optional) Validate arbitrary byte data + signature.
    /// @dev Not used by GemStep, but included for broader compatibility with some wallets.
    /// @param data      Arbitrary data.
    /// @param signature Signature byte array associated with 'data'.
    /// @return magicValue 0x1626ba7e if valid, 0xffffffff otherwise.
    function isValidSignature(bytes calldata data, bytes calldata signature) external view returns (bytes4 magicValue);
}
