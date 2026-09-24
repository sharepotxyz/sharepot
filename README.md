# SharePot — bet with your stock tokens, get paid in them

Daily parimutuel pools on US stocks where **the stake and the payout are the tokenized stock itself** — any issuer's
token on Solana: xStocks (SPCXx, TSLAx, NVDAx, SPYx), Backpack Securities (SPCX) and Ondo Global Markets (SPCXon,
TSLAon, NVDAon, SPYon). Holders put their shares to work without selling them:

* **Hedge without selling.** Hold 10 TSLAx and worried about today? Stake 1 TSLAx on "Big drop". If Tesla falls hard,
  you receive extra TSLAx on exactly the day your shares lose value.
* **Add upside without buying.** Stake on "Big gain" instead and a win adds shares on the day the price jumps.
* A wrong call costs only what you staked. You never swap out of the stock, so you never leave your position.

Built for the Solana Foundation **Stocklana** hackathon (September 2026).

**Try it (devnet): <https://devnet.sharepot.xyz>** — connect Phantom / Solflare / Backpack set to devnet, or use the built-in
browser test wallet, then press "Get test tokens": every wallet gets mock tokens of every pool open today plus a little
SOL for fees. A new stock pool opens for every token at each US opening bell; a pre-IPO or meme day's pool opens at
11:00 UTC the day before.

Updates: [@sharepotxyz on X](https://x.com/sharepotxyz) · contact: hello@sharepot.xyz

## How a market works

* **One market per stock per US trading session.** The market for session S opens at the previous session's opening
  bell and **stops taking bets at S's opening bell (09:30 New York)**, so there is always exactly one pool per stock you
  can bet into, around the clock.
* It settles on the **official close of S against the official close of the session before**, in four ranges:
  big drop / small drop / small gain / big gain. The cuts are set near the quartiles of each stock's daily moves over
  the last 12 weeks (TSLA −1.75 % / 0 / +2 %, NVDA −1.5 % / 0 / +2.25 %, SPY −0.5 % / 0 / +0.5 %), so every range
  starts out roughly equally likely. Odds then move with the pools.
* Session times come from the NYSE holiday calendar built into the server (holidays, early closes, daylight saving;
  checked session by session against a broker's market calendar for the rest of 2026). Before it opens a market the
  opener also asks Nasdaq's live market status for the next session and follows Nasdaq if the two disagree (an
  unscheduled closure). Years beyond the published table are generated from the exchange's standing holiday rules
  (`nyseYearByRule`, tested against NYSE's published lists for 2022 and 2024–2027), so nothing is added by hand each year.

## Many issuers, one question

The same stock often trades on Solana as several tokens: SpaceX as SPCXx (xStocks), SPCX (Backpack Securities) and
SPCXon (Ondo Global Markets); Tesla as TSLAx and TSLAon. The tokens are not interchangeable (different issuers,
decimals and dividend multipliers), so **each token gets its own pool**. All pools of a stock ask the same question and
resolve on the same official close; each is staked and paid in its own token.

## Dividends, splits and other corporate actions

* **What is predicted is the total-return move**: (close + any dividend going ex that session) ÷ previous close − 1,
  with both closes on the same share basis. An ex-dividend day therefore doesn't count as a drop (SPY 2026-06-18: price
  +0.78 %, total return +1.04 %), and a split doesn't show up as a −90 % day (NVDA's 10-for-1 on 2024-06-10 settles at
  +0.75 %). The dividend and split lines are part of the published raw price data.
* **The tokens themselves** carry dividends and splits as a `ScaledUiAmount` multiplier that the issuer applies to every
  balance, vaults included. The program books raw units, so every stake, pool and payout moves by the same ratio and
  keeps its share of the pot; the site shows amounts with the multiplier applied, exactly as wallets do.
* New shares issued for cash are a real price move and count. Stock dividends and bonus issues are splits; capital
  reductions are reverse splits or cash returns, handled as above.
* Anything that can't be expressed this way — a spin-off, a merger that delists the stock, a halt for the whole
  session — voids the market and refunds every stake in full.

## How the money works

* Each range has its own pool, denominated in the market's stock token. **Winners get their stake back plus a pro-rata
  share of every losing pool**, paid in the same stock.
* **The fee (3 %) is charged only on what a winner takes from the losing pools**, never on the winner's own stake.
  Bets in the first quarter of the betting window (up to 6 h) pay 2 %. The rate is locked into the position when you
  bet, stake-weighted, so a late top-up cannot inherit an early rate.
* **Fees are collected in the stock itself.** A pool staked in NVDAx pays its fee in NVDAx, swept to that token's
  treasury account.
