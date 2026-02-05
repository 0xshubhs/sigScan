// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title VolatilityOracle
 * @dev Oracle for tracking and calculating implied volatility
 */
contract VolatilityOracle {
    struct PricePoint {
        uint256 price;
        uint256 timestamp;
    }

    struct VolatilityData {
        uint256 impliedVolatility;
        uint256 historicalVolatility;
        uint256 lastUpdate;
        uint256 sampleSize;
    }

    mapping(address => PricePoint[]) public priceHistory;
    mapping(address => VolatilityData) public volatilityData;
    mapping(address => bool) public authorizedUpdaters;
    
    address public admin;
    uint256 public maxHistorySize = 100;
    uint256 public updateInterval = 1 hours;

    event PriceUpdated(address indexed token, uint256 price, uint256 timestamp);
    event VolatilityCalculated(address indexed token, uint256 historical, uint256 implied);
    event UpdaterAuthorized(address indexed updater);
    event UpdaterRevoked(address indexed updater);

    error Unauthorized();
    error InvalidPrice();
    error InsufficientData();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert Unauthorized();
        _;
    }

    modifier onlyAuthorized() {
        if (!authorizedUpdaters[msg.sender] && msg.sender != admin) revert Unauthorized();
        _;
    }

    constructor() {
        admin = msg.sender;
        authorizedUpdaters[msg.sender] = true;
    }

    function updatePrice(address token, uint256 price) external onlyAuthorized {
        if (price == 0) revert InvalidPrice();

        priceHistory[token].push(PricePoint({
            price: price,
            timestamp: block.timestamp
        }));

        if (priceHistory[token].length > maxHistorySize) {
            _removeOldestPrice(token);
        }

        if (priceHistory[token].length >= 2) {
            _calculateVolatility(token);
        }

        emit PriceUpdated(token, price, block.timestamp);
    }

    function calculateHistoricalVolatility(address token) external view returns (uint256) {
        PricePoint[] memory history = priceHistory[token];
        if (history.length < 2) revert InsufficientData();

        uint256 sumSquaredReturns = 0;
        uint256 count = 0;

        for (uint256 i = 1; i < history.length; i++) {
            int256 priceReturn = int256(history[i].price) - int256(history[i-1].price);
            int256 squaredReturn = (priceReturn * priceReturn) / int256(history[i-1].price);
            sumSquaredReturns += uint256(squaredReturn);
            count++;
        }

        uint256 variance = sumSquaredReturns / count;
        return _sqrt(variance * 365 days);
    }

    function authorizeUpdater(address updater) external onlyAdmin {
        authorizedUpdaters[updater] = true;
        emit UpdaterAuthorized(updater);
    }

    function revokeUpdater(address updater) external onlyAdmin {
        authorizedUpdaters[updater] = false;
        emit UpdaterRevoked(updater);
    }

    function getVolatilityData(address token) external view returns (VolatilityData memory) {
        return volatilityData[token];
    }

    function getPriceHistory(address token) external view returns (PricePoint[] memory) {
        return priceHistory[token];
    }

    function _calculateVolatility(address token) internal {
        uint256 historical = this.calculateHistoricalVolatility(token);
        
        volatilityData[token] = VolatilityData({
            impliedVolatility: historical,
            historicalVolatility: historical,
            lastUpdate: block.timestamp,
            sampleSize: priceHistory[token].length
        });

        emit VolatilityCalculated(token, historical, historical);
    }

    function _removeOldestPrice(address token) internal {
        PricePoint[] storage history = priceHistory[token];
        for (uint256 i = 0; i < history.length - 1; i++) {
            history[i] = history[i + 1];
        }
        history.pop();
    }

    function _sqrt(uint256 x) internal pure returns (uint256) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        uint256 y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
        return y;
    }
}
