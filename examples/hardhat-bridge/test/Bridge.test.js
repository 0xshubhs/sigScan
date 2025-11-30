const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("CrossChainBridge", function () {
  let bridge, relayerNetwork;
  let owner, validator1, validator2, user;

  beforeEach(async function () {
    [owner, validator1, validator2, user] = await ethers.getSigners();
    
    const Bridge = await ethers.getContractFactory("CrossChainBridge");
    bridge = await Bridge.deploy(1);

    const RelayerNetwork = await ethers.getContractFactory("RelayerNetwork");
    relayerNetwork = await RelayerNetwork.deploy();
  });

  it("Should add validators", async function () {
    await expect(bridge.addValidator(validator1.address, 100))
      .to.emit(bridge, "ValidatorAdded");
  });

  it("Should support new chains", async function () {
    await expect(bridge.supportChain(137))
      .to.emit(bridge, "ChainSupported");
  });
});
