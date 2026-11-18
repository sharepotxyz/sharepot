// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// SharePot Perp — a long/short pool on ONE tokenized stock that is settled once a day at the official close, paid
/// in the stock token itself, and never liquidates anyone.
///
/// * Everyone deposits the stock token (NVDAc on Base). Holding it is already +1x, so a tier only adds an in-pool
///   exposure of `c` times its holdings, long or short. Base launch tiers: long 2x (c=1 long), hedge (c=1 short,
///   value locked), short 1x (c=2 short), short 2x (c=3 short).
/// * Each trading day the token value (close x issuer multiplier) is proposed, waits out a dispute window, and is
///   settled against the previous settled value: the losing side moves tokens to the winning side, but only on the
///   matched part (M = min(long exposure, short exposure)); each side's fill ratio is M / its exposure.
/// * A loser's loss is capped at what its tier holds: a tier can go to zero, never below, and nobody owes anything.
///   Intraday prices never matter, only closes.
/// * Funding: the crowded side pays the thin side fundingBps x imbalance a day, on the matched part only.
/// * Entries and exits are requests that are filled at that day's close (ERC-7540 style): request before the
///   cutoff, the settlement prices it. An entry can be taken back until its cutoff (`cancelDeposit`): the price is the
///   close either way, so backing out before the bell gains nothing; the entry fee is kept all the same. A filled entry is the user's position at once (no claim; it is booked on their
///   next request or claim); a filled exit waits until the user withdraws it with `claim`. Nothing is ever paid out
///   on the user's behalf. Gains, losses and funding all stay in the position and compound. A 0.1 % fee on both
///   entries and exits is turned into hedge-tier shares owned by the treasury. The treasury itself pays no fee.
/// * Each tier is accounted as a pool with shares, so a settlement touches a handful of tiers, never positions.
/// * All rounding is down; remainders stay in the contract (`dust`), so the pool never pays out more than it holds.
///
/// The contract keeps no market calendar: the operator schedules each trading day's cutoff ahead of time, and a
/// day without a valid close is skipped, rolling its requests into the next day. Roles: the operator schedules,
/// proposes and skips; the guardian (an independent checker) can only reject a proposal; the admin can do all of
/// that plus configuration, propose past the daily move cap and settle without waiting. Issuer controls (pause, blocklists)
/// on the stock token apply to this contract like to anyone; a failed transfer simply reverts and can be retried.
interface IERC20Like {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract SharePotPerp {
    uint256 public constant BPS = 10_000;
    uint16 public constant MAX_FEE_BPS = 100; // 1 % ceiling on the entry/exit fee
    uint16 public constant MAX_FUNDING_BPS = 100; // 1 % a day ceiling on the funding rate
    uint256 public constant MAX_TIERS = 5;
    uint8 public constant MAX_C = 3;
    /// Shares minted per raw token unit for the first deposit of a tier (or of a new generation).
    uint256 public constant SHARE_SCALE = 1e10;
    /// A tier whose share value has fallen below a billionth of its starting value is treated as wiped out (its
    /// last crumbs go to `dust`). Without this, a tier ground down to a few raw units again and again would mint
    /// ever larger share counts until the arithmetic overflowed and no day could settle.
    uint256 public constant WIPE_RATIO = SHARE_SCALE * 1e9;
    /// How far a claim follows skipped days.
    uint256 internal constant MAX_ROLL = 64;
    /// Entries of one user in one tier still waiting for their close. Each request books the filled ones first, so
    /// only days not yet settled stay here (normally one or two).
    uint256 public constant MAX_PENDING_ENTRIES = 8;
    /// Ceiling on the tokens the pool accounts for (accepted deposits not yet withdrawn), in raw units, and on a
    /// proposed value (the close in any fixed point; NVDA at 8 decimals is about 1e10). Together they keep every
    /// product in the settlement inside 256 bits (largest: x_i x M <= 9e54, then <= 3e27 x 1e36). No real stock token
    /// comes near 1e27 units (1e19 tokens at 8 decimals); a freely minted test token could, and a settlement that
    /// overflowed would revert every day after, freezing every position (weekly audit 2026-11-17).
    uint256 public constant MAX_POOL = 1e27;
    uint256 public constant MAX_VALUE = 1e36;
    /// How far ahead a cutoff may be scheduled. A day scheduled years out (a stolen operator key, or milliseconds
    /// passed as seconds) would take every later request and could not be proposed or skipped before it.
    uint64 public constant MAX_AHEAD_SECS = 30 days;

    enum EpochState { None, Scheduled, Proposed, Settled, Skipped }

