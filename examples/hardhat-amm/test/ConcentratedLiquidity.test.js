const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ConcentratedLiquidity", function () {
  let pool, router;
  let owner, user1, user2;

  beforeEach(async function () {
    [owner, user1, user2] = await ethers.getSigners();
    
    const ConcentratedLiquidity = await ethers.getContractFactory("ConcentratedLiquidity");
    pool = await ConcentratedLiquidity.deploy(
      ethers.ZeroAddress,
      ethers.ZeroAddress,
      3000,
      60
    );

    const RouterV3 = await ethers.getContractFactory("RouterV3");
    router = await RouterV3.deploy(ethers.ZeroAddress, ethers.ZeroAddress);
  });

  it("Should mint liquidity position", async function () {
    await expect(
      pool.connect(user1).mint(user1.address, -120, 120, 1000)
    ).to.emit(pool, "Mint");
  });

  it("Should perform swap", async function () {
    await pool.connect(user1).mint(user1.address, -120, 120, 10000);
    
    await expect(
      pool.swap(user2.address, true, 100, 0)
    ).to.emit(pool, "Swap");
  });
});
