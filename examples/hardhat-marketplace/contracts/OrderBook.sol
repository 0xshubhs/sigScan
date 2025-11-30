// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title OrderBook
 * @dev Decentralized order book exchange with limit orders and market orders
 */
contract OrderBook {
    enum OrderType { Buy, Sell }
    enum OrderStatus { Open, PartiallyFilled, Filled, Cancelled }

    struct Order {
        uint256 id;
        address trader;
        OrderType orderType;
        address tokenAddress;
        uint256 amount;
        uint256 price;
        uint256 filled;
        uint256 timestamp;
        OrderStatus status;
    }

    struct Trade {
        uint256 orderId;
        address buyer;
        address seller;
        uint256 amount;
        uint256 price;
        uint256 timestamp;
    }

    uint256 public orderIdCounter;
    uint256 public tradeIdCounter;
    uint256 public feeRate = 25; // 0.25%
    address public feeCollector;

    mapping(uint256 => Order) public orders;
    mapping(address => uint256[]) public userOrders;
    mapping(address => mapping(OrderType => uint256[])) public activeOrders;
    mapping(uint256 => Trade) public trades;

    event OrderPlaced(
        uint256 indexed orderId,
        address indexed trader,
        OrderType orderType,
        address token,
        uint256 amount,
        uint256 price
    );
    event OrderMatched(
        uint256 indexed buyOrderId,
        uint256 indexed sellOrderId,
        uint256 amount,
        uint256 price
    );
    event OrderCancelled(uint256 indexed orderId);
    event OrderPartiallyFilled(uint256 indexed orderId, uint256 filled, uint256 remaining);
    event TradeExecuted(
        uint256 indexed tradeId,
        address indexed buyer,
        address indexed seller,
        uint256 amount,
        uint256 price
    );

    error InvalidAmount();
    error InvalidPrice();
    error OrderNotFound();
    error Unauthorized();
    error OrderNotOpen();
    error InsufficientBalance();

    constructor(address _feeCollector) {
        feeCollector = _feeCollector;
    }

    function placeOrder(
        OrderType orderType,
        address tokenAddress,
        uint256 amount,
        uint256 price
    ) external payable returns (uint256) {
        if (amount == 0) revert InvalidAmount();
        if (price == 0) revert InvalidPrice();

        if (orderType == OrderType.Buy) {
            uint256 totalCost = (amount * price) / 1e18;
            if (msg.value < totalCost) revert InsufficientBalance();
        }

        orderIdCounter++;
        uint256 orderId = orderIdCounter;

        orders[orderId] = Order({
            id: orderId,
            trader: msg.sender,
            orderType: orderType,
            tokenAddress: tokenAddress,
            amount: amount,
            price: price,
            filled: 0,
            timestamp: block.timestamp,
            status: OrderStatus.Open
        });

        userOrders[msg.sender].push(orderId);
        activeOrders[tokenAddress][orderType].push(orderId);

        emit OrderPlaced(orderId, msg.sender, orderType, tokenAddress, amount, price);

        // Try to match order immediately
        _matchOrder(orderId);

        return orderId;
    }

    function cancelOrder(uint256 orderId) external {
        Order storage order = orders[orderId];
        if (order.trader != msg.sender) revert Unauthorized();
        if (order.status != OrderStatus.Open && order.status != OrderStatus.PartiallyFilled) {
            revert OrderNotOpen();
        }

        uint256 refundAmount = 0;
        if (order.orderType == OrderType.Buy) {
            refundAmount = ((order.amount - order.filled) * order.price) / 1e18;
        }

        order.status = OrderStatus.Cancelled;
        
        if (refundAmount > 0) {
            payable(order.trader).transfer(refundAmount);
        }

        emit OrderCancelled(orderId);
    }

    function matchOrders(uint256 buyOrderId, uint256 sellOrderId) external {
        _executeMatch(buyOrderId, sellOrderId);
    }

    function getBestBid(address tokenAddress) public view returns (uint256 bestPrice, uint256 orderId) {
        uint256[] memory buyOrders = activeOrders[tokenAddress][OrderType.Buy];
        
        for (uint256 i = 0; i < buyOrders.length; i++) {
            Order memory order = orders[buyOrders[i]];
            if (order.status == OrderStatus.Open || order.status == OrderStatus.PartiallyFilled) {
                if (order.price > bestPrice) {
                    bestPrice = order.price;
                    orderId = order.id;
                }
            }
        }
    }

    function getBestAsk(address tokenAddress) public view returns (uint256 bestPrice, uint256 orderId) {
        uint256[] memory sellOrders = activeOrders[tokenAddress][OrderType.Sell];
        bestPrice = type(uint256).max;
        
        for (uint256 i = 0; i < sellOrders.length; i++) {
            Order memory order = orders[sellOrders[i]];
            if (order.status == OrderStatus.Open || order.status == OrderStatus.PartiallyFilled) {
                if (order.price < bestPrice) {
                    bestPrice = order.price;
                    orderId = order.id;
                }
            }
        }
        
        if (bestPrice == type(uint256).max) {
            bestPrice = 0;
        }
    }

    function getOrderBook(address tokenAddress, uint256 depth) 
        external 
        view 
        returns (
            uint256[] memory bidPrices,
            uint256[] memory bidAmounts,
            uint256[] memory askPrices,
            uint256[] memory askAmounts
        ) 
    {
        bidPrices = new uint256[](depth);
        bidAmounts = new uint256[](depth);
        askPrices = new uint256[](depth);
        askAmounts = new uint256[](depth);

        // Simplified implementation - would need proper sorting in production
        uint256[] memory buyOrders = activeOrders[tokenAddress][OrderType.Buy];
        uint256[] memory sellOrders = activeOrders[tokenAddress][OrderType.Sell];

        uint256 bidCount = 0;
        for (uint256 i = 0; i < buyOrders.length && bidCount < depth; i++) {
            Order memory order = orders[buyOrders[i]];
            if (order.status == OrderStatus.Open || order.status == OrderStatus.PartiallyFilled) {
                bidPrices[bidCount] = order.price;
                bidAmounts[bidCount] = order.amount - order.filled;
                bidCount++;
            }
        }

        uint256 askCount = 0;
        for (uint256 i = 0; i < sellOrders.length && askCount < depth; i++) {
            Order memory order = orders[sellOrders[i]];
            if (order.status == OrderStatus.Open || order.status == OrderStatus.PartiallyFilled) {
                askPrices[askCount] = order.price;
                askAmounts[askCount] = order.amount - order.filled;
                askCount++;
            }
        }
    }

    function getUserOrders(address user) external view returns (uint256[] memory) {
        return userOrders[user];
    }

    function getOrder(uint256 orderId) external view returns (Order memory) {
        return orders[orderId];
    }

    function _matchOrder(uint256 orderId) internal {
        Order storage order = orders[orderId];
        
        if (order.orderType == OrderType.Buy) {
            (uint256 bestAskPrice, uint256 bestAskId) = getBestAsk(order.tokenAddress);
            if (bestAskPrice > 0 && bestAskPrice <= order.price && bestAskId != 0) {
                _executeMatch(orderId, bestAskId);
            }
        } else {
            (uint256 bestBidPrice, uint256 bestBidId) = getBestBid(order.tokenAddress);
            if (bestBidPrice > 0 && bestBidPrice >= order.price && bestBidId != 0) {
                _executeMatch(bestBidId, orderId);
            }
        }
    }

    function _executeMatch(uint256 buyOrderId, uint256 sellOrderId) internal {
        Order storage buyOrder = orders[buyOrderId];
        Order storage sellOrder = orders[sellOrderId];

        if (buyOrder.status == OrderStatus.Cancelled || sellOrder.status == OrderStatus.Cancelled) {
            return;
        }

        uint256 matchAmount = _min(
            buyOrder.amount - buyOrder.filled,
            sellOrder.amount - sellOrder.filled
        );

        uint256 matchPrice = _min(buyOrder.price, sellOrder.price);
        uint256 totalValue = (matchAmount * matchPrice) / 1e18;
        uint256 fee = (totalValue * feeRate) / 10000;

        buyOrder.filled += matchAmount;
        sellOrder.filled += matchAmount;

        if (buyOrder.filled == buyOrder.amount) {
            buyOrder.status = OrderStatus.Filled;
        } else {
            buyOrder.status = OrderStatus.PartiallyFilled;
        }

        if (sellOrder.filled == sellOrder.amount) {
            sellOrder.status = OrderStatus.Filled;
        } else {
            sellOrder.status = OrderStatus.PartiallyFilled;
        }

        tradeIdCounter++;
        trades[tradeIdCounter] = Trade({
            orderId: buyOrderId,
            buyer: buyOrder.trader,
            seller: sellOrder.trader,
            amount: matchAmount,
            price: matchPrice,
            timestamp: block.timestamp
        });

        payable(sellOrder.trader).transfer(totalValue - fee);
        payable(feeCollector).transfer(fee);

        emit OrderMatched(buyOrderId, sellOrderId, matchAmount, matchPrice);
        emit TradeExecuted(tradeIdCounter, buyOrder.trader, sellOrder.trader, matchAmount, matchPrice);

        if (buyOrder.status == OrderStatus.PartiallyFilled) {
            emit OrderPartiallyFilled(buyOrderId, buyOrder.filled, buyOrder.amount - buyOrder.filled);
        }
        if (sellOrder.status == OrderStatus.PartiallyFilled) {
            emit OrderPartiallyFilled(sellOrderId, sellOrder.filled, sellOrder.amount - sellOrder.filled);
        }
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
