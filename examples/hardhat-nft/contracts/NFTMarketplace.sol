// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./ERC721A.sol";

/**
 * @title NFTMarketplace
 * @dev Marketplace for trading NFTs with auction support
 */
contract NFTMarketplace {
    struct Listing {
        address seller;
        address nftContract;
        uint256 tokenId;
        uint256 price;
        bool active;
    }

    struct Auction {
        address seller;
        address nftContract;
        uint256 tokenId;
        uint256 startingBid;
        uint256 highestBid;
        address highestBidder;
        uint256 endTime;
        bool active;
    }

    uint256 public listingCounter;
    uint256 public auctionCounter;
    uint256 public feePercentage = 250; // 2.5%
    address public feeRecipient;

    mapping(uint256 => Listing) public listings;
    mapping(uint256 => Auction) public auctions;
    mapping(address => mapping(uint256 => uint256)) public pendingReturns;

    event Listed(uint256 indexed listingId, address indexed seller, address nftContract, uint256 tokenId, uint256 price);
    event Sold(uint256 indexed listingId, address indexed buyer, uint256 price);
    event ListingCancelled(uint256 indexed listingId);
    event AuctionCreated(uint256 indexed auctionId, address indexed seller, uint256 tokenId, uint256 startingBid, uint256 endTime);
    event BidPlaced(uint256 indexed auctionId, address indexed bidder, uint256 amount);
    event AuctionEnded(uint256 indexed auctionId, address indexed winner, uint256 amount);

    error NotSeller();
    error ListingNotActive();
    error InsufficientPayment();
    error BidTooLow();
    error AuctionEnded();
    error AuctionNotEnded();

    constructor(address _feeRecipient) {
        feeRecipient = _feeRecipient;
    }

    function createListing(
        address nftContract,
        uint256 tokenId,
        uint256 price
    ) external returns (uint256) {
        ERC721A nft = ERC721A(nftContract);
        require(nft.ownerOf(tokenId) == msg.sender, "Not token owner");
        require(nft.isApprovedForAll(msg.sender, address(this)) || 
                nft.getApproved(tokenId) == address(this), "Not approved");

        uint256 listingId = listingCounter++;
        listings[listingId] = Listing({
            seller: msg.sender,
            nftContract: nftContract,
            tokenId: tokenId,
            price: price,
            active: true
        });

        emit Listed(listingId, msg.sender, nftContract, tokenId, price);
        return listingId;
    }

    function buyListing(uint256 listingId) external payable {
        Listing storage listing = listings[listingId];
        if (!listing.active) revert ListingNotActive();
        if (msg.value < listing.price) revert InsufficientPayment();

        listing.active = false;

        uint256 fee = (listing.price * feePercentage) / 10000;
        uint256 sellerAmount = listing.price - fee;

        ERC721A(listing.nftContract).transferFrom(listing.seller, msg.sender, listing.tokenId);
        
        payable(listing.seller).transfer(sellerAmount);
        payable(feeRecipient).transfer(fee);

        if (msg.value > listing.price) {
            payable(msg.sender).transfer(msg.value - listing.price);
        }

        emit Sold(listingId, msg.sender, listing.price);
    }

    function cancelListing(uint256 listingId) external {
        Listing storage listing = listings[listingId];
        if (listing.seller != msg.sender) revert NotSeller();
        if (!listing.active) revert ListingNotActive();

        listing.active = false;
        emit ListingCancelled(listingId);
    }

    function createAuction(
        address nftContract,
        uint256 tokenId,
        uint256 startingBid,
        uint256 duration
    ) external returns (uint256) {
        ERC721A nft = ERC721A(nftContract);
        require(nft.ownerOf(tokenId) == msg.sender, "Not token owner");

        uint256 auctionId = auctionCounter++;
        auctions[auctionId] = Auction({
            seller: msg.sender,
            nftContract: nftContract,
            tokenId: tokenId,
            startingBid: startingBid,
            highestBid: 0,
            highestBidder: address(0),
            endTime: block.timestamp + duration,
            active: true
        });

        emit AuctionCreated(auctionId, msg.sender, tokenId, startingBid, block.timestamp + duration);
        return auctionId;
    }

    function placeBid(uint256 auctionId) external payable {
        Auction storage auction = auctions[auctionId];
        if (block.timestamp >= auction.endTime) revert AuctionEnded();
        if (msg.value < auction.startingBid || msg.value <= auction.highestBid) revert BidTooLow();

        if (auction.highestBidder != address(0)) {
            pendingReturns[auction.highestBidder][auctionId] += auction.highestBid;
        }

        auction.highestBid = msg.value;
        auction.highestBidder = msg.sender;

        emit BidPlaced(auctionId, msg.sender, msg.value);
    }

    function endAuction(uint256 auctionId) external {
        Auction storage auction = auctions[auctionId];
        if (block.timestamp < auction.endTime) revert AuctionNotEnded();
        if (!auction.active) revert ListingNotActive();

        auction.active = false;

        if (auction.highestBidder != address(0)) {
            uint256 fee = (auction.highestBid * feePercentage) / 10000;
            uint256 sellerAmount = auction.highestBid - fee;

            ERC721A(auction.nftContract).transferFrom(
                auction.seller,
                auction.highestBidder,
                auction.tokenId
            );

            payable(auction.seller).transfer(sellerAmount);
            payable(feeRecipient).transfer(fee);

            emit AuctionEnded(auctionId, auction.highestBidder, auction.highestBid);
        }
    }

    function withdrawBid(uint256 auctionId) external {
        uint256 amount = pendingReturns[msg.sender][auctionId];
        if (amount > 0) {
            pendingReturns[msg.sender][auctionId] = 0;
            payable(msg.sender).transfer(amount);
        }
    }

    function getListing(uint256 listingId) external view returns (Listing memory) {
        return listings[listingId];
    }

    function getAuction(uint256 auctionId) external view returns (Auction memory) {
        return auctions[auctionId];
    }

    function setFeePercentage(uint256 newFee) external {
        require(msg.sender == feeRecipient, "Not authorized");
        require(newFee <= 1000, "Fee too high"); // Max 10%
        feePercentage = newFee;
    }
}
