// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IProxyAdmin {
    // Present in OZ v5
    function getProxyImplementation(address proxy) external view returns (address);
    function getProxyAdmin(address proxy) external view returns (address);

    function upgrade(address proxy, address implementation) external;
    function upgradeAndCall(address proxy, address implementation, bytes calldata data) external payable;

    // v4 (Ownable) and v5 (Ownable2Step) compatible surface
    function owner() external view returns (address);
    function transferOwnership(address newOwner) external;
    function acceptOwnership() external;
}

interface ITwoStepOwnable {
    function pendingOwner() external view returns (address);
    function acceptOwnership() external;
}

interface IOwnable {
    function owner() external view returns (address);
}

contract UpgradeExecutor is Ownable2Step, ReentrancyGuard {
    event UpgradeScheduled(address indexed proxyAdmin, address indexed proxy, address indexed implementation, uint256 executeAfter);
    event UpgradeScheduledWithData(address indexed proxyAdmin, address indexed proxy, address indexed implementation, bytes data, uint256 executeAfter);
    event UpgradeExecuted(address indexed proxyAdmin, address indexed proxy, address indexed implementation);
    event UpgradeExecutedWithData(address indexed proxyAdmin, address indexed proxy, address indexed implementation, bytes data);
    event EmergencyCancel(address indexed cancelledImplementation);
    event UpgradeDelayChanged(uint256 oldDelay, uint256 newDelay);

    uint256 public upgradeDelay = 24 hours;

    // key = keccak(proxyAdmin, proxy, implementation)
    mapping(bytes32 => uint256) public scheduledUpgrades;
    // key = keccak(proxyAdmin, proxy, implementation, data)
    mapping(bytes32 => uint256) public scheduledUpgradesWithData;

    constructor(address initialOwner) Ownable(initialOwner) {}

    /* ----------------------------- Ownership helpers ---------------------------- */

    function claimProxyAdminOwnership(address proxyAdmin) external onlyOwner {
        // If ProxyAdmin is two-step ownable, finalize the transfer
        try ITwoStepOwnable(proxyAdmin).pendingOwner() returns (address p) {
            if (p == address(this)) {
                ITwoStepOwnable(proxyAdmin).acceptOwnership();
            }
        } catch { /* single-step Ownable: no-op */ }
    }

    /* --------------------------------- Schedule -------------------------------- */

    function scheduleUpgrade(address proxyAdmin, address proxy, address implementation) external onlyOwner {
        _precheckCommon(proxyAdmin, proxy, implementation);
        _assertManagedProxy(proxyAdmin, proxy);
        _validateNewImpl(proxyAdmin, proxy, implementation);

        uint256 t = block.timestamp + upgradeDelay;
        scheduledUpgrades[_key(proxyAdmin, proxy, implementation)] = t;
        emit UpgradeScheduled(proxyAdmin, proxy, implementation, t);
    }

    function scheduleUpgradeWithData(address proxyAdmin, address proxy, address implementation, bytes calldata data)
        external
        onlyOwner
    {
        _precheckCommon(proxyAdmin, proxy, implementation);
        _assertManagedProxy(proxyAdmin, proxy);
        _validateNewImpl(proxyAdmin, proxy, implementation);

        uint256 t = block.timestamp + upgradeDelay;
        scheduledUpgradesWithData[_keyWithData(proxyAdmin, proxy, implementation, data)] = t;
        emit UpgradeScheduledWithData(proxyAdmin, proxy, implementation, data, t);
    }

    // Convenience wrapper for tests (inline; no external self-call)
    function scheduleUpgradeAndCall(address proxyAdmin, address proxy, address implementation, bytes calldata data)
        external
        onlyOwner
    {
        _precheckCommon(proxyAdmin, proxy, implementation);
        _assertManagedProxy(proxyAdmin, proxy);
        _validateNewImpl(proxyAdmin, proxy, implementation);

        uint256 t = block.timestamp + upgradeDelay;
        scheduledUpgradesWithData[_keyWithData(proxyAdmin, proxy, implementation, data)] = t;
        emit UpgradeScheduledWithData(proxyAdmin, proxy, implementation, data, t);
    }

    /* ---------------------------------- Execute -------------------------------- */

        /// @notice Execute a scheduled upgrade without calldata
    function executeUpgrade(
        address proxyAdmin,
        address proxy,
        address implementation
    )
        external
        nonReentrant
        onlyOwner
    {
        bytes32 key = _key(proxyAdmin, proxy, implementation);
        uint256 t = scheduledUpgrades[key];

        // Checks
        require(t != 0, "Upgrade not scheduled");
        require(block.timestamp >= t, "Upgrade delay not passed");
        require(IOwnable(proxyAdmin).owner() == address(this), "Executor is NOT ProxyAdmin owner");
        _assertManagedProxy(proxyAdmin, proxy);
        _validateNewImpl(proxyAdmin, proxy, implementation);

        // Effects (consume schedule before interaction)
        delete scheduledUpgrades[key];

        // Interactions
        try IProxyAdmin(proxyAdmin).upgrade(proxy, implementation) {
            // No state writes after external call
            emit UpgradeExecuted(proxyAdmin, proxy, implementation);
        } catch (bytes memory low) {
            // Revert with normalized message; the deletion above is rolled back by EVM
            revert(_normalizeRevert(low, /*withData*/ false));
        }
    }

    /// @notice Execute a scheduled upgrade with calldata
    function executeUpgradeWithData(
        address proxyAdmin,
        address proxy,
        address implementation,
        bytes calldata data
    )
        external
        nonReentrant
        onlyOwner
    {
        bytes32 key = _keyWithData(proxyAdmin, proxy, implementation, data);
        uint256 t = scheduledUpgradesWithData[key];

        // Checks
        require(t != 0, "Upgrade not scheduled");
        require(block.timestamp >= t, "Upgrade delay not passed");
        require(IOwnable(proxyAdmin).owner() == address(this), "Executor is NOT ProxyAdmin owner");
        _assertManagedProxy(proxyAdmin, proxy);
        _validateNewImpl(proxyAdmin, proxy, implementation);

        // Effects
        delete scheduledUpgradesWithData[key];

        // Interactions
        try IProxyAdmin(proxyAdmin).upgradeAndCall(proxy, implementation, data) {
            // No state writes after external call
            emit UpgradeExecutedWithData(proxyAdmin, proxy, implementation, data);
        } catch (bytes memory low) {
            revert(_normalizeRevert(low, /*withData*/ true));
        }
    }

    /// @notice Convenience wrapper mirroring executeUpgradeWithData
    function executeUpgradeAndCall(
        address proxyAdmin,
        address proxy,
        address implementation,
        bytes calldata data
    )
        external
        nonReentrant
        onlyOwner
    {
        bytes32 key = _keyWithData(proxyAdmin, proxy, implementation, data);
        uint256 t = scheduledUpgradesWithData[key];

        // Checks
        require(t != 0, "Upgrade not scheduled");
        require(block.timestamp >= t, "Upgrade delay not passed");
        require(IOwnable(proxyAdmin).owner() == address(this), "Executor is NOT ProxyAdmin owner");
        _assertManagedProxy(proxyAdmin, proxy);
        _validateNewImpl(proxyAdmin, proxy, implementation);

        // Effects
        delete scheduledUpgradesWithData[key];

        // Interactions
        try IProxyAdmin(proxyAdmin).upgradeAndCall(proxy, implementation, data) {
            // No state writes after external call
            emit UpgradeExecutedWithData(proxyAdmin, proxy, implementation, data);
        } catch (bytes memory low) {
            revert(_normalizeRevert(low, /*withData*/ true));
        }
    }

    /* ---------------------------------- Admin ---------------------------------- */

    function cancelUpgrade(address proxyAdmin, address proxy, address implementation) external onlyOwner {
        bytes32 key = _key(proxyAdmin, proxy, implementation);
        require(scheduledUpgrades[key] > 0, "No upgrade scheduled");
        delete scheduledUpgrades[key];
        emit EmergencyCancel(implementation);
    }

    function cancelUpgradeWithData(address proxyAdmin, address proxy, address implementation, bytes calldata data)
        external
        onlyOwner
    {
        bytes32 key = _keyWithData(proxyAdmin, proxy, implementation, data);
        require(scheduledUpgradesWithData[key] > 0, "No upgrade scheduled");
        delete scheduledUpgradesWithData[key];
        emit EmergencyCancel(implementation);
    }

    function setUpgradeDelay(uint256 newDelay) external onlyOwner {
        require(newDelay <= 7 days, "Delay too long");
        emit UpgradeDelayChanged(upgradeDelay, newDelay);
        upgradeDelay = newDelay;
    }

    /* ----------------------------------- Views --------------------------------- */

    function isUpgradeReady(address proxyAdmin, address proxy, address implementation) external view returns (bool) {
        uint256 t = scheduledUpgrades[_key(proxyAdmin, proxy, implementation)];
        return t > 0 && block.timestamp >= t;
    }

    function isUpgradeWithDataReady(address proxyAdmin, address proxy, address implementation, bytes calldata data)
        external
        view
        returns (bool)
    {
        uint256 t = scheduledUpgradesWithData[_keyWithData(proxyAdmin, proxy, implementation, data)];
        return t > 0 && block.timestamp >= t;
    }

    /* --------------------------------- Internals -------------------------------- */

    function _precheckCommon(address proxyAdmin, address proxy, address implementation) private view {
        require(proxyAdmin != address(0) && proxy != address(0) && implementation != address(0), "Invalid addr");
        require(IOwnable(proxyAdmin).owner() == address(this), "Executor not ProxyAdmin owner");
    }

    function _assertManagedProxy(address proxyAdmin, address proxy) private view {
        // If present (OZ v5), verify proxy admin relationship
        try IProxyAdmin(proxyAdmin).getProxyAdmin(proxy) returns (address who) {
            require(who == proxyAdmin, "Executor: proxy not managed by proxyAdmin");
        } catch { /* older ProxyAdmin: no getter */ }
    }

    function _isContract(address a) private view returns (bool) {
        uint256 size;
        assembly { size := extcodesize(a) }
        return size > 0;
    }

    function _validateNewImpl(address proxyAdmin, address proxy, address implementation) private view {
        require(_isContract(implementation), "Executor: new impl has no code");
        // Skip same-impl check if getter not present
        try IProxyAdmin(proxyAdmin).getProxyImplementation(proxy) returns (address current) {
            require(current != implementation, "Executor: same implementation");
        } catch { }
    }

    function _key(address proxyAdmin, address proxy, address implementation) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(proxyAdmin, proxy, implementation));
    }

    function _keyWithData(address proxyAdmin, address proxy, address implementation, bytes memory data)
        private pure returns (bytes32)
    {
        return keccak256(abi.encode(proxyAdmin, proxy, implementation, data));
    }

    /* ------------------------ Minimal revert normalization ----------------------- */

    // Map a few common OZ v5 custom errors to readable strings.
    function _normalizeRevert(bytes memory low, bool withData) private view returns (string memory) {
        if (low.length < 4) {
            return withData ? "ProxyAdmin: upgradeAndCall failed" : "ProxyAdmin: upgrade failed";
        }
        bytes4 sel;
        assembly { sel := mload(add(low, 0x20)) }

        // TransparentUpgradeableProxy: ProxyDeniedAdminAccess()
        if (sel == 0xd2b576ec) {
            return "TransparentUpgradeableProxy: caller is not the proxy admin";
        }
        // ERC1967InvalidImplementation(address)
        if (sel == 0x3cf4e2c3) {
            if (low.length >= 0x44) {
                bytes32 raw; assembly { raw := mload(add(low, 0x24)) }
                address impl = address(uint160(uint256(raw)));
                return _concat("ERC1967: invalid implementation (", _toHex(impl), ")");
            }
            return "ERC1967: invalid implementation";
        }
        // OwnableUnauthorizedAccount(address)
        if (sel == 0x82b42900) {
            if (low.length >= 0x44) {
                bytes32 raw; assembly { raw := mload(add(low, 0x24)) }
                address acc = address(uint160(uint256(raw)));
                return _concat("Ownable: caller is not the owner (", _toHex(acc), ")");
            }
            return "Ownable: caller is not the owner";
        }

        // If it was a plain revert(string), try to decode it into a string.
        // (selector 0x08c379a0 == Error(string))
        if (sel == 0x08c379a0 && low.length >= 0x44) {
            // strip selector and decode string
            bytes memory rest = new bytes(low.length - 4);
            assembly {
                let len := mload(low)
                mstore(rest, sub(len, 4))
                // copy starting after selector
                mstore(add(rest, 0x20), mload(add(low, 0x24)))
                // the remainder (string payload) is copied by ABI decoder on return
            }
            // Attempt to decode string; if it fails, fallback to default error
            bool success;
            string memory s;
            assembly {
                // solc ABI decoder expects offset at 0x20, so we need to shift
                // rest points to bytes array, so offset is at 0x20
                // We use staticcall to catch decoding errors
                let free := mload(0x40)
                mstore(free, 0x20) // offset
                mstore(add(free, 0x20), mload(add(rest, 0x20))) // length
                mstore(add(free, 0x40), mload(add(rest, 0x40))) // data
                success := staticcall(
                    gas(),
                    0x04, // address 0x04 is not a contract, but staticcall will not revert
                    add(rest, 0x20),
                    mload(rest),
                    free,
                    0x60
                )
            }
            if (success) {
                s = abi.decode(rest, (string));
                return s;
            }
        }

        return withData ? "ProxyAdmin: upgradeAndCall failed" : "ProxyAdmin: upgrade failed";
    }

    function _toHex(address a) private pure returns (string memory) {
        bytes20 b = bytes20(a);
        bytes memory s = new bytes(42);
        s[0] = "0"; s[1] = "x";
        bytes16 HEX = 0x30313233343536373839616263646566;
        for (uint256 i = 0; i < 20; i++) {
            uint8 by = uint8(b[i]);
            s[2 + i * 2] = bytes1(HEX[by >> 4]);
            s[3 + i * 2] = bytes1(HEX[by & 0x0f]);
        }
        return string(s);
    }

    function _concat(string memory a, string memory b, string memory c) private pure returns (string memory) {
        return string(abi.encodePacked(a, b, c));
    }
}
