// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title RelayerNetwork
 * @dev Decentralized relayer network for bridge message passing
 */
contract RelayerNetwork {
    struct Relayer {
        bool isActive;
        uint256 stake;
        uint256 reputation;
        uint256 successfulRelays;
        uint256 failedRelays;
        uint256 totalEarned;
        uint256 slashedAmount;
        uint256 registeredTimestamp;
    }

    struct Message {
        bytes32 messageId;
        uint256 sourceChain;
        uint256 targetChain;
        address sender;
        bytes payload;
        uint256 timestamp;
        uint256 gasLimit;
        uint256 relayerFee;
        bool delivered;
        address relayer;
    }

    uint256 public minStake = 1 ether;
    uint256 public slashPercentage = 1000; // 10%
    uint256 public reputationDecay = 100; // 1% per failed delivery
    
    mapping(address => Relayer) public relayers;
    mapping(bytes32 => Message) public messages;
    mapping(bytes32 => mapping(address => bool)) public messageAttempts;
    
    address[] public relayerList;
    bytes32[] public pendingMessages;

    event RelayerRegistered(address indexed relayer, uint256 stake);
    event RelayerDeactivated(address indexed relayer);
    event MessageSubmitted(bytes32 indexed messageId, uint256 sourceChain, uint256 targetChain);
    event MessageDelivered(bytes32 indexed messageId, address indexed relayer);
    event RelayerSlashed(address indexed relayer, uint256 amount, bytes32 messageId);
    event ReputationUpdated(address indexed relayer, uint256 newReputation);

    error InsufficientStake();
    error RelayerNotActive();
    error MessageNotFound();
    error MessageAlreadyDelivered();
    error AlreadyAttempted();
    error InvalidMessage();

    function registerRelayer() external payable {
        if (msg.value < minStake) revert InsufficientStake();

        relayers[msg.sender] = Relayer({
            isActive: true,
            stake: msg.value,
            reputation: 1000, // Start with 100% reputation
            successfulRelays: 0,
            failedRelays: 0,
            totalEarned: 0,
            slashedAmount: 0,
            registeredTimestamp: block.timestamp
        });

        relayerList.push(msg.sender);

        emit RelayerRegistered(msg.sender, msg.value);
    }

    function deactivateRelayer() external {
        Relayer storage relayer = relayers[msg.sender];
        if (!relayer.isActive) revert RelayerNotActive();

        relayer.isActive = false;
        payable(msg.sender).transfer(relayer.stake - relayer.slashedAmount);

        emit RelayerDeactivated(msg.sender);
    }

    function submitMessage(
        uint256 sourceChain,
        uint256 targetChain,
        bytes calldata payload,
        uint256 gasLimit
    ) external payable returns (bytes32) {
        bytes32 messageId = keccak256(
            abi.encodePacked(
                sourceChain,
                targetChain,
                msg.sender,
                payload,
                block.timestamp
            )
        );

        messages[messageId] = Message({
            messageId: messageId,
            sourceChain: sourceChain,
            targetChain: targetChain,
            sender: msg.sender,
            payload: payload,
            timestamp: block.timestamp,
            gasLimit: gasLimit,
            relayerFee: msg.value,
            delivered: false,
            relayer: address(0)
        });

        pendingMessages.push(messageId);

        emit MessageSubmitted(messageId, sourceChain, targetChain);

        return messageId;
    }

    function deliverMessage(bytes32 messageId, bytes calldata proof) external {
        Message storage message = messages[messageId];
        if (message.messageId == bytes32(0)) revert MessageNotFound();
        if (message.delivered) revert MessageAlreadyDelivered();
        if (messageAttempts[messageId][msg.sender]) revert AlreadyAttempted();

        Relayer storage relayer = relayers[msg.sender];
        if (!relayer.isActive) revert RelayerNotActive();

        messageAttempts[messageId][msg.sender] = true;

        // Simplified verification - in production would verify cryptographic proof
        bool success = _verifyDelivery(messageId, proof);

        if (success) {
            message.delivered = true;
            message.relayer = msg.sender;
            
            relayer.successfulRelays++;
            relayer.totalEarned += message.relayerFee;
            relayer.reputation = _min(relayer.reputation + 10, 1000);
            
            payable(msg.sender).transfer(message.relayerFee);

            emit MessageDelivered(messageId, msg.sender);
            emit ReputationUpdated(msg.sender, relayer.reputation);
        } else {
            relayer.failedRelays++;
            uint256 reputationLoss = (relayer.reputation * reputationDecay) / 10000;
            relayer.reputation -= reputationLoss;
            
            uint256 slashAmount = (relayer.stake * slashPercentage) / 10000;
            relayer.slashedAmount += slashAmount;

            emit RelayerSlashed(msg.sender, slashAmount, messageId);
            emit ReputationUpdated(msg.sender, relayer.reputation);
        }
    }

    function getRelayerInfo(address relayer) external view returns (Relayer memory) {
        return relayers[relayer];
    }

    function getMessage(bytes32 messageId) external view returns (Message memory) {
        return messages[messageId];
    }

    function getPendingMessages() external view returns (bytes32[] memory) {
        return pendingMessages;
    }

    function getTopRelayers(uint256 count) external view returns (address[] memory) {
        address[] memory topRelayers = new address[](count);
        // Simplified - would need proper sorting in production
        uint256 added = 0;
        for (uint256 i = 0; i < relayerList.length && added < count; i++) {
            if (relayers[relayerList[i]].isActive) {
                topRelayers[added] = relayerList[i];
                added++;
            }
        }
        return topRelayers;
    }

    function _verifyDelivery(bytes32 messageId, bytes calldata proof) internal pure returns (bool) {
        // Simplified verification - production would use merkle proofs or similar
        return proof.length > 0 && messageId != bytes32(0);
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
