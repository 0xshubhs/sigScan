// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

contract SimpleStorage {
    uint256 private value;
    mapping(address => uint256) public balances;
    
    event ValueSet(uint256 newValue);
    event Transfer(address indexed from, address indexed to, uint256 amount);
    
    function setValue(uint256 newValue) public {
        value = newValue;
        emit ValueSet(newValue);
    }
    
    function getValue() public view returns (uint256) {
        return value;
    }
    
    function deposit() public payable {
        balances[msg.sender] += msg.value;
    }
    
    function withdraw(uint256 amount) public {
        require(balances[msg.sender] >= amount, "Insufficient balance");
        balances[msg.sender] -= amount;
        payable(msg.sender).transfer(amount);
    }
    
    function transfer(address to, uint256 amount) public {
        require(balances[msg.sender] >= amount, "Insufficient balance");
        balances[msg.sender] -= amount;
        balances[to] += amount;
        emit Transfer(msg.sender, to, amount);
    }
}