    struct Tier {
        uint8 c; // in-pool exposure multiple
        bool isLong;
        uint32 gen; // bumped when the tier is wiped out; shares of an older generation are worthless
        uint256 held; // raw token units owned by the tier
        uint256 shares; // all current-generation shares, claimed or not, including those queued for exit
    }

    struct Epoch {
        uint64 cutoff; // requests strictly before this time belong to this day
        EpochState state;
        uint64 proposedAt;
        uint256 value; // token value at the close (any fixed point; only ratios are used)
        bytes32 evidence; // hash of the price evidence the value came from
        uint256 rolledTo; // a skipped day's requests were moved here
    }

    /// One per day, tier and bucket (0 = pays fees, 1 = treasury, fee-free).
    struct Batch {
        uint256 depIn; // gross tokens queued to enter
        uint256 sharesOut; // shares minted for them at the close
        uint256 redIn; // shares that exited at the close
        uint256 tokensOut; // tokens owed for them, after the fee
        uint32 gen; // the tier's generation when this batch was filled
    }

    struct Request {
        uint256 dep;
        uint256 red;
        uint32 redGen;
        bool exempt;
        bool used;
    }

    struct Position {
        uint256 shares;
        uint32 gen;
    }

    IERC20Like public immutable token;
    uint8 public immutable hedgeTier;
    address public admin;
    address public operator;
    /// May only throw a proposal out (`reject`): the independent checker's key, so the host that runs the check never
    /// needs the admin's key. Zero = none (the admin can always reject).
    address public guardian;
    address public treasury;
    uint16 public feeBps;
    uint16 public fundingBps;
    uint64 public disputeWindowSecs;
    /// The operator may not propose a close more than this far from the last one; only the admin can. Limits what a
    /// stolen operator key can do inside the dispute window (NVDA's largest daily moves: −35 %, +42 %).
    uint16 public maxMoveBps = 5_000;
    bool public paused;
    /// Reentrancy latch (1 = free, 2 = inside), as in SharePot.sol. The stock token is a third-party,
    /// issuer-controlled contract: a callback during a transfer must not re-enter, or the balance-delta
    /// crediting in `_pull` would count an inner deposit twice.
    uint256 private _entered = 1;

    Tier[] internal _tiers;
    mapping(uint256 => Epoch) public epochs;
    uint256 public lastScheduled;
    /// The last day settled or skipped; days are processed strictly in order.
    uint256 public lastSettled;
    /// Token value at the last settled day; 0 until the first settlement.
    uint256 public lastValue;
    /// First scheduled day whose cutoff may still be ahead (advanced lazily).
    uint256 public openEpoch = 1;
    /// Rounding remainders of price moves and funding; they stay in the contract and back nobody.
    uint256 public dust;
    /// Tokens accepted by `requestDeposit` and not yet withdrawn by `claim` (bounded by MAX_POOL).
    uint256 public pooled;
    /// Entry fees kept from cancelled entries, by the day they were queued for: they become the treasury's hedge
    /// shares at that day's close, like every other fee (a skipped day rolls them into the next).
    mapping(uint256 => uint256) public cancelFees;
    /// Days skipped in a row since the last settlement. Claims follow skipped days at most MAX_ROLL steps, so a run
    /// is kept below that: past it a day must be proposed (an unchanged value moves nothing but funding).
    uint256 public skipRun;

    mapping(uint256 => mapping(uint256 => Batch[2])) internal _batches; // day => tier => bucket
    /// Exit requests are keyed by generation: an exit queued before a wipe must not be paid from the new pool.
    mapping(uint256 => mapping(uint256 => mapping(uint32 => uint256[2]))) internal _redQueued; // day => tier => gen => bucket
    mapping(address => mapping(uint256 => mapping(uint256 => Request))) public requests; // user => day => tier
    mapping(address => mapping(uint256 => Position)) internal _positions; // user => tier
    mapping(address => mapping(uint256 => uint256[])) internal _entryDays; // user => tier => days of unbooked entries

    event Scheduled(uint256 indexed day, uint64 cutoff);
    event Rescheduled(uint256 indexed day, uint64 cutoff);
    event DepositRequested(address indexed user, uint256 indexed day, uint8 indexed tier, uint256 amount);
    event RedeemRequested(address indexed user, uint256 indexed day, uint8 indexed tier, uint256 shares);
    event DepositCancelled(address indexed user, uint256 indexed day, uint8 indexed tier, uint256 amount, uint256 refund);
    event Proposed(uint256 indexed day, uint256 value, bytes32 evidence);
    event Rejected(uint256 indexed day);
    event Skipped(uint256 indexed day, uint256 rolledTo);
    event Settled(
        uint256 indexed day, uint256 value, uint256 prevValue, uint256 longExp, uint256 shortExp, uint256 moved, uint256 funding
    );
    event TierWiped(uint8 indexed tier, uint32 newGen);
    event Claimed(address indexed user, uint256 indexed day, uint8 indexed tier, uint256 shares, uint256 tokens);
    event EntryBooked(address indexed user, uint256 indexed day, uint8 indexed tier, uint256 shares);
    event ConfigChanged();

