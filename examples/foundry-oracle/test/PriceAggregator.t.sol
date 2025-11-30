// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Test.sol";
import "../src/PriceAggregator.sol";

contract PriceAggregatorTest is Test {
    PriceAggregator public aggregator;
    
    address public oracle1 = address(0x1);
    address public oracle2 = address(0x2);
    address public oracle3 = address(0x3);

    function setUp() public {
        aggregator = new PriceAggregator();
        
        aggregator.addOracle(oracle1, 100);
        aggregator.addOracle(oracle2, 100);
        aggregator.addOracle(oracle3, 100);
    }

    function testSubmitPrice() public {
        vm.prank(oracle1);
        aggregator.submitPrice(address(0), 2000 ether, 9500);
        
        vm.prank(oracle2);
        aggregator.submitPrice(address(0), 2010 ether, 9600);
        
        vm.prank(oracle3);
        aggregator.submitPrice(address(0), 1990 ether, 9400);
        
        (uint256 price, uint256 confidence) = aggregator.getPrice(address(0));
        assertGt(price, 0);
        assertGt(confidence, 0);
    }
}
