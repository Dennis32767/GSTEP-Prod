// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Minimal ProxyAdmin surface compatible with OZ v4/v5.
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

/// @notice Minimal 2-step ownable surface (for ProxyAdmin variants using 2-step).
interface ITwoStepOwnable {
    function pendingOwner() external view returns (address);
    function acceptOwnership() external;
}

/// @notice Minimal Ownable surface used for ownership checks.
interface IOwnable {
    function owner() external view returns (address);
}

/**
 * @title UpgradeExecutor
 * @notice Timelocked upgrade orchestrator for Transparent Proxy + ProxyAdmin setups.
 * @dev
 *  - Designed to be the **owner of a ProxyAdmin**.
 *  - Owner (typically a TimelockController / multisig) schedules upgrades with a delay,
 *    then executes after the delay elapses.
 *  - Supports both upgrade() and upgradeAndCall().
 *
 * Security properties:
 *  - Enforces:
 *      - non-zero addresses
 *      - executor is ProxyAdmin owner at schedule and execute time
 *      - target implementation has bytecode
 *      - optional “same implementation” protection when getter exists
 *      - consumes schedule before external call (reentrancy-safe pattern)
 *  - Uses {ReentrancyGuard} for execute paths (defense-in-depth).
 *
 * Notes:
 *  - Some older ProxyAdmin versions don’t expose getProxyAdmin/getProxyImplementation; checks are best-effort.
 *  - This contract does not itself manage timelock queueing—your governance owner should.
 */