    error NotAdmin();
    error NotOperator();
    error IsPaused();
    error BadConfig();
    error BadTier();
    error Zero();
    error NoOpenDay();
    error BadCutoff();
    error OutOfOrder();
    error BadState();
    error TooEarly();
    error MoveTooLarge();
    error InDisputeWindow();
    error NotSettled();
    error NothingToClaim();
    error InsufficientShares();
    error BucketMismatch();
    error TooManyPending();
    error TransferFailed();
    error Reentrancy();
    error NotGuardian();
    error PoolFull();
    error ValueOutOfRange();
    error TooLate();
    error TooManySkips();
    error NothingToCancel();

    modifier nonReentrant() {
        if (_entered != 1) revert Reentrancy();
        _entered = 2;
        _;
        _entered = 1;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator && msg.sender != admin) revert NotOperator();
        _;
    }

    modifier onlyGuardian() {
        if (msg.sender != admin && (guardian == address(0) || msg.sender != guardian)) revert NotGuardian();
        _;
    }

    constructor(
        address token_,
        address admin_,
        address operator_,
        address guardian_,
        address treasury_,
        uint16 feeBps_,
        uint16 fundingBps_,
        uint64 disputeWindowSecs_,
        uint8[] memory cs,
        bool[] memory longs,
        uint8 hedgeTier_
    ) {
        if (token_ == address(0) || admin_ == address(0) || operator_ == address(0) || treasury_ == address(0)) {
            revert BadConfig();
        }
        if (feeBps_ > MAX_FEE_BPS || fundingBps_ > MAX_FUNDING_BPS) revert BadConfig();
        uint256 n = cs.length;
        if (n < 2 || n > MAX_TIERS || longs.length != n || hedgeTier_ >= n) revert BadConfig();
        bool anyLong;
        bool anyShort;
        for (uint256 i = 0; i < n; i++) {
            if (cs[i] == 0 || cs[i] > MAX_C) revert BadConfig();
            if (longs[i]) anyLong = true;
            else anyShort = true;
            _tiers.push(Tier({c: cs[i], isLong: longs[i], gen: 0, held: 0, shares: 0}));
        }
        // The hedge tier is the one whose value stays put when fully filled: short, c = 1.
        if (!anyLong || !anyShort || longs[hedgeTier_] || cs[hedgeTier_] != 1) revert BadConfig();
        token = IERC20Like(token_);
        admin = admin_;
        operator = operator_;
        guardian = guardian_;
        treasury = treasury_;
        feeBps = feeBps_;
        fundingBps = fundingBps_;
        disputeWindowSecs = disputeWindowSecs_;
        hedgeTier = hedgeTier_;
    }

    // ------------------------------------------------------------------ admin

    function setOperator(address a) external onlyAdmin {
        if (a == address(0)) revert BadConfig();
        operator = a;
        emit ConfigChanged();
    }

    /// Zero removes the guardian.
    function setGuardian(address a) external onlyAdmin {
        guardian = a;
        emit ConfigChanged();
    }

    function setTreasury(address a) external onlyAdmin {
        if (a == address(0)) revert BadConfig();
        treasury = a;
        emit ConfigChanged();
    }

    function setRates(uint16 feeBps_, uint16 fundingBps_) external onlyAdmin {
        if (feeBps_ > MAX_FEE_BPS || fundingBps_ > MAX_FUNDING_BPS) revert BadConfig();
        feeBps = feeBps_;
        fundingBps = fundingBps_;
        emit ConfigChanged();
    }

    function setMaxMove(uint16 bps) external onlyAdmin {
        if (bps == 0 || bps > BPS) revert BadConfig();
        maxMoveBps = bps;
        emit ConfigChanged();
    }

    function setDisputeWindow(uint64 secs) external onlyAdmin {
        disputeWindowSecs = secs;
        emit ConfigChanged();
    }

    function setPaused(bool p) external onlyAdmin {
        paused = p;
        emit ConfigChanged();
    }

    function transferAdmin(address a) external onlyAdmin {
        if (a == address(0)) revert BadConfig();
        admin = a;
        emit ConfigChanged();
    }

    // ------------------------------------------------------------- calendar

