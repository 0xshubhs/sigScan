const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ERC721A", function () {
  let nft;
  let owner;
  let addr1;

  beforeEach(async function () {
    [owner, addr1] = await ethers.getSigners();
    
    const ERC721A = await ethers.getContractFactory("ERC721A");
    nft = await ERC721A.deploy("TestNFT", "TNFT", 10000, ethers.parseEther("0.1"));
  });

  it("Should mint NFTs correctly", async function () {
    await nft.connect(addr1).mint(3, { value: ethers.parseEther("0.3") });
    expect(await nft.balanceOf(addr1.address)).to.equal(3);
  });

  it("Should return correct token URI", async function () {
    await nft.mint(1, { value: ethers.parseEther("0.1") });
    const uri = await nft.tokenURI(0);
    expect(uri).to.include("0");
  });
});
