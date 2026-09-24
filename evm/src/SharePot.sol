// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// SharePot — parimutuel prediction pools on US stocks, staked and paid out in the tokenized stock itself
/// (Robinhood Stock Tokens on Robinhood Chain, or any plain ERC-20). This is the EVM port of the Solana program in
/// programs/sharepot; the money model is the same and is described in the README and at the top of
/// programs/sharepot/src/lib.rs.
///
/// * Each market belongs to ONE stock token. Every bet, payout, fee and house seed is in that token.
/// * 2..=8 outcome buckets defined by sorted thresholds on one metric; each bucket has its own pool.
/// * Winners get their stake back plus a pro-rata share of every losing pool. The protocol fee is charged only on
///   that share, never on the stake, at the fee rate locked when the bet was placed (stake-weighted per position).
/// * House seed is split pro-rata among winners, fee-free.
/// * Resolution is two-step: the proposer submits the observed VALUE and the hash of the price evidence; the winning
///   bucket is derived here. Anyone can finalize after the dispute window; the admin at once.
/// * Settlement is permissionless: anyone can pay any position out to its owner.
///
/// What the EVM changes:
/// * This one contract is the vault for every market. Each market's tokens are tracked in `held`, never read from
///   balanceOf(this), so two markets in the same token cannot see each other's funds, and a token that skims a
///   transfer fee is booked at what actually arrived.
/// * There is no rent and no token account: a position is a storage entry, a payout goes to the owner's address,
///   and a settled position is deleted.
/// * An owner who cannot receive the token (blocked on the issuer's registry) has no account to inspect, so
///   `forfeitPosition` simply tries to pay the owner and, only when that transfer fails, pays the treasury. A paused
///   token fails both transfers, so a pause never forfeits anyone.
///
/// Issuer controls (read before depositing): Robinhood Stock Tokens can be paused, any address (this contract
/// included) can be blocked from sending or receiving, and an issuer role can burn from any address. All accounting
/// here is in raw units, so a multiplier change (dividend, split; ERC-8056 scaled UI amount) scales every pool,
/// stake and payout alike.
interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract SharePot {
    uint256 public constant BPS = 10_000;
    uint16 public constant MAX_FEE_BPS = 1_000; // 10 % hard ceiling, protects users from a hostile config
    uint8 public constant MAX_BUCKETS = 8;
    uint8 public constant MAX_THRESHOLDS = 7;
    uint8 public constant NO_OUTCOME = 255;
    /// A market still unproposed this long after resolveAfterTs has no usable price: the proposer may void it.
    uint64 public constant STALE_VOID_SECS = 86_400;
    /// A position that still cannot be paid this long after its market resolved may be forfeited to the treasury.
    uint64 public constant FORFEIT_GRACE_SECS = 30 days;

    enum Status { None, Open, Proposed, Resolved, Voided, Swept }

    struct Config {
        address admin;
        address proposer;
        /// Receives fees, rounding dust, unused seed and forfeited payouts, in each market's token.
        address treasury;
        uint16 feeBps;
        uint16 earlyBirdDiscountBps;
        uint64 earlyBirdSecs;
        uint64 disputeWindowSecs;
        /// Raw units of whichever stock token the market uses (Robinhood Stock Tokens: 18 decimals).
        uint256 minBet;
        bool paused;
    }

    struct ConfigArgs {
        address proposer;
        address treasury;
        uint16 feeBps;
        uint16 earlyBirdDiscountBps;
        uint64 earlyBirdSecs;
        uint64 disputeWindowSecs;
        uint256 minBet;
    }

    struct MarketArgs {
        address token;
        bytes32 metric;
        bytes32 questionHash;
        /// Sorted, strictly increasing; only the first nBuckets-1 entries are used.
        int64[7] thresholds;
        uint8 nBuckets;
        uint64 openTs;
        uint64 closeTs;
        uint64 resolveAfterTs;
        /// Reference value at open (e.g. the previous close). Informational for move markets.
        int64 baseline;
    }

    struct Market {
        address token;
        bytes32 metric;
        bytes32 questionHash;
        int64[7] thresholds;
        uint8 nBuckets;
        uint64 openTs;
        uint64 closeTs;
        uint64 resolveAfterTs;
        int64 baseline;
        uint256[8] pools;
        uint256 seedAmount;
        Status status;
        /// Winning bucket once resolved; NO_OUTCOME otherwise.
        uint8 outcome;
        uint8 proposedOutcome;
        int64 proposedValue;
        uint64 proposedAt;
        bytes32 snapshotHash;
        uint64 resolvedAt;
        uint256 feeCollected;
        uint256 paidOut;
        uint256 swept;
        /// Tokens this market holds inside the contract: credited by bets and seed, debited by payouts and sweep.
        uint256 held;
        uint32 positions;
        uint32 positionsOpen;
    }

    struct Position {
        uint256[8] amounts;
        /// Σ amount_i × feeBps_i per bucket, so feeW / amount is the position's stake-weighted fee rate.
        uint256[8] feeW;
        bool open;
    }

    Config public config;
    uint256 public marketCount;
    mapping(uint256 => Market) internal _markets;
    mapping(uint256 => mapping(address => Position)) internal _positions;
    uint256 private _entered = 1;

    event ConfigUpdated(address admin, address proposer, address treasury, uint16 feeBps, uint16 earlyBirdDiscountBps, uint64 earlyBirdSecs, uint64 disputeWindowSecs, uint256 minBet, bool paused);
    event MarketCreated(uint256 indexed id, address indexed token, bytes32 metric, uint8 nBuckets, int64[7] thresholds, uint64 openTs, uint64 closeTs);
    event MarketSeeded(uint256 indexed id, address indexed funder, uint256 amount);
    event BetPlaced(uint256 indexed id, address indexed user, uint8 bucket, uint256 amount, uint16 feeBps, uint256[8] pools);
    event ResolutionProposed(uint256 indexed id, uint8 bucket, int64 observedValue, bytes32 snapshotHash, uint64 proposedAt);
    event MarketResolved(uint256 indexed id, uint8 bucket, bool voided);
    event PositionSettled(uint256 indexed id, address indexed user, uint256 payout, uint256 fee);
    event PositionForfeited(uint256 indexed id, address indexed user, uint256 amount);
    event MarketSwept(uint256 indexed id, address indexed token, uint8 outcome, uint256[8] pools, uint256 seedAmount, uint256 paidOut, uint256 feeCollected, uint256 swept);

    error Unauthorized();
    error FeeTooHigh();
    error BadSchedule();
    error ZeroAmount();
    error BelowMinBet();
    error MarketNotOpen();
    error BettingNotStarted();
    error BettingClosed();
    error Paused();
    error TooEarlyToResolve();
    error NotProposed();
    error DisputeWindowOpen();
    error AlreadyFinal();
    error NotResolved();
    error PositionsOutstanding();
    error BadBuckets();
    error UnsupportedToken();
    error NotStaleYet();
    error NotForfeitableYet();
    error NoPosition();
    error TransferFailed();
    error Reentrancy();
    error ZeroAddress();

    modifier nonReentrant() {
        if (_entered != 1) revert Reentrancy();
        _entered = 2;
        _;
        _entered = 1;
    }

    modifier onlyAdmin() {
        if (msg.sender != config.admin) revert Unauthorized();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != config.admin && msg.sender != config.proposer) revert Unauthorized();
        _;
    }

    constructor(ConfigArgs memory args) {
        _validate(args);
        config.admin = msg.sender;
        _apply(args);
        _emitConfig();
    }

    // ---------- admin ----------

    function updateConfig(ConfigArgs calldata args, address newAdmin, bool paused) external onlyAdmin {
        _validate(args);
        _apply(args);
        config.paused = paused;
        if (newAdmin != address(0)) config.admin = newAdmin;
        _emitConfig();
    }

    // ---------- markets ----------

    /// One market = one stock token. The admin or the proposer opens markets.
    function createMarket(MarketArgs calldata a) external onlyOperator returns (uint256 id) {
        if (a.token.code.length == 0) revert UnsupportedToken();
        if (a.closeTs <= a.openTs || a.closeTs <= block.timestamp || a.resolveAfterTs < a.closeTs) revert BadSchedule();
        uint256 n = a.nBuckets;
        if (n < 2 || n > MAX_BUCKETS) revert BadBuckets();
        for (uint256 i = 1; i + 1 < n; i++) {
            if (a.thresholds[i] <= a.thresholds[i - 1]) revert BadBuckets();
        }
        id = marketCount++;
        Market storage m = _markets[id];
        m.token = a.token;
        m.metric = a.metric;
        m.questionHash = a.questionHash;
        m.thresholds = a.thresholds;
        m.nBuckets = a.nBuckets;
        m.openTs = a.openTs;
        m.closeTs = a.closeTs;
        m.resolveAfterTs = a.resolveAfterTs;
        m.baseline = a.baseline;
        m.status = Status.Open;
        m.outcome = NO_OUTCOME;
        m.proposedOutcome = NO_OUTCOME;
        emit MarketCreated(id, a.token, a.metric, a.nBuckets, a.thresholds, a.openTs, a.closeTs);
    }

    /// Anyone (normally the treasury) adds a fee-free prize to the pot. On void or no-winner the seed is swept to
    /// the treasury, not returned to a third-party funder.
    function seedMarket(uint256 id, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Market storage m = _markets[id];
        if (m.status != Status.Open) revert MarketNotOpen();
        if (block.timestamp >= m.closeTs) revert BettingClosed();
        uint256 credited = _pull(m.token, msg.sender, amount);
        if (credited == 0) revert ZeroAmount();
        m.seedAmount += credited;
        m.held += credited;
        emit MarketSeeded(id, msg.sender, credited);
    }

    function placeBet(uint256 id, uint8 bucket, uint256 amount) external nonReentrant {
        Config storage c = config;
        Market storage m = _markets[id];
        if (c.paused) revert Paused();
        if (m.status != Status.Open) revert MarketNotOpen();
        if (block.timestamp < m.openTs) revert BettingNotStarted();
        if (block.timestamp >= m.closeTs) revert BettingClosed();
        if (amount < c.minBet) revert BelowMinBet();
        if (bucket >= m.nBuckets) revert BadBuckets();
        // Fee tier is decided now and locked into the position, stake-weighted.
        // Early-bird window = the first quarter of the betting window, capped by config.earlyBirdSecs.
        uint16 feeBps = c.feeBps;
        if (block.timestamp < m.openTs + earlyBirdSecs(id)) feeBps -= c.earlyBirdDiscountBps;
        // The stake is what the contract received: on a token with a transfer fee that is less than `amount`, and
        // only the credited part can ever be paid back out, so only that part joins the pool.
        uint256 credited = _pull(m.token, msg.sender, amount);
        if (credited == 0) revert ZeroAmount();
        Position storage p = _positions[id][msg.sender];
        if (!p.open) {
            p.open = true;
            m.positions += 1;
            m.positionsOpen += 1;
        }
        p.amounts[bucket] += credited;
        p.feeW[bucket] += credited * feeBps;
        m.pools[bucket] += credited;
        m.held += credited;
        emit BetPlaced(id, msg.sender, bucket, credited, feeBps, m.pools);
    }

    /// Proposer publishes the observed value plus the hash of the price evidence it came from. The winning bucket
    /// is derived here. Starts the dispute window; a re-proposal restarts it.
    function proposeResolution(uint256 id, int64 observedValue, bytes32 snapshotHash) external onlyOperator {
        Market storage m = _markets[id];
        if (m.status != Status.Open && m.status != Status.Proposed) revert MarketNotOpen();
        if (block.timestamp < m.resolveAfterTs) revert TooEarlyToResolve();
        uint8 bucket = bucketOf(id, observedValue);
        m.status = Status.Proposed;
        m.proposedOutcome = bucket;
        m.proposedValue = observedValue;
        m.proposedAt = uint64(block.timestamp);
        m.snapshotHash = snapshotHash;
        emit ResolutionProposed(id, bucket, observedValue, snapshotHash, uint64(block.timestamp));
    }

    /// Anyone after the dispute window; admin immediately.
    function finalizeResolution(uint256 id) external {
        Market storage m = _markets[id];
        if (m.status != Status.Proposed) revert NotProposed();
        bool isAdmin = msg.sender == config.admin;
        if (!isAdmin && block.timestamp < uint256(m.proposedAt) + config.disputeWindowSecs) revert DisputeWindowOpen();
        m.status = Status.Resolved;
        m.outcome = m.proposedOutcome;
        m.resolvedAt = uint64(block.timestamp);
        emit MarketResolved(id, m.outcome, false);
    }

    /// Admin escape hatch: every position is refunded in full, seed goes to the treasury on sweep.
    function voidMarket(uint256 id) external onlyAdmin {
        Market storage m = _markets[id];
        if (m.status != Status.Open && m.status != Status.Proposed) revert AlreadyFinal();
        _void(id, m);
    }

    /// Proposer (or admin) voids a market that is still unproposed STALE_VOID_SECS after its resolve time: the price
    /// it needs does not exist, so everyone is refunded. Refunding is the only thing this adds to the proposer's
    /// powers; it can still never pick a winner.
    function voidStaleMarket(uint256 id) external onlyOperator {
        Market storage m = _markets[id];
        if (m.status != Status.Open) revert MarketNotOpen();
        if (block.timestamp < uint256(m.resolveAfterTs) + STALE_VOID_SECS) revert NotStaleYet();
        _void(id, m);
    }

    /// Permissionless payout. Winners are paid to their address; losers' positions are simply closed. Works for
    /// Resolved and Voided markets. Reverts if the owner cannot receive the token (see forfeitPosition).
    function settlePosition(uint256 id, address owner) external nonReentrant {
        Market storage m = _markets[id];
        (uint256 payout, uint256 fee) = _close(id, m, owner);
        m.paidOut += payout;
        if (payout > 0 && !_push(m.token, owner, payout)) revert TransferFailed();
        emit PositionSettled(id, owner, payout, fee);
    }

    /// A position whose owner cannot receive the stock (blocked by the issuer, or a contract that rejects it) would
    /// keep the market from ever being swept. Once FORFEIT_GRACE_SECS have passed since the market resolved (the
    /// admin: at once), anyone may call this: the owner is paid if the transfer goes through, exactly like
    /// settlePosition; only if it fails does the payout go to the treasury instead. A paused token fails both
    /// transfers, so nothing is forfeited while the issuer has trading stopped.
    function forfeitPosition(uint256 id, address owner) external nonReentrant {
        Market storage m = _markets[id];
        if (msg.sender != config.admin && block.timestamp < uint256(m.resolvedAt) + FORFEIT_GRACE_SECS) revert NotForfeitableYet();
        (uint256 payout, uint256 fee) = _close(id, m, owner);
        if (payout == 0 || _push(m.token, owner, payout)) {
            m.paidOut += payout;
            emit PositionSettled(id, owner, payout, fee);
            return;
        }
        if (!_push(m.token, config.treasury, payout)) revert TransferFailed();
        emit PositionForfeited(id, owner, payout);
    }

    /// After every position is settled: fees + rounding dust (+ seed if voided or no winners) go to the treasury.
    function sweepMarket(uint256 id) external nonReentrant {
        Market storage m = _markets[id];
        if (m.status != Status.Resolved && m.status != Status.Voided) revert NotResolved();
        if (m.positionsOpen != 0) revert PositionsOutstanding();
        uint256 remaining = m.held;
        m.held = 0;
        m.swept = remaining;
        m.status = Status.Swept;
        if (remaining > 0 && !_push(m.token, config.treasury, remaining)) revert TransferFailed();
        emit MarketSwept(id, m.token, m.outcome, m.pools, m.seedAmount, m.paidOut, m.feeCollected, remaining);
    }

    // ---------- views ----------

    function getMarket(uint256 id) external view returns (Market memory) {
        return _markets[id];
    }

    function getPosition(uint256 id, address owner) external view returns (Position memory) {
        return _positions[id][owner];
    }

    /// Seconds after open during which the early-bird discount applies: min(config cap, 25 % of the window).
    function earlyBirdSecs(uint256 id) public view returns (uint64) {
        Market storage m = _markets[id];
        uint64 quarter = (m.closeTs - m.openTs) / 4;
        uint64 cap = config.earlyBirdSecs;
        return cap < quarter ? cap : quarter;
    }

    /// Bucket index for a value: number of active thresholds the value reaches.
    /// bucket 0 = below thresholds[0]; bucket n-1 = at or above thresholds[n-2].
    function bucketOf(uint256 id, int64 value) public view returns (uint8) {
        Market storage m = _markets[id];
        uint256 n = m.nBuckets;
        uint8 b = 0;
        for (uint256 i = 0; i + 1 < n; i++) {
            if (value >= m.thresholds[i]) b = uint8(i + 1);
        }
        return b;
    }

    function totalPool(uint256 id) public view returns (uint256 t) {
        uint256[8] storage pools = _markets[id].pools;
        for (uint256 i = 0; i < MAX_BUCKETS; i++) t += pools[i];
    }

    /// (payout to owner, fee taken out of that payout) for a position on a Resolved or Voided market.
    function computePayout(uint256 id, address owner) public view returns (uint256 payout, uint256 fee) {
        Market storage m = _markets[id];
        Position storage p = _positions[id][owner];
        uint256 totalStake;
        for (uint256 i = 0; i < MAX_BUCKETS; i++) totalStake += p.amounts[i];
        if (m.status == Status.Voided) return (totalStake, 0);
        if (m.status != Status.Resolved) revert NotResolved();
        uint256 w = m.outcome;
        if (w >= m.nBuckets) revert NotResolved();
        uint256 winPool = m.pools[w];
        uint256 losePool = totalPool(id) - winPool;
        uint256 stake = p.amounts[w];
        // Nobody on the winning side: everyone is made whole, house seed returns via sweep.
        if (winPool == 0) return (totalStake, 0);
        if (stake == 0) return (0, 0);
        uint256 grossShare = losePool * stake / winPool;
        // Stake-weighted fee rate for this position: feeW = Σ amount_i × bps_i, so feeW / stake ≤ MAX_FEE_BPS.
        uint256 weightedBps = p.feeW[w] / stake;
        if (weightedBps > MAX_FEE_BPS) weightedBps = MAX_FEE_BPS;
        fee = grossShare * weightedBps / BPS;
        uint256 seedShare = m.seedAmount * stake / winPool;
        payout = stake + grossShare - fee + seedShare;
    }

    // ---------- internals ----------

    function _validate(ConfigArgs memory a) internal pure {
        if (a.feeBps > MAX_FEE_BPS || a.earlyBirdDiscountBps > a.feeBps) revert FeeTooHigh();
        if (a.proposer == address(0) || a.treasury == address(0)) revert ZeroAddress();
    }

    function _apply(ConfigArgs memory a) internal {
        Config storage c = config;
        c.proposer = a.proposer;
        c.treasury = a.treasury;
        c.feeBps = a.feeBps;
        c.earlyBirdDiscountBps = a.earlyBirdDiscountBps;
        c.earlyBirdSecs = a.earlyBirdSecs;
        c.disputeWindowSecs = a.disputeWindowSecs;
        c.minBet = a.minBet;
    }

    function _emitConfig() internal {
        Config storage c = config;
        emit ConfigUpdated(c.admin, c.proposer, c.treasury, c.feeBps, c.earlyBirdDiscountBps, c.earlyBirdSecs, c.disputeWindowSecs, c.minBet, c.paused);
    }

    function _void(uint256 id, Market storage m) internal {
        m.status = Status.Voided;
        m.resolvedAt = uint64(block.timestamp);
        emit MarketResolved(id, NO_OUTCOME, true);
    }

    /// Books a position's payout and deletes it. The caller moves the tokens.
    function _close(uint256 id, Market storage m, address owner) internal returns (uint256 payout, uint256 fee) {
        if (m.status != Status.Resolved && m.status != Status.Voided) revert NotResolved();
        Position storage p = _positions[id][owner];
        if (!p.open) revert NoPosition();
        (payout, fee) = computePayout(id, owner);
        delete _positions[id][owner];
        m.feeCollected += fee;
        m.held -= payout;
        m.positionsOpen -= 1;
    }

    /// transferFrom into this contract; returns what actually arrived.
    function _pull(address token, address from, uint256 amount) internal returns (uint256 credited) {
        uint256 before = IERC20(token).balanceOf(address(this));
        if (!_call(token, abi.encodeCall(IERC20.transferFrom, (from, address(this), amount)))) revert TransferFailed();
        credited = IERC20(token).balanceOf(address(this)) - before;
    }

    /// transfer out; false instead of reverting so forfeitPosition can fall through to the treasury.
    function _push(address token, address to, uint256 amount) internal returns (bool) {
        return _call(token, abi.encodeCall(IERC20.transfer, (to, amount)));
    }

    /// Tolerates tokens that return nothing; a returned false counts as failure.
    function _call(address token, bytes memory data) internal returns (bool) {
        (bool ok, bytes memory ret) = token.call(data);
        return ok && (ret.length == 0 || (ret.length >= 32 && abi.decode(ret, (bool))));
    }
}