    /// Appends trading days. Cutoffs must be in the future, at most MAX_AHEAD_SECS ahead, and strictly increasing.
    function schedule(uint64[] calldata cutoffs) external onlyOperator {
        uint64 prev = epochs[lastScheduled].cutoff;
        for (uint256 i = 0; i < cutoffs.length; i++) {
            uint64 c = cutoffs[i];
            if (c <= prev || c <= block.timestamp || c > block.timestamp + MAX_AHEAD_SECS) revert BadCutoff();
            uint256 d = ++lastScheduled;
            Epoch storage ep = epochs[d];
            ep.cutoff = c;
            ep.state = EpochState.Scheduled;
            prev = c;
            emit Scheduled(d, c);
        }
    }

    /// Moves the cutoff of a scheduled day that has not reached it yet (a wrong schedule, a close moved by the
    /// exchange). The day keeps its requests; the order of days is kept: after the previous cutoff, before the next.
    function reschedule(uint256 day, uint64 cutoff) external onlyAdmin {
        Epoch storage ep = epochs[day];
        if (day == 0 || day > lastScheduled || ep.state != EpochState.Scheduled || ep.cutoff <= block.timestamp) {
            revert BadState();
        }
        if (cutoff <= block.timestamp || cutoff > block.timestamp + MAX_AHEAD_SECS || cutoff <= epochs[day - 1].cutoff) {
            revert BadCutoff();
        }
        if (day < lastScheduled && cutoff >= epochs[day + 1].cutoff) revert BadCutoff();
        ep.cutoff = cutoff;
        emit Rescheduled(day, cutoff);
    }

    // ------------------------------------------------------------- requests

    /// Queues `amount` tokens to enter `tier` at the next close. Returns the day it will be filled.
    function requestDeposit(uint8 tier, uint256 amount) external nonReentrant returns (uint256 day) {
        if (paused) revert IsPaused();
        if (tier >= _tiers.length) revert BadTier();
        if (amount == 0) revert Zero();
        day = _currentDay();
        _credit(msg.sender, tier);
        uint256 got = _pull(msg.sender, amount);
        if (got == 0) revert Zero();
        pooled += got;
        if (pooled > MAX_POOL) revert PoolFull();
        uint256 b = _bucketFor(msg.sender, day, tier);
        _batches[day][tier][b].depIn += got;
        Request storage r = requests[msg.sender][day][tier];
        if (r.dep == 0) {
            uint256[] storage ds = _entryDays[msg.sender][tier];
            if (ds.length >= MAX_PENDING_ENTRIES) revert TooManyPending();
            ds.push(day);
        }
        r.dep += got;
        emit DepositRequested(msg.sender, day, tier, got);
    }

    /// Takes back `amount` (0 = all) of the caller's entry into `tier` that waits for the next close, before that
    /// close's cutoff: after the bell the close is known, and backing out then would be a free option. The entry fee
    /// (feeBps, none for the treasury) is kept and joins that close's fees; the rest is paid back now. Allowed while
    /// paused: it only returns the caller's own tokens that nothing has priced yet. An entry rolled over from a skipped
    /// day is queued under that day and cannot be taken back. Returns the tokens paid back.
    function cancelDeposit(uint8 tier, uint256 amount) external nonReentrant returns (uint256 refund) {
        if (tier >= _tiers.length) revert BadTier();
        uint256 day = _currentDay();
        Request storage r = requests[msg.sender][day][tier];
        if (r.dep == 0) revert NothingToCancel();
        if (amount == 0) amount = r.dep;
        if (amount > r.dep) revert NothingToCancel();
        uint256 b = r.exempt ? 1 : 0;
        uint256 fee = b == 0 ? amount * feeBps / BPS : 0;
        refund = amount - fee;
        r.dep -= amount;
        _batches[day][tier][b].depIn -= amount;
        cancelFees[day] += fee;
        pooled -= refund;
        if (r.dep == 0) {
            // no longer an entry: off the list `sharesOf` and `_credit` walk (a new entry the same day is pushed again)
            uint256[] storage ds = _entryDays[msg.sender][tier];
            for (uint256 i = 0; i < ds.length; i++) {
                if (ds[i] == day) {
                    ds[i] = ds[ds.length - 1];
                    ds.pop();
                    break;
                }
            }
            if (r.red == 0) delete requests[msg.sender][day][tier];
        }
        emit DepositCancelled(msg.sender, day, tier, amount, refund);
        if (refund != 0 && !_push(msg.sender, refund)) revert TransferFailed();
    }

