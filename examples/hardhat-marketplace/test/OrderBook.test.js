const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("OrderBook", function () {
  let orderBook;
  let owner, trader1, trader2, feeCollector;

  beforeEach(async function () {
    [owner, trader1, trader2, feeCollector] = await ethers.getSigners();
    
    const OrderBook = await ethers.getContractFactory("OrderBook");
    orderBook = await OrderBook.deploy(feeCollector.address);
  });

  it("Should place a buy order", async function () {
    const tokenAddress = ethers.ZeroAddress;
    const amount = ethers.parseEther("10");
    const price = ethers.parseEther("100");
    const totalCost = ethers.parseEther("1000");

    await expect(
      orderBook.connect(trader1).placeOrder(0, tokenAddress, amount, price, { value: totalCost })
    ).to.emit(orderBook, "OrderPlaced");
  });

  it("Should return best bid and ask", async function () {
    const tokenAddress = ethers.ZeroAddress;
    
    const [bestBidPrice, bestBidId] = await orderBook.getBestBid(tokenAddress);
    expect(bestBidPrice).to.equal(0);
  });
});
