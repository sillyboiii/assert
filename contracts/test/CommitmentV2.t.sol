// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CommitmentV2} from "../src/CommitmentV2.sol";

contract MockUSDC {
    string public constant name = "Mock USDC";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        allowance[from][msg.sender] = allowed - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

contract CommitmentV2Test is Test {
    CommitmentV2 c;
    MockUSDC usdc;
    address creator = makeAddr("creator");
    address referee = makeAddr("referee");
    address stranger = makeAddr("stranger");
    address treasury = makeAddr("treasury");
    uint256 constant FEE_BPS = 200;
    uint256 constant MIN_ETH_STAKE = 0.001 ether;
    uint256 constant MAX_ETH_STAKE = 5 ether;
    uint256 constant MIN_USDC_STAKE = 1e6; // 1 USDC
    uint256 constant MAX_USDC_STAKE = 5_000e6;
    uint256 constant GRACE = 2 days;
    uint256 ethStake = 1 ether;
    uint256 usdcStake = 100e6;

    function setUp() public {
        usdc = new MockUSDC();
        c = new CommitmentV2({
            feeBps_: FEE_BPS,
            treasury_: treasury,
            usdc_: address(usdc),
            minEthStake_: MIN_ETH_STAKE,
            maxEthStake_: MAX_ETH_STAKE,
            minUsdcStake_: MIN_USDC_STAKE,
            maxUsdcStake_: MAX_USDC_STAKE
        });
        vm.deal(creator, 10 ether);
        vm.deal(referee, 10 ether);
        usdc.mint(creator, 1_000e6);
    }

    function _deadline() internal view returns (uint256) {
        return block.timestamp + 7 days;
    }

    function _createEth() internal returns (uint256) {
        vm.prank(creator);
        return c.createGoal{value: ethStake}("no junk food for 30 days", referee, _deadline());
    }

    function _createUsdc() internal returns (uint256) {
        vm.startPrank(creator);
        usdc.approve(address(c), usdcStake);
        uint256 id = c.createGoalWithToken("no junk food for 30 days", referee, _deadline(), address(usdc), usdcStake);
        vm.stopPrank();
        return id;
    }

    function _accept(uint256 id) internal {
        vm.prank(referee);
        c.acceptRole(id);
    }

    function test_EthCreateStillWorks() public {
        uint256 id = _createEth();
        (address cr, address r, address token, string memory goal, uint256 amount, uint256 fee, uint256 dl, CommitmentV2.Status s) = c.goals(id);
        assertEq(cr, creator);
        assertEq(r, referee);
        assertEq(token, address(0));
        assertEq(goal, "no junk food for 30 days");
        assertEq(amount, ethStake);
        assertEq(fee, ethStake * FEE_BPS / 10_000);
        assertEq(dl, _deadline());
        assertEq(uint8(s), uint8(CommitmentV2.Status.Pending));
    }

    function test_UsdcCreate_PullsTokensAndStoresToken() public {
        uint256 id = _createUsdc();
        (address cr, address r, address token, , uint256 amount, uint256 fee, , CommitmentV2.Status s) = c.goals(id);
        assertEq(cr, creator);
        assertEq(r, referee);
        assertEq(token, address(usdc));
        assertEq(amount, usdcStake);
        assertEq(fee, usdcStake * FEE_BPS / 10_000);
        assertEq(uint8(s), uint8(CommitmentV2.Status.Pending));
        assertEq(usdc.balanceOf(address(c)), usdcStake);
        assertEq(usdc.balanceOf(creator), 900e6);
    }

    function test_UsdcApprove_PaysCreatorAndFee() public {
        uint256 id = _createUsdc();
        _accept(id);

        vm.prank(referee);
        c.approve(id);

        uint256 fee = usdcStake * FEE_BPS / 10_000;
        assertEq(usdc.balanceOf(creator), 900e6 + usdcStake - fee);
        assertEq(usdc.balanceOf(treasury), fee);
        assertEq(usdc.balanceOf(address(c)), 0);
        (, , , , , , , CommitmentV2.Status s) = c.goals(id);
        assertEq(uint8(s), uint8(CommitmentV2.Status.Approved));
    }

    function test_UsdcClaimReferee_PaysRefereeAndFee() public {
        uint256 id = _createUsdc();
        _accept(id);
        vm.warp(_deadline() + 1);

        vm.prank(referee);
        c.claimReferee(id);

        uint256 fee = usdcStake * FEE_BPS / 10_000;
        assertEq(usdc.balanceOf(referee), usdcStake - fee);
        assertEq(usdc.balanceOf(treasury), fee);
        assertEq(usdc.balanceOf(address(c)), 0);
        (, , , , , , , CommitmentV2.Status s) = c.goals(id);
        assertEq(uint8(s), uint8(CommitmentV2.Status.Failed));
    }

    function test_UsdcCancel_RefundsFullAmount() public {
        uint256 id = _createUsdc();

        vm.prank(creator);
        c.cancel(id);

        assertEq(usdc.balanceOf(creator), 1_000e6);
        assertEq(usdc.balanceOf(address(c)), 0);
        (, , , , , , , CommitmentV2.Status s) = c.goals(id);
        assertEq(uint8(s), uint8(CommitmentV2.Status.Cancelled));
    }

    function test_UsdcRefundNoShow_RefundsFullAmount() public {
        uint256 id = _createUsdc();
        _accept(id);
        vm.warp(_deadline() + GRACE + 1);

        vm.prank(creator);
        c.refundNoShow(id);

        assertEq(usdc.balanceOf(creator), 1_000e6);
        assertEq(usdc.balanceOf(address(c)), 0);
        (, , , , , , , CommitmentV2.Status s) = c.goals(id);
        assertEq(uint8(s), uint8(CommitmentV2.Status.Cancelled));
    }

    function test_Revert_UsdcWithoutAllowance() public {
        vm.prank(creator);
        vm.expectRevert(CommitmentV2.TransferFailed.selector);
        c.createGoalWithToken("x", referee, _deadline(), address(usdc), usdcStake);
    }

    function test_Revert_UnsupportedToken() public {
        MockUSDC fake = new MockUSDC();
        fake.mint(creator, usdcStake);
        vm.startPrank(creator);
        fake.approve(address(c), usdcStake);
        vm.expectRevert(CommitmentV2.UnsupportedToken.selector);
        c.createGoalWithToken("x", referee, _deadline(), address(fake), usdcStake);
        vm.stopPrank();
    }

    function test_Revert_UsdcStakeBelowMin() public {
        vm.startPrank(creator);
        usdc.approve(address(c), MIN_USDC_STAKE - 1);
        vm.expectRevert(CommitmentV2.InvalidStake.selector);
        c.createGoalWithToken("x", referee, _deadline(), address(usdc), MIN_USDC_STAKE - 1);
        vm.stopPrank();
    }

    function test_Revert_AcceptRole_WhenNotReferee() public {
        uint256 id = _createUsdc();
        vm.prank(stranger);
        vm.expectRevert(CommitmentV2.NotReferee.selector);
        c.acceptRole(id);
    }
}