    /// Queues `shares` of `tier` to exit at the next close; the tokens are withdrawn with `claim` once it settles.
    function requestRedeem(uint8 tier, uint256 shares) external nonReentrant returns (uint256 day) {
        if (paused) revert IsPaused();
        if (tier >= _tiers.length) revert BadTier();
        if (shares == 0) revert Zero();
        _credit(msg.sender, tier);
        Tier storage t = _tiers[tier];
        Position storage p = _positions[msg.sender][tier];
        if (p.gen != t.gen || p.shares < shares) revert InsufficientShares();
        day = _currentDay();
        uint256 b = _bucketFor(msg.sender, day, tier);
        p.shares -= shares;
        Request storage r = requests[msg.sender][day][tier];
        if (r.red != 0 && r.redGen != t.gen) r.red = 0; // queued before a wipe: already worthless
        r.red += shares;
        r.redGen = t.gen;
        _redQueued[day][tier][t.gen][b] += shares;
        emit RedeemRequested(msg.sender, day, tier, shares);
    }

    // ----------------------------------------------------------- settlement

    function propose(uint256 day, uint256 value, bytes32 evidence) external onlyOperator {
        if (day != lastSettled + 1) revert OutOfOrder();
        Epoch storage ep = epochs[day];
        if (ep.state != EpochState.Scheduled) revert BadState();
        if (block.timestamp < ep.cutoff) revert TooEarly();
        if (value == 0) revert Zero();
        if (value > MAX_VALUE) revert ValueOutOfRange();
        uint256 lv = lastValue;
        if (msg.sender != admin && lv != 0) {
            uint256 d = value > lv ? value - lv : lv - value;
            if (d * BPS > lv * maxMoveBps) revert MoveTooLarge();
        }
        ep.state = EpochState.Proposed;
        ep.value = value;
        ep.evidence = evidence;
        ep.proposedAt = uint64(block.timestamp);
        emit Proposed(day, value, evidence);
    }

    /// Dispute: the guardian (or the admin) throws a proposal out; the operator may propose again or skip the day.
    function reject(uint256 day) external onlyGuardian {
        Epoch storage ep = epochs[day];
        if (ep.state != EpochState.Proposed) revert BadState();
        ep.state = EpochState.Scheduled;
        ep.value = 0;
        ep.evidence = bytes32(0);
        ep.proposedAt = 0;
        emit Rejected(day);
    }

    /// A day with no usable close: nothing moves, its requests roll into the next scheduled day, and the next
    /// settlement compares against the last settled value. Only an unproposed day (a proposal must be rejected
    /// first), and only before the next day's cutoff: later, whoever skips would already know the next close and
    /// could choose between settling and skipping after the fact.
    function skip(uint256 day) external onlyOperator {
        if (day != lastSettled + 1) revert OutOfOrder();
        Epoch storage ep = epochs[day];
        if (ep.state != EpochState.Scheduled) revert BadState();
        if (block.timestamp < ep.cutoff) revert TooEarly();
        uint256 next = day + 1;
        if (next > lastScheduled) revert NoOpenDay();
        if (block.timestamp >= epochs[next].cutoff) revert TooLate();
        if (skipRun + 1 >= MAX_ROLL) revert TooManySkips();
        skipRun += 1;
        if (cancelFees[day] != 0) {
            cancelFees[next] += cancelFees[day];
            cancelFees[day] = 0;
        }
        for (uint256 i = 0; i < _tiers.length; i++) {
            uint32 g = _tiers[i].gen;
            for (uint256 b = 0; b < 2; b++) {
                Batch storage from = _batches[day][i][b];
                _batches[next][i][b].depIn += from.depIn;
                from.depIn = 0;
                uint256 q = _redQueued[day][i][g][b];
                if (q != 0) {
                    _redQueued[next][i][g][b] += q;
                    _redQueued[day][i][g][b] = 0;
                }
            }
        }
        ep.state = EpochState.Skipped;
        ep.value = 0;
        ep.rolledTo = next;
        lastSettled = day;
        emit Skipped(day, next);
    }

    /// Anyone once the dispute window is over; the admin at once.
    function settle(uint256 day) external {
        if (day != lastSettled + 1) revert OutOfOrder();
        Epoch storage ep = epochs[day];
        if (ep.state != EpochState.Proposed) revert BadState();
        if (msg.sender != admin && block.timestamp < uint256(ep.proposedAt) + disputeWindowSecs) {
            revert InDisputeWindow();
        }
        uint256 v = ep.value;
        uint256 prev = lastValue;
        (uint256 eL, uint256 eS, uint256 moved, uint256 fund) = _process(day, v, prev);
        ep.state = EpochState.Settled;
        lastSettled = day;
        lastValue = v;
        skipRun = 0;
        emit Settled(day, v, prev, eL, eS, moved, fund);
    }

    // ---------------------------------------------------------------- claims