* On a test network the operator **seeds** a market with a small fee-free prize so an empty pool looks alive. **On
  mainnet there is no seed** (`SEED_MARKETS=1` overrides it for a deliberate promotion). If nobody picked the winning
  range, everyone is refunded; a **voided** market refunds everyone in full.
* Payouts are **pushed** to wallets by a permissionless crank after the dispute window. Nobody has to claim.
* **The one case the crank cannot pay**: the owner's token account for that stock was closed, frozen, or set to require a memo on incoming transfers after the bet.
  The crank reopens a closed account at its own cost when the payout is worth at least $0.50; a smaller one waits for
  the owner to reopen it. A position still unpayable 30 days after resolution can be forfeited to the treasury
  (`forfeit_position`; the program checks both the delay and the account), so a market can always be closed. The site
  asks for stakes of about $1 or more for the same reason.

## Why this works with no house money

SharePot is parimutuel, so **there is no house on the other side of your bet** — the players are each other's
counterparty. Three consequences worth stating plainly, because "who pays me if I win?" is the first question anyone
asks:

* **Nobody needs to fund the prize.** Winners are paid out of the losing ranges, which is money players put in
  themselves. The program never owes more than the vault holds.
* **A market with no counterparty cannot lose you money.** If everyone picks the same range, the losing pools are
  empty and every stake comes back. If nobody picks the winning range, everyone is refunded and no fee is charged
  (`compute_payout` in [`programs/sharepot/src/lib.rs`](programs/sharepot/src/lib.rs)). The worst case is a wasted
  session, not a loss.
* **The cold-start problem is about depth, not solvency.** Splitting a day's volume across 9 pools × 4 ranges makes
  every range look thin, which is why a mainnet launch starts with one or two pools rather than all nine.

## Leaderboard

Every settled market scores the wallets that were in it:

    points = shares staked × the official close the market settled on

That is what the stake was worth, in dollars, at settlement. Every range you bet counts, won or lost: one share on
each of the four ranges of a $212 close is 848 points, and only one of them can pay. The close is the one in the
evidence file the result was derived from, so NVDAx and NVDAon score alike and no token quote is involved. It is
frozen into the settlement record at payout time (`server/resolve.mjs`); `server/points.mjs` only adds up what the
crank wrote. The board is at `/leaderboard.html`, backed by `GET /api/leaderboard?window=7d|30d|all`.

## Invite links

Anyone who has placed a bet gets a link (`/?ref=CODE`, code derived from the wallet address). A wallet that arrives
through it and places its **first** bet is bound to that code — the wallet signs the binding, so nobody can claim
someone else's wallet, and the file is keyed by address, so the binding holds on devnet and mainnet alike.

Fees are charged on winnings only, in the pool's token. When a bound wallet's winning bet settles, the referrer earns
20 % of that fee (25 % from 10 000 all-time points, 30 % from 100 000) and the invitee gets 10 % of it back, both in
the same token. `deploy/referral-payout-remote.sh` pays the balance out once a week straight from the treasury (rebates are a
share of collected fees, so it always holds enough), from the machine that keeps the treasury key, never the app host;
before a settlement row earns anyone a rebate the payer finds its transaction on-chain and requires this program's
`PositionSettled` event for the same market, owner and fee (`server/settlement-proof.mjs`), so the app host's files
cannot invent fees; one run never sends more than $2,000 without a human; a wallet that does not hold the token yet
gets its account opened once the rebate reaches $10.
`data/referral-payouts.jsonl` is the ledger, `data/referrals.json` the bindings, and everything else is recomputed from
`settlements.jsonl` so nothing is counted twice. Rules and maths: `server/referrals.mjs` (tests in
`referrals.test.mjs`).

## Why you can trust the settlement

1. **The server never holds funds.** Stakes sit in a program-owned vault per market; only the program's payout math can
   move them.
2. **The proposer submits a number, not a winner.** The resolver reads the official daily closes (Yahoo Finance chart
   API; `PRICE_SOURCE=alpaca` switches to Alpaca SIP daily bars — both agree to the cent), computes the close-to-close
   move and proposes it together with the **sha256 of the raw price response**. The winning range is derived
   **on-chain** from the market's thresholds.
   Before it proposes, the number has to pass three checks, and a failed check holds the market for the next run
   instead of posting a wrong result: the bar before the target must be the calendar's previous session (a dropped bar
   would silently shift "previous close" back a day); the target bar must be final (the source's last regular trade
   at or after the closing bell, so an intraday price is never mistaken for the close); and the close must **match
   Nasdaq's official close to the cent** — an independent second source with no key. Closes that differ but leave
   the day in the same range settle on the primary, with the difference written into the evidence; closes that put
   the day in different ranges are never proposed, and if 24 h of retries do not reconcile them the market refunds
   itself. If Nasdaq has nothing for the
   day yet the resolver waits up to two hours after the bell, then proceeds on the primary alone and says so in the
   published evidence. Fetches retry on network errors; whatever still fails is retried by cron every ten minutes.
