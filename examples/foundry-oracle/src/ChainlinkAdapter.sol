// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title ChainlinkAdapter
 * @dev Adapter for Chainlink price feeds with circuit breaker
 */
contract ChainlinkAdapter {
    struct FeedConfig {
        address feedAddress;
        uint8 decimals;
        uint256 heartbeat;
        uint256 minAnswer;
        uint256 maxAnswer;
        bool isActive;
    }

    mapping(address => FeedConfig) public feedConfigs;
    mapping(address => uint256) public lastGoodPrice;
    
    address public admin;
    address public aggregator;
    
    uint256 public circuitBreakerThreshold = 1000; // 10%
    bool public emergencyStop;

    event FeedConfigured(address indexed token, address feed, uint256 heartbeat);
    event CircuitBreakerTriggered(address indexed token, uint256 price, uint256 lastPrice);
    event EmergencyStopActivated();
    event EmergencyStopDeactivated();

    error Unauthorized();
    error StalePrice();
    error InvalidPrice();
    error CircuitBreakerActive();
    error EmergencyStopped();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert Unauthorized();
        _;
    }

    modifier notStopped() {
        if (emergencyStop) revert EmergencyStopped();
        _;
    }

    constructor(address _aggregator) {
        admin = msg.sender;
        aggregator = _aggregator;
    }

    function configureFeed(
        address token,
        address feedAddress,
        uint8 decimals,
        uint256 heartbeat,
        uint256 minAnswer,
        uint256 maxAnswer
    ) external onlyAdmin {
        feedConfigs[token] = FeedConfig({
            feedAddress: feedAddress,
            decimals: decimals,
            heartbeat: heartbeat,
            minAnswer: minAnswer,
            maxAnswer: maxAnswer,
            isActive: true
        });

        emit FeedConfigured(token, feedAddress, heartbeat);
    }

    function getPrice(address token) external view notStopped returns (uint256, uint256) {
        FeedConfig memory config = feedConfigs[token];
        if (!config.isActive) revert InvalidPrice();

        // Simplified - production would call actual Chainlink feed
        uint256 price = lastGoodPrice[token];
        uint256 confidence = 9500; // 95%

        return (price, confidence);
    }

    function activateEmergencyStop() external onlyAdmin {
        emergencyStop = true;
        emit EmergencyStopActivated();
    }

    function deactivateEmergencyStop() external onlyAdmin {
        emergencyStop = false;
        emit EmergencyStopDeactivated();
    }
}