contract UpgradeExecutor is Ownable2Step, ReentrancyGuard {
    /* =============================================================
                                   EVENTS
       ============================================================= */

    event UpgradeScheduled(
        address indexed proxyAdmin,
        address indexed proxy,
        address indexed implementation,
        uint256 executeAfter
    );

    event UpgradeScheduledWithData(
        address indexed proxyAdmin,
        address indexed proxy,
        address indexed implementation,
        bytes data,
        uint256 executeAfter
    );

    event UpgradeExecuted(
        address indexed proxyAdmin,
        address indexed proxy,
        address indexed implementation
    );

    event UpgradeExecutedWithData(
        address indexed proxyAdmin,
        address indexed proxy,
        address indexed implementation,
        bytes data
    );

    /// @notice Back-compat event kept for older off-chain listeners.
    event EmergencyCancel(address indexed cancelledImplementation);

    /// @notice Rich cancel event for modern indexers.
    event UpgradeCancelled(address indexed proxyAdmin, address indexed proxy, address indexed implementation);

    /// @notice Rich cancel event for upgradeAndCall cancellations.
    event UpgradeCancelledWithData(
        address indexed proxyAdmin,
        address indexed proxy,
        address indexed implementation,
        bytes data
    );

    event UpgradeDelayChanged(uint256 oldDelay, uint256 newDelay);

    /* =============================================================
                                   STORAGE
       ============================================================= */

    /// @notice Minimum delay between schedule and execute.
    uint256 public upgradeDelay = 24 hours;

    /// @notice Scheduled upgrade time keyed by keccak256(proxyAdmin, proxy, implementation).
    mapping(bytes32 => uint256) public scheduledUpgrades;

    /// @notice Scheduled upgrade time keyed by keccak256(proxyAdmin, proxy, implementation, data).
    mapping(bytes32 => uint256) public scheduledUpgradesWithData;

    /* =============================================================
                                 CONSTRUCTOR
       ============================================================= */

    /// @param initialOwner Initial owner (recommended: TimelockController or governance multisig).
    /// @dev Ownable2Step in OZ v5 inherits Ownable and accepts initialOwner via Ownable(initialOwner).
    constructor(address initialOwner) Ownable(initialOwner) {}

    /* =============================================================
                           OWNERSHIP / ADMIN HELPERS
       ============================================================= */

    /**
     * @notice If `proxyAdmin` is 2-step ownable and this executor is pending owner, finalize the transfer.
     * @param proxyAdmin The ProxyAdmin address.
     * @dev No-op if ProxyAdmin is single-step Ownable (no `pendingOwner()`).
     */
    function claimProxyAdminOwnership(address proxyAdmin) external onlyOwner {
        try ITwoStepOwnable(proxyAdmin).pendingOwner() returns (address p) {
            if (p == address(this)) {
                ITwoStepOwnable(proxyAdmin).acceptOwnership();
            }
        } catch {
            // single-step Ownable: nothing to do
        }
    }

    /* =============================================================
                                  SCHEDULE
       ============================================================= */

    /// @notice Schedule an upgrade (no calldata).
    function scheduleUpgrade(address proxyAdmin, address proxy, address implementation) external onlyOwner {
        _precheckCommon(proxyAdmin, proxy, implementation);
        _assertManagedProxy(proxyAdmin, proxy);
        _validateNewImpl(proxyAdmin, proxy, implementation);

        bytes32 key = _key(proxyAdmin, proxy, implementation);
        require(scheduledUpgrades[key] == 0, "Already scheduled");

        uint256 t = block.timestamp + upgradeDelay;
        scheduledUpgrades[key] = t;
        emit UpgradeScheduled(proxyAdmin, proxy, implementation, t);
    }

    /// @notice Schedule an upgradeAndCall (with calldata).
    function scheduleUpgradeWithData(
        address proxyAdmin,
        address proxy,
        address implementation,
        bytes calldata data
    ) external onlyOwner {
        _precheckCommon(proxyAdmin, proxy, implementation);
        _assertManagedProxy(proxyAdmin, proxy);
        _validateNewImpl(proxyAdmin, proxy, implementation);

        bytes32 key = _keyWithData(proxyAdmin, proxy, implementation, data);
        require(scheduledUpgradesWithData[key] == 0, "Already scheduled");

        uint256 t = block.timestamp + upgradeDelay;
        scheduledUpgradesWithData[key] = t;
        emit UpgradeScheduledWithData(proxyAdmin, proxy, implementation, data, t);
    }

    /// @notice Convenience wrapper (kept for compatibility with older scripts/tests).
    function scheduleUpgradeAndCall(
        address proxyAdmin,
        address proxy,
        address implementation,
        bytes calldata data
    ) external onlyOwner {
        _precheckCommon(proxyAdmin, proxy, implementation);
        _assertManagedProxy(proxyAdmin, proxy);
        _validateNewImpl(proxyAdmin, proxy, implementation);

        bytes32 key = _keyWithData(proxyAdmin, proxy, implementation, data);
        require(scheduledUpgradesWithData[key] == 0, "Already scheduled");

        uint256 t = block.timestamp + upgradeDelay;
        scheduledUpgradesWithData[key] = t;
        emit UpgradeScheduledWithData(proxyAdmin, proxy, implementation, data, t);
    }

    /* =============================================================
                                   EXECUTE
       ============================================================= */

    /// @notice Execute a scheduled upgrade without calldata.
    function executeUpgrade(address proxyAdmin, address proxy, address implementation)
        external
        nonReentrant
        onlyOwner
    {
        bytes32 key = _key(proxyAdmin, proxy, implementation);
        uint256 t = scheduledUpgrades[key];

        require(t != 0, "Upgrade not scheduled");
        require(block.timestamp >= t, "Upgrade delay not passed");
        require(IOwnable(proxyAdmin).owner() == address(this), "Executor is NOT ProxyAdmin owner");

        _assertManagedProxy(proxyAdmin, proxy);
        _validateNewImpl(proxyAdmin, proxy, implementation);

        // Effects
        delete scheduledUpgrades[key];

        // Interactions
        try IProxyAdmin(proxyAdmin).upgrade(proxy, implementation) {
            emit UpgradeExecuted(proxyAdmin, proxy, implementation);
        } catch (bytes memory low) {
            revert(_normalizeRevert(low, false));
        }
    }

    /// @notice Execute a scheduled upgrade with calldata.
    function executeUpgradeWithData(
        address proxyAdmin,
        address proxy,
        address implementation,
        bytes calldata data
    ) external nonReentrant onlyOwner {
        bytes32 key = _keyWithData(proxyAdmin, proxy, implementation, data);
        uint256 t = scheduledUpgradesWithData[key];

        require(t != 0, "Upgrade not scheduled");
        require(block.timestamp >= t, "Upgrade delay not passed");
        require(IOwnable(proxyAdmin).owner() == address(this), "Executor is NOT ProxyAdmin owner");

        _assertManagedProxy(proxyAdmin, proxy);
        _validateNewImpl(proxyAdmin, proxy, implementation);

        // Effects
        delete scheduledUpgradesWithData[key];

        // Interactions
        try IProxyAdmin(proxyAdmin).upgradeAndCall(proxy, implementation, data) {
            emit UpgradeExecutedWithData(proxyAdmin, proxy, implementation, data);
        } catch (bytes memory low) {
            revert(_normalizeRevert(low, true));
        }
    }

    /// @notice Convenience wrapper mirroring executeUpgradeWithData (kept for compatibility).
    function executeUpgradeAndCall(
        address proxyAdmin,
        address proxy,
        address implementation,
        bytes calldata data
    ) external nonReentrant onlyOwner {
        bytes32 key = _keyWithData(proxyAdmin, proxy, implementation, data);
        uint256 t = scheduledUpgradesWithData[key];

        require(t != 0, "Upgrade not scheduled");
        require(block.timestamp >= t, "Upgrade delay not passed");
        require(IOwnable(proxyAdmin).owner() == address(this), "Executor is NOT ProxyAdmin owner");

        _assertManagedProxy(proxyAdmin, proxy);
        _validateNewImpl(proxyAdmin, proxy, implementation);

        // Effects
        delete scheduledUpgradesWithData[key];

        // Interactions
        try IProxyAdmin(proxyAdmin).upgradeAndCall(proxy, implementation, data) {
            emit UpgradeExecutedWithData(proxyAdmin, proxy, implementation, data);
        } catch (bytes memory low) {
            revert(_normalizeRevert(low, true));
        }
    }

    /* =============================================================
                                   ADMIN
       ============================================================= */

    /// @notice Cancel a scheduled upgrade (no calldata).
    function cancelUpgrade(address proxyAdmin, address proxy, address implementation) external onlyOwner {
        bytes32 key = _key(proxyAdmin, proxy, implementation);
        require(scheduledUpgrades[key] > 0, "No upgrade scheduled");
        delete scheduledUpgrades[key];

        emit EmergencyCancel(implementation); // back-compat
        emit UpgradeCancelled(proxyAdmin, proxy, implementation);
    }

    /// @notice Cancel a scheduled upgrade with calldata.
    function cancelUpgradeWithData(
        address proxyAdmin,
        address proxy,
        address implementation,
        bytes calldata data
    ) external onlyOwner {
        bytes32 key = _keyWithData(proxyAdmin, proxy, implementation, data);
        require(scheduledUpgradesWithData[key] > 0, "No upgrade scheduled");
        delete scheduledUpgradesWithData[key];

        emit EmergencyCancel(implementation); // back-compat
        emit UpgradeCancelledWithData(proxyAdmin, proxy, implementation, data);
    }

    /// @notice Update the upgrade delay.
    /// @param newDelay New delay value (must be <= 7 days).
    function setUpgradeDelay(uint256 newDelay) external onlyOwner {
        require(newDelay <= 7 days, "Delay too long");
        emit UpgradeDelayChanged(upgradeDelay, newDelay);
        upgradeDelay = newDelay;
    }

    /* =============================================================
                                    VIEWS
       ============================================================= */

    /// @notice True if an upgrade is scheduled and ready to execute.
    function isUpgradeReady(address proxyAdmin, address proxy, address implementation) external view returns (bool) {
        uint256 t = scheduledUpgrades[_key(proxyAdmin, proxy, implementation)];
        return t > 0 && block.timestamp >= t;
    }

    /// @notice True if an upgradeWithData is scheduled and ready to execute.
    function isUpgradeWithDataReady(
        address proxyAdmin,
        address proxy,
        address implementation,
        bytes calldata data
    ) external view returns (bool) {
        uint256 t = scheduledUpgradesWithData[_keyWithData(proxyAdmin, proxy, implementation, data)];
        return t > 0 && block.timestamp >= t;
    }

    /* =============================================================
                                  INTERNALS
       ============================================================= */

    /// @dev Common address checks and ownership check for ProxyAdmin.
    function _precheckCommon(address proxyAdmin, address proxy, address implementation) private view {
        require(proxyAdmin != address(0) && proxy != address(0) && implementation != address(0), "Invalid addr");
        require(IOwnable(proxyAdmin).owner() == address(this), "Executor not ProxyAdmin owner");
    }

    /// @dev If ProxyAdmin exposes getProxyAdmin (OZ v5), verify proxy is managed by it.
    function _assertManagedProxy(address proxyAdmin, address proxy) private view {
        try IProxyAdmin(proxyAdmin).getProxyAdmin(proxy) returns (address who) {
            require(who == proxyAdmin, "Executor: proxy not managed by proxyAdmin");
        } catch {
            // Older ProxyAdmin: no getter; best-effort only.
        }
    }

    /// @dev Validate new implementation has code and is not identical to current (when getter exists).
    function _validateNewImpl(address proxyAdmin, address proxy, address implementation) private view {
        require(implementation.code.length > 0, "Executor: new impl has no code");
        try IProxyAdmin(proxyAdmin).getProxyImplementation(proxy) returns (address current) {
            require(current != implementation, "Executor: same implementation");
        } catch {
            // Older ProxyAdmin: no getter; skip same-impl check.
        }
    }

    /// @dev Schedule key (no calldata).
    function _key(address proxyAdmin, address proxy, address implementation) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(proxyAdmin, proxy, implementation));
    }

    /// @dev Schedule key (with calldata). Uses abi.encode to avoid collision risks.
    function _keyWithData(
        address proxyAdmin,
        address proxy,
        address implementation,
        bytes memory data
    ) private pure returns (bytes32) {
        return keccak256(abi.encode(proxyAdmin, proxy, implementation, data));
    }

    /* =============================================================
                         REVERT NORMALIZATION HELPERS
       ============================================================= */

    /// @dev Map a few common OZ/custom selectors and decode Error(string) when present.
    function _normalizeRevert(bytes memory low, bool withData) private pure returns (string memory) {
        if (low.length < 4) {
            return withData ? "ProxyAdmin: upgradeAndCall failed" : "ProxyAdmin: upgrade failed";
        }

        bytes4 sel;
        assembly {
            sel := mload(add(low, 0x20))
        }

        // TransparentUpgradeableProxy: ProxyDeniedAdminAccess()
        if (sel == 0xd2b576ec) {
            return "TransparentUpgradeableProxy: caller is not the proxy admin";
        }

        // ERC1967InvalidImplementation(address)
        if (sel == 0x3cf4e2c3) {
            if (low.length >= 0x44) {
                address impl;
                assembly {
                    impl := shr(96, mload(add(low, 0x24)))
                }
                return string(abi.encodePacked("ERC1967: invalid implementation (", _toHex(impl), ")"));
            }
            return "ERC1967: invalid implementation";
        }

        // OwnableUnauthorizedAccount(address)
        if (sel == 0x82b42900) {
            if (low.length >= 0x44) {
                address acc;
                assembly {
                    acc := shr(96, mload(add(low, 0x24)))
                }
                return string(abi.encodePacked("Ownable: caller is not the owner (", _toHex(acc), ")"));
            }
            return "Ownable: caller is not the owner";
        }

        // Error(string)
        if (sel == 0x08c379a0) {
            // Error(string) = selector + abi.encode(string)
            // Strip selector and decode.
            bytes memory payload = _slice(low, 4, low.length - 4);
            // If payload is malformed, abi.decode will revert; that is acceptable here because
            // it only runs when selector claims Error(string).
            return abi.decode(payload, (string));
        }

        return withData ? "ProxyAdmin: upgradeAndCall failed" : "ProxyAdmin: upgrade failed";
    }

    /// @dev Convert address to hex string with 0x prefix.
    function _toHex(address a) private pure returns (string memory) {
        bytes20 b = bytes20(a);
        bytes16 HEX = 0x30313233343536373839616263646566; // "0123456789abcdef"
        bytes memory s = new bytes(42);
        s[0] = "0";
        s[1] = "x";
        for (uint256 i = 0; i < 20; i++) {
            uint8 by = uint8(b[i]);
            s[2 + i * 2] = bytes1(HEX[by >> 4]);
            s[3 + i * 2] = bytes1(HEX[by & 0x0f]);
        }
        return string(s);
    }

    /// @dev Slice bytes (memory) into a new bytes array (masked final word for exactness).
    function _slice(bytes memory data, uint256 start, uint256 len) private pure returns (bytes memory out) {
        require(data.length >= start + len, "slice_oob");
        out = new bytes(len);

        if (len == 0) return out;

        assembly {
            // Pointers
            let src := add(add(data, 0x20), start)
            let dst := add(out, 0x20)

            // Copy full words
            let fullWords := div(len, 0x20)
            for { let i := 0 } lt(i, fullWords) { i := add(i, 1) } {
                mstore(add(dst, mul(i, 0x20)), mload(add(src, mul(i, 0x20))))
            }

            // Copy remaining bytes (mask)
            let rem := mod(len, 0x20)
            if rem {
                let srcWord := mload(add(src, mul(fullWords, 0x20)))
                let dstWord := mload(add(dst, mul(fullWords, 0x20)))

                // mask keeps the first `rem` bytes (from MSB side)
                // mask = ~((1 << (8*(32-rem))) - 1)
                let shift := mul(8, sub(0x20, rem))
                let mask := not(sub(shl(shift, 1), 1))

                // store: keep dstWord for untouched tail, overwrite head with srcWord
                mstore(
                    add(dst, mul(fullWords, 0x20)),
                    or(and(dstWord, not(mask)), and(srcWord, mask))
                )
            }
        }
    }
}