    /// Withdraws an exit: pays `user` the tokens their exit request for `day` in `tier` was filled with. Anyone may
    /// call it; the tokens always go to the user. It also books the user's filled entries in that tier (which every
    /// request does anyway), so `shares` is what that added to the position.
    function claim(address user, uint256 day, uint8 tier) external nonReentrant returns (uint256 shares, uint256 tokens) {
        if (tier >= _tiers.length) revert BadTier();
        uint256 booked;
        (shares, booked) = _credit(user, tier);
        Request memory r = requests[user][day][tier];
        if (r.red == 0) {
            if (booked == 0) revert NothingToClaim();
            return (shares, 0);
        }
        uint256 sd = _resolve(day);
        delete requests[user][day][tier];
        Batch storage bt = _batches[sd][tier][r.exempt ? 1 : 0];
        if (r.redGen == bt.gen && bt.redIn != 0) {
            tokens = r.red * bt.tokensOut / bt.redIn;
            pooled = tokens < pooled ? pooled - tokens : 0;
            if (tokens != 0 && !_push(user, tokens)) revert TransferFailed();
        }
        emit Claimed(user, day, tier, shares, tokens);
    }

    /// Books every filled entry of `user` in `tier` into their position. Nobody has to call it — each request and
    /// claim of that user does, and `sharesOf` already counts filled entries — but anyone may.
    function credit(address user, uint8 tier) external nonReentrant returns (uint256 shares) {
        if (tier >= _tiers.length) revert BadTier();
        (shares,) = _credit(user, tier);
    }

    // ----------------------------------------------------------------- views

    function tierCount() external view returns (uint256) {
        return _tiers.length;
    }

    function tierInfo(uint8 tier) external view returns (Tier memory) {
        return _tiers[tier];
    }

    /// Current-generation shares the user owns: the position plus every entry already filled at a close (booked or
    /// not), minus shares queued to exit.
    function sharesOf(address user, uint8 tier) external view returns (uint256 s) {
        Tier storage t = _tiers[tier];
        Position storage p = _positions[user][tier];
        if (p.gen == t.gen) s = p.shares;
        uint256[] storage ds = _entryDays[user][tier];
        for (uint256 i = 0; i < ds.length; i++) s += _filledEntry(user, ds[i], tier, t.gen);
    }

    /// Days on which `user` has an entry into `tier` that is not yet booked, and the tokens of each (for the UI:
    /// an entry still waiting for its close shows as pending).
    function pendingEntries(address user, uint8 tier) external view returns (uint256[] memory dayList, uint256[] memory amounts) {
        uint256[] storage ds = _entryDays[user][tier];
        dayList = new uint256[](ds.length);
        amounts = new uint256[](ds.length);
        for (uint256 i = 0; i < ds.length; i++) {
            dayList[i] = ds[i];
            amounts[i] = requests[user][ds[i]][tier].dep;
        }
    }

    /// Token value of `shares` of `tier` right now (before the next close moves it).
    function sharesToTokens(uint8 tier, uint256 shares) external view returns (uint256) {
        Tier storage t = _tiers[tier];
        return t.shares == 0 ? 0 : shares * t.held / t.shares;
    }

    function batch(uint256 day, uint8 tier, uint8 bucket) external view returns (Batch memory) {
        return _batches[day][tier][bucket];
    }

    /// In-pool exposures in token units (c x held) and the matched part.
    function exposures() public view returns (uint256 longExp, uint256 shortExp, uint256 matched) {
        for (uint256 i = 0; i < _tiers.length; i++) {
            uint256 x = uint256(_tiers[i].c) * _tiers[i].held;
            if (_tiers[i].isLong) longExp += x;
            else shortExp += x;
        }
        matched = longExp < shortExp ? longExp : shortExp;
    }

    /// Fill ratio of a tier's side, in bps.
    function fillBps(uint8 tier) public view returns (uint256) {
        (uint256 eL, uint256 eS, uint256 m) = exposures();
        uint256 side = _tiers[tier].isLong ? eL : eS;
        return side == 0 ? 0 : m * BPS / side;
    }

    /// Net exposure to the stock at the current fill, in bps of 1x: 1 + c*f for long tiers, 1 - c*f for short ones.
    /// Negative means net short. This is what the UI must show next to the tier the user picked.
    function effectiveLeverageBps(uint8 tier) external view returns (int256) {
        uint256 cf = uint256(_tiers[tier].c) * fillBps(tier);
        return _tiers[tier].isLong ? int256(BPS + cf) : int256(BPS) - int256(cf);
    }

    /// Funding rate for the next close, in bps a day: positive = longs pay shorts.
    function fundingRateBps() external view returns (int256) {
        (uint256 eL, uint256 eS,) = exposures();
        if (eL + eS == 0) return 0;
        int256 imb = int256(eL) - int256(eS);
        return int256(uint256(fundingBps)) * imb / int256(eL + eS);
    }

