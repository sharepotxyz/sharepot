// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {SharePot} from "../src/SharePot.sol";
import {MockStock} from "../src/MockStock.sol";

/// Mirrors tests/sharepot.ts (the Solana suite): same money model, same scenarios, plus the cases the EVM adds
/// (shared vault, blocked owners, tokens that return nothing).
contract SharePotTest is Test {
    SharePot pot;
    MockStock tsla;
    MockStock nvda;

    address admin = address(this);
    address proposer = makeAddr("proposer");
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address stranger = makeAddr("stranger");

    uint64 constant T0 = 1_700_000_000;
    uint64 constant OPEN = T0;
    uint64 constant CLOSE = T0 + 4 hours; // quarter = 1 h, below the 2 h config cap
    uint64 constant RESOLVE = CLOSE + 30 minutes;
    uint16 constant FEE = 500; // 5 %
    uint16 constant DISCOUNT = 200; // early birds pay 3 %
    uint64 constant DISPUTE = 1 hours;
    uint256 constant MIN_BET = 1e16;

    function setUp() public {
        vm.warp(T0);
        pot = new SharePot(cfg());
        tsla = new MockStock("Tesla", "TSLA");
        nvda = new MockStock("NVIDIA", "NVDA");
        address[4] memory who = [alice, bob, carol, treasury];
        for (uint256 i = 0; i < who.length; i++) {
            tsla.mint(who[i], 1_000e18);
            nvda.mint(who[i], 1_000e18);
            vm.startPrank(who[i]);
            tsla.approve(address(pot), type(uint256).max);
            nvda.approve(address(pot), type(uint256).max);
            vm.stopPrank();
        }
    }

    function cfg() internal view returns (SharePot.ConfigArgs memory) {
        return SharePot.ConfigArgs({
            proposer: proposer,
            treasury: treasury,
            feeBps: FEE,
            earlyBirdDiscountBps: DISCOUNT,
            earlyBirdSecs: 2 hours,
            disputeWindowSecs: DISPUTE,
            minBet: MIN_BET
        });
    }

    function upDown(address token) internal pure returns (SharePot.MarketArgs memory a) {
        a.token = token;
        a.metric = keccak256("TSLA.move:2026-09-24");
        a.questionHash = keccak256("close vs previous close, bps");
        a.thresholds[0] = 0; // bucket 0 = down (< 0 bps), bucket 1 = up (>= 0)
        a.nBuckets = 2;
        a.openTs = OPEN;
        a.closeTs = CLOSE;
        a.resolveAfterTs = RESOLVE;
    }

    function create(SharePot.MarketArgs memory a) internal returns (uint256) {
        vm.prank(proposer);
        return pot.createMarket(a);
    }

    function bet(address who, uint256 id, uint8 bucket, uint256 amount) internal {
        vm.prank(who);
        pot.placeBet(id, bucket, amount);
    }

    function propose(uint256 id, int64 value) internal {
        vm.prank(proposer);
        pot.proposeResolution(id, value, keccak256(abi.encode(value)));
    }

    // ---------- config ----------

    function test_initializesConfig() public view {
        (address a, address p, address t, uint16 f, uint16 d, uint64 eb, uint64 dw, uint256 mb, bool paused) = pot.config();
        assertEq(a, admin);
        assertEq(p, proposer);
        assertEq(t, treasury);
        assertEq(f, FEE);
        assertEq(d, DISCOUNT);
        assertEq(eb, 2 hours);
        assertEq(dw, DISPUTE);
        assertEq(mb, MIN_BET);
        assertFalse(paused);
        assertEq(pot.marketCount(), 0);
    }

    function test_configRejectsFeeAboveCeilingAndDiscountAboveFee() public {
        SharePot.ConfigArgs memory a = cfg();
        a.feeBps = 1_001;
        vm.expectRevert(SharePot.FeeTooHigh.selector);
        new SharePot(a);
        a = cfg();
        a.earlyBirdDiscountBps = FEE + 1;
        vm.expectRevert(SharePot.FeeTooHigh.selector);
        pot.updateConfig(a, address(0), false);
        a = cfg();
        a.treasury = address(0);
        vm.expectRevert(SharePot.ZeroAddress.selector);
        pot.updateConfig(a, address(0), false);
        vm.prank(stranger);
        vm.expectRevert(SharePot.Unauthorized.selector);
        pot.updateConfig(cfg(), stranger, false);
    }

    function test_pausedConfigBlocksBets() public {
        uint256 id = create(upDown(address(tsla)));
        pot.updateConfig(cfg(), address(0), true);
        vm.expectRevert(SharePot.Paused.selector);
        bet(alice, id, 1, 1e18);
        pot.updateConfig(cfg(), address(0), false);
        bet(alice, id, 1, 1e18);
        assertEq(pot.getMarket(id).pools[1], 1e18);
    }

    // ---------- market creation ----------

    function test_rejectsBadSchedulesUnauthorizedCreatorsAndBadBuckets() public {
        SharePot.MarketArgs memory a = upDown(address(tsla));
        vm.prank(stranger);
        vm.expectRevert(SharePot.Unauthorized.selector);
        pot.createMarket(a);

        a.closeTs = a.openTs;
        vm.expectRevert(SharePot.BadSchedule.selector);
        create(a);
        a = upDown(address(tsla));
        a.resolveAfterTs = a.closeTs - 1;
        vm.expectRevert(SharePot.BadSchedule.selector);
        create(a);
        a = upDown(address(tsla));
        vm.warp(CLOSE);
        vm.expectRevert(SharePot.BadSchedule.selector);
        create(a);
        vm.warp(T0);

        a = upDown(address(tsla));
        a.nBuckets = 1;
        vm.expectRevert(SharePot.BadBuckets.selector);
        create(a);
        a.nBuckets = 9;
        vm.expectRevert(SharePot.BadBuckets.selector);
        create(a);
        a.nBuckets = 3;
        a.thresholds[1] = 0; // not strictly increasing
        vm.expectRevert(SharePot.BadBuckets.selector);
        create(a);

        a = upDown(makeAddr("not-a-contract"));
        vm.expectRevert(SharePot.UnsupportedToken.selector);
        create(a);

        // the admin may create too
        pot.createMarket(upDown(address(tsla)));
        assertEq(pot.marketCount(), 1);
    }

    // ---------- lifecycle ----------

    /// seed, early-bird + normal bets, propose, admin finalize, permissionless settle, sweep — every number checked.
    function test_fullLifecycle() public {
        uint256 id = create(upDown(address(tsla)));
        vm.prank(treasury);
        pot.seedMarket(id, 10e18);

        bet(alice, id, 1, 100e18); // t = open: early bird, 3 %
        vm.warp(OPEN + 2 hours); // past the 1 h early-bird quarter
        bet(bob, id, 1, 50e18); // 5 %
        bet(carol, id, 0, 60e18);
        assertEq(tsla.balanceOf(address(pot)), 220e18);

        SharePot.Market memory m = pot.getMarket(id);
        assertEq(m.pools[0], 60e18);
        assertEq(m.pools[1], 150e18);
        assertEq(m.seedAmount, 10e18);
        assertEq(m.held, 220e18);
        assertEq(m.positions, 3);
        SharePot.Position memory pa = pot.getPosition(id, alice);
        assertEq(pa.feeW[1], 100e18 * 300);
        assertEq(pot.getPosition(id, bob).feeW[1], 50e18 * 500);

        vm.warp(CLOSE);
        vm.expectRevert(SharePot.BettingClosed.selector);
        bet(alice, id, 1, 1e18);
        vm.expectRevert(SharePot.TooEarlyToResolve.selector);
        propose(id, 25);
        vm.prank(stranger);
        vm.expectRevert(SharePot.Unauthorized.selector);
        pot.proposeResolution(id, 25, bytes32(0));

        vm.warp(RESOLVE);
        propose(id, 25);
        m = pot.getMarket(id);
        assertEq(uint8(m.status), uint8(SharePot.Status.Proposed));
        assertEq(m.proposedOutcome, 1);
        assertEq(m.proposedValue, 25);

        vm.prank(stranger);
        vm.expectRevert(SharePot.DisputeWindowOpen.selector);
        pot.finalizeResolution(id);
        pot.finalizeResolution(id); // admin: at once
        assertEq(pot.getMarket(id).outcome, 1);

        // alice: 100 stake + 60×100/150 = 40 gross − 3 % = 1.2 fee + seed 10×100/150 = 6.666…
        (uint256 payout, uint256 fee) = pot.computePayout(id, alice);
        assertEq(payout, 145_466_666_666_666_666_666);
        assertEq(fee, 1_200_000_000_000_000_000);
        // bob: 50 + 20 − 5 % = 1 + seed 3.333…
        (payout, fee) = pot.computePayout(id, bob);
        assertEq(payout, 72_333_333_333_333_333_333);
        assertEq(fee, 1e18);
        (payout, fee) = pot.computePayout(id, carol);
        assertEq(payout, 0);
        assertEq(fee, 0);

        vm.expectRevert(SharePot.PositionsOutstanding.selector);
        pot.sweepMarket(id);

        uint256 a0 = tsla.balanceOf(alice);
        vm.prank(stranger); // permissionless
        pot.settlePosition(id, alice);
        assertEq(tsla.balanceOf(alice) - a0, 145_466_666_666_666_666_666);
        vm.expectRevert(SharePot.NoPosition.selector);
        pot.settlePosition(id, alice); // twice: no
        pot.settlePosition(id, bob);
        pot.settlePosition(id, carol);
        m = pot.getMarket(id);
        assertEq(m.positionsOpen, 0);
        assertEq(m.paidOut, 217_799_999_999_999_999_999);
        assertEq(m.feeCollected, 2_200_000_000_000_000_000);
        assertEq(m.held, 2_200_000_000_000_000_001); // fees + 1 wei of seed rounding

        uint256 t0 = treasury.balance;
        t0 = tsla.balanceOf(treasury);
        vm.prank(stranger);
        pot.sweepMarket(id);
        assertEq(tsla.balanceOf(treasury) - t0, 2_200_000_000_000_000_001);
        assertEq(tsla.balanceOf(address(pot)), 0);
        m = pot.getMarket(id);
        assertEq(uint8(m.status), uint8(SharePot.Status.Swept));
        assertEq(m.swept, 2_200_000_000_000_000_001);
        assertEq(m.held, 0);
        vm.expectRevert(SharePot.NotResolved.selector);
        pot.sweepMarket(id);
    }

    function test_voidRefundsEveryoneAndSeedGoesToTreasury() public {
        uint256 id = create(upDown(address(tsla)));
        vm.prank(treasury);
        pot.seedMarket(id, 10e18);
        bet(alice, id, 1, 100e18);
        bet(carol, id, 0, 60e18);
        vm.prank(stranger);
        vm.expectRevert(SharePot.Unauthorized.selector);
        pot.voidMarket(id);
        pot.voidMarket(id);
        uint256 a0 = tsla.balanceOf(alice);
        uint256 c0 = tsla.balanceOf(carol);
        uint256 t0 = tsla.balanceOf(treasury);
        pot.settlePosition(id, alice);
        pot.settlePosition(id, carol);
        pot.sweepMarket(id);
        assertEq(tsla.balanceOf(alice) - a0, 100e18);
        assertEq(tsla.balanceOf(carol) - c0, 60e18);
        assertEq(tsla.balanceOf(treasury) - t0, 10e18);
        assertEq(tsla.balanceOf(address(pot)), 0);
    }

    function test_noWinnersRefundsEveryoneAndPermissionlessFinalizeAfterWindow() public {
        uint256 id = create(upDown(address(tsla)));
        vm.prank(treasury);
        pot.seedMarket(id, 10e18);
        bet(alice, id, 1, 100e18);
        bet(bob, id, 1, 50e18);
        vm.warp(RESOLVE);
        propose(id, -30); // down: nobody bet down
        vm.warp(RESOLVE + DISPUTE - 1);
        vm.prank(stranger);
        vm.expectRevert(SharePot.DisputeWindowOpen.selector);
        pot.finalizeResolution(id);
        vm.warp(RESOLVE + DISPUTE);
        vm.prank(stranger);
        pot.finalizeResolution(id);
        (uint256 payout, uint256 fee) = pot.computePayout(id, alice);
        assertEq(payout, 100e18);
        assertEq(fee, 0);
        uint256 t0 = tsla.balanceOf(treasury);
        pot.settlePosition(id, alice);
        pot.settlePosition(id, bob);
        pot.sweepMarket(id);
        assertEq(tsla.balanceOf(treasury) - t0, 10e18);
    }

    function test_fourBucketsWithNegativeThresholdsDerivedOnChain() public {
        SharePot.MarketArgs memory a = upDown(address(tsla));
        a.nBuckets = 4;
        a.thresholds[0] = -176;
        a.thresholds[1] = -10;
        a.thresholds[2] = 201;
        uint256 id = create(a);
        assertEq(pot.bucketOf(id, -200), 0);
        assertEq(pot.bucketOf(id, -176), 1);
        assertEq(pot.bucketOf(id, -50), 1);
        assertEq(pot.bucketOf(id, -10), 2);
        assertEq(pot.bucketOf(id, 0), 2);
        assertEq(pot.bucketOf(id, 200), 2);
        assertEq(pot.bucketOf(id, 201), 3);
        assertEq(pot.bucketOf(id, 9_999), 3);
        vm.expectRevert(SharePot.BadBuckets.selector);
        bet(alice, id, 4, 1e18);
        bet(alice, id, 0, 10e18);
        bet(bob, id, 1, 10e18);
        bet(carol, id, 3, 10e18);
        vm.warp(RESOLVE);
        propose(id, 300);
        pot.finalizeResolution(id);
        (uint256 payout, uint256 fee) = pot.computePayout(id, carol);
        assertEq(fee, 20e18 * 300 / 10_000); // early bird
        assertEq(payout, 10e18 + 20e18 - fee);
    }

    function test_boundaryZeroIsUpReproposeRestartsWindowAndFinalStatesAreFinal() public {
        uint256 id = create(upDown(address(tsla)));
        bet(alice, id, 1, 10e18);
        bet(bob, id, 0, 10e18);
        vm.warp(RESOLVE);
        propose(id, -1);
        assertEq(pot.getMarket(id).proposedOutcome, 0);
        vm.warp(RESOLVE + 30 minutes);
        propose(id, 0); // corrected: 0 bps counts as up, window restarts
        SharePot.Market memory m = pot.getMarket(id);
        assertEq(m.proposedOutcome, 1);
        assertEq(m.proposedAt, RESOLVE + 30 minutes);
        vm.warp(RESOLVE + DISPUTE);
        vm.prank(stranger);
        vm.expectRevert(SharePot.DisputeWindowOpen.selector);
        pot.finalizeResolution(id);
        vm.warp(RESOLVE + 30 minutes + DISPUTE);
        vm.prank(stranger);
        pot.finalizeResolution(id);
        assertEq(pot.getMarket(id).outcome, 1);

        vm.expectRevert(SharePot.NotProposed.selector);
        pot.finalizeResolution(id);
        vm.expectRevert(SharePot.AlreadyFinal.selector);
        pot.voidMarket(id);
        vm.prank(proposer);
        vm.expectRevert(SharePot.MarketNotOpen.selector);
        pot.proposeResolution(id, 5, bytes32(0));
        vm.expectRevert(SharePot.MarketNotOpen.selector);
        bet(alice, id, 1, 1e18);
        vm.prank(treasury);
        vm.expectRevert(SharePot.MarketNotOpen.selector);
        pot.seedMarket(id, 1e18);
    }

    function test_bettingWindowAndMinBet() public {
        SharePot.MarketArgs memory a = upDown(address(tsla));
        a.openTs = OPEN + 1 hours;
        a.closeTs = OPEN + 5 hours;
        a.resolveAfterTs = a.closeTs;
        uint256 id = create(a);
        vm.expectRevert(SharePot.BettingNotStarted.selector);
        bet(alice, id, 1, 1e18);
        vm.warp(OPEN + 1 hours);
        vm.expectRevert(SharePot.BelowMinBet.selector);
        bet(alice, id, 1, MIN_BET - 1);
        bet(alice, id, 1, MIN_BET);
        // topping up keeps one position, stake-weighted fee
        vm.warp(OPEN + 1 hours + 1 hours); // early-bird quarter over
        bet(alice, id, 1, MIN_BET);
        SharePot.Position memory p = pot.getPosition(id, alice);
        assertEq(p.amounts[1], 2 * MIN_BET);
        assertEq(p.feeW[1], MIN_BET * 300 + MIN_BET * 500);
        assertEq(pot.getMarket(id).positions, 1);
        // nonexistent market
        vm.expectRevert(SharePot.MarketNotOpen.selector);
        bet(alice, 99, 1, 1e18);
    }

    // ---------- stale void ----------

    function test_staleVoidProposerAfterADayStrangerNeverAdminAtOnce() public {
        uint256 id = create(upDown(address(tsla)));
        uint256 id2 = create(upDown(address(tsla)));
        uint256 id3 = create(upDown(address(tsla)));
        bet(alice, id, 1, 10e18);
        vm.warp(RESOLVE + pot.STALE_VOID_SECS() - 1);
        vm.prank(proposer);
        vm.expectRevert(SharePot.NotStaleYet.selector);
        pot.voidStaleMarket(id);
        vm.warp(RESOLVE + pot.STALE_VOID_SECS());
        vm.prank(stranger);
        vm.expectRevert(SharePot.Unauthorized.selector);
        pot.voidStaleMarket(id);
        vm.prank(proposer);
        pot.voidStaleMarket(id);
        assertEq(uint8(pot.getMarket(id).status), uint8(SharePot.Status.Voided));

        pot.voidMarket(id2); // not stale, but the admin may void at once
        // a proposed market is not "stale": the dispute window handles it
        vm.warp(RESOLVE);
        propose(id3, 1);
        vm.warp(RESOLVE + pot.STALE_VOID_SECS());
        vm.prank(proposer);
        vm.expectRevert(SharePot.MarketNotOpen.selector);
        pot.voidStaleMarket(id3);
    }

    // ---------- issuer controls ----------

    function test_issuerPauseFreezesBetsAndPayoutsThenResumesIntact() public {
        uint256 id = create(upDown(address(tsla)));
        bet(alice, id, 1, 10e18);
        tsla.setPaused(true);
        vm.expectRevert(SharePot.TransferFailed.selector);
        bet(bob, id, 0, 10e18);
        tsla.setPaused(false);
        bet(bob, id, 0, 10e18);
        vm.warp(RESOLVE);
        propose(id, 1);
        pot.finalizeResolution(id);
        tsla.setPaused(true);
        vm.expectRevert(SharePot.TransferFailed.selector);
        pot.settlePosition(id, alice);
        // a pause forfeits nobody, even the admin cannot
        vm.expectRevert(SharePot.TransferFailed.selector);
        pot.forfeitPosition(id, alice);
        SharePot.Market memory m = pot.getMarket(id);
        assertEq(m.positionsOpen, 2);
        assertEq(m.held, 20e18);
        tsla.setPaused(false);
        uint256 a0 = tsla.balanceOf(alice);
        pot.settlePosition(id, alice);
        assertEq(tsla.balanceOf(alice) - a0, 10e18 + 10e18 - 10e18 * 300 / 10_000);
    }

    function test_forfeitBlockedOwnerAfterGraceAdminAtOncePayableOwnerIsPaid() public {
        uint256 id = create(upDown(address(tsla)));
        uint256 id2 = create(upDown(address(tsla)));
        bet(alice, id, 1, 10e18);
        bet(bob, id, 1, 10e18);
        bet(carol, id, 0, 10e18);
        bet(bob, id2, 1, 5e18);
        vm.warp(RESOLVE);
        propose(id, 1);
        pot.finalizeResolution(id);
        tsla.setBlocked(alice, true);
        vm.expectRevert(SharePot.TransferFailed.selector);
        pot.settlePosition(id, alice);
        vm.prank(stranger);
        vm.expectRevert(SharePot.NotForfeitableYet.selector);
        pot.forfeitPosition(id, alice);
        vm.warp(RESOLVE + pot.FORFEIT_GRACE_SECS() - 1);
        vm.prank(stranger);
        vm.expectRevert(SharePot.NotForfeitableYet.selector);
        pot.forfeitPosition(id, alice);
        vm.warp(RESOLVE + pot.FORFEIT_GRACE_SECS());
        (uint256 payout, uint256 fee) = pot.computePayout(id, alice);
        uint256 t0 = tsla.balanceOf(treasury);
        vm.prank(stranger);
        vm.expectEmit(true, true, false, true);
        emit SharePot.PositionForfeited(id, alice, payout);
        pot.forfeitPosition(id, alice);
        assertEq(tsla.balanceOf(treasury) - t0, payout);
        SharePot.Market memory m = pot.getMarket(id);
        assertEq(m.feeCollected, fee);
        assertEq(m.paidOut, 0);
        assertEq(m.positionsOpen, 2);
        // an owner who can be paid is paid, never forfeited
        uint256 b0 = tsla.balanceOf(bob);
        vm.prank(stranger);
        vm.expectEmit(true, true, false, true);
        emit SharePot.PositionSettled(id, bob, payout, fee);
        pot.forfeitPosition(id, bob);
        assertEq(tsla.balanceOf(bob) - b0, payout);
        // a loser's position closes with no transfer at all
        pot.forfeitPosition(id, carol);
        assertEq(pot.getMarket(id).positionsOpen, 0);
        pot.sweepMarket(id);
        assertEq(tsla.balanceOf(address(pot)), 5e18); // only id2's stake is left

        // admin: at once, and a blocked owner's stake on a voided market goes the same way
        tsla.setBlocked(bob, true);
        pot.voidMarket(id2);
        t0 = tsla.balanceOf(treasury);
        pot.forfeitPosition(id2, bob);
        assertEq(tsla.balanceOf(treasury) - t0, 5e18);
        pot.sweepMarket(id2);
        assertEq(tsla.balanceOf(address(pot)), 0);
    }

    function test_multiplierChangeMidMarketLeavesRawAccountingExact() public {
        uint256 id = create(upDown(address(tsla)));
        bet(alice, id, 1, 10e18);
        bet(bob, id, 0, 10e18);
        tsla.setMultiplier(2e18); // 2:1 split
        assertEq(tsla.balanceOfUI(address(pot)), 40e18);
        vm.warp(RESOLVE);
        propose(id, 1);
        pot.finalizeResolution(id);
        uint256 a0 = tsla.balanceOf(alice);
        pot.settlePosition(id, alice);
        assertEq(tsla.balanceOf(alice) - a0, 19_700_000_000_000_000_000); // raw: 10 + 10 − 3 %
        assertEq(tsla.balanceOfUI(alice), (1_000e18 - 10e18 + 19.7e18) * 2);
    }

    function test_transferFeeTokenPoolsBookWhatArrived() public {
        tsla.setFeeBps(50); // 0.5 %, Tessera/PreStocks style
        uint256 id = create(upDown(address(tsla)));
        vm.prank(treasury);
        pot.seedMarket(id, 10e18);
        bet(alice, id, 1, 100e18);
        bet(bob, id, 0, 100e18);
        SharePot.Market memory m = pot.getMarket(id);
        assertEq(m.seedAmount, 9.95e18);
        assertEq(m.pools[1], 99.5e18);
        assertEq(m.pools[0], 99.5e18);
        assertEq(m.held, 208.95e18);
        assertEq(tsla.balanceOf(address(pot)), 208.95e18);
        vm.warp(RESOLVE);
        propose(id, 1);
        pot.finalizeResolution(id);
        (uint256 payout,) = pot.computePayout(id, alice);
        assertEq(payout, 99.5e18 + 99.5e18 - 99.5e18 * 300 / 10_000 + 9.95e18);
        pot.settlePosition(id, alice);
        pot.settlePosition(id, bob);
        pot.sweepMarket(id);
        assertEq(tsla.balanceOf(address(pot)), 0);
    }

    // ---------- the shared vault ----------

    function test_marketsAreIsolatedInsideTheSharedVault() public {
        uint256 a = create(upDown(address(tsla)));
        uint256 b = create(upDown(address(tsla)));
        uint256 c = create(upDown(address(nvda)));
        bet(alice, a, 1, 10e18);
        bet(bob, b, 0, 20e18);
        bet(carol, c, 1, 30e18);
        assertEq(tsla.balanceOf(address(pot)), 30e18);
        assertEq(nvda.balanceOf(address(pot)), 30e18);
        // a position lives in one market only
        assertFalse(pot.getPosition(b, alice).open);
        assertEq(pot.getMarket(a).held, 10e18);
        assertEq(pot.getMarket(b).held, 20e18);
        assertEq(pot.getMarket(c).held, 30e18);

        pot.voidMarket(a);
        pot.settlePosition(a, alice);
        pot.sweepMarket(a);
        assertEq(tsla.balanceOf(address(pot)), 20e18); // b untouched
        assertEq(pot.getMarket(b).held, 20e18);

        // tokens sent straight to the contract belong to no market and are never paid out or swept
        tsla.mint(address(pot), 5e18);
        pot.voidMarket(b);
        pot.settlePosition(b, bob);
        pot.sweepMarket(b);
        assertEq(pot.getMarket(b).swept, 0);
        assertEq(tsla.balanceOf(address(pot)), 5e18);
        assertEq(nvda.balanceOf(address(pot)), 30e18);
    }

    function test_settleOnOpenMarketAndUnknownPositionRejected() public {
        uint256 id = create(upDown(address(tsla)));
        bet(alice, id, 1, 10e18);
        vm.expectRevert(SharePot.NotResolved.selector);
        pot.settlePosition(id, alice);
        vm.expectRevert(SharePot.NotResolved.selector);
        pot.computePayout(id, alice);
        pot.voidMarket(id);
        vm.expectRevert(SharePot.NoPosition.selector);
        pot.settlePosition(id, stranger);
        vm.expectRevert(SharePot.NotResolved.selector);
        pot.sweepMarket(99);
    }
}
