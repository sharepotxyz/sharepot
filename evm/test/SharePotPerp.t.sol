// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {SharePotPerp} from "../src/SharePotPerp.sol";
import {MockStock} from "../src/MockStock.sol";

/// The worked examples of perps/DESIGN.md, the calendar/dispute/skip rules, the wipe-out path, and a random
/// sequence that checks the pool never owes more tokens than it holds.
contract SharePotPerpTest is Test {
    SharePotPerp perp;
    MockStock nvda;

    address admin = address(this);
    address operator = makeAddr("operator");
    address guardian = makeAddr("guardian");
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address dave = makeAddr("dave");

    uint8 constant LONG2 = 0;
    uint8 constant HEDGE = 1;
    uint8 constant SHORT1 = 2;
    uint8 constant SHORT2 = 3;

    uint64 constant T0 = 1_700_000_000;
    uint64 constant DISPUTE = 6 hours;
    uint256 constant ONE = 1e8; // NVDAc has 8 decimals
    uint256 constant P100 = 100e8; // token value $100

    function setUp() public {
        vm.warp(T0);
        nvda = new MockStock("NVIDIA xStock", "NVDAc", 8);
        perp = deploy(0, 0);
    }

    function deploy(uint16 fee, uint16 funding) internal returns (SharePotPerp p) {
        uint8[] memory cs = new uint8[](4);
        bool[] memory longs = new bool[](4);
        cs[0] = 1; longs[0] = true; // long 2x
        cs[1] = 1; // hedge
        cs[2] = 2; // short 1x
        cs[3] = 3; // short 2x
        p = new SharePotPerp(address(nvda), admin, operator, guardian, treasury, fee, funding, DISPUTE, cs, longs, HEDGE);
        address[5] memory who = [alice, bob, carol, dave, treasury];
        for (uint256 i = 0; i < who.length; i++) {
            nvda.mint(who[i], 1_000_000 * ONE);
            vm.prank(who[i]);
            nvda.approve(address(p), type(uint256).max);
        }
        uint64[] memory cutoffs = new uint64[](30);
        for (uint256 i = 0; i < 30; i++) cutoffs[i] = uint64(T0 + (i + 1) * 1 days);
        vm.prank(operator);
        p.schedule(cutoffs);
    }

    // ---------------------------------------------------------------- helpers

    function dep(address who, uint8 tier, uint256 amt) internal returns (uint256 day) {
        vm.prank(who);
        day = perp.requestDeposit(tier, amt);
    }

    function red(address who, uint8 tier, uint256 sh) internal returns (uint256 day) {
        vm.prank(who);
        day = perp.requestRedeem(tier, sh);
    }

    function close(uint256 day, uint256 value) internal {
        (uint64 cutoff,,,,,) = perp.epochs(day);
        if (block.timestamp < cutoff) vm.warp(cutoff);
        // moves beyond the operator's cap (50 %) can only be proposed by the admin
        uint256 lv = perp.lastValue();
        uint256 d = value > lv ? value - lv : lv - value;
        if (lv == 0 || d * 10_000 <= lv * perp.maxMoveBps()) vm.prank(operator);
        perp.propose(day, value, keccak256(abi.encode(day, value)));
        vm.warp(block.timestamp + DISPUTE);
        perp.settle(day);
    }

    function claim(address who, uint256 day, uint8 tier) internal returns (uint256 sh, uint256 tok) {
        (sh, tok) = perp.claim(who, day, tier);
    }

    /// Token value of everything `who` owns in `tier`, times `value`, in whole-dollar-ish units.
    function worth(address who, uint8 tier, uint256 value) internal view returns (uint256) {
        uint256 tok = perp.sharesToTokens(tier, perp.sharesOf(who, tier));
        return tok * value / ONE / ONE; // dollars (value has 8 decimals, tokens 8 decimals)
    }

    // --------------------------------------------------- design doc examples

    /// Example 1: long 2x vs an equal hedge, fully filled. +5 % → +10 %, then −5 % → $990 of $1,000 (here x100).
    function test_example1_balancedDoublesTheMove() public {
        uint256 d1 = dep(alice, LONG2, 1_000 * ONE);
        dep(bob, HEDGE, 1_000 * ONE);
        close(d1, P100);
        claim(alice, d1, LONG2);
        claim(bob, d1, HEDGE);
        assertEq(worth(alice, LONG2, P100), 100_000);

        close(2, 105e8); // +5 %
        assertApproxEqAbs(worth(alice, LONG2, 105e8), 110_000, 1);
        assertApproxEqAbs(worth(bob, HEDGE, 105e8), 100_000, 1); // the hedge's value is locked

        // After the win the long side is $110k and the hedge still $100k: the long is only 100/110 = 90.9 % filled,
        // so −5 % costs it 5 % × 1.909 = 9.55 %, not 10 % (DESIGN.md example 1 first assumed a full fill here).
        assertEq(perp.fillBps(LONG2), 9_090);
        close(3, 99_75e6); // −5 %
        assertApproxEqAbs(worth(alice, LONG2, 99_75e6), 99_499, 1);
        assertApproxEqAbs(worth(bob, HEDGE, 99_75e6), 100_000, 1);

        // exit at the next close, no fee configured
        uint256 sh = perp.sharesOf(alice, LONG2);
        uint256 d4 = red(alice, LONG2, sh);
        close(d4, 99_75e6);
        uint256 before = nvda.balanceOf(alice);
        (, uint256 tok) = claim(alice, d4, LONG2);
        assertEq(nvda.balanceOf(alice) - before, tok);
        assertApproxEqAbs(tok * 99_75e6 / ONE / ONE, 99_499, 1);
    }

    /// Example 2: the hedge side only covers half → long 2x gets 1.5x; with nobody against it, it is just the stock.
    function test_example2_partialFill() public {
        uint256 d1 = dep(alice, LONG2, 1_000 * ONE);
        dep(bob, HEDGE, 500 * ONE);
        close(d1, P100);
        claim(alice, d1, LONG2);
        claim(bob, d1, HEDGE);
        assertEq(perp.fillBps(LONG2), 5_000);
        assertEq(perp.fillBps(HEDGE), 10_000);
        assertEq(perp.effectiveLeverageBps(LONG2), 15_000);
        assertEq(perp.effectiveLeverageBps(HEDGE), 0);

        close(2, 105e8);
        assertApproxEqAbs(worth(alice, LONG2, 105e8), 107_500, 1);
        assertApproxEqAbs(worth(bob, HEDGE, 105e8), 50_000, 1);
    }

    function test_example2_nobodyAgainst_isJustTheStock() public {
        uint256 d1 = dep(alice, LONG2, 1_000 * ONE);
        close(d1, P100);
        claim(alice, d1, LONG2);
        assertEq(perp.effectiveLeverageBps(LONG2), 10_000);
        close(2, 105e8);
        assertEq(worth(alice, LONG2, 105e8), 105_000);
    }

    /// Example 3b: $100 long 2x vs $10,000 hedge, +10 %: the long gets +20 % and, being the thin side, also
    /// collects funding at 0.098 %/day of the matched $100.
    function test_example3b_extremeImbalance_andFunding() public {
        perp = deploy(0, 10); // 0.1 %/day funding cap
        uint256 d1 = dep(alice, LONG2, 1 * ONE); // $100
        dep(bob, HEDGE, 100 * ONE); // $10,000
        close(d1, P100);
        claim(alice, d1, LONG2);
        claim(bob, d1, HEDGE);
        assertEq(perp.fundingRateBps(), -9); // shorts pay: 10 × (1 − 100)/101 = −9.8 bps → −9 (truncated)

        uint256 aliceTok0 = perp.sharesToTokens(LONG2, perp.sharesOf(alice, LONG2));
        close(2, 110e8);
        uint256 aliceTok = perp.sharesToTokens(LONG2, perp.sharesOf(alice, LONG2));
        // price part: 1 token × 10/110; funding: 0.098 % of the matched 1 token × 100/110
        uint256 priceGain = ONE * 10 / 110;
        uint256 fundingGain = uint256(10) * (99 * ONE) * ONE * P100 / (10_000 * (101 * ONE) * 110e8);
        assertApproxEqAbs(aliceTok - aliceTok0, priceGain + fundingGain, 2);
        assertEq(worth(alice, LONG2, 110e8), 120); // $100 → $120 (+ $0.098 funding)
        assertEq(worth(bob, HEDGE, 110e8), 10_989); // $10,990 − $0.098: only 1 % of the hedge was hedged
    }

    /// Short 1x below 50 % fill and short 2x below 33 % fill are net LONG; the view says so.
    function test_effectiveLeverage_shortTiersFlipToLong() public {
        uint256 d1 = dep(alice, LONG2, 100 * ONE);
        dep(bob, SHORT1, 1_000 * ONE); // short exposure 2,000 vs long 100 → fill 5 %
        close(d1, P100);
        assertEq(perp.fillBps(SHORT1), 500);
        assertEq(perp.effectiveLeverageBps(SHORT1), 9_000); // 1 − 2 × 5 % = +0.9x: net long
    }

    // ------------------------------------------------------------------- fees

    function test_fees_becomeTreasuryHedgeShares_treasuryPaysNone() public {
        perp = deploy(10, 0); // 0.1 %
        uint256 d1 = dep(alice, LONG2, 1_000 * ONE);
        dep(treasury, HEDGE, 1 * ONE);
        close(d1, P100);
        (uint256 sh,) = claim(alice, d1, LONG2);
        assertEq(perp.sharesToTokens(LONG2, sh), 999 * ONE); // 0.1 % taken
        claim(treasury, d1, HEDGE);
        // treasury: its own 1 token (fee-free) + the 1-token fee, both in the hedge tier
        assertEq(perp.sharesToTokens(HEDGE, perp.sharesOf(treasury, HEDGE)), 2 * ONE);

        uint256 d2 = red(alice, LONG2, sh);
        close(d2, P100);
        (, uint256 tok) = claim(alice, d2, LONG2);
        // 999 tokens out, minus 0.1 % → 998.001; exposure was 1:1 at 999 vs 1 → no price move, no funding
        assertEq(tok, 999 * ONE - 999 * ONE / 1_000);
        assertApproxEqAbs(perp.sharesToTokens(HEDGE, perp.sharesOf(treasury, HEDGE)), 2 * ONE + 999 * ONE / 1_000, 1);
    }

    // --------------------------------------------------------------- calendar

    function test_requestBeforeCutoffIsToday_afterIsNextDay() public {
        assertEq(dep(alice, LONG2, ONE), 1);
        vm.warp(T0 + 1 days - 1);
        assertEq(dep(alice, LONG2, ONE), 1);
        vm.warp(T0 + 1 days); // exactly the cutoff → next day
        assertEq(dep(alice, LONG2, ONE), 2);
        vm.warp(T0 + 31 days); // nothing scheduled that far
        vm.prank(alice);
        vm.expectRevert(SharePotPerp.NoOpenDay.selector);
        perp.requestDeposit(LONG2, ONE);
    }

    function test_scheduleMustIncrease() public {
        uint64[] memory c = new uint64[](1);
        c[0] = T0 + 30 days; // equal to the last one
        vm.prank(operator);
        vm.expectRevert(SharePotPerp.BadCutoff.selector);
        perp.schedule(c);
        vm.prank(alice);
        vm.expectRevert(SharePotPerp.NotOperator.selector);
        perp.schedule(c);
    }

    function test_proposeRules() public {
        vm.prank(operator);
        vm.expectRevert(SharePotPerp.TooEarly.selector);
        perp.propose(1, P100, bytes32(0));
        vm.warp(T0 + 1 days);
        vm.prank(operator);
        vm.expectRevert(SharePotPerp.OutOfOrder.selector);
        perp.propose(2, P100, bytes32(0));
        vm.prank(alice);
        vm.expectRevert(SharePotPerp.NotOperator.selector);
        perp.propose(1, P100, bytes32(0));
    }

    function test_disputeWindow_rejectAndAdminSettle() public {
        uint256 d1 = dep(alice, LONG2, 10 * ONE);
        vm.warp(T0 + 1 days);
        vm.prank(operator);
        perp.propose(d1, 1e8, bytes32("wrong"));
        vm.expectRevert(SharePotPerp.InDisputeWindow.selector);
        vm.prank(bob);
        perp.settle(d1);
        perp.reject(d1); // admin
        vm.prank(operator);
        perp.propose(d1, P100, bytes32("right"));
        perp.settle(d1); // admin, inside the window
        assertEq(perp.lastValue(), P100);
        (uint256 sh,) = claim(alice, d1, LONG2);
        assertGt(sh, 0);
    }

    /// A day without a usable close moves nothing; its requests are filled the next day, and that day is compared
    /// with the last good close.
    function test_skip_rollsRequests_andComparesWithLastGoodClose() public {
        uint256 d1 = dep(alice, LONG2, 1_000 * ONE);
        dep(bob, HEDGE, 1_000 * ONE);
        close(d1, P100);
        claim(alice, d1, LONG2);
        claim(bob, d1, HEDGE);

        uint256 d2 = dep(carol, HEDGE, 500 * ONE);
        assertEq(d2, 2);
        vm.warp(T0 + 2 days);
        vm.prank(operator);
        perp.skip(2);
        assertEq(perp.sharesOf(carol, HEDGE), 0); // still waiting: rolled to day 3
        (uint256[] memory ds, uint256[] memory amts) = perp.pendingEntries(carol, HEDGE);
        assertEq(ds.length, 1);
        assertEq(ds[0], 2);
        assertEq(amts[0], 500 * ONE);

        close(3, 110e8); // +10 % against day 1, carol not yet in
        assertApproxEqAbs(worth(alice, LONG2, 110e8), 120_000, 1);
        // filled at day 3's close, already hers without any claim
        assertApproxEqAbs(perp.sharesToTokens(HEDGE, perp.sharesOf(carol, HEDGE)), 500 * ONE, 1);
    }

    // ------------------------------------------------------------------ wipe

    /// A single close beyond the zero line takes the tier to 0, never below. Old shares are void, a queued exit of
    /// the old generation gets nothing, and newcomers start a fresh generation at a fair price.
    function test_wipe_capsLoss_voidsOldShares_freshGeneration() public {
        uint256 d1 = dep(alice, LONG2, 100 * ONE);
        dep(bob, HEDGE, 100 * ONE);
        close(d1, P100);
        claim(alice, d1, LONG2);
        claim(bob, d1, HEDGE);

        uint256 aliceSh = perp.sharesOf(alice, LONG2);
        uint256 d2 = red(alice, LONG2, aliceSh / 2); // queued for day 2's close
        assertEq(d2, 2);
        close(2, 49e8); // −51 %: long 2x loses 102 % → capped at 100 %
        SharePotPerp.Tier memory t = perp.tierInfo(LONG2);
        assertEq(t.held, 0);
        assertEq(t.gen, 1);
        assertEq(perp.sharesOf(alice, LONG2), 0);
        (, uint256 tok) = claim(alice, d2, LONG2);
        assertEq(tok, 0);
        assertEq(perp.sharesToTokens(HEDGE, perp.sharesOf(bob, HEDGE)), 200 * ONE); // got all of it

        uint256 d3 = dep(carol, LONG2, 10 * ONE);
        close(d3, 49e8);
        (uint256 sh,) = claim(carol, d3, LONG2);
        assertEq(perp.sharesToTokens(LONG2, sh), 10 * ONE);
        vm.prank(alice);
        vm.expectRevert(SharePotPerp.InsufficientShares.selector);
        perp.requestRedeem(LONG2, 1);
    }

    /// A stolen operator key cannot push a close more than 50 % away from the last one; the admin can.
    function test_operatorMoveCap_adminOverrides() public {
        uint256 d1 = dep(alice, LONG2, ONE);
        close(d1, P100);
        vm.warp(T0 + 2 days);
        vm.prank(operator);
        vm.expectRevert(SharePotPerp.MoveTooLarge.selector);
        perp.propose(2, 49e8, bytes32(0)); // −51 %
        vm.prank(operator);
        vm.expectRevert(SharePotPerp.MoveTooLarge.selector);
        perp.propose(2, 151e8, bytes32(0)); // +51 %
        vm.prank(operator);
        perp.propose(2, 50e8, bytes32(0)); // exactly −50 % is allowed
        perp.reject(2);
        perp.propose(2, 10e8, bytes32(0)); // admin: −90 %
        vm.expectRevert(SharePotPerp.NotAdmin.selector);
        vm.prank(operator);
        perp.setMaxMove(10_000);
    }

    /// A tier ground down to crumbs (share value below a billionth of its start) is wiped like one at zero, so share
    /// counts cannot keep inflating; its crumbs go to dust and the books still balance.
    function test_dustWipe_boundsShareInflation() public {
        uint256 d1 = dep(alice, LONG2, 100 * ONE);
        dep(bob, HEDGE, 100 * ONE);
        close(d1, P100);
        claim(alice, d1, LONG2);
        claim(bob, d1, HEDGE);
        close(2, 50e8 + 1); // −49.99999999 %: long 2x keeps a few raw units, not zero
        SharePotPerp.Tier memory t = perp.tierInfo(LONG2);
        assertEq(t.held, 0);
        assertEq(t.gen, 1);
        assertGt(perp.dust(), 0);
        assertEq(perp.sharesOf(alice, LONG2), 0);
        uint256 held = perp.tierInfo(HEDGE).held;
        assertGe(nvda.balanceOf(address(perp)), held + perp.dust());
    }

    /// An entry is the user's position as soon as its close settles: no claim, no transaction. An exit waits for the
    /// user to withdraw it; nothing is paid on their behalf.
    function test_entriesBookThemselves_exitsAreWithdrawnByTheUser() public {
        uint256 d1 = dep(alice, LONG2, 100 * ONE);
        dep(bob, HEDGE, 100 * ONE);
        assertEq(perp.sharesOf(alice, LONG2), 0); // before the close: pending
        close(d1, P100);
        uint256 sh = perp.sharesOf(alice, LONG2);
        assertEq(perp.sharesToTokens(LONG2, sh), 100 * ONE); // hers, with no claim

        uint256 d2 = red(alice, LONG2, sh); // works straight away: the request books the entry first
        assertEq(perp.sharesOf(alice, LONG2), 0);
        (uint256[] memory ds,) = perp.pendingEntries(alice, LONG2);
        assertEq(ds.length, 0);
        uint256 before = nvda.balanceOf(alice);
        close(d2, 105e8);
        assertEq(nvda.balanceOf(alice), before); // filled, but sits in the contract until she withdraws
        vm.prank(alice);
        (, uint256 tok) = perp.claim(alice, d2, LONG2);
        assertEq(nvda.balanceOf(alice) - before, tok);
        assertApproxEqAbs(tok * 105e8 / ONE / ONE, 11_000, 1); // $10,000 → $11,000 at 2x on +5 %
        vm.expectRevert(SharePotPerp.NothingToClaim.selector);
        perp.claim(alice, d2, LONG2);
        // bob's entry was never claimed and is still all there
        assertApproxEqAbs(worth(bob, HEDGE, 105e8), 10_000, 1);
    }

    /// Entries waiting for a close are capped per user and tier (each request books the filled ones first, so only
    /// unsettled days count).
    function test_tooManyPendingEntries() public {
        for (uint256 i = 0; i < 8; i++) {
            vm.warp(T0 + i * 1 days); // a new day each time, none of them settled
            dep(alice, LONG2, ONE);
        }
        vm.warp(T0 + 8 days);
        vm.prank(alice);
        vm.expectRevert(SharePotPerp.TooManyPending.selector);
        perp.requestDeposit(LONG2, ONE);
        vm.prank(alice);
        perp.requestDeposit(HEDGE, ONE); // another tier has its own list
    }

    function test_cannotClaimTwice_orUnknown() public {
        uint256 d1 = dep(alice, LONG2, ONE);
        close(d1, P100);
        claim(alice, d1, LONG2);
        vm.expectRevert(SharePotPerp.NothingToClaim.selector);
        perp.claim(alice, d1, LONG2);
        vm.expectRevert(SharePotPerp.NothingToClaim.selector);
        perp.claim(bob, d1, LONG2);
    }

    function test_pause_blocksRequestsOnly() public {
        uint256 d1 = dep(alice, LONG2, ONE);
        perp.setPaused(true);
        vm.prank(alice);
        vm.expectRevert(SharePotPerp.IsPaused.selector);
        perp.requestDeposit(LONG2, ONE);
        close(d1, P100); // settlement still runs
        claim(alice, d1, LONG2);
    }

    // ------------------------------------------------------------ solvency

    /// Random entries, exits and closes (including a wipe-sized move now and then) for 3 users over 25 days, then
    /// everyone leaves. Every claim must succeed and the pool must never pay out more than it took in.
    function testFuzz_neverPaysOutMoreThanItHolds(uint256 seed) public {
        perp = deploy(10, 10);
        address[3] memory users = [alice, bob, carol];
        uint256 value = P100;
        uint256 startBal;
        for (uint256 u = 0; u < 3; u++) startBal += nvda.balanceOf(users[u]);
        for (uint256 day = 1; day <= 24; day++) {
            for (uint256 u = 0; u < 3; u++) {
                uint256 r = uint256(keccak256(abi.encode(seed, day, u)));
                uint8 tier = uint8(r % 4);
                if ((r >> 8) % 3 != 0) {
                    dep(users[u], tier, 1 + (r >> 16) % (5_000 * ONE));
                } else {
                    uint256 have = perp.sharesOf(users[u], tier);
                    if (have != 0) red(users[u], tier, 1 + (r >> 24) % have);
                }
            }
            uint256 mv = uint256(keccak256(abi.encode(seed, day, "move")));
            // mostly ±0–8 %, sometimes −60 % / +60 % to force wipes
            if (mv % 17 == 0) value = value * 40 / 100;
            else if (mv % 19 == 0) value = value * 160 / 100;
            else if (mv % 2 == 0) value = value * (10_000 + mv % 800) / 10_000;
            else value = value * (10_000 - mv % 800) / 10_000;
            if (value == 0) value = 1;
            close(day, value);
            for (uint256 u = 0; u < 3; u++) {
                for (uint8 t = 0; t < 4; t++) {
                    (,,,, bool used) = perp.requests(users[u], day, t);
                    if (used) claim(users[u], day, t);
                }
            }
            _assertBacked();
        }
        // everyone (treasury too) exits everything on day 25
        address[4] memory all = [alice, bob, carol, treasury];
        for (uint256 u = 0; u < 4; u++) {
            for (uint8 t = 0; t < 4; t++) {
                uint256 have = perp.sharesOf(all[u], t);
                if (have != 0) red(all[u], t, have);
            }
        }
        close(25, value);
        for (uint256 u = 0; u < 4; u++) {
            for (uint8 t = 0; t < 4; t++) {
                (,,,, bool used) = perp.requests(all[u], 25, t);
                if (used) claim(all[u], 25, t);
            }
        }
        // fees taken on the way out land back in the hedge as treasury shares; what remains is backed
        _assertBacked();
        uint256 endBal;
        for (uint256 u = 0; u < 3; u++) endBal += nvda.balanceOf(users[u]);
        assertLe(endBal, startBal + 0); // users as a group can never get back more than they put in
    }

    /// Tokens in the contract cover every tier's holdings plus the dust.
    function _assertBacked() internal view {
        uint256 held;
        for (uint8 t = 0; t < 4; t++) held += perp.tierInfo(t).held;
        assertGe(nvda.balanceOf(address(perp)), held + perp.dust());
    }

    // --------------------------------------------------------------- reentrancy

    /// The stock token is a third-party, issuer-controlled contract. If it called back into the pool while moving
    /// tokens, the balance-delta crediting in `_pull` would count the inner deposit twice and the pool would book
    /// more tokens than it holds. The latch must reject the inner call and leave the outer one exact.
    function test_reentrantTokenCannotDoubleCredit() public {
        ReenterStock evil = new ReenterStock();
        uint8[] memory cs = new uint8[](4);
        bool[] memory longs = new bool[](4);
        cs[0] = 1; longs[0] = true;
        cs[1] = 1;
        cs[2] = 2;
        cs[3] = 3;
        SharePotPerp p = new SharePotPerp(address(evil), admin, operator, guardian, treasury, 0, 0, DISPUTE, cs, longs, HEDGE);
        evil.setPerp(p);
        evil.mint(alice, 1_000_000 * ONE);
        evil.mint(address(evil), 1_000_000 * ONE);
        evil.selfApprove(address(p));
        vm.prank(alice);
        evil.approve(address(p), type(uint256).max);
        uint64[] memory cutoffs = new uint64[](3);
        for (uint256 i = 0; i < 3; i++) cutoffs[i] = uint64(T0 + (i + 1) * 1 days);
        vm.prank(operator);
        p.schedule(cutoffs);

        evil.arm(LONG2, 1_000);
        vm.prank(alice);
        uint256 day = p.requestDeposit(LONG2, 100 * ONE);

        assertTrue(evil.reenterReverted(), "the inner deposit must be rejected");
        assertFalse(evil.reenterSucceeded(), "the inner deposit must not be booked");
        // exactly what alice sent is booked, and the pool holds exactly that
        assertEq(p.batch(day, LONG2, 0).depIn, 100 * ONE);
        assertEq(evil.balanceOf(address(p)), 100 * ONE);
    }

    // ------------------------------------------------ weekly audit 2026-11-17

    /// The test token is free to mint: 2^115 units in both sides made `x * num` overflow, so `settle` reverted on
    /// every later day and every position froze. Deposits now stop at MAX_POOL.
    function test_poolCap_refusesAHugeDeposit_andWithdrawalsFreeRoom() public {
        address mallory = makeAddr("mallory");
        nvda.mint(mallory, 2 ** 116);
        vm.prank(mallory);
        nvda.approve(address(perp), type(uint256).max);
        vm.prank(mallory);
        vm.expectRevert(SharePotPerp.PoolFull.selector);
        perp.requestDeposit(LONG2, 2 ** 115);

        uint256 d1 = dep(bob, HEDGE, 100 * ONE);
        uint256 room = perp.MAX_POOL() - perp.pooled();
        vm.prank(mallory);
        perp.requestDeposit(LONG2, room); // exactly full is allowed
        vm.prank(alice);
        vm.expectRevert(SharePotPerp.PoolFull.selector);
        perp.requestDeposit(HEDGE, 1);

        close(d1, P100);
        (uint256 sh,) = claim(bob, d1, HEDGE);
        uint256 d2 = red(bob, HEDGE, sh);
        close(d2, P100);
        (, uint256 tok) = claim(bob, d2, HEDGE);
        assertEq(tok, 100 * ONE);
        assertEq(perp.pooled(), perp.MAX_POOL() - 100 * ONE); // the withdrawal freed its room
        dep(alice, HEDGE, 100 * ONE);
    }

    /// Holdings near MAX_POOL, values near MAX_VALUE, ±50 % days and the top funding rate: every day still settles
    /// (the old one-step products overflowed here) and the pool stays backed.
    function test_nearCapHoldings_atHugeValues_withFunding_stillSettle() public {
        perp = deploy(0, 100);
        address w1 = makeAddr("whale1");
        address w2 = makeAddr("whale2");
        nvda.mint(w1, 6e26);
        nvda.mint(w2, 39e25);
        vm.prank(w1);
        nvda.approve(address(perp), type(uint256).max);
        vm.prank(w2);
        nvda.approve(address(perp), type(uint256).max);
        vm.prank(w1);
        uint256 d1 = perp.requestDeposit(LONG2, 6e26);
        vm.prank(w2);
        perp.requestDeposit(SHORT2, 39e25);
        close(d1, 6e35);
        close(2, 9e35); // +50 %
        _assertBacked();
        close(3, 45e34); // −50 %
        _assertBacked();
        (uint256 sh,) = claim(w1, d1, LONG2);
        uint256 before = perp.pooled();
        vm.prank(w1);
        uint256 d4 = perp.requestRedeem(LONG2, sh);
        close(d4, 45e34);
        (, uint256 tok) = claim(w1, d4, LONG2);
        assertGt(tok, 0);
        assertEq(perp.pooled(), before - tok);
        _assertBacked();
    }

    function test_valueCap_evenForTheAdmin() public {
        dep(alice, LONG2, ONE);
        vm.warp(T0 + 1 days);
        uint256 maxV = perp.MAX_VALUE();
        vm.expectRevert(SharePotPerp.ValueOutOfRange.selector);
        perp.propose(1, maxV + 1, bytes32(0));
        perp.propose(1, maxV, bytes32(0));
    }

    /// A day scheduled years ahead took every later request and could never be proposed or skipped: cutoffs now stay
    /// within 30 days, and the admin can move a day that has not closed yet.
    function test_scheduleHorizon_andAdminReschedule() public {
        uint64[] memory c = new uint64[](1);
        c[0] = uint64(block.timestamp) * 1000; // milliseconds passed as seconds
        vm.prank(operator);
        vm.expectRevert(SharePotPerp.BadCutoff.selector);
        perp.schedule(c);
        c[0] = T0 + 30 days + 1; // one second past the horizon
        vm.prank(operator);
        vm.expectRevert(SharePotPerp.BadCutoff.selector);
        perp.schedule(c);

        vm.warp(T0 + 1 days + 1); // day 1 has closed
        c[0] = T0 + 31 days;
        vm.prank(operator);
        perp.schedule(c); // day 31, right at the horizon
        perp.reschedule(31, T0 + 30 days + 1 hours);
        (uint64 cut,,,,,) = perp.epochs(31);
        assertEq(cut, T0 + 30 days + 1 hours);
        vm.expectRevert(SharePotPerp.BadCutoff.selector);
        perp.reschedule(31, T0 + 30 days); // not after day 30
        vm.expectRevert(SharePotPerp.BadCutoff.selector);
        perp.reschedule(5, T0 + 6 days); // not before day 6
        vm.expectRevert(SharePotPerp.BadCutoff.selector);
        perp.reschedule(5, uint64(block.timestamp)); // must still be ahead
        vm.expectRevert(SharePotPerp.BadState.selector);
        perp.reschedule(1, T0 + 1 days + 2 hours); // day 1 has closed
        vm.expectRevert(SharePotPerp.BadState.selector);
        perp.reschedule(32, T0 + 30 days + 2 hours); // not scheduled
        vm.prank(operator);
        vm.expectRevert(SharePotPerp.NotAdmin.selector);
        perp.reschedule(31, T0 + 30 days + 2 hours);

        // a request belongs to its day by number: moving the cutoff keeps it there, and later ones go to the next day
        assertEq(dep(alice, LONG2, ONE), 2);
        perp.reschedule(2, T0 + 1 days + 2 hours);
        vm.warp(T0 + 1 days + 2 hours);
        assertEq(dep(alice, LONG2, ONE), 3);
        (uint256[] memory ds,) = perp.pendingEntries(alice, LONG2);
        assertEq(ds.length, 2);
    }

    /// Skipping after the next close (or a proposed day) let whoever skips choose between settling and skipping
    /// with the next close known.
    function test_skip_onlyUnproposed_andBeforeTheNextCutoff() public {
        dep(alice, LONG2, 100 * ONE);
        dep(bob, HEDGE, 100 * ONE);
        vm.warp(T0 + 1 days);
        vm.prank(operator);
        perp.propose(1, P100, bytes32(0));
        vm.prank(operator);
        vm.expectRevert(SharePotPerp.BadState.selector);
        perp.skip(1); // reject first
        perp.reject(1);
        vm.prank(operator);
        perp.skip(1);

        vm.warp(T0 + 3 days); // day 3 has closed as well
        vm.prank(operator);
        vm.expectRevert(SharePotPerp.TooLate.selector);
        perp.skip(2);
        close(2, P100); // a day that cannot be skipped any more is proposed
        assertEq(perp.lastSettled(), 2);
    }

    /// Claims follow skipped days at most MAX_ROLL (64) steps: 64 skips in a row stranded the first day's entries.
    function test_skipRun_staysBelowMaxRoll_soEntriesStillResolve() public {
        uint256 d1 = dep(alice, LONG2, 100 * ONE);
        dep(bob, HEDGE, 100 * ONE);
        uint64[] memory one = new uint64[](1);
        uint256 d = 1;
        for (;; d++) {
            if (perp.lastScheduled() <= d) {
                (uint64 last,,,,,) = perp.epochs(perp.lastScheduled());
                one[0] = last + 1 days;
                vm.prank(operator);
                perp.schedule(one);
            }
            (uint64 cut,,,,,) = perp.epochs(d);
            vm.warp(cut);
            if (perp.skipRun() == 63) break;
            vm.prank(operator);
            perp.skip(d);
        }
        assertEq(d, 64);
        vm.prank(operator);
        vm.expectRevert(SharePotPerp.TooManySkips.selector);
        perp.skip(d);
        close(d, P100);
        assertEq(perp.skipRun(), 0);
        (uint256 sh,) = claim(alice, d1, LONG2); // day 1's entry followed 63 skips to day 64
        assertEq(perp.sharesToTokens(LONG2, sh), 100 * ONE);
    }

    /// The independent checker holds a key that can throw a proposal out and nothing else.
    function test_guardian_canOnlyReject() public {
        dep(alice, LONG2, ONE);
        vm.warp(T0 + 1 days);
        vm.prank(operator);
        perp.propose(1, P100, bytes32(0));
        vm.prank(alice);
        vm.expectRevert(SharePotPerp.NotGuardian.selector);
        perp.reject(1);
        vm.prank(operator);
        vm.expectRevert(SharePotPerp.NotGuardian.selector);
        perp.reject(1);
        vm.prank(guardian);
        perp.reject(1);

        vm.startPrank(guardian);
        vm.expectRevert(SharePotPerp.NotOperator.selector);
        perp.propose(1, P100, bytes32(0));
        vm.expectRevert(SharePotPerp.NotOperator.selector);
        perp.skip(1);
        vm.expectRevert(SharePotPerp.NotOperator.selector);
        perp.schedule(new uint64[](0));
        vm.expectRevert(SharePotPerp.NotAdmin.selector);
        perp.setRates(0, 0);
        vm.expectRevert(SharePotPerp.NotAdmin.selector);
        perp.setGuardian(alice);
        vm.expectRevert(SharePotPerp.NotAdmin.selector);
        perp.reschedule(2, T0 + 1 days + 1 hours);
        vm.stopPrank();

        vm.prank(operator);
        perp.propose(1, P100, bytes32(0));
        vm.prank(guardian);
        vm.expectRevert(SharePotPerp.InDisputeWindow.selector);
        perp.settle(1); // only the admin settles early
        perp.setGuardian(address(0));
        vm.prank(guardian);
        vm.expectRevert(SharePotPerp.NotGuardian.selector);
        perp.reject(1);
    }

    function test_mockStockMintCap() public {
        nvda.mint(alice, 2 ** 200); // no cap by default (the Robinhood tests mint freely)
        nvda.setMintCap(10_000 * ONE);
        nvda.mint(alice, 10_000 * ONE);
        vm.expectRevert(MockStock.MintTooLarge.selector);
        nvda.mint(alice, 10_000 * ONE + 1);
        vm.prank(alice);
        vm.expectRevert(MockStock.NotOwner.selector);
        nvda.setMintCap(0);
    }

    // ------------------------------------------------------------- cancel

    function cancel(address who, uint8 tier, uint256 amt) internal returns (uint256 refund) {
        vm.prank(who);
        refund = perp.cancelDeposit(tier, amt);
    }

    /// Taken back before the bell: all but the entry fee comes back at once; the fee becomes the treasury's hedge
    /// shares at that close, like every fee; the pool still holds exactly what it accounts for.
    function test_cancel_beforeTheBell_refundsAllButTheFee() public {
        perp = deploy(10, 0); // 0.1 %
        uint256 d1 = dep(alice, LONG2, 1_000 * ONE);
        dep(bob, HEDGE, 500 * ONE);
        uint256 before = nvda.balanceOf(alice);
        assertEq(cancel(alice, LONG2, 0), 999 * ONE);
        assertEq(nvda.balanceOf(alice) - before, 999 * ONE);
        (uint256[] memory ds,) = perp.pendingEntries(alice, LONG2);
        assertEq(ds.length, 0);
        assertEq(perp.cancelFees(d1), 1 * ONE);
        assertEq(perp.pooled(), 501 * ONE);
        close(d1, P100);
        assertEq(perp.sharesOf(alice, LONG2), 0);
        // the treasury: bob's entry fee (0.5) and alice's kept fee (1.0), as hedge shares
        assertEq(perp.sharesToTokens(HEDGE, perp.sharesOf(treasury, HEDGE)), 15 * ONE / 10);
        assertEq(perp.tierInfo(HEDGE).held, 501 * ONE);
        assertEq(nvda.balanceOf(address(perp)), 501 * ONE);
    }

    function test_cancel_partial_keepsTheRestQueued() public {
        perp = deploy(10, 0);
        uint256 d1 = dep(alice, LONG2, 1_000 * ONE);
        dep(bob, HEDGE, 1_000 * ONE);
        assertEq(cancel(alice, LONG2, 400 * ONE), 3996 * ONE / 10);
        (uint256[] memory ds, uint256[] memory amts) = perp.pendingEntries(alice, LONG2);
        assertEq(ds.length, 1);
        assertEq(amts[0], 600 * ONE);
        close(d1, P100);
        assertEq(perp.sharesToTokens(LONG2, perp.sharesOf(alice, LONG2)), 5994 * ONE / 10); // 600 less its 0.1 %
    }

    /// A full cancel and a new entry the same day count once: the day is on the pending list once (cancel takes it
    /// off at once; requestDeposit's own booking would also clear an emptied day before pushing it again).
    function test_cancel_thenEnterAgainTheSameDay_countsOnce() public {
        uint256 d1 = dep(alice, LONG2, 1_000 * ONE);
        dep(bob, HEDGE, 1_000 * ONE);
        cancel(alice, LONG2, 0);
        assertEq(dep(alice, LONG2, 300 * ONE), d1);
        (uint256[] memory ds,) = perp.pendingEntries(alice, LONG2);
        assertEq(ds.length, 1);
        close(d1, P100);
        assertEq(perp.sharesToTokens(LONG2, perp.sharesOf(alice, LONG2)), 300 * ONE);
        claim(alice, d1, LONG2);
        assertEq(perp.sharesToTokens(LONG2, perp.sharesOf(alice, LONG2)), 300 * ONE);
        assertEq(perp.tierInfo(LONG2).held, 300 * ONE);
    }

    /// After the bell the close is known: nothing can be taken back (the request now belongs to a day past its cutoff).
    function test_cancel_afterTheBell_isRefused() public {
        uint256 d1 = dep(alice, LONG2, 1_000 * ONE);
        (uint64 cutoff,,,,,) = perp.epochs(d1);
        vm.warp(cutoff);
        vm.prank(alice);
        vm.expectRevert(SharePotPerp.NothingToCancel.selector);
        perp.cancelDeposit(LONG2, 0);
        vm.prank(operator);
        perp.propose(d1, P100, bytes32(0));
        vm.prank(alice);
        vm.expectRevert(SharePotPerp.NothingToCancel.selector);
        perp.cancelDeposit(LONG2, 0);
    }

    function test_cancel_refusesNothingAndTooMuch() public {
        vm.prank(alice);
        vm.expectRevert(SharePotPerp.NothingToCancel.selector);
        perp.cancelDeposit(LONG2, 0);
        dep(alice, LONG2, 100 * ONE);
        vm.prank(alice);
        vm.expectRevert(SharePotPerp.NothingToCancel.selector);
        perp.cancelDeposit(LONG2, 100 * ONE + 1);
        vm.prank(bob); // someone else's entry is not yours to take back
        vm.expectRevert(SharePotPerp.NothingToCancel.selector);
        perp.cancelDeposit(LONG2, 0);
    }

    function test_cancel_byTheTreasury_paysNoFee() public {
        perp = deploy(10, 0);
        dep(treasury, HEDGE, 100 * ONE);
        assertEq(cancel(treasury, HEDGE, 0), 100 * ONE);
        assertEq(perp.pooled(), 0);
    }

    /// A kept fee follows a skipped day to the close that is actually settled.
    function test_cancel_feeRollsOverASkippedDay() public {
        perp = deploy(10, 0);
        uint256 d1 = dep(alice, LONG2, 1_000 * ONE);
        cancel(alice, LONG2, 0);
        (uint64 cutoff,,,,,) = perp.epochs(d1);
        vm.warp(cutoff);
        vm.prank(operator);
        perp.skip(d1);
        assertEq(perp.cancelFees(d1), 0);
        assertEq(perp.cancelFees(d1 + 1), 1 * ONE);
        close(d1 + 1, P100);
        assertEq(perp.sharesToTokens(HEDGE, perp.sharesOf(treasury, HEDGE)), 1 * ONE);
        assertEq(nvda.balanceOf(address(perp)), 1 * ONE);
    }

    /// Paused stops new requests, not taking back your own unpriced entry.
    function test_cancel_worksWhilePaused() public {
        dep(alice, LONG2, 100 * ONE);
        perp.setPaused(true);
        assertEq(cancel(alice, LONG2, 0), 100 * ONE);
    }
}