    // -------------------------------------------------------------- internal

    function _currentDay() internal returns (uint256 d) {
        d = openEpoch;
        while (d <= lastScheduled && epochs[d].cutoff <= block.timestamp) d++;
        if (d > lastScheduled) revert NoOpenDay();
        if (d != openEpoch) openEpoch = d;
    }

    function _bucketFor(address user, uint256 day, uint256 tier) internal returns (uint256) {
        bool exempt = user == treasury;
        Request storage r = requests[user][day][tier];
        if (!r.used) {
            r.used = true;
            r.exempt = exempt;
        } else if (r.exempt != exempt) {
            revert BucketMismatch(); // the treasury changed mid-day
        }
        return exempt ? 1 : 0;
    }

    function _resolve(uint256 day) internal view returns (uint256) {
        (bool ok, uint256 d) = _tryResolve(day);
        if (!ok) revert NotSettled();
        return d;
    }

    /// The settled day a request of `day` was filled on (following skipped days), if it has been filled.
    function _tryResolve(uint256 day) internal view returns (bool, uint256) {
        uint256 d = day;
        for (uint256 i = 0; i < MAX_ROLL; i++) {
            EpochState s = epochs[d].state;
            if (s == EpochState.Settled) return (true, d);
            if (s != EpochState.Skipped) return (false, 0);
            d = epochs[d].rolledTo;
        }
        return (false, 0);
    }

    /// Shares a filled entry is worth in the current generation (0 if not filled yet, or wiped out since).
    function _filledEntry(address user, uint256 day, uint256 tier, uint32 gen) internal view returns (uint256) {
        Request storage r = requests[user][day][tier];
        if (r.dep == 0) return 0;
        (bool ok, uint256 sd) = _tryResolve(day);
        if (!ok) return 0;
        Batch storage bt = _batches[sd][tier][r.exempt ? 1 : 0];
        return bt.depIn != 0 && bt.gen == gen ? r.dep * bt.sharesOut / bt.depIn : 0;
    }

    /// Books the user's filled entries in `tier` into the position; keeps the ones still waiting for their close.
    /// Returns the shares added and how many entries were booked (a wiped-out one books for 0 shares).
    function _credit(address user, uint256 tier) internal returns (uint256 added, uint256 booked) {
        uint256[] storage ds = _entryDays[user][tier];
        uint256 n = ds.length;
        if (n == 0) return (0, 0);
        Tier storage t = _tiers[tier];
        Position storage p = _positions[user][tier];
        if (p.gen != t.gen) {
            p.shares = 0;
            p.gen = t.gen;
        }
        uint256 i = 0;
        while (i < n) {
            uint256 day = ds[i];
            Request storage r = requests[user][day][tier];
            (bool ok,) = _tryResolve(day);
            if (r.dep != 0 && !ok) {
                i++;
                continue; // still waiting for its close
            }
            if (r.dep != 0) {
                uint256 sh = _filledEntry(user, day, tier, t.gen);
                p.shares += sh;
                added += sh;
                booked++;
                emit EntryBooked(user, day, uint8(tier), sh);
                if (r.red == 0) delete requests[user][day][tier];
                else r.dep = 0;
            }
            ds[i] = ds[n - 1];
            ds.pop();
            n--;
        }
    }

