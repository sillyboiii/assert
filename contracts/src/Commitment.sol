// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract Commitment {
    enum Status { Pending, Active, Approved, Failed, Cancelled }

    struct Goal {
        address creator;
        address referee;
        uint256 amount;
        uint256 feeAmount;
        uint256 deadline;
        Status status;
    }

    uint256 public constant MIN_LOCK_HOURS = 1 hours;
    uint256 public constant MAX_LOCK_DAYS = 365 days;
    uint256 public immutable minStake;
    uint256 public immutable maxStake;

    address public owner;
    uint256 public feeBps;
    address public treasury;
    uint256 public nextId;
    mapping(uint256 => Goal) public goals;

    event Created(
        uint256 indexed id,
        address indexed creator,
        address indexed referee,
        uint256 amount,
        uint256 deadline
    );
    event RoleAccepted(uint256 indexed id, address referee);
    event Approved(uint256 indexed id, uint256 amountToCreator);
    event Failed(uint256 indexed id, uint256 amountToReferee);
    event Cancelled(uint256 indexed id, uint256 refunded);
    event FeeSent(uint256 indexed id, address recipient, uint256 amount);

    error NotCreator();
    error NotReferee();
    error SelfReferee();
    error InvalidReferee();
    error DeadlineOutOfRange();
    error InvalidStake();
    error AlreadyStarted();
    error NotStarted();
    error DeadlineExpired();
    error DeadlineNotReached();
    error AlreadyResolved();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotCreator();
        _;
    }

    constructor(
        uint256 feeBps_,
        address treasury_,
        uint256 minStake_,
        uint256 maxStake_
    ) {
        owner = msg.sender;
        feeBps = feeBps_;
        treasury = treasury_;
        minStake = minStake_;
        maxStake = maxStake_;
    }

    function setFee(uint256 feeBps_) external onlyOwner {
        feeBps = feeBps_;
    }

    function setTreasury(address treasury_) external onlyOwner {
        treasury = treasury_;
    }

    function createGoal(address referee, uint256 deadline) external payable returns (uint256 id) {
        if (msg.value == 0 || msg.value < minStake || msg.value > maxStake) revert InvalidStake();
        if (referee == address(0) || referee == msg.sender) revert SelfReferee();
        if (deadline < block.timestamp + MIN_LOCK_HOURS || deadline > block.timestamp + MAX_LOCK_DAYS) {
            revert DeadlineOutOfRange();
        }

        id = nextId++;
        goals[id] = Goal({
            creator: msg.sender,
            referee: referee,
            amount: msg.value,
            feeAmount: (msg.value * feeBps) / 10_000,
            deadline: deadline,
            status: Status.Pending
        });

        emit Created(id, msg.sender, referee, msg.value, deadline);
    }

    function acceptRole(uint256 id) external {
        Goal storage g = goals[id];
        if (msg.sender != g.referee) revert NotReferee();
        if (g.status != Status.Pending) revert AlreadyStarted();
        if (block.timestamp >= g.deadline) revert DeadlineExpired();

        g.status = Status.Active;
        emit RoleAccepted(id, msg.sender);
    }

    function approve(uint256 id) external {
        Goal storage g = goals[id];
        if (msg.sender != g.referee) revert NotReferee();
        if (g.status != Status.Active) revert NotStarted();
        if (block.timestamp > g.deadline) revert DeadlineExpired();

        g.status = Status.Approved;
        _payOut(id, g.creator);
        emit Approved(id, g.amount - g.feeAmount);
    }

    function claimReferee(uint256 id) external {
        Goal storage g = goals[id];
        if (g.status != Status.Active) revert NotStarted();
        if (block.timestamp <= g.deadline) revert DeadlineNotReached();

        g.status = Status.Failed;
        _payOut(id, g.referee);
        emit Failed(id, g.amount - g.feeAmount);
    }

    function cancel(uint256 id) external {
        Goal storage g = goals[id];
        if (msg.sender != g.creator) revert NotCreator();
        if (g.status != Status.Pending) revert AlreadyStarted();

        g.status = Status.Cancelled;
        (bool ok, ) = g.creator.call{value: g.amount}("");
        if (!ok) revert TransferFailed();
        emit Cancelled(id, g.amount);
    }

    function _payOut(uint256 id, address beneficiary) internal {
        Goal storage g = goals[id];
        if (g.feeAmount > 0) {
            (bool feeOk, ) = treasury.call{value: g.feeAmount}("");
            if (!feeOk) revert TransferFailed();
            emit FeeSent(id, treasury, g.feeAmount);
        }
        uint256 toBeneficiary = g.amount - g.feeAmount;
        if (toBeneficiary > 0) {
            (bool ok, ) = beneficiary.call{value: toBeneficiary}("");
            if (!ok) revert TransferFailed();
        }
    }

    receive() external payable {}
}