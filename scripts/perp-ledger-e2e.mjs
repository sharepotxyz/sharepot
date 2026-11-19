// Driven by scripts/perp-ledger-e2e.sh (which starts anvil, deploys the pool and bundles web/src/perp-ledger.ts).
// Plays six trading days on a real SharePotPerp — a first close, a rise, a fall, a skipped day whose requests roll
// on, a close after it, an unchanged close (funding only) — with entries, a take-back, exits (one withdrawn, one left
// to withdraw), an entry still waiting, and the treasury's fee-free entry; then rebuilds every wallet's ledger the
// way /me does (from the same events and per-day fields the site serves) and checks it against the contract:
//   1. each wallet's tokens per tier as the ledger carries them = what the contract says its shares are worth now
//   2. each tier's cash flows (in, out, still in) = the ledger's price + funding − fees
//   3. funding goes from the crowded side to the thin side, and a close that does not move moves nothing but funding
//   4. a filled exit is reported with exactly what its withdrawal paid; the treasury pays no entry fee
// Usage: node scripts/perp-ledger-e2e.mjs <rpc> <pool> <token> <bundled ledger .mjs>
import fs from "node:fs";
const [, , RPC, POOL, TOKEN, LEDGER] = process.argv;
const viem = await import(new URL("../web/node_modules/viem/_esm/index.js", import.meta.url));
const { mnemonicToAccount } = await import(new URL("../web/node_modules/viem/_esm/accounts/index.js", import.meta.url));
const { buildLedger } = await import(LEDGER);
const abi = JSON.parse(fs.readFileSync(new URL("../evm/abi/SharePotPerp.json", import.meta.url), "utf8"));
const erc20 = viem.parseAbi(["function mint(address to, uint256 amount)", "function approve(address s, uint256 a) returns (bool)"]);

const MN = "test test test test test test test test test test test junk";
const acct = (i) => mnemonicToAccount(MN, { addressIndex: i });
const admin = acct(0), treasury = acct(2), alice = acct(3), bob = acct(4), carol = acct(6), dave = acct(7), eve = acct(8);
const chain = { id: 31337, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pub = viem.createPublicClient({ chain, transport: viem.http(RPC) });
const send = async (who, address, a, functionName, args) => {
  const hash = await viem.createWalletClient({ account: who, chain, transport: viem.http(RPC) }).writeContract({ address, abi: a, functionName, args });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted`);
};
const pool = (who, fn, ...args) => send(who, POOL, abi, fn, args);
const read = (fn, ...args) => pub.readContract({ address: POOL, abi, functionName: fn, args });
const warp = async (ts) => { await pub.request({ method: "evm_setNextBlockTimestamp", params: [ts] }); await pub.request({ method: "evm_mine", params: [] }); };
const T = (n) => BigInt(Math.round(n * 1e8));   // whole tokens to raw units (8 decimals)

let fails = 0;
const check = (name, ok, extra = "") => { console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${extra ? "  " + extra : ""}`); if (!ok) fails++; };

// ------------------------------------------------------------------ the days
await pool(admin, "setRates", 10, 100);   // 0.1 % entry/exit fee, funding up to 1 % a day: big enough to see
for (const u of [treasury, alice, bob, carol, dave, eve]) { await send(u, TOKEN, erc20, "mint", [u.address, T(1000)]); await send(u, TOKEN, erc20, "approve", [POOL, 2n ** 255n]); }
const t0 = Number((await pub.getBlock()).timestamp);
const cut = [0, ...[1, 2, 3, 4, 5, 6, 7].map((k) => t0 + 3600 * k)];
await pool(admin, "schedule", cut.slice(1).map(BigInt));
const close = async (day, value) => { await warp(cut[day] + 60); await pool(admin, "propose", BigInt(day), T(value), "0x" + "00".repeat(32)); await pool(admin, "settle", BigInt(day)); };
const LONG2 = 0, HEDGE = 1, SHORT1 = 2, SHORT2 = 3;   // DeployPerp's tiers: c 1 1 2 3, long only the first

// day 1: the first close (nothing moves yet); the treasury's entry pays no fee
await pool(alice, "requestDeposit", LONG2, T(100));
await pool(bob, "requestDeposit", HEDGE, T(50));
await pool(carol, "requestDeposit", SHORT2, T(20));
await pool(treasury, "requestDeposit", HEDGE, T(10));
await close(1, 100);
// day 2: up 3 % (longs win); dave enters; carol takes an entry back (the fee is kept)
await pool(dave, "requestDeposit", LONG2, T(30));
await pool(carol, "requestDeposit", SHORT2, T(5));
await pool(carol, "cancelDeposit", SHORT2, 0n);
await close(2, 103);
// day 3: down to 98 (shorts win); alice exits half; carol adds
const aliceShares = await read("sharesOf", alice.address, LONG2);
await pool(alice, "requestRedeem", LONG2, aliceShares / 2n);
await pool(carol, "requestDeposit", SHORT2, T(10));
await close(3, 98);
await pool(alice, "claim", alice.address, 3n, LONG2);
// day 4: skipped — bob's exit and eve's entry roll to day 5
const bobShares = await read("sharesOf", bob.address, HEDGE);
await pool(bob, "requestRedeem", HEDGE, bobShares / 3n);
await pool(eve, "requestDeposit", SHORT1, T(40));
await warp(cut[4] + 60); await pool(admin, "skip", 4n);
// day 5: 101; day 6: unchanged (funding only); day 7: alice's new entry waits
await close(5, 101);
await close(6, 101);
await pool(alice, "requestDeposit", LONG2, T(20));

