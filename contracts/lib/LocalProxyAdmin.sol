// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/**
 * @title LocalProxyAdmin
 * @notice Minimal, size-optimized admin for OZ TransparentUpgradeableProxy.
 * - Emits the standard EIP-173 OwnershipTransferred event.
 * - owner() + transferOwnership() + renounceOwnership() kept for Ownable/EIP-173 compatibility.
 */
contract LocalProxyAdmin {
    address public admin;

    error NotAdmin();
    error NotAContract();

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    /**
     * @dev Initializes the contract, setting the initial admin and emitting an event for compatibility.
     * @param initialOwner The address of the initial contract admin.
     */
    constructor(address initialOwner) {
    require(initialOwner != address(0), "owner zero");
    admin = initialOwner;
}

    /**
     * @dev Returns the address of the current admin (maintains Ownable compatibility).
     */
    function owner() public view returns (address) {
        return admin;
    }

    /**
     * @dev Transfers ownership of the contract to a new account (`newOwner`).
     * Can only be called by the current admin. Maintains full Ownable compatibility.
     * @param newOwner The address to transfer ownership to.
     */
    function transferOwnership(address newOwner) public virtual onlyAdmin {
        require(newOwner != address(0), "Ownable: new owner is the zero address");
        _transferOwnership(newOwner);
    }

    /**
     * @dev Transfers admin rights to a new account (`newAdmin`).
     * Can only be called by the current admin. Provides a simpler function name.
     * @param newAdmin The address to transfer admin rights to.
     */
    function transferAdmin(address newAdmin) public virtual onlyAdmin {
        require(newAdmin != address(0), "LocalProxyAdmin: new admin is zero address");
        _transferOwnership(newAdmin);
    }

    /**
     * @dev Internal function to transfer admin rights and emit the standard event.
     * @param newAdmin The address of the new admin.
     */
    function _transferOwnership(address newAdmin) internal virtual {
        address oldAdmin = admin;
        admin = newAdmin;
        emit OwnershipTransferred(oldAdmin, newAdmin);
    }

    /**
     * @dev Returns the current implementation address the proxy points to.
     * @param proxy The proxy contract address to query.
     * @return The address of the current implementation.
     */
    function getProxyImplementation(address proxy) public view returns (address) {
        _checkIsContract(proxy);
        return ITransparentUpgradeableProxy(proxy).implementation();
    }

    /**
     * @dev Upgrades the proxy to a new implementation contract.
     * @param proxy The proxy contract address to upgrade.
     * @param implementation The address of the new implementation contract.
     */
    function upgrade(address proxy, address implementation) public onlyAdmin {
        _checkIsContract(proxy);
        _checkIsContract(implementation);
        ITransparentUpgradeableProxy(payable(proxy)).upgradeTo(implementation);
    }

    /**
     * @dev Upgrades the proxy to a new implementation and calls a function on the new implementation.
     * @param proxy The proxy contract address to upgrade.
     * @param implementation The address of the new implementation contract.
     * @param data The encoded function data to call on the new implementation.
     */
    function upgradeAndCall(
        address proxy,
        address implementation,
        bytes memory data
    ) public payable onlyAdmin {
        _checkIsContract(proxy);
        _checkIsContract(implementation);
        ITransparentUpgradeableProxy(payable(proxy)).upgradeToAndCall{value: msg.value}(implementation, data);
    }

    /**
     * @dev Internal helper function to check if a target address is a contract.
     * @param target The address to check.
     */
    function _checkIsContract(address target) internal view {
        if (target.code.length == 0) revert NotAContract();
    }
}

/**
 * @dev Minimal interface for Transparent Upgradeable Proxy contracts.
 */
interface ITransparentUpgradeableProxy {
    function upgradeTo(address newImplementation) external;
    function upgradeToAndCall(address newImplementation, bytes calldata data) external payable;
    function implementation() external view returns (address);
}