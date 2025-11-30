// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./GovernanceToken.sol";

/**
 * @title GovernorAlpha
 * @dev On-chain governance with proposal, voting, and execution
 */
contract GovernorAlpha {
    string public constant name = "Governor Alpha";
    
    GovernanceToken public governanceToken;
    address public guardian;
    address public timelock;

    uint256 public proposalCount;
    uint256 public constant VOTING_DELAY = 1; // 1 block
    uint256 public constant VOTING_PERIOD = 17280; // ~3 days in blocks
    uint256 public constant PROPOSAL_THRESHOLD = 100000e18; // 100,000 tokens
    uint256 public constant QUORUM_VOTES = 400000e18; // 400,000 votes

    enum ProposalState {
        Pending,
        Active,
        Canceled,
        Defeated,
        Succeeded,
        Queued,
        Expired,
        Executed
    }

    struct Proposal {
        uint256 id;
        address proposer;
        uint256 eta;
        address[] targets;
        uint256[] values;
        string[] signatures;
        bytes[] calldatas;
        uint256 startBlock;
        uint256 endBlock;
        uint256 forVotes;
        uint256 againstVotes;
        uint256 abstainVotes;
        bool canceled;
        bool executed;
        mapping(address => Receipt) receipts;
    }

    struct Receipt {
        bool hasVoted;
        uint8 support;
        uint256 votes;
    }

    mapping(uint256 => Proposal) public proposals;
    mapping(address => uint256) public latestProposalIds;

    event ProposalCreated(
        uint256 id,
        address proposer,
        address[] targets,
        uint256[] values,
        string[] signatures,
        bytes[] calldatas,
        uint256 startBlock,
        uint256 endBlock,
        string description
    );
    event VoteCast(address indexed voter, uint256 proposalId, uint8 support, uint256 votes, string reason);
    event ProposalCanceled(uint256 id);
    event ProposalQueued(uint256 id, uint256 eta);
    event ProposalExecuted(uint256 id);

    error BelowProposalThreshold(uint256 votes, uint256 required);
    error ProposalInfoArityMismatch();
    error NoActions();
    error TooManyActions();
    error ProposerHasActiveProp();
    error InvalidProposalId();
    error ProposalNotActive();
    error AlreadyVoted();
    error InvalidVoteType();
    error ProposalNotSucceeded();
    error ProposalNotQueued();

    constructor(address _governanceToken, address _timelock, address _guardian) {
        governanceToken = GovernanceToken(_governanceToken);
        timelock = _timelock;
        guardian = _guardian;
    }

    function propose(
        address[] memory targets,
        uint256[] memory values,
        string[] memory signatures,
        bytes[] memory calldatas,
        string memory description
    ) public returns (uint256) {
        uint256 proposerVotes = governanceToken.getPriorVotes(msg.sender, block.number - 1);
        if (proposerVotes < PROPOSAL_THRESHOLD) {
            revert BelowProposalThreshold(proposerVotes, PROPOSAL_THRESHOLD);
        }

        if (
            targets.length != values.length ||
            targets.length != signatures.length ||
            targets.length != calldatas.length
        ) {
            revert ProposalInfoArityMismatch();
        }
        
        if (targets.length == 0) revert NoActions();
        if (targets.length > 10) revert TooManyActions();

        uint256 latestProposalId = latestProposalIds[msg.sender];
        if (latestProposalId != 0) {
            ProposalState proposersLatestProposalState = state(latestProposalId);
            if (proposersLatestProposalState == ProposalState.Active || proposersLatestProposalState == ProposalState.Pending) {
                revert ProposerHasActiveProp();
            }
        }

        proposalCount++;
        uint256 newProposalId = proposalCount;
        
        Proposal storage newProposal = proposals[newProposalId];
        newProposal.id = newProposalId;
        newProposal.proposer = msg.sender;
        newProposal.targets = targets;
        newProposal.values = values;
        newProposal.signatures = signatures;
        newProposal.calldatas = calldatas;
        newProposal.startBlock = block.number + VOTING_DELAY;
        newProposal.endBlock = newProposal.startBlock + VOTING_PERIOD;

        latestProposalIds[msg.sender] = newProposalId;

        emit ProposalCreated(
            newProposalId,
            msg.sender,
            targets,
            values,
            signatures,
            calldatas,
            newProposal.startBlock,
            newProposal.endBlock,
            description
        );

        return newProposalId;
    }

    function queue(uint256 proposalId) external {
        if (state(proposalId) != ProposalState.Succeeded) {
            revert ProposalNotSucceeded();
        }
        
        Proposal storage proposal = proposals[proposalId];
        uint256 eta = block.timestamp + 2 days;
        proposal.eta = eta;
        
        emit ProposalQueued(proposalId, eta);
    }

    function execute(uint256 proposalId) external payable {
        if (state(proposalId) != ProposalState.Queued) {
            revert ProposalNotQueued();
        }

        Proposal storage proposal = proposals[proposalId];
        proposal.executed = true;

        for (uint256 i = 0; i < proposal.targets.length; i++) {
            _executeTransaction(
                proposal.targets[i],
                proposal.values[i],
                proposal.signatures[i],
                proposal.calldatas[i]
            );
        }

        emit ProposalExecuted(proposalId);
    }

    function cancel(uint256 proposalId) external {
        if (proposalId == 0 || proposalId > proposalCount) {
            revert InvalidProposalId();
        }

        Proposal storage proposal = proposals[proposalId];
        require(
            msg.sender == guardian ||
            governanceToken.getPriorVotes(proposal.proposer, block.number - 1) < PROPOSAL_THRESHOLD,
            "Cannot cancel"
        );

        proposal.canceled = true;
        emit ProposalCanceled(proposalId);
    }

    function castVote(uint256 proposalId, uint8 support) external {
        return _castVote(msg.sender, proposalId, support, "");
    }

    function castVoteWithReason(uint256 proposalId, uint8 support, string calldata reason) external {
        return _castVote(msg.sender, proposalId, support, reason);
    }

    function castVoteBySig(uint256 proposalId, uint8 support, uint8 v, bytes32 r, bytes32 s) external {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                block.chainid,
                address(this)
            )
        );

        bytes32 structHash = keccak256(abi.encode(
            keccak256("Ballot(uint256 proposalId,uint8 support)"),
            proposalId,
            support
        ));

        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        address signatory = ecrecover(digest, v, r, s);
        require(signatory != address(0), "Invalid signature");

        return _castVote(signatory, proposalId, support, "");
    }

    function getActions(uint256 proposalId)
        external
        view
        returns (
            address[] memory targets,
            uint256[] memory values,
            string[] memory signatures,
            bytes[] memory calldatas
        )
    {
        Proposal storage p = proposals[proposalId];
        return (p.targets, p.values, p.signatures, p.calldatas);
    }

    function getReceipt(uint256 proposalId, address voter) external view returns (Receipt memory) {
        return proposals[proposalId].receipts[voter];
    }

    function state(uint256 proposalId) public view returns (ProposalState) {
        if (proposalId == 0 || proposalId > proposalCount) {
            revert InvalidProposalId();
        }

        Proposal storage proposal = proposals[proposalId];
        
        if (proposal.canceled) {
            return ProposalState.Canceled;
        } else if (block.number <= proposal.startBlock) {
            return ProposalState.Pending;
        } else if (block.number <= proposal.endBlock) {
            return ProposalState.Active;
        } else if (proposal.forVotes <= proposal.againstVotes || proposal.forVotes < QUORUM_VOTES) {
            return ProposalState.Defeated;
        } else if (proposal.eta == 0) {
            return ProposalState.Succeeded;
        } else if (proposal.executed) {
            return ProposalState.Executed;
        } else if (block.timestamp >= proposal.eta + 14 days) {
            return ProposalState.Expired;
        } else {
            return ProposalState.Queued;
        }
    }

    function _castVote(address voter, uint256 proposalId, uint8 support, string memory reason) internal {
        if (state(proposalId) != ProposalState.Active) {
            revert ProposalNotActive();
        }
        if (support > 2) revert InvalidVoteType();

        Proposal storage proposal = proposals[proposalId];
        Receipt storage receipt = proposal.receipts[voter];
        
        if (receipt.hasVoted) revert AlreadyVoted();

        uint256 votes = governanceToken.getPriorVotes(voter, proposal.startBlock);

        if (support == 0) {
            proposal.againstVotes += votes;
        } else if (support == 1) {
            proposal.forVotes += votes;
        } else if (support == 2) {
            proposal.abstainVotes += votes;
        }

        receipt.hasVoted = true;
        receipt.support = support;
        receipt.votes = votes;

        emit VoteCast(voter, proposalId, support, votes, reason);
    }

    function _executeTransaction(
        address target,
        uint256 value,
        string memory signature,
        bytes memory data
    ) internal {
        bytes memory callData;

        if (bytes(signature).length == 0) {
            callData = data;
        } else {
            callData = abi.encodePacked(bytes4(keccak256(bytes(signature))), data);
        }

        (bool success, ) = target.call{value: value}(callData);
        require(success, "Transaction execution reverted");
    }
}
