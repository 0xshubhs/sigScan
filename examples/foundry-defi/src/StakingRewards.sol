// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title StakingRewards
 * @dev Token staking with rewards distribution
 */
contract StakingRewards {
    address public owner;
    address public rewardsToken;
    address public stakingToken;
    
    uint256 public rewardRate;
    uint256 public lastUpdateTime;
    uint256 public rewardPerTokenStored;
    uint256 public totalStaked;

    mapping(address => uint256) public stakedBalance;
    mapping(address => uint256) public rewards;
    mapping(address => uint256) public userRewardPerTokenPaid;

    event Staked(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event RewardPaid(address indexed user, uint256 reward);
    event RewardRateUpdated(uint256 newRate);

    error Unauthorized();
    error InvalidAmount();
    error InsufficientBalance();

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier updateReward(address account) {
        rewardPerTokenStored = rewardPerToken();
        lastUpdateTime = block.timestamp;
        if (account != address(0)) {
            rewards[account] = earned(account);
            userRewardPerTokenPaid[account] = rewardPerTokenStored;
        }
        _;
    }

    constructor(address _stakingToken, address _rewardsToken, uint256 _rewardRate) {
        owner = msg.sender;
        stakingToken = _stakingToken;
        rewardsToken = _rewardsToken;
        rewardRate = _rewardRate;
        lastUpdateTime = block.timestamp;
    }

    function stake(uint256 amount) external updateReward(msg.sender) {
        if (amount == 0) revert InvalidAmount();
        
        totalStaked += amount;
        stakedBalance[msg.sender] += amount;
        
        emit Staked(msg.sender, amount);
    }

    function withdraw(uint256 amount) external updateReward(msg.sender) {
        if (amount == 0) revert InvalidAmount();
        if (stakedBalance[msg.sender] < amount) revert InsufficientBalance();
        
        totalStaked -= amount;
        stakedBalance[msg.sender] -= amount;
        
        emit Withdrawn(msg.sender, amount);
    }

    function claimReward() external updateReward(msg.sender) {
        uint256 reward = rewards[msg.sender];
        if (reward > 0) {
            rewards[msg.sender] = 0;
            emit RewardPaid(msg.sender, reward);
        }
    }

    function exit() external {
        withdraw(stakedBalance[msg.sender]);
        claimReward();
    }

    function setRewardRate(uint256 _rewardRate) external onlyOwner updateReward(address(0)) {
        rewardRate = _rewardRate;
        emit RewardRateUpdated(_rewardRate);
    }

    function rewardPerToken() public view returns (uint256) {
        if (totalStaked == 0) {
            return rewardPerTokenStored;
        }
        return rewardPerTokenStored + (
            ((block.timestamp - lastUpdateTime) * rewardRate * 1e18) / totalStaked
        );
    }

    function earned(address account) public view returns (uint256) {
        return (
            (stakedBalance[account] * (rewardPerToken() - userRewardPerTokenPaid[account])) / 1e18
        ) + rewards[account];
    }

    function getStakedBalance(address account) external view returns (uint256) {
        return stakedBalance[account];
    }

    function getTotalStaked() external view returns (uint256) {
        return totalStaked;
    }
}
