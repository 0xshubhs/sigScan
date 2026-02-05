// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title OptionsMarket
 * @dev Decentralized options trading with Black-Scholes pricing
 */
contract OptionsMarket {
    enum OptionType { Call, Put }
    enum OptionState { Active, Exercised, Expired, Cancelled }

    struct Option {
        uint256 id;
        address writer;
        address holder;
        OptionType optionType;
        address underlying;
        uint256 strikePrice;
        uint256 premium;
        uint256 expiry;
        uint256 amount;
        OptionState state;
        uint256 collateral;
    }

    struct PricingParams {
        uint256 spotPrice;
        uint256 strikePrice;
        uint256 timeToExpiry;
        uint256 volatility;
        uint256 riskFreeRate;
    }

    uint256 public optionIdCounter;
    uint256 public constant PRECISION = 1e18;
    uint256 public minCollateralRatio = 15000; // 150%
    
    mapping(uint256 => Option) public options;
    mapping(address => uint256[]) public userOptions;
    mapping(address => mapping(address => uint256)) public collateralBalance;
    mapping(address => uint256) public impliedVolatility;
    
    address public priceOracle;
    address public feeCollector;
    uint256 public tradingFee = 30; // 0.3%

    event OptionWritten(
        uint256 indexed optionId,
        address indexed writer,
        OptionType optionType,
        uint256 strikePrice,
        uint256 premium,
        uint256 expiry
    );
    event OptionPurchased(uint256 indexed optionId, address indexed buyer, uint256 premium);
    event OptionExercised(uint256 indexed optionId, address indexed holder, uint256 payout);
    event OptionExpired(uint256 indexed optionId);
    event OptionCancelled(uint256 indexed optionId);
    event CollateralDeposited(address indexed user, address token, uint256 amount);
    event CollateralWithdrawn(address indexed user, address token, uint256 amount);
    event VolatilityUpdated(address indexed token, uint256 newVolatility);

    error InsufficientCollateral();
    error OptionNotActive();
    error OptionExpired();
    error Unauthorized();
    error InvalidStrike();
    error InvalidExpiry();
    error InsufficientPremium();
    error OptionNotExpired();

    constructor(address _priceOracle, address _feeCollector) {
        priceOracle = _priceOracle;
        feeCollector = _feeCollector;
    }

    function writeOption(
        OptionType optionType,
        address underlying,
        uint256 strikePrice,
        uint256 expiry,
        uint256 amount
    ) external payable returns (uint256) {
        if (strikePrice == 0) revert InvalidStrike();
        if (expiry <= block.timestamp) revert InvalidExpiry();

        uint256 requiredCollateral = _calculateRequiredCollateral(
            optionType,
            strikePrice,
            amount
        );

        if (collateralBalance[msg.sender][underlying] < requiredCollateral) {
            revert InsufficientCollateral();
        }

        uint256 premium = calculatePremium(
            underlying,
            strikePrice,
            expiry,
            amount,
            optionType
        );

        optionIdCounter++;
        uint256 optionId = optionIdCounter;

        options[optionId] = Option({
            id: optionId,
            writer: msg.sender,
            holder: address(0),
            optionType: optionType,
            underlying: underlying,
            strikePrice: strikePrice,
            premium: premium,
            expiry: expiry,
            amount: amount,
            state: OptionState.Active,
            collateral: requiredCollateral
        });

        collateralBalance[msg.sender][underlying] -= requiredCollateral;
        userOptions[msg.sender].push(optionId);

        emit OptionWritten(optionId, msg.sender, optionType, strikePrice, premium, expiry);

        return optionId;
    }

    function buyOption(uint256 optionId) external payable {
        Option storage option = options[optionId];
        
        if (option.state != OptionState.Active) revert OptionNotActive();
        if (option.expiry <= block.timestamp) revert OptionExpired();
        if (option.holder != address(0)) revert Unauthorized();
        if (msg.value < option.premium) revert InsufficientPremium();

        option.holder = msg.sender;
        userOptions[msg.sender].push(optionId);

        uint256 fee = (option.premium * tradingFee) / 10000;
        uint256 writerPayment = option.premium - fee;

        payable(option.writer).transfer(writerPayment);
        payable(feeCollector).transfer(fee);

        if (msg.value > option.premium) {
            payable(msg.sender).transfer(msg.value - option.premium);
        }

        emit OptionPurchased(optionId, msg.sender, option.premium);
    }

    function exerciseOption(uint256 optionId) external {
        Option storage option = options[optionId];
        
        if (option.holder != msg.sender) revert Unauthorized();
        if (option.state != OptionState.Active) revert OptionNotActive();
        if (option.expiry <= block.timestamp) revert OptionExpired();

        uint256 spotPrice = _getSpotPrice(option.underlying);
        uint256 payout = 0;

        if (option.optionType == OptionType.Call) {
            if (spotPrice > option.strikePrice) {
                payout = ((spotPrice - option.strikePrice) * option.amount) / PRECISION;
            }
        } else {
            if (option.strikePrice > spotPrice) {
                payout = ((option.strikePrice - spotPrice) * option.amount) / PRECISION;
            }
        }

        if (payout == 0) revert OptionNotActive();

        option.state = OptionState.Exercised;
        
        payable(msg.sender).transfer(payout);
        
        uint256 remainingCollateral = option.collateral - payout;
        if (remainingCollateral > 0) {
            collateralBalance[option.writer][option.underlying] += remainingCollateral;
        }

        emit OptionExercised(optionId, msg.sender, payout);
    }

    function expireOption(uint256 optionId) external {
        Option storage option = options[optionId];
        
        if (option.expiry > block.timestamp) revert OptionNotExpired();
        if (option.state != OptionState.Active) revert OptionNotActive();

        option.state = OptionState.Expired;
        collateralBalance[option.writer][option.underlying] += option.collateral;

        emit OptionExpired(optionId);
    }

    function cancelOption(uint256 optionId) external {
        Option storage option = options[optionId];
        
        if (option.writer != msg.sender) revert Unauthorized();
        if (option.holder != address(0)) revert Unauthorized();
        if (option.state != OptionState.Active) revert OptionNotActive();

        option.state = OptionState.Cancelled;
        collateralBalance[msg.sender][option.underlying] += option.collateral;

        emit OptionCancelled(optionId);
    }

    function depositCollateral(address token) external payable {
        collateralBalance[msg.sender][token] += msg.value;
        emit CollateralDeposited(msg.sender, token, msg.value);
    }

    function withdrawCollateral(address token, uint256 amount) external {
        if (collateralBalance[msg.sender][token] < amount) {
            revert InsufficientCollateral();
        }

        collateralBalance[msg.sender][token] -= amount;
        payable(msg.sender).transfer(amount);

        emit CollateralWithdrawn(msg.sender, token, amount);
    }

    function calculatePremium(
        address underlying,
        uint256 strikePrice,
        uint256 expiry,
        uint256 amount,
        OptionType optionType
    ) public view returns (uint256) {
        uint256 spotPrice = _getSpotPrice(underlying);
        uint256 timeToExpiry = expiry > block.timestamp ? expiry - block.timestamp : 0;
        uint256 volatility = impliedVolatility[underlying];

        PricingParams memory params = PricingParams({
            spotPrice: spotPrice,
            strikePrice: strikePrice,
            timeToExpiry: timeToExpiry,
            volatility: volatility,
            riskFreeRate: 500 // 5%
        });

        return _blackScholes(params, optionType, amount);
    }

    function updateVolatility(address token, uint256 newVolatility) external {
        if (msg.sender != priceOracle) revert Unauthorized();
        impliedVolatility[token] = newVolatility;
        emit VolatilityUpdated(token, newVolatility);
    }

    function getOption(uint256 optionId) external view returns (Option memory) {
        return options[optionId];
    }

    function getUserOptions(address user) external view returns (uint256[] memory) {
        return userOptions[user];
    }

    function getIntrinsicValue(uint256 optionId) external view returns (uint256) {
        Option memory option = options[optionId];
        uint256 spotPrice = _getSpotPrice(option.underlying);

        if (option.optionType == OptionType.Call) {
            return spotPrice > option.strikePrice 
                ? ((spotPrice - option.strikePrice) * option.amount) / PRECISION 
                : 0;
        } else {
            return option.strikePrice > spotPrice 
                ? ((option.strikePrice - spotPrice) * option.amount) / PRECISION 
                : 0;
        }
    }

    function getTimeValue(uint256 optionId) external view returns (uint256) {
        Option memory option = options[optionId];
        uint256 intrinsicValue = this.getIntrinsicValue(optionId);
        return option.premium > intrinsicValue ? option.premium - intrinsicValue : 0;
    }

    function _blackScholes(
        PricingParams memory params,
        OptionType optionType,
        uint256 amount
    ) internal pure returns (uint256) {
        // Simplified Black-Scholes - production would use proper implementation
        uint256 timeValueFactor = (params.volatility * params.timeToExpiry) / 365 days;
        uint256 moneyness = (params.spotPrice * PRECISION) / params.strikePrice;
        
        uint256 premium;
        if (optionType == OptionType.Call) {
            premium = moneyness > PRECISION 
                ? ((params.spotPrice - params.strikePrice) * amount) / PRECISION
                : (params.spotPrice * timeValueFactor) / 10000;
        } else {
            premium = params.strikePrice > params.spotPrice
                ? ((params.strikePrice - params.spotPrice) * amount) / PRECISION
                : (params.strikePrice * timeValueFactor) / 10000;
        }

        return premium;
    }

    function _calculateRequiredCollateral(
        OptionType optionType,
        uint256 strikePrice,
        uint256 amount
    ) internal view returns (uint256) {
        uint256 baseCollateral = optionType == OptionType.Call 
            ? amount 
            : (strikePrice * amount) / PRECISION;
        
        return (baseCollateral * minCollateralRatio) / 10000;
    }

    function _getSpotPrice(address token) internal view returns (uint256) {
        // Simplified - production would query actual oracle
        return PRECISION;
    }
}
