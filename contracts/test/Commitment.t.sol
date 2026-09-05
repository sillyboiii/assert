// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Commitment} from "../src/Commitment.sol";

contract CommitmentTest is Test {
    Commitment c;
    address creator = makeAddr("creator");
    address referee = makeAddr("referee");
    address stranger = makeAddr("stranger");
    address treasury = makeAddr("treasury");
    uint256 constant FEE_BPS = 200;
    uint256 constant MIN_STAKE = 0.001 ether;
    uint256 constant MAX_STAKE = 5 ether;
    uint256 stake = 1 ether;

    function setUp() public {
        vm.deal(creator, 10 ether);
        vm.deal(referee, 10 ether);
        c = new Commitment(FEE_BPS, treasury, MIN_STAKE, MAX_STAKE);
    }

    function _deadline() internal view returns (uint256) {
        return block.timestamp + 7 days;
    }

    function _create() internal returns (uint256) {
        vm.prank(creator);
        return c.createGoal{value: stake}("no junk food for 30 days", referee, _deadline());
    }

    function _accept(uint256 id) internal {
        vm.prank(referee);
        c.acceptRole(id);
    }

    function test_CreateGoal_SetsFields() public {
        uint256 id = _create();
        (address c_, address r, string memory goal, uint256 amount, uint256 fee, uint256 dl, Commitment.Status s) = c.goals(id);
        assertEq(c_, creator);
        assertEq(r, referee);
        assertEq(goal, "no junk food for 30 days");
        assertEq(amount, stake);
        assertEq(fee, stake * FEE_BPS / 10_000);
        assertEq(dl, _deadline());
        assertEq(uint8(s), uint8(Commitment.Status.Pending));
    }

    function test_CreateGoal_EmitsEvent() public {
        vm.expectEmit(true, true, false, true, address(c));
        emit Commitment.Created(0, creator, referee, "no junk food for 30 days", stake, _deadline());
        _create();
    }

    function test_Revert_WhenSelfReferee() public {
        vm.prank(creator);
        vm.expectRevert(Commitment.SelfReferee.selector);
        c.createGoal{value: stake}("x", creator, _deadline());
    }

    function test_Revert_WhenRefereeZero() public {
        vm.prank(creator);
        vm.expectRevert(Commitment.SelfReferee.selector);
        c.createGoal{value: stake}("x", address(0), _deadline());
    }

    function test_Revert_WhenStakeBelowMin() public {
        vm.prank(creator);
        vm.expectRevert(Commitment.InvalidStake.selector);
        c.createGoal{value: MIN_STAKE - 1}("x", referee, _deadline());
    }

    function test_Revert_WhenStakeAboveMax() public {
        vm.prank(creator);
        vm.expectRevert(Commitment.InvalidStake.selector);
        c.createGoal{value: MAX_STAKE + 1}("x", referee, _deadline());
    }

    function test_Revert_WhenDeadlineTooSoon() public {
        vm.prank(creator);
        vm.expectRevert(Commitment.DeadlineOutOfRange.selector);
        c.createGoal{value: stake}("x", referee, block.timestamp + 59 minutes);
    }

    function test_Revert_WhenGoalTooLong() public {
        vm.prank(creator);
        vm.expectRevert(Commitment.GoalTooLong.selector);
        c.createGoal{value: stake}(string(new bytes(281)), referee, _deadline());
    }

    function test_Revert_WhenDeadlineTooFar() public {
        vm.prank(creator);
        vm.expectRevert(Commitment.DeadlineOutOfRange.selector);
        c.createGoal{value: stake}("x", referee, block.timestamp + 366 days);
    }

    function test_AcceptRole_Activates() public {
        uint256 id = _create();
        _accept(id);
        (, , , , , , Commitment.Status s) = c.goals(id);
        assertEq(uint8(s), uint8(Commitment.Status.Active));
    }

    function test_Revert_AcceptRole_WhenNotReferee() public {
        uint256 id = _create();
        vm.prank(stranger);
        vm.expectRevert(Commitment.NotReferee.selector);
        c.acceptRole(id);
    }

    function test_Revert_AcceptRole_AfterDeadline() public {
        uint256 id = _create();
        vm.warp(_deadline() + 1);
        vm.prank(referee);
        vm.expectRevert(Commitment.DeadlineExpired.selector);
        c.acceptRole(id);
    }

    function test_Revert_AcceptRole_Twice() public {
        uint256 id = _create();
        _accept(id);
        vm.prank(referee);
        vm.expectRevert(Commitment.AlreadyStarted.selector);
        c.acceptRole(id);
    }

    function test_Cancel_FullRefund_NoFee() public {
        uint256 id = _create();
        uint256 createBalance = address(c).balance;
        assertEq(createBalance, stake);

        vm.prank(creator);
        c.cancel(id);

        assertEq(address(c).balance, 0);
        assertEq(creator.balance, 10 ether);
        (, , , , , , Commitment.Status s) = c.goals(id);
        assertEq(uint8(s), uint8(Commitment.Status.Cancelled));
    }

    function test_Revert_Cancel_WhenNotCreator() public {
        uint256 id = _create();
        vm.prank(referee);
        vm.expectRevert(Commitment.NotCreator.selector);
        c.cancel(id);
    }

    function test_Revert_Cancel_AfterAccepted() public {
        uint256 id = _create();
        _accept(id);
        vm.prank(creator);
        vm.expectRevert(Commitment.AlreadyStarted.selector);
        c.cancel(id);
    }

    function test_Approve_PaysCreatorAndFee() public {
        uint256 id = _create();
        _accept(id);

        uint256 creatorBefore = creator.balance;
        uint256 treasuryBefore = treasury.balance;

        vm.prank(referee);
        c.approve(id);

        uint256 fee = stake * FEE_BPS / 10_000;
        assertEq(creator.balance, creatorBefore + stake - fee);
        assertEq(treasury.balance, treasuryBefore + fee);
        assertEq(address(c).balance, 0);
        (, , , , , , Commitment.Status s) = c.goals(id);
        assertEq(uint8(s), uint8(Commitment.Status.Approved));
    }

    function test_Revert_Approve_WhenNotReferee() public {
        uint256 id = _create();
        _accept(id);
        vm.prank(stranger);
        vm.expectRevert(Commitment.NotReferee.selector);
        c.approve(id);
    }

    function test_Revert_Approve_WhenPending() public {
        uint256 id = _create();
        vm.prank(referee);
        vm.expectRevert(Commitment.NotStarted.selector);
        c.approve(id);
    }

    function test_Revert_Approve_AfterDeadline() public {
        uint256 id = _create();
        _accept(id);
        vm.warp(_deadline() + 1);
        vm.prank(referee);
        vm.expectRevert(Commitment.DeadlineExpired.selector);
        c.approve(id);
    }

    function test_ClaimReferee_AfterDeadline_PaysReferee() public {
        uint256 id = _create();
        _accept(id);
        vm.warp(_deadline() + 1);

        uint256 refereeBefore = referee.balance;
        uint256 treasuryBefore = treasury.balance;

        c.claimReferee(id);

        uint256 fee = stake * FEE_BPS / 10_000;
        assertEq(referee.balance, refereeBefore + stake - fee);
        assertEq(treasury.balance, treasuryBefore + fee);
        assertEq(address(c).balance, 0);
        (, , , , , , Commitment.Status s) = c.goals(id);
        assertEq(uint8(s), uint8(Commitment.Status.Failed));
    }

    function test_Revert_ClaimReferee_BeforeDeadline() public {
        uint256 id = _create();
        _accept(id);
        vm.expectRevert(Commitment.DeadlineNotReached.selector);
        c.claimReferee(id);
    }

    function test_Revert_ClaimReferee_WhenPending() public {
        uint256 id = _create();
        vm.warp(_deadline() + 1);
        vm.expectRevert(Commitment.NotStarted.selector);
        c.claimReferee(id);
    }

    function test_Revert_Resolve_Twice() public {
        uint256 id = _create();
        _accept(id);
        vm.prank(referee);
        c.approve(id);

        vm.warp(_deadline() + 1);
        vm.prank(referee);
        vm.expectRevert(Commitment.NotStarted.selector);
        c.claimReferee(id);
    }

    function test_NoStuckFunds_LockedOnlyWhileGameOn() public {
        uint256 id = _create();
        _accept(id);
        assertTrue(address(c).balance > 0);
        vm.warp(_deadline() + 1);
        c.claimReferee(id);
        assertEq(address(c).balance, 0);
    }

    function test_SetFee_OnlyOwner() public {
        vm.prank(creator);
        vm.expectRevert(Commitment.NotCreator.selector);
        c.setFee(100);

        c.setFee(100);
        assertEq(c.feeBps(), 100);
    }

    function test_SetTreasury_OnlyOwner() public {
        address newTreasury = makeAddr("newTreasury");
        vm.prank(stranger);
        vm.expectRevert(Commitment.NotCreator.selector);
        c.setTreasury(newTreasury);

        c.setTreasury(newTreasury);
        assertEq(c.treasury(), newTreasury);
    }
}