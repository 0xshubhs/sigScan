// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title Treasury
 * @dev Manages DAO funds with multi-signature and budget controls
 */
contract Treasury {
    address public governance;
    
    struct Spending {
        address recipient;
        uint256 amount;
        string purpose;
        uint256 timestamp;
        bool executed;
    }

    struct Budget {
        uint256 totalBudget;
        uint256 spentAmount;
        uint256 resetTimestamp;
        bool active;
    }

    mapping(uint256 => Spending) public spendings;
    mapping(address => Budget) public budgets;
    uint256 public spendingCount;

    event FundsReceived(address indexed from, uint256 amount);
    event SpendingProposed(uint256 indexed id, address recipient, uint256 amount, string purpose);
    event SpendingExecuted(uint256 indexed id);
    event BudgetSet(address indexed department, uint256 amount);
    event EmergencyWithdraw(address indexed to, uint256 amount);

    error OnlyGovernance();
    error InsufficientBalance();
    error BudgetExceeded();
    error AlreadyExecuted();
    error InvalidAmount();

    modifier onlyGovernance() {
        if (msg.sender != governance) revert OnlyGovernance();
        _;
    }

    constructor(address _governance) {
        governance = _governance;
    }

    receive() external payable {
        emit FundsReceived(msg.sender, msg.value);
    }

    function proposeSpending(
        address recipient,
        uint256 amount,
        string memory purpose
    ) external onlyGovernance returns (uint256) {
        if (amount == 0) revert InvalidAmount();
        if (address(this).balance < amount) revert InsufficientBalance();

        spendingCount++;
        spendings[spendingCount] = Spending({
            recipient: recipient,
            amount: amount,
            purpose: purpose,
            timestamp: block.timestamp,
            executed: false
        });

        emit SpendingProposed(spendingCount, recipient, amount, purpose);
        return spendingCount;
    }

    function executeSpending(uint256 spendingId) external onlyGovernance {
        Spending storage spending = spendings[spendingId];
        if (spending.executed) revert AlreadyExecuted();
        if (address(this).balance < spending.amount) revert InsufficientBalance();

        spending.executed = true;
        payable(spending.recipient).transfer(spending.amount);

        emit SpendingExecuted(spendingId);
    }

    function setBudget(address department, uint256 amount) external onlyGovernance {
        budgets[department] = Budget({
            totalBudget: amount,
            spentAmount: 0,
            resetTimestamp: block.timestamp + 30 days,
            active: true
        });

        emit BudgetSet(department, amount);
    }

    function spendFromBudget(address department, uint256 amount) external {
        Budget storage budget = budgets[department];
        if (!budget.active) revert InvalidAmount();
        if (block.timestamp > budget.resetTimestamp) {
            budget.spentAmount = 0;
            budget.resetTimestamp = block.timestamp + 30 days;
        }
        if (budget.spentAmount + amount > budget.totalBudget) {
            revert BudgetExceeded();
        }

        budget.spentAmount += amount;
        payable(msg.sender).transfer(amount);
    }

    function emergencyWithdraw(address to, uint256 amount) external onlyGovernance {
        if (address(this).balance < amount) revert InsufficientBalance();
        payable(to).transfer(amount);
        emit EmergencyWithdraw(to, amount);
    }

    function getBalance() external view returns (uint256) {
        return address(this).balance;
    }
}
