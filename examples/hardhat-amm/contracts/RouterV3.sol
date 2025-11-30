// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title RouterV3
 * @dev Multi-hop swap router with path encoding
 */
contract RouterV3 {
    struct SwapParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    struct ExactOutputParams {
        bytes path;
        address recipient;
        uint256 amountOut;
        uint256 amountInMaximum;
    }

    address public factory;
    address public WETH;

    event Swap(address indexed sender, address indexed recipient, uint256 amountIn, uint256 amountOut);

    error DeadlineExpired();
    error InsufficientOutput();
    error ExcessiveInput();
    error InvalidPath();

    modifier checkDeadline(uint256 deadline) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        _;
    }

    constructor(address _factory, address _WETH) {
        factory = _factory;
        WETH = _WETH;
    }

    function exactInputSingle(SwapParams calldata params)
        external
        payable
        checkDeadline(params.deadline)
        returns (uint256 amountOut)
    {
        (address tokenIn, address tokenOut, uint24 fee) = _decodePath(params.path);
        
        // Simplified swap logic
        amountOut = (params.amountIn * 997) / 1000;
        
        if (amountOut < params.amountOutMinimum) revert InsufficientOutput();
        
        emit Swap(msg.sender, params.recipient, params.amountIn, amountOut);
        
        return amountOut;
    }

    function exactInput(ExactInputParams calldata params)
        external
        payable
        returns (uint256 amountOut)
    {
        uint256 amountIn = params.amountIn;
        
        while (params.path.length > 0) {
            (address tokenIn, address tokenOut, uint24 fee) = _decodePath(params.path);
            amountOut = (amountIn * 997) / 1000;
            amountIn = amountOut;
        }
        
        if (amountOut < params.amountOutMinimum) revert InsufficientOutput();
        
        emit Swap(msg.sender, params.recipient, params.amountIn, amountOut);
        
        return amountOut;
    }

    function exactOutputSingle(SwapParams calldata params)
        external
        payable
        checkDeadline(params.deadline)
        returns (uint256 amountIn)
    {
        // Simplified calculation
        amountIn = (params.amountIn * 1000) / 997;
        
        emit Swap(msg.sender, params.recipient, amountIn, params.amountIn);
        
        return amountIn;
    }

    function quoteExactInput(bytes memory path, uint256 amountIn)
        external
        view
        returns (uint256 amountOut)
    {
        return (amountIn * 997) / 1000;
    }

    function quoteExactOutput(bytes memory path, uint256 amountOut)
        external
        view
        returns (uint256 amountIn)
    {
        return (amountOut * 1000) / 997;
    }

    function _decodePath(bytes memory path)
        internal
        pure
        returns (address tokenA, address tokenB, uint24 fee)
    {
        if (path.length < 43) revert InvalidPath();
        
        assembly {
            tokenA := mload(add(path, 20))
            fee := mload(add(path, 23))
            tokenB := mload(add(path, 43))
        }
    }
}
