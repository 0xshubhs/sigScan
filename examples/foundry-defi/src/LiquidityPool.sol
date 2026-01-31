// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../lib/SafeMath.sol";
                                                                                                                                                                                                                                                                                                                                                                
/**
 * @title LiquidityPool
 * @dev Automated Market Maker liquidity pool implementation
 */
contract LiquidityPool {
    using SafeMath for uint256;

    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;

    address public token0;
    address public token1;
    uint256 public reserve0;
    uint256 public reserve1;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Mint(address indexed sender, uint256 amount0, uint256 amount1);
    event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to);
    event Swap(
        address indexed sender,
        uint256 amount0In,
        uint256 amount1In,
        uint256 amount0Out,
        uint256 amount1Out,
        address indexed to
    );
    event Sync(uint256 reserve0, uint256 reserve1);
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error InsufficientLiquidity();
    error InvalidAmount();
    error InsufficientOutputAmount();
    error TransferFailed();

    constructor(address _token0, address _token1) {
        token0 = _token0;
        token1 = _token1;
        name = "LP Token";
        symbol = "LP-V2";
    }

    function addLiquidity(
        uint256 amount0Desired,
        uint256 amount1Desired,
        uint256 amount0Min,
        uint256 amount1Min,
        address to
    ) external returns (uint256 amount0, uint256 amount1, uint256 liquidity) {
        (amount0, amount1) = _calculateOptimalAmounts(
            amount0Desired,
            amount1Desired,
            amount0Min,
            amount1Min
        );

        liquidity = _mint(to, amount0, amount1);
        emit Mint(msg.sender, amount0, amount1);
    }

    function removeLiquidity(
        uint256 liquidity,
        uint256 amount0Min,
        uint256 amount1Min,
        address to
    ) external returns (uint256 amount0, uint256 amount1) {
        (amount0, amount1) = _burn(to, liquidity);
        
        if (amount0 < amount0Min) revert InsufficientOutputAmount();
        if (amount1 < amount1Min) revert InsufficientOutputAmount();

        emit Burn(msg.sender, amount0, amount1, to);
    }

    function swap(
        uint256 amount0Out,
        uint256 amount1Out,
        address to
    ) external {
        if (amount0Out == 0 && amount1Out == 0) revert InvalidAmount();
        if (amount0Out > reserve0 || amount1Out > reserve1) revert InsufficientLiquidity();

        _swap(amount0Out, amount1Out, to);
        emit Swap(msg.sender, 0, 0, amount0Out, amount1Out, to);
    }

    function getReserves() public view returns (uint256 _reserve0, uint256 _reserve1) {
        _reserve0 = reserve0;
        _reserve1 = reserve1;
    }

    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        public
        pure
        returns (uint256 amountOut)
    {
        if (amountIn == 0) revert InvalidAmount();
        if (reserveIn == 0 || reserveOut == 0) revert InsufficientLiquidity();

        uint256 amountInWithFee = amountIn.mul(997);
        uint256 numerator = amountInWithFee.mul(reserveOut);
        uint256 denominator = reserveIn.mul(1000).add(amountInWithFee);
        amountOut = numerator / denominator;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        if (allowance[from][msg.sender] != type(uint256).max) {
            allowance[from][msg.sender] = allowance[from][msg.sender].sub(value);
        }
        _transfer(from, to, value);
        return true;
    }

    function _calculateOptimalAmounts(
        uint256 amount0Desired,
        uint256 amount1Desired,
        uint256 amount0Min,
        uint256 amount1Min
    ) internal view returns (uint256 amount0, uint256 amount1) {
        if (reserve0 == 0 && reserve1 == 0) {
            (amount0, amount1) = (amount0Desired, amount1Desired);
        } else {
            uint256 amount1Optimal = (amount0Desired * reserve1) / reserve0;
            if (amount1Optimal <= amount1Desired) {
                if (amount1Optimal < amount1Min) revert InsufficientOutputAmount();
                (amount0, amount1) = (amount0Desired, amount1Optimal);
            } else {
                uint256 amount0Optimal = (amount1Desired * reserve0) / reserve1;
                if (amount0Optimal < amount0Min) revert InsufficientOutputAmount();
                (amount0, amount1) = (amount0Optimal, amount1Desired);
            }
        }
    }

    function _mint(address to, uint256 amount0, uint256 amount1) internal returns (uint256 liquidity) {
        if (totalSupply == 0) {
            liquidity = SafeMath.sqrt(amount0.mul(amount1));
        } else {
            liquidity = SafeMath.min(
                amount0.mul(totalSupply) / reserve0,
                amount1.mul(totalSupply) / reserve1
            );
        }
        
        if (liquidity == 0) revert InsufficientLiquidity();
        
        balanceOf[to] = balanceOf[to].add(liquidity);
        totalSupply = totalSupply.add(liquidity);
        
        reserve0 = reserve0.add(amount0);
        reserve1 = reserve1.add(amount1);
        
        emit Sync(reserve0, reserve1);
    }

    function _burn(address to, uint256 liquidity) internal returns (uint256 amount0, uint256 amount1) {
        uint256 balance0 = reserve0;
        uint256 balance1 = reserve1;
        
        amount0 = liquidity.mul(balance0) / totalSupply;
        amount1 = liquidity.mul(balance1) / totalSupply;
        
        if (amount0 == 0 || amount1 == 0) revert InsufficientLiquidity();
        
        balanceOf[msg.sender] = balanceOf[msg.sender].sub(liquidity);
        totalSupply = totalSupply.sub(liquidity);
        
        reserve0 = reserve0.sub(amount0);
        reserve1 = reserve1.sub(amount1);
        
        emit Sync(reserve0, reserve1);
    }

    function _swap(uint256 amount0Out, uint256 amount1Out, address to) internal {
        reserve0 = reserve0.sub(amount0Out);
        reserve1 = reserve1.sub(amount1Out);
        emit Sync(reserve0, reserve1);
    }

    function _transfer(address from, address to, uint256 value) internal {
        balanceOf[from] = balanceOf[from].sub(value);
        balanceOf[to] = balanceOf[to].add(value);
        emit Transfer(from, to, value);
    }
}
