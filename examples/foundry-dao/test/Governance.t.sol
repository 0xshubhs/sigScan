// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Test.sol";
import "../src/GovernanceToken.sol";
import "../src/GovernorAlpha.sol";
import "../src/Timelock.sol";

contract GovernanceTest is Test {
    GovernanceToken token;
    GovernorAlpha governor;
    Timelock timelock;
    
    address alice = address(0x1);
    address bob = address(0x2);

    function setUp() public {
        token = new GovernanceToken(1000000e18);
        timelock = new Timelock(address(this), 2 days);
        governor = new GovernorAlpha(address(token), address(timelock), address(this));
        
        token.transfer(alice, 500000e18);
        token.transfer(bob, 500000e18);
    }

    function testDelegation() public {
        vm.prank(alice);
        token.delegate(alice);
        
        assertEq(token.getCurrentVotes(alice), 500000e18);
    }

    function testProposalCreation() public {
        vm.prank(alice);
        token.delegate(alice);
        
        vm.roll(block.number + 1);
        
        address[] memory targets = new address[](1);
        uint256[] memory values = new uint256[](1);
        string[] memory signatures = new string[](1);
        bytes[] memory calldatas = new bytes[](1);
        
        targets[0] = address(token);
        
        vm.prank(alice);
        uint256 proposalId = governor.propose(targets, values, signatures, calldatas, "Test Proposal");
        
        assertEq(proposalId, 1);
    }
}