3. **Anyone can check the number.** The raw response is published byte for byte; the market page re-hashes it **in
   your browser** and shows whether it matches the hash stored on-chain.
4. **Dispute window.** A proposal can be disputed (wallet-signed) for six hours on devnet; it can be corrected by
   re-proposing, which restarts the window. After the window anyone can finalize. A dispute, a held-back market, a
   disagreement between the price sources, a market that is overdue or a payout that keeps failing each page the
   operator (Telegram), so the window is never left to run out unwatched.
5. **Betting closes before any of the answer exists.** Bets stop at the opening bell of the session being predicted.
6. **Integer math end to end.** Moves are stored in ppm and floored, so a fall of any size can never round onto the
   0 % threshold; the page floors to whole basis points for the same reason.

### Trust model, stated plainly

* **The proposer key can propose any number.** The checks above run off-chain, in the same process that holds the key.
  A compromised resolver could propose a wrong move; the range still comes from the on-chain thresholds, but a wrong
  input gives a wrong range. What stops it is the six-hour window and a second machine: `server/verify-proposals.mjs`
  runs every ten minutes on a different host that holds the admin key, fetches the closes itself (for on-chain closes:
  from its own per-minute samples), and **voids a proposal whose range it cannot reproduce** — a full refund, never a
  different winner. A proposal it still cannot check 45 minutes before the window closes (no price source
  answered) is voided too: nothing settles on a value nobody re-derived (`server/verify-policy.mjs`). For an on-chain close, a disagreement within 0.5 % of a threshold only pages the operator (two samplers never see the same quotes). Disputes are recorded off-chain and
  have no on-chain effect by themselves.
* **The admin is fully trusted.** The admin can finalize inside the window, void any open or proposed market
  (full refund), and change the proposer, treasury and fee (capped at 10 %; a bet already placed keeps its rate). The admin cannot move
  vault funds anywhere but to winners (per the payout math) or, after every position is settled, fees and dust to the
  treasury.
* **The issuer is trusted by construction.** Every xStock carries a permanent delegate and a pause switch; the vaults
  are ordinary token accounts to the issuer. Nothing on Solana can change that, so the site says it on every page.
* **On devnet** both keys are single hot keys: the proposer lives on the server, the admin does not. **Before mainnet**
  the admin, the upgrade authority and the treasury move to a 2-of-3 Squads multisig that the server is not a member
  of; the server keeps only the proposer key, which can never touch funds. Corrections then need a second signature
  and the window gives the time to gather it.
* **A market whose price never comes refunds itself.** Still unproposed 24 h after its resolve time (a session that
  never traded, a token whose quotes disappeared), a market may be voided by the proposer (`void_stale_market`; the
  program checks the delay) and the crank refunds every stake. That is the only power the proposer has beyond
  proposing a number: it can return money, never pick a winner.

We do not settle on Pyth: since 2026-08-26 Hermes requires an API key for both latest and historical prices, and its
equity feed reports the last trade before 16:00, not the official closing print these markets are defined on.

## Built for xStocks specifically

xStocks are Token-2022 mints with several extensions. The program and the tests take each of them into account:

* **Token-2022 transfers.** Every movement uses `transfer_checked` through the token interface; classic SPL mints work
  through the same path.
* **One mint per market.** Each market records its stock mint; bets, payouts and fee sweeps must use that mint and the
  matching token accounts (wrong mint, wrong wallet or wrong treasury account are rejected).
* **Extension-aware vaults.** Vault accounts are sized for whatever account extensions the mint requires.
* **Booked at what arrives.** `place_bet` and `seed_market` record the vault's balance change, not the amount sent,
  so mints with a transfer fee (Tessera, PreStocks) run pools that never exceed their vault. Only an active transfer
  hook is refused at `create_market`. xStocks, Ondo Global Markets and Backpack Securities tokens carry neither; the
  program itself is issuer-agnostic.
* **Dividends and splits.** All accounting is in raw units, so a `ScaledUiAmount` multiplier change scales every pool,
  stake and payout alike (tested mid-market).
