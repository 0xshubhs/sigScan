// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Test.sol";
import "../src/OptionsMarket.sol";
import "../src/VolatilityOracle.sol";

contract OptionsMarketTest is Test {
    OptionsMarket public optionsMarket;
    VolatilityOracle public oracle;
    
    address public writer = address(0x1);
    address public buyer = address(0x2);
    address public feeCollector = address(0x3);

    function setUp() public {
        oracle = new VolatilityOracle();
        optionsMarket = new OptionsMarket(address(oracle), feeCollector);
        
        vm.deal(writer, 100 ether);
        vm.deal(buyer, 100 ether);
    }

    function testWriteOption() public {
        vm.startPrank(writer);
        optionsMarket.depositCollateral{value: 10 ether}(address(0));
        
        uint256 optionId = optionsMarket.writeOption(
            OptionsMarket.OptionType.Call,
            address(0),
            2000 ether,
            block.timestamp + 30 days,
            1 ether
        );
        
        assertEq(optionId, 1);
        vm.stopPrank();
    }

    function testBuyOption() public {
        vm.startPrank(writer);
        optionsMarket.depositCollateral{value: 10 ether}(address(0));
        uint256 optionId = optionsMarket.writeOption(
            OptionsMarket.OptionType.Call,
            address(0),
            2000 ether,
            block.timestamp + 30 days,
            1 ether
        );
        vm.stopPrank();

        vm.startPrank(buyer);
        OptionsMarket.Option memory option = optionsMarket.getOption(optionId);
        optionsMarket.buyOption{value: option.premium}(optionId);
        vm.stopPrank();
    }
}