/// A stock token that calls back into the pool while it is moving tokens, as an issuer-upgradeable token could.
contract ReenterStock {
    string public name = "Reentrant xStock";
    string public symbol = "REc";
    uint8 public decimals = 8;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    SharePotPerp public perp;
    uint8 public armedTier;
    uint256 public armedAmount;
    bool public armed;
    bool public reenterReverted;
    bool public reenterSucceeded;

    function setPerp(SharePotPerp p) external {
        perp = p;
    }

    function arm(uint8 tier, uint256 amount) external {
        armed = true;
        armedTier = tier;
        armedAmount = amount;
    }

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function selfApprove(address spender) external {
        allowance[address(this)][spender] = type(uint256).max;
    }

    function approve(address spender, uint256 a) external returns (bool) {
        allowance[msg.sender][spender] = a;
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        _move(msg.sender, to, a);
        return true;
    }

    function transferFrom(address from, address to, uint256 a) external returns (bool) {
        if (from != msg.sender) {
            uint256 al = allowance[from][msg.sender];
            require(al >= a, "allowance");
            if (al != type(uint256).max) allowance[from][msg.sender] = al - a;
        }
        _move(from, to, a);
        if (armed) {
            armed = false; // one shot
            try perp.requestDeposit(armedTier, armedAmount) {
                reenterSucceeded = true;
            } catch {
                reenterReverted = true;
            }
        }
        return true;
    }

    function _move(address from, address to, uint256 a) internal {
        require(balanceOf[from] >= a, "balance");
        balanceOf[from] -= a;
        balanceOf[to] += a;
    }
}
