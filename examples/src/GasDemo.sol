// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title GasDemo
 * @notice Demo contract showing inline gas annotations (Remix-style)
 * @dev Open this file in VS Code to see gas costs displayed next to each function
 */
contract GasDemo {
    // Storage variables
    mapping(address => uint256) public balances;
    uint256[] public numbers;
    address public owner;

    event Transfer(address indexed from, address indexed to, uint256 amount);

    constructor() {
        owner = msg.sender;
    }

    // Simple function - Low gas
    function getBalance(address account) public view returns (uint256) {
        return balances[account];
    }

    // Simple setter - Medium gas
    function setBalance(address account, uint256 amount) public {
        require(msg.sender == owner, "Not owner");
        balances[account] = amount;
    }

    // Loop operation - High gas
    function batchTransfer(address[] calldata recipients, uint256 amount) public {
        for (uint256 i = 0; i < recipients.length; i++) {
            balances[msg.sender] -= amount;
            balances[recipients[i]] += amount;
            emit Transfer(msg.sender, recipients[i], amount);
        }
    }

    // Complex nested loops - Very high gas
    function complexOperation(uint256 size) public {
        for (uint256 i = 0; i < size; i++) {
            for (uint256 j = 0; j < size; j++) {
                numbers.push(i * j);
            }
        }
    }

    // Storage operations - High gas
    function storeData(uint256[] calldata data) public {
        require(msg.sender == owner, "Not owner");
        for (uint256 i = 0; i < data.length; i++) {
            numbers.push(data[i]);
        }
    }

    // Simple calculation - Very low gas
    function add(uint256 a, uint256 b) public pure returns (uint256) {
        return a + b;
    }

    // Memory operations - Low gas
    function processArray(uint256[] memory data) public pure returns (uint256) {
        uint256 sum = 0;
        for (uint256 i = 0; i < data.length; i++) {
            sum += data[i];
        }
        return sum;
    }

    // External call - Gas depends on called contract
    function externalCall(address target, bytes calldata data) public returns (bool) {
        (bool success, ) = target.call(data);
        return success;
    }
}
