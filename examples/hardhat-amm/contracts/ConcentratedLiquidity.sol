// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title ConcentratedLiquidity
 * @dev Uniswap V3 style concentrated liquidity AMM
 */
contract ConcentratedLiquidity {
    struct Position {
        uint256 liquidity;
        int24 tickLower;
        int24 tickUpper;
        uint256 feeGrowthInside0Last;
        uint256 feeGrowthInside1Last;
        uint128 tokensOwed0;
        uint128 tokensOwed1;
    }

    struct Tick {
        uint128 liquidityGross;
        int128 liquidityNet;
        uint256 feeGrowthOutside0;
        uint256 feeGrowthOutside1;
        bool initialized;
    }

    struct PoolInfo {
        uint160 sqrtPriceX96;
        int24 tick;
        uint16 observationIndex;
        uint16 observationCardinality;
        uint16 observationCardinalityNext;
        uint8 feeProtocol;
        bool unlocked;
    }

    address public token0;
    address public token1;
    uint24 public fee;
    int24 public tickSpacing;

    PoolInfo public poolInfo;
    
    mapping(bytes32 => Position) public positions;
    mapping(int24 => Tick) public ticks;
    mapping(address => uint256) public balances0;
    mapping(address => uint256) public balances1;
    
    uint256 public feeGrowthGlobal0;
    uint256 public feeGrowthGlobal1;
    uint128 public liquidity;

    uint256 private constant Q96 = 2**96;
    uint256 private constant Q128 = 2**128;

    event Mint(
        address indexed sender,
        address indexed owner,
        int24 indexed tickLower,
        int24 tickUpper,
        uint128 amount,
        uint256 amount0,
        uint256 amount1
    );
    
    event Burn(
        address indexed owner,
        int24 indexed tickLower,
        int24 tickUpper,
        uint128 amount,
        uint256 amount0,
        uint256 amount1
    );
    
    event Swap(
        address indexed sender,
        address indexed recipient,
        int256 amount0,
        int256 amount1,
        uint160 sqrtPriceX96,
        uint128 liquidity,
        int24 tick
    );
    
    event Collect(
        address indexed owner,
        address recipient,
        int24 indexed tickLower,
        int24 indexed tickUpper,
        uint128 amount0,
        uint128 amount1
    );

    error InsufficientLiquidity();
    error InvalidTickRange();
    error PositionNotFound();
    error SlippageExceeded();
    error Locked();

    modifier lock() {
        if (!poolInfo.unlocked) revert Locked();
        poolInfo.unlocked = false;
        _;
        poolInfo.unlocked = true;
    }

    constructor(
        address _token0,
        address _token1,
        uint24 _fee,
        int24 _tickSpacing
    ) {
        token0 = _token0;
        token1 = _token1;
        fee = _fee;
        tickSpacing = _tickSpacing;
        
        poolInfo.unlocked = true;
        poolInfo.sqrtPriceX96 = uint160(Q96);
    }

    function mint(
        address recipient,
        int24 tickLower,
        int24 tickUpper,
        uint128 amount
    ) external lock returns (uint256 amount0, uint256 amount1) {
        if (tickLower >= tickUpper) revert InvalidTickRange();
        if (tickLower % tickSpacing != 0 || tickUpper % tickSpacing != 0) {
            revert InvalidTickRange();
        }

        bytes32 positionKey = keccak256(abi.encodePacked(recipient, tickLower, tickUpper));
        Position storage position = positions[positionKey];

        _updatePosition(recipient, tickLower, tickUpper, int128(amount));

        if (amount > 0) {
            if (poolInfo.tick >= tickLower && poolInfo.tick < tickUpper) {
                liquidity += amount;
            }
        }

        (amount0, amount1) = _getAmountsForLiquidity(
            poolInfo.sqrtPriceX96,
            tickLower,
            tickUpper,
            amount
        );

        balances0[recipient] += amount0;
        balances1[recipient] += amount1;

        emit Mint(msg.sender, recipient, tickLower, tickUpper, amount, amount0, amount1);
    }

    function burn(
        int24 tickLower,
        int24 tickUpper,
        uint128 amount
    ) external lock returns (uint256 amount0, uint256 amount1) {
        bytes32 positionKey = keccak256(abi.encodePacked(msg.sender, tickLower, tickUpper));
        Position storage position = positions[positionKey];
        
        if (position.liquidity < amount) revert InsufficientLiquidity();

        _updatePosition(msg.sender, tickLower, tickUpper, -int128(amount));

        if (poolInfo.tick >= tickLower && poolInfo.tick < tickUpper) {
            liquidity -= amount;
        }

        (amount0, amount1) = _getAmountsForLiquidity(
            poolInfo.sqrtPriceX96,
            tickLower,
            tickUpper,
            amount
        );

        if (amount0 > 0) position.tokensOwed0 += uint128(amount0);
        if (amount1 > 0) position.tokensOwed1 += uint128(amount1);

        emit Burn(msg.sender, tickLower, tickUpper, amount, amount0, amount1);
    }

    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96
    ) external lock returns (int256 amount0, int256 amount1) {
        if (liquidity == 0) revert InsufficientLiquidity();

        PoolInfo memory pool = poolInfo;
        
        uint160 sqrtPriceX96 = pool.sqrtPriceX96;
        int24 tick = pool.tick;

        // Simplified swap logic
        if (zeroForOne) {
            amount0 = amountSpecified;
            amount1 = -int256(uint256(amountSpecified) * sqrtPriceX96 / Q96);
        } else {
            amount1 = amountSpecified;
            amount0 = -int256(uint256(amountSpecified) * Q96 / sqrtPriceX96);
        }

        uint256 feeAmount = uint256(amount0 > 0 ? amount0 : -amount0) * fee / 1000000;
        
        if (zeroForOne) {
            feeGrowthGlobal0 += (feeAmount * Q128) / liquidity;
        } else {
            feeGrowthGlobal1 += (feeAmount * Q128) / liquidity;
        }

        poolInfo.sqrtPriceX96 = sqrtPriceX96;
        poolInfo.tick = tick;

        emit Swap(msg.sender, recipient, amount0, amount1, sqrtPriceX96, liquidity, tick);
    }

    function collect(
        address recipient,
        int24 tickLower,
        int24 tickUpper,
        uint128 amount0Requested,
        uint128 amount1Requested
    ) external lock returns (uint128 amount0, uint128 amount1) {
        bytes32 positionKey = keccak256(abi.encodePacked(msg.sender, tickLower, tickUpper));
        Position storage position = positions[positionKey];

        amount0 = amount0Requested > position.tokensOwed0 
            ? position.tokensOwed0 
            : amount0Requested;
        amount1 = amount1Requested > position.tokensOwed1 
            ? position.tokensOwed1 
            : amount1Requested;

        if (amount0 > 0) {
            position.tokensOwed0 -= amount0;
            balances0[recipient] -= amount0;
        }

        if (amount1 > 0) {
            position.tokensOwed1 -= amount1;
            balances1[recipient] -= amount1;
        }

        emit Collect(msg.sender, recipient, tickLower, tickUpper, amount0, amount1);
    }

    function getPosition(address owner, int24 tickLower, int24 tickUpper) 
        external 
        view 
        returns (Position memory) 
    {
        bytes32 positionKey = keccak256(abi.encodePacked(owner, tickLower, tickUpper));
        return positions[positionKey];
    }

    function getTick(int24 tick) external view returns (Tick memory) {
        return ticks[tick];
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidityCumulativeX128s = new uint160[](secondsAgos.length);
        
        // Simplified - production would implement full oracle logic
        for (uint256 i = 0; i < secondsAgos.length; i++) {
            tickCumulatives[i] = int56(int24(poolInfo.tick)) * int56(int32(secondsAgos[i]));
            secondsPerLiquidityCumulativeX128s[i] = uint160(secondsAgos[i]) * Q128 / liquidity;
        }
    }

    function _updatePosition(
        address owner,
        int24 tickLower,
        int24 tickUpper,
        int128 liquidityDelta
    ) internal {
        bytes32 positionKey = keccak256(abi.encodePacked(owner, tickLower, tickUpper));
        Position storage position = positions[positionKey];

        uint256 feeGrowthInside0;
        uint256 feeGrowthInside1;

        if (liquidityDelta != 0) {
            _updateTick(tickLower, liquidityDelta, false);
            _updateTick(tickUpper, liquidityDelta, true);

            (feeGrowthInside0, feeGrowthInside1) = _getFeeGrowthInside(tickLower, tickUpper);
        }

        if (liquidityDelta > 0) {
            position.liquidity += uint128(liquidityDelta);
        } else {
            position.liquidity -= uint128(-liquidityDelta);
        }

        position.tickLower = tickLower;
        position.tickUpper = tickUpper;
        position.feeGrowthInside0Last = feeGrowthInside0;
        position.feeGrowthInside1Last = feeGrowthInside1;
    }

    function _updateTick(int24 tick, int128 liquidityDelta, bool upper) internal {
        Tick storage tickInfo = ticks[tick];

        uint128 liquidityGrossBefore = tickInfo.liquidityGross;
        uint128 liquidityGrossAfter = liquidityDelta > 0
            ? liquidityGrossBefore + uint128(liquidityDelta)
            : liquidityGrossBefore - uint128(-liquidityDelta);

        tickInfo.liquidityGross = liquidityGrossAfter;

        if (upper) {
            tickInfo.liquidityNet -= liquidityDelta;
        } else {
            tickInfo.liquidityNet += liquidityDelta;
        }

        if (liquidityGrossBefore == 0 && liquidityGrossAfter > 0) {
            tickInfo.initialized = true;
        }
    }

    function _getFeeGrowthInside(int24 tickLower, int24 tickUpper)
        internal
        view
        returns (uint256 feeGrowthInside0, uint256 feeGrowthInside1)
    {
        Tick memory lower = ticks[tickLower];
        Tick memory upper = ticks[tickUpper];

        if (poolInfo.tick >= tickLower && poolInfo.tick < tickUpper) {
            feeGrowthInside0 = feeGrowthGlobal0 - lower.feeGrowthOutside0 - upper.feeGrowthOutside0;
            feeGrowthInside1 = feeGrowthGlobal1 - lower.feeGrowthOutside1 - upper.feeGrowthOutside1;
        } else if (poolInfo.tick < tickLower) {
            feeGrowthInside0 = lower.feeGrowthOutside0 - upper.feeGrowthOutside0;
            feeGrowthInside1 = lower.feeGrowthOutside1 - upper.feeGrowthOutside1;
        } else {
            feeGrowthInside0 = upper.feeGrowthOutside0 - lower.feeGrowthOutside0;
            feeGrowthInside1 = upper.feeGrowthOutside1 - lower.feeGrowthOutside1;
        }
    }

    function _getAmountsForLiquidity(
        uint160 sqrtPriceX96,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidityAmount
    ) internal pure returns (uint256 amount0, uint256 amount1) {
        // Simplified calculation
        amount0 = uint256(liquidityAmount);
        amount1 = uint256(liquidityAmount) * sqrtPriceX96 / Q96;
    }
}