* **Issuer controls, disclosed.** The issuer holds a permanent delegate, a pause switch and an (empty) transfer-hook
  slot on every xStock. It can move or freeze tokens in any account, these vaults included; while a mint is paused no
  bet, payout or sweep for it can move. The tests pause and resume a mint mid-market and show that everything settles
  correctly afterwards. The site states this on every page.

## Pre-IPO tokens and memes: the same pool, an on-chain close

Two more token classes run on the same program. There is no exchange for them, so **a day's close is read on-chain**:

* **Pre-IPO**: T-OpenAI and T-Kalshi (Tessera) and OpenAI (PreStocks), one pool per token per UTC day. The pool
  settles on the token's on-chain price, the only price anyone can actually trade at.
* **Memes**: `server/select-chain.mjs` runs at 11:00 UTC and picks the ten Solana tokens with the most 24-hour traded
  volume (Jupiter's top-traded list) for the next day, subject to filters: mint and freeze authority given up, liquidity
  ≥ $500k, first pool ≥ 3 days old, no wrapped/bridged assets, no tokenized stocks, DeFi or "strict"-list tokens.
  They are recorded in `data/chain-tokens.json`; on devnet the opener mints a mock per token and stocks the faucet.
* **Close** = median of one Jupiter quote per minute during the day's last hour (23:00–24:00 UTC), sampled by
  `server/sample-prices.mjs` into `data/ticks/<date>.jsonl`. Metric tag `<SYMBOL>.day:<date>`; the move is that day's
  close against the previous day's, both read from the samples at resolution and published together as evidence.
  Fewer than 40 usable quotes on either day voids the market (full refund). Jupiter is the one settlement source —
  the same feed the site shows as "now" and "prev close". Every sample also records a second quote (DexScreener),
  published with the evidence for comparison only: two venues trade at different prices, so it never decides or
  holds a market.
* **Three ranges** (down / flat / up) cut at ± the token's median absolute daily move over 60 days (GeckoTerminal).
  A day's pool opens at 11:00 UTC the day before and locks at 12:00 UTC on the day, so there is always one to bet into
  (tomorrow's opens before today's locks); resolution after 00:05 the next day, same dispute window and crank as the
  stock pools.
* **Transfer fees.** Tessera (0.2 %) and PreStocks (0.5 %) mints charge on every transfer. `place_bet` and `seed_market`
  book what the vault actually received (balance before/after the transfer), so the pools never exceed the vault and a
  payout simply lands net of the issuer's fee. Before a fee-mint vault is closed the crank harvests the withheld fees to
  the mint (`HarvestWithheldTokensToMint`, permissionless); Token-2022 refuses to close an account holding any.

## Layout

```
programs/sharepot   Anchor program (Rust): per-stock parimutuel pools, Token-2022, on-chain range derivation
tests/              15 tests against a local validator with mock xStocks carrying the real TSLAx extension set
server/             market opener (NYSE calendar), resolver + settlement crank, API + devnet faucet + static site
web/                market pages, Wallet Standard betting (Phantom, Solflare, Backpack), "My bets"
scripts/            devnet bootstrap (mock xStocks, faucet, config), replay markets for demos, admin tools
idl/                program IDL + TypeScript types
examples/           automate.mjs: list open pools, bet, read results from a script
```

## Languages

The site speaks English, 繁體中文, 简体中文, 日本語, 한국어 and Español. The server picks one per request — a `?lang=`
link, then the picker's cookie, then the browser's `Accept-Language` — and sends the page already in that language
(static text, the pre-rendered market cards, dates in the viewer's locale), so nothing flashes in English first. The
page's scripts get the same dictionary from a cacheable `/i18n/<lang>.js`. Dictionaries are plain JSON in
`web/src/i18n/`; `server/i18n.test.mjs` fails if a language misses a key, a `{slot}` or a tag, or if a page's English
drifts from `en.json`. Adding a language is two JSON files and one row in `LANGS`.

## Program

Instruction | Who | What
--- | --- | ---
`initialize` / `update_config` | admin | proposer, treasury owner, fee (≤ 10 % hard cap), early-bird, dispute window, min bet, pause
`create_market` | admin or proposer | stock mint, metric tag, question hash, thresholds + range count, open/close/resolve times; creates the vault
`seed_market` | anyone | add a fee-free prize in the market's stock
`place_bet` | anyone | range index + amount of the stock; fee rate locked into the position
`propose_resolution` | proposer or admin | observed move + evidence hash; range derived on-chain; starts the dispute window
`finalize_resolution` | anyone after the window, admin any time | locks the outcome
`void_market` | admin | refund everyone
`void_stale_market` | proposer or admin | refund everyone in a market still unproposed 24 h after its resolve time
`settle_position` | anyone | pay one position in the stock, close it, refund its rent to the payer
`forfeit_position` | anyone after 30 days, admin any time | only if the owner's token account is gone, frozen or set to require memos: the payout goes to the treasury, the position closes
`sweep_market` | anyone | after all positions are settled: fees + dust to the treasury's account for that stock, close the vault and the market account; their rent goes back to the proposer that paid it

Program id: `8TzdVXpqa52o3fBvYynSxHTWP4zuWfZmTvSkpdLT9rWW`

## Automation: the API and the program

A bot needs three things: which pools are open, a way to bet, and the results. The first and the third are the
public read API (no key, open CORS); the second is the program, signed by the bot's own wallet. There is no
server-side bet endpoint, so nobody can bet with your tokens but you.

Endpoint | What
--- | ---
`GET /api/markets`, `GET /api/markets/<id>` | every market / one market. `status`: 0 open, 1 proposed, 2 resolved, 3 voided, 4 settled and swept. A bet is accepted while status is 0 and now is between `openTs` and `closeTs` (unix seconds)
`GET /api/config` | fee, early-bird discount, dispute window, minimum bet (base units)
`GET /api/stocks`, `GET /api/prices` | the tokens with mints and decimals; the live prices the site shows
`GET /api/evidence/<id>`, `…/raw` | the settlement evidence; `/raw` is the exact bytes whose sha256 is on-chain
`GET /api/positions/<wallet>` | every payout the crank pushed to a wallet, with its signature
`GET /api/leaderboard?window=7d\|30d\|all` | the points board
`POST /api/faucet {"address"}` | devnet only: mock shares of every open pool plus a little SOL, once a day per wallet

Units: `thresholds` and the observed move `proposedValue` are in ppm (1 % = 10 000); range 0 is below the first
threshold, the last range at or above the last one, `outcome` is the winning range. `pools` and bet amounts are in base
units (shares × 10^`decimals`). Betting is the program's `place_bet(range, amount)` instruction (IDL in `idl/`);
payouts are pushed to the wallet after the dispute window, nothing to claim. Market data is cached for 15 s; the
faucet, disputes and feedback are limited per address and per day.

[`examples/automate.mjs`](examples/automate.mjs) does all of it in 80 lines (Node 22, `cd server && npm ci` once):

```sh
node examples/automate.mjs markets                 # open pools: id, ranges, closes in, pool sizes
node examples/automate.mjs bet 153 1 0.5           # 0.5 shares on range 1 of market #153, signed by KEYPAIR
node examples/automate.mjs results <wallet>        # settled markets, and what that wallet was paid
```

## Running it locally

```bash
anchor build
./scripts/test-local.sh                       # fresh validator + the 15 tests

# a local cluster with mock xStocks, a faucet and today's markets
solana-test-validator --reset --bpf-program 8TzdVXpqa52o3fBvYynSxHTWP4zuWfZmTvSkpdLT9rWW target/deploy/sharepot.so &
export ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=~/.config/solana/id.json
SHAREPOT_SECRETS=./.local npx ts-node scripts/devnet-setup.ts
CLUSTER=localnet STATE=./.local/state.json node server/open-markets.mjs
(cd server && npm i) && (cd web && npm i && VITE_CLUSTER=localnet npm run build)
CLUSTER=localnet SHAREPOT_SECRETS=./.local CLUSTER_RPC=http://127.0.0.1:8899 node server/api.mjs   # site + API on :5041

# watch a full cycle in minutes: a market on a past session, resolved from its real official close
SYMBOL=TSLA SESSION=2026-09-11 BET_SECS=120 CLUSTER=localnet STATE=./.local/state.json node scripts/quick-market.mjs
CLUSTER=localnet SHAREPOT_SECRETS=./.local ADMIN_FINALIZE=1 ADMIN_KEYPAIR=$ANCHOR_WALLET node server/resolve.mjs
```

## Status and next steps

* devnet: live since 2026-09-14 — program `8TzdVXpqa52o3fBvYynSxHTWP4zuWfZmTvSkpdLT9rWW`, config
  `3tS4yRS8HrrSnNi4or5UGbfAyFpFrXTJAF3BNMivF5Uh`; nine mock stock tokens copying each issuer's mainnet extension set
  and decimals; markets open and settle on a schedule (`deploy/crontab.txt`), payouts are pushed automatically.
* Next: weekend markets on the 24/7 xStock price, mainnet with real xStocks after an audit, upgrade authority and
  treasury behind a Squads multisig.

## License

MIT
