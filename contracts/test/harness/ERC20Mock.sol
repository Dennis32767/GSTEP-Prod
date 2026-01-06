// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract ERC20Mock {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    event Transfer(address indexed from, address indexed to, uint256 value);

    constructor(string memory _n, string memory _s, address to, uint256 amount) {
        name = _n; symbol = _s;
        _mint(to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(to != address(0), "zero addr");
        require(balanceOf[msg.sender] >= amount, "bal");
        unchecked { balanceOf[msg.sender] -= amount; balanceOf[to] += amount; }
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function _mint(address to, uint256 amount) internal {
        require(to != address(0), "zero addr");
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }
}