// ------------------------------------------------------- the data /me reads
// days as /api/days serves them (perp-site.mjs readDays), the wallet rows as /api/activity does (activity())
const logs = await pub.getContractEvents({ address: POOL, abi, fromBlock: 0n });
const blockTs = new Map();
for (const l of logs) if (!blockTs.has(l.blockNumber)) blockTs.set(l.blockNumber, Number((await pub.getBlock({ blockNumber: l.blockNumber })).timestamp));
const lower = (v) => (typeof v === "string" ? v.toLowerCase() : v);
const ev = logs.map((l) => ({ ev: l.eventName, ts: blockTs.get(l.blockNumber), tx: l.transactionHash, a: Object.fromEntries(Object.entries(l.args ?? {}).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : lower(v)])) }));
const lastScheduled = Number(await read("lastScheduled"));
const days = [];
for (let d = 1; d <= lastScheduled; d++) {
  const [cutoff, state, , value, , rolledTo] = await read("epochs", BigInt(d));
  const s = ev.find((r) => r.ev === "Settled" && Number(r.a.day) === d), k = ev.find((r) => r.ev === "Skipped" && Number(r.a.day) === d);
  days.push({ day: d, cutoff: Number(cutoff), state: Number(state), value: value.toString(), rolledTo: Number(rolledTo) || null, prevValue: s?.a.prevValue ?? null, longExp: s?.a.longExp ?? null,
    shortExp: s?.a.shortExp ?? null, moved: s?.a.moved ?? null, funding: s?.a.funding ?? null, settledAt: s?.ts ?? k?.ts ?? null, settleTx: s?.tx ?? k?.tx ?? null });
}
const USER = new Set(["DepositRequested", "DepositCancelled", "RedeemRequested", "EntryBooked", "Claimed"]);
const rowsOf = (addr) => ev.filter((r) => USER.has(r.ev) && r.a.user === addr.toLowerCase()).map((r) => ({ ev: r.ev, ts: r.ts, tx: r.tx, day: Number(r.a.day), tier: Number(r.a.tier),
  amount: r.a.amount ?? null, shares: r.a.shares ?? null, tokens: r.ev === "DepositCancelled" ? r.a.refund ?? null : r.a.tokens ?? null }));
const nTiers = Number(await read("tierCount"));
const tiers = [];
for (let i = 0; i < nTiers; i++) { const t = await read("tierInfo", i); tiers.push({ i, c: Number(t.c), isLong: t.isLong }); }
const feeBps = Number(await read("feeBps"));
const lastSettled = Number(await read("lastSettled"));
const resolve = (d) => { for (;;) { const x = days[d - 1]; if (!x || x.state !== 4) return d; d = x.rolledTo; } };

