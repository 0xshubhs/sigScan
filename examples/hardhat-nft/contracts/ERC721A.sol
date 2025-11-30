// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title ERC721A
 * @dev Optimized ERC721 implementation for batch minting
 */
contract ERC721A {
    string public name;
    string public symbol;
    uint256 public totalSupply;
    uint256 public maxSupply;
    uint256 public mintPrice;
    address public owner;
    string private baseTokenURI;

    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => address) private _tokenApprovals;
    mapping(address => mapping(address => bool)) private _operatorApprovals;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event Minted(address indexed to, uint256 quantity, uint256 startTokenId);
    event BaseURIUpdated(string newBaseURI);

    error NotOwner();
    error InvalidQuantity();
    error MaxSupplyExceeded();
    error InsufficientPayment();
    error NonexistentToken();
    error NotAuthorized();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        string memory _name,
        string memory _symbol,
        uint256 _maxSupply,
        uint256 _mintPrice
    ) {
        name = _name;
        symbol = _symbol;
        maxSupply = _maxSupply;
        mintPrice = _mintPrice;
        owner = msg.sender;
    }

    function mint(uint256 quantity) external payable {
        if (quantity == 0) revert InvalidQuantity();
        if (totalSupply + quantity > maxSupply) revert MaxSupplyExceeded();
        if (msg.value < mintPrice * quantity) revert InsufficientPayment();

        uint256 startTokenId = totalSupply;
        
        for (uint256 i = 0; i < quantity; i++) {
            uint256 tokenId = startTokenId + i;
            _owners[tokenId] = msg.sender;
            emit Transfer(address(0), msg.sender, tokenId);
        }

        _balances[msg.sender] += quantity;
        totalSupply += quantity;

        emit Minted(msg.sender, quantity, startTokenId);
    }

    function batchMint(address[] calldata recipients, uint256[] calldata quantities) 
        external 
        onlyOwner 
    {
        if (recipients.length != quantities.length) revert InvalidQuantity();

        for (uint256 i = 0; i < recipients.length; i++) {
            uint256 quantity = quantities[i];
            if (totalSupply + quantity > maxSupply) revert MaxSupplyExceeded();

            uint256 startTokenId = totalSupply;
            
            for (uint256 j = 0; j < quantity; j++) {
                uint256 tokenId = startTokenId + j;
                _owners[tokenId] = recipients[i];
                emit Transfer(address(0), recipients[i], tokenId);
            }

            _balances[recipients[i]] += quantity;
            totalSupply += quantity;
        }
    }

    function transferFrom(address from, address to, uint256 tokenId) external {
        if (!_isApprovedOrOwner(msg.sender, tokenId)) revert NotAuthorized();
        _transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(
        address from,
        address to,
        uint256 tokenId,
        bytes memory data
    ) public {
        if (!_isApprovedOrOwner(msg.sender, tokenId)) revert NotAuthorized();
        _safeTransfer(from, to, tokenId, data);
    }

    function approve(address to, uint256 tokenId) external {
        address tokenOwner = ownerOf(tokenId);
        if (msg.sender != tokenOwner && !isApprovedForAll(tokenOwner, msg.sender)) {
            revert NotAuthorized();
        }
        _tokenApprovals[tokenId] = to;
        emit Approval(tokenOwner, to, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function setBaseURI(string memory newBaseURI) external onlyOwner {
        baseTokenURI = newBaseURI;
        emit BaseURIUpdated(newBaseURI);
    }

    function setMintPrice(uint256 newPrice) external onlyOwner {
        mintPrice = newPrice;
    }

    function withdraw() external onlyOwner {
        payable(owner).transfer(address(this).balance);
    }

    function ownerOf(uint256 tokenId) public view returns (address) {
        address tokenOwner = _owners[tokenId];
        if (tokenOwner == address(0)) revert NonexistentToken();
        return tokenOwner;
    }

    function balanceOf(address account) public view returns (uint256) {
        return _balances[account];
    }

    function getApproved(uint256 tokenId) public view returns (address) {
        if (_owners[tokenId] == address(0)) revert NonexistentToken();
        return _tokenApprovals[tokenId];
    }

    function isApprovedForAll(address owner, address operator) public view returns (bool) {
        return _operatorApprovals[owner][operator];
    }

    function tokenURI(uint256 tokenId) public view returns (string memory) {
        if (_owners[tokenId] == address(0)) revert NonexistentToken();
        return string(abi.encodePacked(baseTokenURI, _toString(tokenId)));
    }

    function supportsInterface(bytes4 interfaceId) public pure returns (bool) {
        return
            interfaceId == 0x01ffc9a7 || // ERC165
            interfaceId == 0x80ac58cd || // ERC721
            interfaceId == 0x5b5e139f;   // ERC721Metadata
    }

    function _transfer(address from, address to, uint256 tokenId) internal {
        if (ownerOf(tokenId) != from) revert NotAuthorized();
        if (to == address(0)) revert InvalidQuantity();

        delete _tokenApprovals[tokenId];
        
        _balances[from] -= 1;
        _balances[to] += 1;
        _owners[tokenId] = to;

        emit Transfer(from, to, tokenId);
    }

    function _safeTransfer(
        address from,
        address to,
        uint256 tokenId,
        bytes memory data
    ) internal {
        _transfer(from, to, tokenId);
    }

    function _isApprovedOrOwner(address spender, uint256 tokenId) internal view returns (bool) {
        address tokenOwner = ownerOf(tokenId);
        return (
            spender == tokenOwner ||
            isApprovedForAll(tokenOwner, spender) ||
            getApproved(tokenId) == spender
        );
    }

    function _toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) {
            return "0";
        }
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }
}
