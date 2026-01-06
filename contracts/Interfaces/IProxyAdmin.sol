// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/**
 * @title Enhanced Proxy Admin Interface
 * @notice Standard interface for managing transparent upgradeable proxies
 * @dev Includes all standard proxy admin functions plus additional safety features
 */
interface IProxyAdmin {
    // Core Proxy Functions
    function getProxyImplementation(address proxy) external view returns (address);
    function getProxyAdmin(address proxy) external view returns (address);
    function upgrade(address proxy, address implementation) external;
    function upgradeAndCall(address proxy, address implementation, bytes calldata data) external payable;
    
    // Ownership Management
    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
    function transferOwnership(address newOwner) external;
    function acceptOwnership() external;
    
    // Safety Features
    function pauseUpgrades() external;
    function unpauseUpgrades() external;
    function upgradesPaused() external view returns (bool);
    
    // Emergency Functions
    function emergencyWithdrawETH(address payable recipient) external;
    function recoverERC20(address token, address recipient, uint256 amount) external;
    
    // Implementation Management
    function approveImplementation(address implementation, bool approved) external;
    function isApprovedImplementation(address implementation) external view returns (bool);
    
    // Events
    event Upgrade(address indexed proxy, address indexed implementation);
    event UpgradeAndCall(address indexed proxy, address indexed implementation, bytes data);
    event AdminChanged(address indexed proxy, address indexed previousAdmin, address indexed newAdmin);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event UpgradesPaused(address account);
    event UpgradesUnpaused(address account);
    event ImplementationApproved(address indexed implementation);
    event ImplementationRevoked(address indexed implementation);
}