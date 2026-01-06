// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MiniMultisig2of2
/// @notice Minimal 2-of-2 multisig used for testnets. Both owners must approve a tx.
///         It can execute *any* call (e.g., Timelock.schedule/execute). Not for production.
contract MiniMultisig2of2 {
    address public immutable owner1;
    address public immutable owner2;

    uint256 public txCount;

    struct Tx {
        address target;
        uint256 value;
        bytes data;
        bool executed;
        uint8 approvals; // 0..2
        mapping(address => bool) approvedBy;
    }

    mapping(uint256 => Tx) private _txs;

    // simple reentrancy guard
    uint256 private _locked = 1;
    modifier nonReentrant() {
        require(_locked == 1, "REENTRANT");
        _locked = 2;
        _;
        _locked = 1;
    }

    modifier onlyOwner() {
        require(msg.sender == owner1 || msg.sender == owner2, "NOT_OWNER");
        _;
    }

    modifier txExists(uint256 id) {
        require(id > 0 && id <= txCount, "TX_NOT_FOUND");
        _;
    }

    modifier notExecuted(uint256 id) {
        require(!_txs[id].executed, "ALREADY_EXECUTED");
        _;
    }

    event Proposed(uint256 indexed id, address indexed proposer, address target, uint256 value, bytes data);
    event Approved(uint256 indexed id, address indexed owner);
    event Revoked(uint256 indexed id, address indexed owner);
    event Executed(uint256 indexed id, bool success, bytes returndata);
    event Deposit(address indexed from, uint256 value);

    constructor(address _owner1, address _owner2) {
        require(_owner1 != address(0) && _owner2 != address(0), "ZERO_ADDR");
        require(_owner1 != _owner2, "DUP_OWNERS");
        owner1 = _owner1;
        owner2 = _owner2;
    }

    receive() external payable {
        emit Deposit(msg.sender, msg.value);
    }

    /// @notice Propose a tx; proposer auto-approves it.
    function propose(address target, uint256 value, bytes calldata data) external onlyOwner returns (uint256 id) {
        require(target != address(0), "ZERO_TARGET");
        id = ++txCount;
        Tx storage t = _txs[id];
        t.target = target;
        t.value = value;
        t.data = data;
        // auto-approve by proposer
        t.approvedBy[msg.sender] = true;
        t.approvals = 1;
        emit Proposed(id, msg.sender, target, value, data);
        emit Approved(id, msg.sender);
    }

    /// @notice Approve a pending tx (the other owner).
    function approve(uint256 id) external onlyOwner txExists(id) notExecuted(id) {
        Tx storage t = _txs[id];
        require(!t.approvedBy[msg.sender], "ALREADY_APPROVED");
        t.approvedBy[msg.sender] = true;
        unchecked { t.approvals += 1; } // max 2
        emit Approved(id, msg.sender);
    }

    /// @notice Revoke your approval (before execution).
    function revoke(uint256 id) external onlyOwner txExists(id) notExecuted(id) {
        Tx storage t = _txs[id];
        require(t.approvedBy[msg.sender], "NOT_APPROVED");
        t.approvedBy[msg.sender] = false;
        unchecked { t.approvals -= 1; }
        emit Revoked(id, msg.sender);
    }

    /// @notice Execute after 2 approvals.
    function execute(uint256 id) external nonReentrant txExists(id) notExecuted(id) returns (bool ok, bytes memory ret) {
        Tx storage t = _txs[id];
        require(t.approvals == 2, "NEED_2_APPROVALS");
        t.executed = true;
        (ok, ret) = t.target.call{value: t.value}(t.data);
        emit Executed(id, ok, ret);
        require(ok, "CALL_FAILED");
    }

    /* ---------------------------- view helpers ---------------------------- */

    function getTx(uint256 id)
        external
        view
        txExists(id)
        returns (address target, uint256 value, bool executed, uint8 approvals, bytes memory data)
    {
        Tx storage t = _txs[id];
        return (t.target, t.value, t.executed, t.approvals, t.data);
    }

    function isApproved(uint256 id, address owner) external view txExists(id) returns (bool) {
        return _txs[id].approvedBy[owner];
    }

    function owners() external view returns (address, address) {
        return (owner1, owner2);
    }
}
