// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title CrossChainBridge
 * @dev Secure cross-chain bridge with multi-signature validation and relay network
 */
contract CrossChainBridge {
    enum TransferStatus { Pending, Completed, Cancelled, Disputed }
    
    struct Transfer {
        bytes32 transferId;
        address sender;
        address recipient;
        uint256 amount;
        uint256 sourceChain;
        uint256 targetChain;
        uint256 timestamp;
        uint256 completedTimestamp;
        TransferStatus status;
        bytes32 txHash;
    }

    struct Validator {
        bool isActive;
        uint256 weight;
        uint256 totalValidations;
        uint256 successfulValidations;
        uint256 lastActivityTimestamp;
    }

    struct ValidationRequest {
        bytes32 transferId;
        uint256 signatures;
        uint256 totalWeight;
        bool executed;
        mapping(address => bool) hasValidated;
    }

    uint256 public currentChainId;
    uint256 public validationThreshold = 6667; // 66.67% in basis points
    uint256 public totalValidatorWeight;
    uint256 public transferTimeout = 24 hours;
    uint256 public minValidators = 3;
    
    address public admin;
    address[] public validatorList;
    mapping(address => Validator) public validators;
    mapping(bytes32 => Transfer) public transfers;
    mapping(bytes32 => ValidationRequest) public validations;
    mapping(uint256 => bool) public supportedChains;
    mapping(address => uint256) public userNonces;
    
    bytes32[] public pendingTransfers;
    uint256 public bridgeFee = 10; // 0.1% in basis points

    event TransferInitiated(
        bytes32 indexed transferId,
        address indexed sender,
        address indexed recipient,
        uint256 amount,
        uint256 sourceChain,
        uint256 targetChain
    );
    event TransferValidated(
        bytes32 indexed transferId,
        address indexed validator,
        uint256 currentWeight
    );
    event TransferCompleted(
        bytes32 indexed transferId,
        address indexed recipient,
        uint256 amount
    );
    event TransferCancelled(bytes32 indexed transferId, string reason);
    event ValidatorAdded(address indexed validator, uint256 weight);
    event ValidatorRemoved(address indexed validator);
    event ValidatorWeightUpdated(address indexed validator, uint256 newWeight);
    event ChainSupported(uint256 indexed chainId);
    event DisputeRaised(bytes32 indexed transferId, address indexed reporter, string reason);

    error ChainNotSupported();
    error InvalidAmount();
    error TransferNotFound();
    error AlreadyValidated();
    error Unauthorized();
    error TransferExpired();
    error InsufficientValidations();
    error InvalidValidator();
    error TransferNotPending();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert Unauthorized();
        _;
    }

    modifier onlyValidator() {
        if (!validators[msg.sender].isActive) revert Unauthorized();
        _;
    }

    constructor(uint256 _chainId) {
        admin = msg.sender;
        currentChainId = _chainId;
        supportedChains[_chainId] = true;
    }

    function addValidator(address validator, uint256 weight) external onlyAdmin {
        if (validators[validator].isActive) revert InvalidValidator();
        
        validators[validator] = Validator({
            isActive: true,
            weight: weight,
            totalValidations: 0,
            successfulValidations: 0,
            lastActivityTimestamp: block.timestamp
        });
        
        validatorList.push(validator);
        totalValidatorWeight += weight;

        emit ValidatorAdded(validator, weight);
    }

    function removeValidator(address validator) external onlyAdmin {
        if (!validators[validator].isActive) revert InvalidValidator();
        
        totalValidatorWeight -= validators[validator].weight;
        validators[validator].isActive = false;

        emit ValidatorRemoved(validator);
    }

    function updateValidatorWeight(address validator, uint256 newWeight) external onlyAdmin {
        if (!validators[validator].isActive) revert InvalidValidator();
        
        uint256 oldWeight = validators[validator].weight;
        validators[validator].weight = newWeight;
        totalValidatorWeight = totalValidatorWeight - oldWeight + newWeight;

        emit ValidatorWeightUpdated(validator, newWeight);
    }

    function supportChain(uint256 chainId) external onlyAdmin {
        supportedChains[chainId] = true;
        emit ChainSupported(chainId);
    }

    function initiateTransfer(
        address recipient,
        uint256 targetChain,
        uint256 amount
    ) external payable returns (bytes32) {
        if (!supportedChains[targetChain]) revert ChainNotSupported();
        if (amount == 0) revert InvalidAmount();

        uint256 fee = (amount * bridgeFee) / 10000;
        uint256 netAmount = amount - fee;

        userNonces[msg.sender]++;
        bytes32 transferId = keccak256(
            abi.encodePacked(
                msg.sender,
                recipient,
                amount,
                currentChainId,
                targetChain,
                userNonces[msg.sender],
                block.timestamp
            )
        );

        transfers[transferId] = Transfer({
            transferId: transferId,
            sender: msg.sender,
            recipient: recipient,
            amount: netAmount,
            sourceChain: currentChainId,
            targetChain: targetChain,
            timestamp: block.timestamp,
            completedTimestamp: 0,
            status: TransferStatus.Pending,
            txHash: bytes32(0)
        });

        pendingTransfers.push(transferId);

        emit TransferInitiated(
            transferId,
            msg.sender,
            recipient,
            netAmount,
            currentChainId,
            targetChain
        );

        return transferId;
    }

    function validateTransfer(bytes32 transferId, bytes32 txHash) external onlyValidator {
        Transfer storage transfer = transfers[transferId];
        if (transfer.transferId == bytes32(0)) revert TransferNotFound();
        if (transfer.status != TransferStatus.Pending) revert TransferNotPending();
        if (block.timestamp > transfer.timestamp + transferTimeout) {
            revert TransferExpired();
        }

        ValidationRequest storage validation = validations[transferId];
        if (validation.hasValidated[msg.sender]) revert AlreadyValidated();

        Validator storage validator = validators[msg.sender];
        validation.hasValidated[msg.sender] = true;
        validation.signatures++;
        validation.totalWeight += validator.weight;
        
        validator.totalValidations++;
        validator.lastActivityTimestamp = block.timestamp;

        emit TransferValidated(transferId, msg.sender, validation.totalWeight);

        if (!validation.executed && _hasReachedThreshold(validation.totalWeight)) {
            _executeTransfer(transferId, txHash);
        }
    }

    function completeTransfer(bytes32 transferId) external onlyValidator {
        Transfer storage transfer = transfers[transferId];
        if (transfer.transferId == bytes32(0)) revert TransferNotFound();
        if (transfer.status != TransferStatus.Pending) revert TransferNotPending();

        ValidationRequest storage validation = validations[transferId];
        if (!_hasReachedThreshold(validation.totalWeight)) {
            revert InsufficientValidations();
        }

        transfer.status = TransferStatus.Completed;
        transfer.completedTimestamp = block.timestamp;

        payable(transfer.recipient).transfer(transfer.amount);

        for (uint256 i = 0; i < validatorList.length; i++) {
            if (validation.hasValidated[validatorList[i]]) {
                validators[validatorList[i]].successfulValidations++;
            }
        }

        emit TransferCompleted(transferId, transfer.recipient, transfer.amount);
    }

    function cancelTransfer(bytes32 transferId, string calldata reason) external {
        Transfer storage transfer = transfers[transferId];
        if (transfer.transferId == bytes32(0)) revert TransferNotFound();
        if (transfer.status != TransferStatus.Pending) revert TransferNotPending();
        
        bool canCancel = msg.sender == transfer.sender || 
                        msg.sender == admin ||
                        block.timestamp > transfer.timestamp + transferTimeout;
        
        if (!canCancel) revert Unauthorized();

        transfer.status = TransferStatus.Cancelled;

        emit TransferCancelled(transferId, reason);
    }

    function raiseDispute(bytes32 transferId, string calldata reason) external onlyValidator {
        Transfer storage transfer = transfers[transferId];
        if (transfer.transferId == bytes32(0)) revert TransferNotFound();

        transfer.status = TransferStatus.Disputed;

        emit DisputeRaised(transferId, msg.sender, reason);
    }

    function getTransfer(bytes32 transferId) external view returns (Transfer memory) {
        return transfers[transferId];
    }

    function getValidatorInfo(address validator) external view returns (Validator memory) {
        return validators[validator];
    }

    function getValidationStatus(bytes32 transferId) 
        external 
        view 
        returns (
            uint256 signatures,
            uint256 totalWeight,
            uint256 requiredWeight,
            bool executed
        ) 
    {
        ValidationRequest storage validation = validations[transferId];
        return (
            validation.signatures,
            validation.totalWeight,
            _getRequiredWeight(),
            validation.executed
        );
    }

    function getPendingTransfers() external view returns (bytes32[] memory) {
        return pendingTransfers;
    }

    function getValidators() external view returns (address[] memory) {
        return validatorList;
    }

    function hasValidated(bytes32 transferId, address validator) external view returns (bool) {
        return validations[transferId].hasValidated[validator];
    }

    function _executeTransfer(bytes32 transferId, bytes32 txHash) internal {
        ValidationRequest storage validation = validations[transferId];
        validation.executed = true;
        
        Transfer storage transfer = transfers[transferId];
        transfer.txHash = txHash;
    }

    function _hasReachedThreshold(uint256 weight) internal view returns (bool) {
        return (weight * 10000) >= (totalValidatorWeight * validationThreshold);
    }

    function _getRequiredWeight() internal view returns (uint256) {
        return (totalValidatorWeight * validationThreshold) / 10000;
    }
}