    function _process(uint256 day, uint256 v, uint256 prev)
        internal
        returns (uint256 eL, uint256 eS, uint256 moved, uint256 fund)
    {
        uint256 n = _tiers.length;
        uint256[] memory x = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            x[i] = uint256(_tiers[i].c) * _tiers[i].held;
            if (_tiers[i].isLong) eL += x[i];
            else eS += x[i];
        }
        uint256 m = eL < eS ? eL : eS;
        if (m != 0 && prev != 0) {
            // Price: the losing side pays c x fill x |dV| / V of its tokens = x_i x (M / E_lose) x (|dV| / V), taken
            // in that order so that no product outgrows x_i x M (see MAX_POOL).
            if (v > prev) moved = _shift(x, false, m, eS, v - prev, v, eL);
            else if (v < prev) moved = _shift(x, true, m, eL, prev - v, v, eS);
            if (fundingBps != 0 && eL != eS) fund = _fund(x, eL, eS, m, v, prev);
        }
        for (uint256 i = 0; i < n; i++) {
            Tier storage t = _tiers[i];
            if (t.shares != 0 && (t.held == 0 || t.shares / t.held > WIPE_RATIO)) {
                dust += t.held;
                t.held = 0;
                t.shares = 0;
                t.gen += 1;
                emit TierWiped(uint8(i), t.gen);
            }
        }
        uint256 fee = cancelFees[day];   // kept from entries taken back before this close
        for (uint256 i = 0; i < n; i++) fee += _fill(day, i);
        if (fee != 0) _creditTreasury(fee);
    }

    /// The crowded side pays fundingBps x imbalance on the matched part, in tokens at today's value.
    function _fund(uint256[] memory x, uint256 eL, uint256 eS, uint256 m, uint256 v, uint256 prev)
        internal
        returns (uint256)
    {
        bool longsPay = eL > eS;
        // in tokens at today's value; never more than the matched part (only an absurd prev/v could ask for that)
        uint256 total = uint256(fundingBps) * (longsPay ? eL - eS : eS - eL) * m / (BPS * (eL + eS)) * prev / v;
        if (total > m) total = m;
        if (total == 0) return 0;
        return longsPay ? _shift(x, true, total, eL, 1, 1, eS) : _shift(x, false, total, eS, 1, 1, eL);
    }

    /// Every tier on the paying side gives x_i x a / b x c / d tokens (a <= b, so the first step never exceeds x_i),
    /// capped at what it holds (a tier can reach zero, never below); the other side splits what was actually paid by
    /// exposure. Rounding remainders go to `dust`.
    function _shift(uint256[] memory x, bool payersLong, uint256 a, uint256 b, uint256 c, uint256 d, uint256 eRecv)
        internal
        returns (uint256 paid)
    {
        uint256 n = x.length;
        for (uint256 i = 0; i < n; i++) {
            Tier storage t = _tiers[i];
            if (t.isLong != payersLong || x[i] == 0) continue;
            uint256 p = x[i] * a / b * c / d;
            if (p > t.held) p = t.held;
            t.held -= p;
            paid += p;
        }
        if (paid == 0) return 0;
        uint256 given;
        for (uint256 i = 0; i < n; i++) {
            Tier storage t = _tiers[i];
            if (t.isLong == payersLong || x[i] == 0) continue;
            uint256 g = paid * x[i] / eRecv;
            t.held += g;
            given += g;
        }
        dust += paid - given;
    }

    /// Exits first, then entries, both at the post-close share value. Returns the fees taken.
    function _fill(uint256 day, uint256 i) internal returns (uint256 fee) {
        Tier storage t = _tiers[i];
        for (uint256 b = 0; b < 2; b++) {
            uint256 r = _redQueued[day][i][t.gen][b];
            if (r == 0) continue;
            uint256 out = r * t.held / t.shares; // t.shares >= r: these shares are still outstanding
            t.held -= out;
            t.shares -= r;
            uint256 f = b == 0 ? out * feeBps / BPS : 0;
            Batch storage bt = _batches[day][i][b];
            bt.redIn = r;
            bt.tokensOut = out - f;
            fee += f;
        }
        for (uint256 b = 0; b < 2; b++) {
            Batch storage bt = _batches[day][i][b];
            uint256 d = bt.depIn;
            if (d != 0) {
                uint256 f = b == 0 ? d * feeBps / BPS : 0;
                bt.sharesOut = _mint(t, d - f);
                fee += f;
            }
            bt.gen = t.gen;
        }
    }

    function _mint(Tier storage t, uint256 net) internal returns (uint256 sh) {
        sh = t.shares == 0 ? net * SHARE_SCALE : net * t.shares / t.held;
        t.held += net;
        t.shares += sh;
    }

    /// Fees enter the hedge tier as the treasury's own shares.
    function _creditTreasury(uint256 fee) internal {
        Tier storage h = _tiers[hedgeTier];
        uint256 sh = _mint(h, fee);
        Position storage p = _positions[treasury][hedgeTier];
        if (p.gen != h.gen) {
            p.shares = 0;
            p.gen = h.gen;
        }
        p.shares += sh;
    }

    /// transferFrom into this contract; returns what actually arrived.
    function _pull(address from, uint256 amount) internal returns (uint256 credited) {
        uint256 before = token.balanceOf(address(this));
        if (!_call(abi.encodeCall(IERC20Like.transferFrom, (from, address(this), amount)))) revert TransferFailed();
        credited = token.balanceOf(address(this)) - before;
    }

    function _push(address to, uint256 amount) internal returns (bool) {
        return _call(abi.encodeCall(IERC20Like.transfer, (to, amount)));
    }

    /// Tolerates tokens that return nothing; a returned false counts as failure.
    function _call(bytes memory data) internal returns (bool) {
        (bool ok, bytes memory ret) = address(token).call(data);
        return ok && (ret.length == 0 || (ret.length >= 32 && abi.decode(ret, (bool))));
    }
}
