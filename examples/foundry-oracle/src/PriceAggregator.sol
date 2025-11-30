// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title PriceAggregator
 * @dev Multi-source oracle aggregator with median pricing and outlier detection
 */
contract PriceAggregator {
    struct OracleData {
        address oracle;
        uint256 weight;
        uint256 lastUpdate;
        uint256 successfulUpdates;
        uint256 failedUpdates;
        bool isActive;
    }

    struct PriceFeed {
        uint256 price;
        uint256 timestamp;
        uint256 confidence;
        address source;
    }

    struct AggregatedPrice {
        uint256 price;
        uint256 timestamp;
        uint256 deviation;
        uint256 confidence;
        uint256 sources;
    }

    mapping(address => mapping(address => PriceFeed)) public priceFeeds;
    mapping(address => OracleData) public oracles;
    mapping(address => AggregatedPrice) public aggregatedPrices;
    mapping(address => uint256) public heartbeat;
    
    address[] public oracleList;
    address public admin;
    
    uint256 public minOracles = 3;
    uint256 public maxDeviation = 500; // 5%
    uint256 public defaultHeartbeat = 1 hours;

    event OracleAdded(address indexed oracle, uint256 weight);
    event OracleRemoved(address indexed oracle);
    event OracleWeightUpdated(address indexed oracle, uint256 newWeight);
    event PriceUpdated(address indexed token, address indexed oracle, uint256 price);
    event PriceAggregated(address indexed token, uint256 price, uint256 confidence);
    event OutlierDetected(address indexed token, address indexed oracle, uint256 price);
    event HeartbeatMissed(address indexed token, address indexed oracle);

    error InsufficientOracles();
    error Unauthorized();
    error InvalidPrice();
    error StalePrice();
    error ExcessiveDeviation();
    error OracleNotActive();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert Unauthorized();
        _;
    }

    modifier onlyOracle() {
        if (!oracles[msg.sender].isActive) revert Unauthorized();
        _;
    }

    constructor() {
        admin = msg.sender;
    }

    function addOracle(address oracle, uint256 weight) external onlyAdmin {
        if (oracles[oracle].isActive) revert OracleNotActive();

        oracles[oracle] = OracleData({
            oracle: oracle,
            weight: weight,
            lastUpdate: 0,
            successfulUpdates: 0,
            failedUpdates: 0,
            isActive: true
        });

        oracleList.push(oracle);

        emit OracleAdded(oracle, weight);
    }

    function removeOracle(address oracle) external onlyAdmin {
        if (!oracles[oracle].isActive) revert OracleNotActive();
        
        oracles[oracle].isActive = false;

        emit OracleRemoved(oracle);
    }

    function updateOracleWeight(address oracle, uint256 newWeight) external onlyAdmin {
        if (!oracles[oracle].isActive) revert OracleNotActive();
        
        oracles[oracle].weight = newWeight;

        emit OracleWeightUpdated(oracle, newWeight);
    }

    function submitPrice(address token, uint256 price, uint256 confidence) external onlyOracle {
        if (price == 0) revert InvalidPrice();

        priceFeeds[token][msg.sender] = PriceFeed({
            price: price,
            timestamp: block.timestamp,
            confidence: confidence,
            source: msg.sender
        });

        OracleData storage oracle = oracles[msg.sender];
        oracle.lastUpdate = block.timestamp;
        oracle.successfulUpdates++;

        emit PriceUpdated(token, msg.sender, price);

        _aggregatePrice(token);
    }

    function getPrice(address token) external view returns (uint256, uint256) {
        AggregatedPrice memory aggPrice = aggregatedPrices[token];
        
        if (block.timestamp - aggPrice.timestamp > heartbeat[token]) {
            revert StalePrice();
        }

        return (aggPrice.price, aggPrice.confidence);
    }

    function getPriceWithDeviation(address token) 
        external 
        view 
        returns (uint256 price, uint256 deviation, uint256 confidence) 
    {
        AggregatedPrice memory aggPrice = aggregatedPrices[token];
        
        if (block.timestamp - aggPrice.timestamp > heartbeat[token]) {
            revert StalePrice();
        }

        return (aggPrice.price, aggPrice.deviation, aggPrice.confidence);
    }

    function setHeartbeat(address token, uint256 duration) external onlyAdmin {
        heartbeat[token] = duration;
    }

    function checkHeartbeat(address token) external {
        for (uint256 i = 0; i < oracleList.length; i++) {
            address oracle = oracleList[i];
            if (!oracles[oracle].isActive) continue;

            PriceFeed memory feed = priceFeeds[token][oracle];
            uint256 expectedHeartbeat = heartbeat[token] > 0 ? heartbeat[token] : defaultHeartbeat;

            if (block.timestamp - feed.timestamp > expectedHeartbeat) {
                oracles[oracle].failedUpdates++;
                emit HeartbeatMissed(token, oracle);
            }
        }
    }

    function getOracleData(address oracle) external view returns (OracleData memory) {
        return oracles[oracle];
    }

    function getActiveSources(address token) external view returns (uint256) {
        uint256 count = 0;
        uint256 maxAge = heartbeat[token] > 0 ? heartbeat[token] : defaultHeartbeat;

        for (uint256 i = 0; i < oracleList.length; i++) {
            address oracle = oracleList[i];
            if (!oracles[oracle].isActive) continue;

            PriceFeed memory feed = priceFeeds[token][oracle];
            if (block.timestamp - feed.timestamp <= maxAge) {
                count++;
            }
        }

        return count;
    }

    function _aggregatePrice(address token) internal {
        uint256[] memory prices = new uint256[](oracleList.length);
        uint256[] memory weights = new uint256[](oracleList.length);
        uint256 validCount = 0;
        uint256 maxAge = heartbeat[token] > 0 ? heartbeat[token] : defaultHeartbeat;

        for (uint256 i = 0; i < oracleList.length; i++) {
            address oracle = oracleList[i];
            if (!oracles[oracle].isActive) continue;

            PriceFeed memory feed = priceFeeds[token][oracle];
            if (block.timestamp - feed.timestamp > maxAge) continue;

            prices[validCount] = feed.price;
            weights[validCount] = oracles[oracle].weight;
            validCount++;
        }

        if (validCount < minOracles) revert InsufficientOracles();

        uint256 medianPrice = _calculateMedian(prices, validCount);
        uint256 deviation = _calculateDeviation(prices, validCount, medianPrice);
        
        if (deviation > maxDeviation) {
            _detectOutliers(token, prices, validCount, medianPrice);
        }

        uint256 weightedPrice = _calculateWeightedPrice(prices, weights, validCount);
        uint256 avgConfidence = _calculateAverageConfidence(token, validCount);

        aggregatedPrices[token] = AggregatedPrice({
            price: weightedPrice,
            timestamp: block.timestamp,
            deviation: deviation,
            confidence: avgConfidence,
            sources: validCount
        });

        emit PriceAggregated(token, weightedPrice, avgConfidence);
    }

    function _calculateMedian(uint256[] memory prices, uint256 length) 
        internal 
        pure 
        returns (uint256) 
    {
        uint256[] memory sorted = new uint256[](length);
        for (uint256 i = 0; i < length; i++) {
            sorted[i] = prices[i];
        }

        for (uint256 i = 0; i < length; i++) {
            for (uint256 j = i + 1; j < length; j++) {
                if (sorted[i] > sorted[j]) {
                    uint256 temp = sorted[i];
                    sorted[i] = sorted[j];
                    sorted[j] = temp;
                }
            }
        }

        if (length % 2 == 0) {
            return (sorted[length / 2 - 1] + sorted[length / 2]) / 2;
        } else {
            return sorted[length / 2];
        }
    }

    function _calculateWeightedPrice(
        uint256[] memory prices,
        uint256[] memory weights,
        uint256 length
    ) internal pure returns (uint256) {
        uint256 totalWeightedPrice = 0;
        uint256 totalWeight = 0;

        for (uint256 i = 0; i < length; i++) {
            totalWeightedPrice += prices[i] * weights[i];
            totalWeight += weights[i];
        }

        return totalWeightedPrice / totalWeight;
    }

    function _calculateDeviation(
        uint256[] memory prices,
        uint256 length,
        uint256 median
    ) internal pure returns (uint256) {
        uint256 sumSquaredDiff = 0;

        for (uint256 i = 0; i < length; i++) {
            int256 diff = int256(prices[i]) - int256(median);
            sumSquaredDiff += uint256(diff * diff);
        }

        uint256 variance = sumSquaredDiff / length;
        return (_sqrt(variance) * 10000) / median;
    }

    function _calculateAverageConfidence(address token, uint256 validCount) 
        internal 
        view 
        returns (uint256) 
    {
        uint256 totalConfidence = 0;
        uint256 count = 0;

        for (uint256 i = 0; i < oracleList.length; i++) {
            address oracle = oracleList[i];
            if (!oracles[oracle].isActive) continue;

            PriceFeed memory feed = priceFeeds[token][oracle];
            if (feed.timestamp > 0) {
                totalConfidence += feed.confidence;
                count++;
            }
        }

        return count > 0 ? totalConfidence / count : 0;
    }

    function _detectOutliers(
        address token,
        uint256[] memory prices,
        uint256 length,
        uint256 median
    ) internal {
        for (uint256 i = 0; i < length; i++) {
            uint256 deviation = prices[i] > median 
                ? ((prices[i] - median) * 10000) / median
                : ((median - prices[i]) * 10000) / median;

            if (deviation > maxDeviation) {
                emit OutlierDetected(token, oracleList[i], prices[i]);
            }
        }
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
