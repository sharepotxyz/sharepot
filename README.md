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
browser test wallet, then press "Get test stocks": every wallet gets 2 mock shares of each listed token plus a little
SOL for fees. A new pool opens for every token at each US opening bell.

## How a market works

* **One market per stock per US trading session.** The market for session S opens at the previous session's opening
  bell and **stops taking bets at S's opening bell (09:30 New York)**, so there is always exactly one pool per stock you
  can bet into, around the clock.
* It settles on the **official close of S against the official close of the session before**, in four ranges:
  big drop / small drop / small gain / big gain. The cuts are set near the quartiles of each stock's daily moves over
  the last 12 weeks (TSLA −1.75 % / 0 / +2 %, NVDA −1.5 % / 0 / +2.25 %, SPY −0.5 % / 0 / +0.5 %), so every range
  starts out roughly equally likely. Odds then move with the pools.
* Session times come from the NYSE holiday calendar built into the server (holidays, early closes, daylight saving;
  checked session by session against a broker's market calendar for the rest of 2026). A date in a year that is not
  in the table stops the scheduler instead of guessing.

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
* The operator may **seed** a market with a fee-free prize in the stock; it goes to the winners. If nobody picked the
  winning range, everyone is refunded and the seed returns to the treasury. A **voided** market refunds everyone in full.
* Payouts are **pushed** to wallets by a permissionless crank after the dispute window. Nobody has to claim.

## Why you can trust the settlement

1. **The server never holds funds.** Stakes sit in a program-owned vault per market; only the program's payout math can
   move them.
2. **The proposer submits a number, not a winner.** The resolver reads the official daily closes (Yahoo Finance chart
   API; `PRICE_SOURCE=alpaca` switches to Alpaca SIP daily bars — both agree to the cent), computes the close-to-close
   move and proposes it together with the **sha256 of the raw price response**. The winning range is derived
   **on-chain** from the market's thresholds.
3. **Anyone can check the number.** The raw response is published byte for byte; the market page re-hashes it **in
   your browser** and shows whether it matches the hash stored on-chain.
4. **Dispute window.** A proposal can be disputed (wallet-signed) for six hours on devnet; it can be corrected by
   re-proposing, which restarts the window. After the window anyone can finalize.
5. **Betting closes before any of the answer exists.** Bets stop at the opening bell of the session being predicted.
6. **Integer math end to end.** Moves are stored in ppm and floored, so a fall of any size can never round onto the
   0 % threshold; the page floors to whole basis points for the same reason.

We do not settle on Pyth: since 2026-08-26 Hermes requires an API key for both latest and historical prices, and its
equity feed reports the last trade before 16:00, not the official closing print these markets are defined on.

## Built for xStocks specifically

xStocks are Token-2022 mints with several extensions. The program and the tests take each of them into account:

* **Token-2022 transfers.** Every movement uses `transfer_checked` through the token interface; classic SPL mints work
  through the same path.
* **One mint per market.** Each market records its stock mint; bets, payouts and fee sweeps must use that mint and the
  matching token accounts (wrong mint, wrong wallet or wrong treasury account are rejected).
* **Extension-aware vaults.** Vault accounts are sized for whatever account extensions the mint requires.
* **Only tokens that arrive in full.** Pools are booked at the amount sent, so `create_market` refuses mints with a
  transfer fee (some pre-IPO tokens on Solana carry one) or an active transfer hook. xStocks, Ondo Global Markets and
  Backpack Securities tokens all pass; the program itself is issuer-agnostic.
* **Dividends and splits.** All accounting is in raw units, so a `ScaledUiAmount` multiplier change scales every pool,
  stake and payout alike (tested mid-market).
* **Issuer controls, disclosed.** The issuer holds a permanent delegate, a pause switch and an (empty) transfer-hook
  slot on every xStock. It can move or freeze tokens in any account, these vaults included; while a mint is paused no
  bet, payout or sweep for it can move. The tests pause and resume a mint mid-market and show that everything settles
  correctly afterwards. The site states this on every page.

## Layout

```
programs/sharepot   Anchor program (Rust): per-stock parimutuel pools, Token-2022, on-chain range derivation
tests/              13 tests against a local validator with mock xStocks carrying the real TSLAx extension set
server/             market opener (NYSE calendar), resolver + settlement crank, API + devnet faucet + static site
web/                market pages, Wallet Standard betting (Phantom, Solflare, Backpack), "My bets"
scripts/            devnet bootstrap (mock xStocks, faucet, config), replay markets for demos, admin tools
idl/                program IDL + TypeScript types
```

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
`settle_position` | anyone | pay one position in the stock, close it, refund its rent to the payer
`sweep_market` | anyone | after all positions are settled: fees + dust to the treasury's account for that stock, close the vault

Program id: `8TzdVXpqa52o3fBvYynSxHTWP4zuWfZmTvSkpdLT9rWW`

## Running it locally

```bash
anchor build
./scripts/test-local.sh                       # fresh validator + the 13 tests

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
