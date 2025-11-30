// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/LiquidityPool.sol";

contract LiquidityPoolTest is Test {
    LiquidityPool public pool;
    address token0 = address(0x1);
    address token1 = address(0x2);

    function setUp() public {
        pool = new LiquidityPool(token0, token1);
    }

    function testGetReserves() public view {
        (uint256 reserve0, uint256 reserve1) = pool.getReserves();
        assertEq(reserve0, 0);
        assertEq(reserve1, 0);
    }

    function testGetAmountOut() public view {
        uint256 amountOut = pool.getAmountOut(1000, 10000, 10000);
        assertGt(amountOut, 0);
    }
}