console.log("== ledger vs contract");
const ledgers = {};
for (const [name, u] of Object.entries({ treasury, alice, bob, carol, dave, eve })) {
  const rows = rowsOf(u.address);
  // what each filled exit pays: its Claimed event once withdrawn, else what claim() would pay now (as loadMine does)
  const exitsNet = new Map();
  for (const r of rows.filter((x) => x.ev === "RedeemRequested")) {
    if (resolve(r.day) > lastSettled) continue;
    const c = rows.find((x) => x.ev === "Claimed" && x.day === r.day && x.tier === r.tier && x.tokens !== "0");
    if (c) exitsNet.set(`${r.day}:${r.tier}`, BigInt(c.tokens));
    else { const sim = await pub.simulateContract({ address: POOL, abi, functionName: "claim", args: [u.address, BigInt(r.day), r.tier], account: u.address }); exitsNet.set(`${r.day}:${r.tier}`, sim.result[1]); }
  }
  const L = buildLedger({ tiers, feeBps, exempt: u === treasury, days, events: rows, exitsNet });
  ledgers[name] = { L, rows, exitsNet };
  for (const t of tiers) {
    const shares = await read("sharesOf", u.address, t.i), now = Number(await read("sharesToTokens", t.i, shares));
    const s = L.sums[t.i];
    if (!s.filled && now === 0) continue;
    // the treasury also owns the fee shares the contract credits it, which are no request of its own
    if (u === treasury) continue;
    const tol = Math.max(50, now * 1e-7);
    check(`${name} tier ${t.i}: ledger tokens = contract`, Math.abs(s.tokens - now) <= tol, `ledger ${(s.tokens / 1e8).toFixed(8)} contract ${(now / 1e8).toFixed(8)}`);
    // cash flows of this tier: in = entries asked, out = withdrawals + take-backs, still in = position + exits ready
    // to withdraw + entries waiting
    const mine = rows.filter((r) => r.tier === t.i);
    const inn = mine.filter((r) => r.ev === "DepositRequested").reduce((a, r) => a + Number(r.amount), 0);
    const out = mine.filter((r) => r.ev === "Claimed" || r.ev === "DepositCancelled").reduce((a, r) => a + Number(r.tokens ?? 0), 0);
    let ready = 0; for (const r of mine.filter((x) => x.ev === "RedeemRequested")) if (!mine.some((x) => x.ev === "Claimed" && x.day === r.day && x.tokens !== "0")) ready += Number(exitsNet.get(`${r.day}:${t.i}`) ?? 0n);
    const waiting = mine.filter((r) => r.ev === "DepositRequested" && resolve(r.day) > lastSettled).reduce((a, r) => a + Number(r.amount), 0)
      - mine.filter((r) => r.ev === "DepositCancelled" && resolve(r.day) > lastSettled).reduce((a, r) => a + Number(r.amount), 0);
    const cash = now + ready + waiting + out - inn, model = s.price + s.funding - s.fees;
    check(`${name} tier ${t.i}: in/out/still-in = price + funding − fees`, Math.abs(cash - model) <= tol, `cash ${(cash / 1e8).toFixed(8)} ledger ${(model / 1e8).toFixed(8)}`);
  }
}

console.log("== what the rows say");
const settleOf = (name, day, tier) => ledgers[name].L.rows.find((r) => r.kind === "settle" && r.day === day && r.tier === tier);
const d2 = days[1];
check("day 2: the short side is the crowded one (it pays funding)", Number(d2.shortExp) > Number(d2.longExp) && Number(d2.funding) > 0, `long ${d2.longExp} short ${d2.shortExp}`);
check("day 2: alice (long, thin side) gains on the rise and receives funding", settleOf("alice", 2, LONG2)?.price > 0 && settleOf("alice", 2, LONG2)?.funding > 0);
check("day 2: carol (short 2x) loses on the rise and pays funding", settleOf("carol", 2, SHORT2)?.price < 0 && settleOf("carol", 2, SHORT2)?.funding < 0);
check("day 2: dave's entry is not moved by the close it entered at", !settleOf("dave", 2, LONG2) && ledgers.dave.L.rows.some((r) => r.kind === "entered" && r.day === 2));
check("day 3: the fall turns it around (alice loses, carol gains)", settleOf("alice", 3, LONG2)?.price < 0 && settleOf("carol", 3, SHORT2)?.price > 0);
check("day 4 (skipped) moves nobody", !Object.values(ledgers).some(({ L }) => L.rows.some((r) => r.day === 4)));
check("day 5: bob's rolled-over exit and eve's rolled-over entry fill at day 5", ledgers.bob.L.rows.some((r) => r.kind === "exited" && r.day === 5) && ledgers.eve.L.rows.some((r) => r.kind === "entered" && r.day === 5));
check("day 6 (unchanged close): no price part, funding only", ["alice", "bob", "carol", "dave", "eve"].every((n) => ledgers[n].L.rows.filter((r) => r.kind === "settle" && r.day === 6).every((r) => r.price === 0 && r.funding !== 0)));
const aliceExit = ledgers.alice.L.rows.find((r) => r.kind === "exited"), aliceClaim = ledgers.alice.rows.find((r) => r.ev === "Claimed" && r.tokens !== "0");
check("alice's exit is reported with exactly what her withdrawal paid", !!aliceExit && !!aliceClaim && aliceExit.tokens === Number(aliceClaim.tokens));
check("the treasury's entry pays no fee", ledgers.treasury.L.rows.some((r) => r.kind === "entered" && r.fee === 0));
check("carol's take-back fee is counted", Math.abs(ledgers.carol.L.sums[SHORT2].fees - (Number(T(5)) * 0.001 + Number(T(20)) * 0.001 + Number(T(10)) * 0.001)) <= 2);
check("alice's waiting entry (day 7) is not filled", !ledgers.alice.L.rows.some((r) => r.day === 7));
const allFunding = Object.entries(ledgers).filter(([n]) => n !== "treasury").reduce((a, [, { L }]) => a + L.sums.reduce((b, s) => b + s.funding, 0), 0);
console.log(`  (funding across the five users: ${(allFunding / 1e8).toFixed(6)} tokens; the treasury's hedge share takes the rest)`);
console.log(fails ? `${fails} FAILED` : "ALL OK");
process.exit(fails ? 1 : 0);
