// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title LendingPool
 * @dev Decentralized lending protocol with variable interest rates
 */
contract LendingPool {
    struct UserAccount {
        uint256 deposited;
        uint256 borrowed;
        uint256 lastUpdateTimestamp;
        uint256 accruedInterest;
    }

    struct Market {
        uint256 totalDeposits;
        uint256 totalBorrows;
        uint256 baseRate;
        uint256 slope1;
        uint256 slope2;
        uint256 optimalUtilization;
        uint256 reserveFactor;
        uint256 lastAccrualTimestamp;
        bool isActive;
    }

    mapping(address => mapping(address => UserAccount)) public accounts;
    mapping(address => Market) public markets;
    mapping(address => uint256) public collateralFactors; // in basis points
    mapping(address => uint256) public liquidationThresholds;
    
    address[] public supportedTokens;
    address public admin;
    uint256 public constant SECONDS_PER_YEAR = 31536000;

    event Deposit(address indexed user, address indexed token, uint256 amount);
    event Withdraw(address indexed user, address indexed token, uint256 amount);
    event Borrow(address indexed user, address indexed token, uint256 amount);
    event Repay(address indexed user, address indexed token, uint256 amount);
    event Liquidation(address indexed borrower, address indexed liquidator, address token, uint256 amount);
    event MarketCreated(address indexed token, uint256 baseRate, uint256 optimalUtilization);

    error MarketNotActive();
    error InsufficientLiquidity();
    error InsufficientCollateral();
    error HealthyPosition();
    error Unauthorized();
    error InvalidAmount();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert Unauthorized();
        _;
    }

    constructor() {
        admin = msg.sender;
    }

    function createMarket(
        address token,
        uint256 baseRate,
        uint256 slope1,
        uint256 slope2,
        uint256 optimalUtilization,
        uint256 reserveFactor,
        uint256 collateralFactor,
        uint256 liquidationThreshold
    ) external onlyAdmin {
        markets[token] = Market({
            totalDeposits: 0,
            totalBorrows: 0,
            baseRate: baseRate,
            slope1: slope1,
            slope2: slope2,
            optimalUtilization: optimalUtilization,
            reserveFactor: reserveFactor,
            lastAccrualTimestamp: block.timestamp,
            isActive: true
        });

        collateralFactors[token] = collateralFactor;
        liquidationThresholds[token] = liquidationThreshold;
        supportedTokens.push(token);

        emit MarketCreated(token, baseRate, optimalUtilization);
    }

    function deposit(address token, uint256 amount) external payable {
        Market storage market = markets[token];
        if (!market.isActive) revert MarketNotActive();
        if (amount == 0) revert InvalidAmount();

        _accrueInterest(token);

        UserAccount storage account = accounts[msg.sender][token];
        account.deposited += amount;
        market.totalDeposits += amount;

        emit Deposit(msg.sender, token, amount);
    }

    function withdraw(address token, uint256 amount) external {
        Market storage market = markets[token];
        if (!market.isActive) revert MarketNotActive();

        _accrueInterest(token);

        UserAccount storage account = accounts[msg.sender][token];
        if (account.deposited < amount) revert InvalidAmount();
        if (market.totalDeposits - market.totalBorrows < amount) {
            revert InsufficientLiquidity();
        }

        account.deposited -= amount;
        market.totalDeposits -= amount;

        // Check if user still has sufficient collateral
        if (!_isHealthy(msg.sender)) revert InsufficientCollateral();

        emit Withdraw(msg.sender, token, amount);
    }

    function borrow(address token, uint256 amount) external {
        Market storage market = markets[token];
        if (!market.isActive) revert MarketNotActive();
        if (amount == 0) revert InvalidAmount();

        _accrueInterest(token);

        if (market.totalDeposits - market.totalBorrows < amount) {
            revert InsufficientLiquidity();
        }

        UserAccount storage account = accounts[msg.sender][token];
        account.borrowed += amount;
        market.totalBorrows += amount;

        if (!_isHealthy(msg.sender)) revert InsufficientCollateral();

        emit Borrow(msg.sender, token, amount);
    }

    function repay(address token, uint256 amount) external payable {
        Market storage market = markets[token];
        if (!market.isActive) revert MarketNotActive();

        _accrueInterest(token);

        UserAccount storage account = accounts[msg.sender][token];
        uint256 totalOwed = account.borrowed + account.accruedInterest;
        
        if (amount > totalOwed) {
            amount = totalOwed;
        }

        if (amount <= account.accruedInterest) {
            account.accruedInterest -= amount;
        } else {
            uint256 principalPayment = amount - account.accruedInterest;
            account.accruedInterest = 0;
            account.borrowed -= principalPayment;
        }

        market.totalBorrows -= amount;

        emit Repay(msg.sender, token, amount);
    }

    function liquidate(address borrower, address token, uint256 amount) external {
        if (_isHealthy(borrower)) revert HealthyPosition();

        _accrueInterest(token);

        UserAccount storage account = accounts[borrower][token];
        uint256 maxLiquidation = (account.borrowed + account.accruedInterest) / 2;
        
        if (amount > maxLiquidation) {
            amount = maxLiquidation;
        }

        // Transfer liquidation amount from liquidator and give them collateral + bonus
        account.borrowed -= amount;
        markets[token].totalBorrows -= amount;

        emit Liquidation(borrower, msg.sender, token, amount);
    }

    function getUtilizationRate(address token) public view returns (uint256) {
        Market memory market = markets[token];
        if (market.totalDeposits == 0) return 0;
        return (market.totalBorrows * 1e18) / market.totalDeposits;
    }

    function getBorrowRate(address token) public view returns (uint256) {
        Market memory market = markets[token];
        uint256 utilization = getUtilizationRate(token);

        if (utilization <= market.optimalUtilization) {
            return market.baseRate + (utilization * market.slope1) / 1e18;
        } else {
            uint256 excessUtilization = utilization - market.optimalUtilization;
            return market.baseRate + 
                   (market.optimalUtilization * market.slope1) / 1e18 +
                   (excessUtilization * market.slope2) / 1e18;
        }
    }

    function getSupplyRate(address token) public view returns (uint256) {
        Market memory market = markets[token];
        uint256 borrowRate = getBorrowRate(token);
        uint256 utilization = getUtilizationRate(token);
        uint256 rateToPool = borrowRate * (10000 - market.reserveFactor) / 10000;
        return (utilization * rateToPool) / 1e18;
    }

    function getAccountHealth(address user) public view returns (uint256) {
        uint256 totalCollateralValue = 0;
        uint256 totalBorrowValue = 0;

        for (uint256 i = 0; i < supportedTokens.length; i++) {
            address token = supportedTokens[i];
            UserAccount memory account = accounts[user][token];
            
            totalCollateralValue += (account.deposited * collateralFactors[token]) / 10000;
            totalBorrowValue += account.borrowed + account.accruedInterest;
        }

        if (totalBorrowValue == 0) return type(uint256).max;
        return (totalCollateralValue * 1e18) / totalBorrowValue;
    }

    function getUserAccount(address user, address token) 
        external 
        view 
        returns (UserAccount memory) 
    {
        return accounts[user][token];
    }

    function getMarket(address token) external view returns (Market memory) {
        return markets[token];
    }

    function _accrueInterest(address token) internal {
        Market storage market = markets[token];
        uint256 timeElapsed = block.timestamp - market.lastAccrualTimestamp;
        
        if (timeElapsed == 0) return;

        uint256 borrowRate = getBorrowRate(token);
        uint256 interestFactor = (borrowRate * timeElapsed) / SECONDS_PER_YEAR;
        uint256 interestAccrued = (market.totalBorrows * interestFactor) / 1e18;

        market.totalBorrows += interestAccrued;
        market.lastAccrualTimestamp = block.timestamp;
    }

    function _isHealthy(address user) internal view returns (bool) {
        uint256 health = getAccountHealth(user);
        return health >= 1e18;
    }
}
