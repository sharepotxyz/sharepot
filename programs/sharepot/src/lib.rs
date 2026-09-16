//! SharePot — parimutuel prediction pools on US stocks, staked and paid out in the
//! tokenized stock itself (xStocks on Solana).
//!
//! Money model (see README):
//! * Each market belongs to ONE tokenized stock (its SPL / Token-2022 mint). Every bet,
//!   payout, fee and house seed is in that same token, so a holder never sells the
//!   stock to play, and a winner ends up with more shares rather than dollars.
//! * Each market has 2..=8 outcome buckets defined by sorted thresholds on one metric
//!   (e.g. the day's close-to-close move in basis points). A yes/no market is simply
//!   2 buckets with 1 threshold. Each bucket has its own pool.
//! * Winners get their stake back plus a pro-rata share of all losing pools.
//! * The protocol fee is charged ONLY on the share of the losing pool a winner
//!   receives, never on the winner's own stake. Fee bps is locked per bet
//!   (stake-weighted per position) so the early-bird discount cannot be gamed by
//!   topping up later.
//! * House "seed" (prize added by the treasury) is split pro-rata among winners
//!   with no fee.
//! * Resolution is two-step: the proposer (server key) submits only the observed
//!   VALUE plus the hash of the price evidence; the winning bucket is derived on-chain,
//!   so the proposer never picks an outcome directly. Anyone can finalize after the
//!   dispute window, or the admin key can finalize/void immediately.
//! * Settlement is permissionless: a crank pays every position out to its
//!   owner's token account and closes it, refunding rent to whoever paid it.
//!
//! Issuer controls (read before depositing): xStocks mints carry a permanent delegate,
//! a pause switch and a (currently empty) transfer-hook slot, all held by the issuer.
//! The issuer can therefore move or freeze tokens in any account, these vaults included,
//! and while a mint is paused no bet, payout or sweep can move. All accounting is in raw
//! units, so a ScaledUiAmount multiplier change (dividend, split) scales every pool,
//! stake and payout alike.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked};
use anchor_spl::token_2022::spl_token_2022::{
    extension::{transfer_hook::TransferHook, BaseStateWithExtensions, StateWithExtensions},
    state::Mint as MintState,
};

declare_id!("8TzdVXpqa52o3fBvYynSxHTWP4zuWfZmTvSkpdLT9rWW");

pub const BPS: u128 = 10_000;
pub const MAX_FEE_BPS: u16 = 1_000; // 10% hard ceiling, protects users from a hostile config
pub const MAX_BUCKETS: usize = 8;
pub const MAX_THRESHOLDS: usize = MAX_BUCKETS - 1;
pub const NO_OUTCOME: u8 = 255;

#[program]
pub mod sharepot {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, args: ConfigArgs) -> Result<()> {
        args.validate()?;
        let c = &mut ctx.accounts.config;
        c.admin = ctx.accounts.admin.key();
        c.proposer = args.proposer;
        c.treasury_owner = args.treasury_owner;
        c.fee_bps = args.fee_bps;
        c.early_bird_discount_bps = args.early_bird_discount_bps;
        c.early_bird_secs = args.early_bird_secs;
        c.dispute_window_secs = args.dispute_window_secs;
        c.min_bet = args.min_bet;
        c.market_count = 0;
        c.paused = false;
        c.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn update_config(ctx: Context<AdminOnly>, args: ConfigArgs, new_admin: Option<Pubkey>, paused: bool) -> Result<()> {
        args.validate()?;
        let c = &mut ctx.accounts.config;
        c.proposer = args.proposer;
        c.treasury_owner = args.treasury_owner;
        c.fee_bps = args.fee_bps;
        c.early_bird_discount_bps = args.early_bird_discount_bps;
        c.early_bird_secs = args.early_bird_secs;
        c.dispute_window_secs = args.dispute_window_secs;
        c.min_bet = args.min_bet;
        c.paused = paused;
        if let Some(a) = new_admin {
            c.admin = a;
        }
        Ok(())
    }

    /// One market = one stock token. The vault is a PDA token account of that mint, sized by Anchor
    /// for whatever account extensions the mint requires (xStocks: pausable, transfer-hook).
    pub fn create_market(ctx: Context<CreateMarket>, args: MarketArgs) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(args.close_ts > args.open_ts, PotError::BadSchedule);
        require!(args.close_ts > now, PotError::BadSchedule);
        require!(args.resolve_after_ts >= args.close_ts, PotError::BadSchedule);
        let n = args.n_buckets as usize;
        require!((2..=MAX_BUCKETS).contains(&n), PotError::BadBuckets);
        for i in 1..(n - 1) {
            require!(args.thresholds[i] > args.thresholds[i - 1], PotError::BadBuckets);
        }
        // Pools are booked at what the vault actually receives (place_bet / seed_market read the vault balance before
        // and after the transfer), so a mint with a transfer fee (Tessera 0.2 %, PreStocks 0.5 %) is fine: the fee
        // the issuer withholds never enters the pools, and payouts are sent from a vault that holds exactly the pools.
        // An active transfer hook needs extra accounts this program does not pass: still refused here.
        {
            let info = ctx.accounts.mint.to_account_info();
            if *info.owner == anchor_spl::token_2022::ID {
                let data = info.try_borrow_data()?;
                let mint = StateWithExtensions::<MintState>::unpack(&data)?;
                if let Ok(hook) = mint.get_extension::<TransferHook>() {
                    require!(hook.program_id == Default::default(), PotError::UnsupportedMint);
                }
            }
        }
        let c = &mut ctx.accounts.config;
        let m = &mut ctx.accounts.market;
        m.id = c.market_count;
        m.mint = ctx.accounts.mint.key();
        m.metric = args.metric;
        m.question_hash = args.question_hash;
        m.thresholds = args.thresholds;
        m.n_buckets = args.n_buckets;
        m.outcome = NO_OUTCOME;
        m.proposed_outcome = NO_OUTCOME;
        m.open_ts = args.open_ts;
        m.close_ts = args.close_ts;
        m.resolve_after_ts = args.resolve_after_ts;
        m.baseline = args.baseline;
        m.status = MarketStatus::Open as u8;
        m.vault = ctx.accounts.vault.key();
        m.bump = ctx.bumps.market;
        c.market_count = c.market_count.checked_add(1).unwrap();
        emit!(MarketCreated { market: m.key(), id: m.id, mint: m.mint, metric: m.metric, n_buckets: m.n_buckets, thresholds: m.thresholds, open_ts: m.open_ts, close_ts: m.close_ts });
        Ok(())
    }

    /// Anyone (normally the treasury) adds a fee-free prize to the pot. Note: on void or
    /// no-winner the seed is swept to the treasury, not returned to a third-party funder.
    pub fn seed_market(ctx: Context<SeedMarket>, amount: u64) -> Result<()> {
        require!(amount > 0, PotError::ZeroAmount);
        {
            let m = &ctx.accounts.market;
            require!(m.status == MarketStatus::Open as u8, PotError::MarketNotOpen);
            require!(Clock::get()?.unix_timestamp < m.close_ts, PotError::BettingClosed);
        }
        let before = ctx.accounts.vault.amount;
        token_interface::transfer_checked(ctx.accounts.transfer_ctx(), amount, ctx.accounts.mint.decimals)?;
        ctx.accounts.vault.reload()?;
        let credited = ctx.accounts.vault.amount.checked_sub(before).ok_or(PotError::MathOverflow)?;
        require!(credited > 0, PotError::ZeroAmount);
        let m = &mut ctx.accounts.market;
        m.seed_amount = m.seed_amount.checked_add(credited).unwrap();
        Ok(())
    }

    pub fn place_bet(ctx: Context<PlaceBet>, bucket: u8, amount: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let fee_bps = {
            let c = &ctx.accounts.config;
            let m = &ctx.accounts.market;
            require!(!c.paused, PotError::Paused);
            require!(m.status == MarketStatus::Open as u8, PotError::MarketNotOpen);
            require!(now >= m.open_ts, PotError::BettingNotStarted);
            require!(now < m.close_ts, PotError::BettingClosed);
            require!(amount >= c.min_bet, PotError::BelowMinBet);
            require!((bucket as usize) < m.n_buckets as usize, PotError::BadBuckets);
            // Fee tier is decided now and locked into the position, stake-weighted.
            // Early-bird window = the first quarter of the betting window, capped by config.early_bird_secs.
            let mut fee_bps = c.fee_bps;
            if now < m.open_ts.saturating_add(Market::early_bird_secs(c, m)) {
                fee_bps = fee_bps.saturating_sub(c.early_bird_discount_bps);
            }
            fee_bps
        };
        // Move the tokens first, then book-keep (borrow checker: CPI needs &ctx.accounts). The stake is what the
        // vault received: on a mint with a transfer fee that is less than `amount`, and only the credited part can
        // ever be paid back out, so only that part joins the pool.
        let before = ctx.accounts.vault.amount;
        token_interface::transfer_checked(ctx.accounts.transfer_ctx(), amount, ctx.accounts.mint.decimals)?;
        ctx.accounts.vault.reload()?;
        let amount = ctx.accounts.vault.amount.checked_sub(before).ok_or(PotError::MathOverflow)?;
        require!(amount > 0, PotError::ZeroAmount);
        let user_key = ctx.accounts.user.key();
        let position_bump = ctx.bumps.position;
        let m = &mut ctx.accounts.market;
        let p = &mut ctx.accounts.position;
        if p.owner == Pubkey::default() {
            p.market = m.key();
            p.owner = user_key;
            p.payer = user_key;
            p.bump = position_bump;
            m.positions = m.positions.checked_add(1).unwrap();
            m.positions_open = m.positions_open.checked_add(1).unwrap();
        }
        let fee_w = (amount as u128).checked_mul(fee_bps as u128).unwrap();
        let b = bucket as usize;
        p.amounts[b] = p.amounts[b].checked_add(amount).unwrap();
        p.fee_w[b] = p.fee_w[b].checked_add(fee_w).unwrap();
        m.pools[b] = m.pools[b].checked_add(amount).unwrap();
        emit!(BetPlaced { market: m.key(), user: p.owner, bucket, amount, fee_bps, pools: m.pools });
        Ok(())
    }

    /// Proposer publishes the observed value plus the hash of the price evidence
    /// it came from. The winning bucket is derived here, on-chain. Starts the dispute window.
    pub fn propose_resolution(ctx: Context<Propose>, observed_value: i64, snapshot_hash: [u8; 32]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let m = &mut ctx.accounts.market;
        // A proposal may be corrected while it is still disputable; every re-proposal restarts the window.
        require!(m.status == MarketStatus::Open as u8 || m.status == MarketStatus::Proposed as u8, PotError::MarketNotOpen);
        require!(now >= m.resolve_after_ts, PotError::TooEarlyToResolve);
        let bucket = m.bucket_of(observed_value);
        m.status = MarketStatus::Proposed as u8;
        m.proposed_outcome = bucket;
        m.proposed_value = observed_value;
        m.proposed_at = now;
        m.snapshot_hash = snapshot_hash;
        emit!(ResolutionProposed { market: m.key(), bucket, observed_value, snapshot_hash, proposed_at: now });
        Ok(())
    }

    /// Anyone after the dispute window; admin immediately.
    pub fn finalize_resolution(ctx: Context<Finalize>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let c = &ctx.accounts.config;
        let m = &mut ctx.accounts.market;
        require!(m.status == MarketStatus::Proposed as u8, PotError::NotProposed);
        let is_admin = ctx.accounts.signer.key() == c.admin;
        require!(is_admin || now >= m.proposed_at.saturating_add(c.dispute_window_secs), PotError::DisputeWindowOpen);
        m.status = MarketStatus::Resolved as u8;
        m.outcome = m.proposed_outcome;
        m.resolved_at = now;
        emit!(MarketResolved { market: m.key(), bucket: m.outcome, voided: false });
        Ok(())
    }

    /// Admin escape hatch: every position is refunded in full, seed goes back to treasury.
    pub fn void_market(ctx: Context<AdminMarket>) -> Result<()> {
        let m = &mut ctx.accounts.market;
        require!(m.status == MarketStatus::Open as u8 || m.status == MarketStatus::Proposed as u8, PotError::AlreadyFinal);
        m.status = MarketStatus::Voided as u8;
        m.resolved_at = Clock::get()?.unix_timestamp;
        emit!(MarketResolved { market: m.key(), bucket: NO_OUTCOME, voided: true });
        Ok(())
    }

    /// Permissionless payout + close. Winners are paid, losers just get their
    /// rent back. Works for Resolved and Voided markets.
    pub fn settle_position(ctx: Context<Settle>) -> Result<()> {
        let (payout, fee, owner, id_bytes, bump) = {
            let m = &ctx.accounts.market;
            let p = &ctx.accounts.position;
            require!(m.status == MarketStatus::Resolved as u8 || m.status == MarketStatus::Voided as u8, PotError::NotResolved);
            let (payout, fee) = compute_payout(m, p)?;
            (payout, fee, p.owner, m.id.to_le_bytes(), m.bump)
        };
        if payout > 0 {
            let seeds: &[&[u8]] = &[b"market", id_bytes.as_ref(), &[bump]];
            token_interface::transfer_checked(ctx.accounts.transfer_ctx().with_signer(&[seeds]), payout, ctx.accounts.mint.decimals)?;
        }
        let m = &mut ctx.accounts.market;
        m.fee_collected = m.fee_collected.checked_add(fee).unwrap();
        m.paid_out = m.paid_out.checked_add(payout).unwrap();
        m.positions_open = m.positions_open.checked_sub(1).unwrap();
        emit!(PositionSettled { market: m.key(), user: owner, payout, fee });
        Ok(())
    }

    /// After every position is settled: fees + rounding dust (+ seed if voided or
    /// no winners) go to the treasury's account for this stock, vault is closed.
    pub fn sweep_market(ctx: Context<Sweep>) -> Result<()> {
        let (id_bytes, bump) = {
            let m = &ctx.accounts.market;
            require!(m.status == MarketStatus::Resolved as u8 || m.status == MarketStatus::Voided as u8, PotError::NotResolved);
            require!(m.positions_open == 0, PotError::PositionsOutstanding);
            (m.id.to_le_bytes(), m.bump)
        };
        let remaining = ctx.accounts.vault.amount;
        let seeds: &[&[u8]] = &[b"market", id_bytes.as_ref(), &[bump]];
        if remaining > 0 {
            token_interface::transfer_checked(ctx.accounts.transfer_ctx().with_signer(&[seeds]), remaining, ctx.accounts.mint.decimals)?;
        }
        token_interface::close_account(ctx.accounts.close_ctx().with_signer(&[seeds]))?;
        let m = &mut ctx.accounts.market;
        m.swept = remaining;
        m.status = MarketStatus::Swept as u8;
        Ok(())
    }
}

/// Returns (payout_to_owner, fee_taken_from_that_payout).
pub fn compute_payout(m: &Market, p: &Position) -> Result<(u64, u64)> {
    let total_stake: u64 = p.amounts.iter().fold(0u64, |a, x| a.checked_add(*x).unwrap());
    let refund_all = || Ok::<(u64, u64), Error>((total_stake, 0));
    if m.status == MarketStatus::Voided as u8 {
        return refund_all();
    }
    let w = m.outcome as usize;
    require!(w < m.n_buckets as usize, PotError::NotResolved);
    let win_pool = m.pools[w];
    let lose_pool = m.total_pool().checked_sub(win_pool).unwrap();
    let stake = p.amounts[w];
    let fee_w = p.fee_w[w];
    // Nobody on the winning side: everyone is made whole, house seed returns via sweep.
    if win_pool == 0 {
        return refund_all();
    }
    if stake == 0 {
        return Ok((0, 0));
    }
    let stake128 = stake as u128;
    let win128 = win_pool as u128;
    let gross_share = (lose_pool as u128).checked_mul(stake128).ok_or(PotError::MathOverflow)? / win128;
    // Stake-weighted fee rate for this position: fee_w = Σ amount_i × bps_i, so fee_w / stake ≤ MAX_FEE_BPS.
    // Reducing to bps first keeps every product far below u128::MAX for any conceivable mint supply.
    let weighted_bps = (fee_w / stake128).min(MAX_FEE_BPS as u128);
    let fee = gross_share.checked_mul(weighted_bps).ok_or(PotError::MathOverflow)? / BPS;
    let seed_share = (m.seed_amount as u128).checked_mul(stake128).ok_or(PotError::MathOverflow)? / win128;
    let payout = stake128.checked_add(gross_share).and_then(|v| v.checked_sub(fee)).and_then(|v| v.checked_add(seed_share)).ok_or(PotError::MathOverflow)?;
    Ok((u64::try_from(payout).map_err(|_| PotError::MathOverflow)?, u64::try_from(fee).map_err(|_| PotError::MathOverflow)?))
}

// ---------- state ----------

impl Market {
    /// Seconds after open during which the early-bird discount applies: min(config cap, 25 % of the window).
    pub fn early_bird_secs(c: &Config, m: &Market) -> i64 {
        let quarter = m.close_ts.saturating_sub(m.open_ts) / 4;
        c.early_bird_secs.min(quarter).max(0)
    }
    /// Bucket index for a value: number of active thresholds the value reaches.
    /// bucket 0 = below thresholds[0]; bucket n-1 = at or above thresholds[n-2].
    pub fn bucket_of(&self, value: i64) -> u8 {
        let n = self.n_buckets as usize;
        let mut b = 0u8;
        for i in 0..(n - 1) {
            if value >= self.thresholds[i] {
                b = (i + 1) as u8;
            }
        }
        b
    }
    pub fn total_pool(&self) -> u64 {
        self.pools.iter().fold(0u64, |a, x| a.checked_add(*x).unwrap())
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum MarketStatus {
    Open = 0,
    Proposed = 1,
    Resolved = 2,
    Voided = 3,
    Swept = 4,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ConfigArgs {
    pub proposer: Pubkey,
    /// Wallet that owns the per-stock treasury token accounts (fees + unused seed land there).
    pub treasury_owner: Pubkey,
    pub fee_bps: u16,
    pub early_bird_discount_bps: u16,
    pub early_bird_secs: i64,
    pub dispute_window_secs: i64,
    /// Raw units of whichever stock token the market uses (xStocks: 8 decimals).
    pub min_bet: u64,
}
impl ConfigArgs {
    fn validate(&self) -> Result<()> {
        require!(self.fee_bps <= MAX_FEE_BPS, PotError::FeeTooHigh);
        require!(self.early_bird_discount_bps <= self.fee_bps, PotError::FeeTooHigh);
        require!(self.early_bird_secs >= 0 && self.dispute_window_secs >= 0, PotError::BadSchedule);
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct MarketArgs {
    pub metric: [u8; 32],
    pub question_hash: [u8; 32],
    /// Sorted, strictly increasing; only the first n_buckets-1 entries are used.
    pub thresholds: [i64; MAX_THRESHOLDS],
    pub n_buckets: u8,
    pub open_ts: i64,
    pub close_ts: i64,
    pub resolve_after_ts: i64,
    /// Reference value at market open (e.g. the previous close, price × 1e8). Informational for
    /// move markets, where the observed value is already the move in bps.
    pub baseline: i64,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub proposer: Pubkey,
    pub treasury_owner: Pubkey,
    pub fee_bps: u16,
    pub early_bird_discount_bps: u16,
    pub early_bird_secs: i64,
    pub dispute_window_secs: i64,
    pub min_bet: u64,
    pub market_count: u64,
    pub paused: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub id: u64,
    /// The stock token this market is staked and paid in.
    pub mint: Pubkey,
    pub metric: [u8; 32],
    pub question_hash: [u8; 32],
    pub thresholds: [i64; MAX_THRESHOLDS],
    pub n_buckets: u8,
    pub open_ts: i64,
    pub close_ts: i64,
    pub resolve_after_ts: i64,
    /// Reference value at open (see MarketArgs::baseline).
    pub baseline: i64,
    pub pools: [u64; MAX_BUCKETS],
    pub seed_amount: u64,
    pub status: u8,
    /// Winning bucket index once resolved; NO_OUTCOME otherwise.
    pub outcome: u8,
    pub proposed_outcome: u8,
    pub proposed_value: i64,
    pub proposed_at: i64,
    pub snapshot_hash: [u8; 32],
    pub resolved_at: i64,
    pub fee_collected: u64,
    pub paid_out: u64,
    pub swept: u64,
    pub positions: u32,
    pub positions_open: u32,
    pub vault: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub payer: Pubkey,
    pub amounts: [u64; MAX_BUCKETS],
    pub fee_w: [u128; MAX_BUCKETS],
    pub bump: u8,
}

// ---------- contexts ----------

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin @ PotError::Unauthorized)]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct CreateMarket<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump,
        constraint = signer.key() == config.admin || signer.key() == config.proposer @ PotError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(init, payer = signer, space = 8 + Market::INIT_SPACE,
        seeds = [b"market", config.market_count.to_le_bytes().as_ref()], bump)]
    pub market: Account<'info, Market>,
    #[account(init, payer = signer, token::mint = mint, token::authority = market, token::token_program = token_program,
        seeds = [b"vault", market.key().as_ref()], bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub signer: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SeedMarket<'info> {
    #[account(mut, seeds = [b"market", market.id.to_le_bytes().as_ref()], bump = market.bump, has_one = vault, has_one = mint)]
    pub market: Account<'info, Market>,
    #[account(mut)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = funder.key(), token::token_program = token_program)]
    pub funder_token: InterfaceAccount<'info, TokenAccount>,
    pub funder: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}
impl<'info> SeedMarket<'info> {
    fn transfer_ctx(&self) -> CpiContext<'_, '_, '_, 'info, TransferChecked<'info>> {
        CpiContext::new(self.token_program.key(), TransferChecked {
            from: self.funder_token.to_account_info(),
            mint: self.mint.to_account_info(),
            to: self.vault.to_account_info(),
            authority: self.funder.to_account_info(),
        })
    }
}

#[derive(Accounts)]
pub struct PlaceBet<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"market", market.id.to_le_bytes().as_ref()], bump = market.bump, has_one = vault, has_one = mint)]
    pub market: Account<'info, Market>,
    #[account(init_if_needed, payer = user, space = 8 + Position::INIT_SPACE,
        seeds = [b"position", market.key().as_ref(), user.key().as_ref()], bump)]
    pub position: Account<'info, Position>,
    #[account(mut)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = user.key(), token::token_program = token_program)]
    pub user_token: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}
impl<'info> PlaceBet<'info> {
    fn transfer_ctx(&self) -> CpiContext<'_, '_, '_, 'info, TransferChecked<'info>> {
        CpiContext::new(self.token_program.key(), TransferChecked {
            from: self.user_token.to_account_info(),
            mint: self.mint.to_account_info(),
            to: self.vault.to_account_info(),
            authority: self.user.to_account_info(),
        })
    }
}

#[derive(Accounts)]
pub struct Propose<'info> {
    #[account(seeds = [b"config"], bump = config.bump,
        constraint = proposer.key() == config.proposer || proposer.key() == config.admin @ PotError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"market", market.id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    pub proposer: Signer<'info>,
}

#[derive(Accounts)]
pub struct Finalize<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"market", market.id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    pub signer: Signer<'info>,
}

#[derive(Accounts)]
pub struct AdminMarket<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin @ PotError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"market", market.id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(mut, seeds = [b"market", market.id.to_le_bytes().as_ref()], bump = market.bump, has_one = vault, has_one = mint)]
    pub market: Account<'info, Market>,
    #[account(mut, close = payer, seeds = [b"position", market.key().as_ref(), position.owner.as_ref()], bump = position.bump,
        has_one = market, has_one = payer)]
    pub position: Account<'info, Position>,
    /// CHECK: rent goes back to whoever created the position; enforced by has_one.
    #[account(mut)]
    pub payer: UncheckedAccount<'info>,
    #[account(mut)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = position.owner, token::token_program = token_program)]
    pub owner_token: InterfaceAccount<'info, TokenAccount>,
    pub cranker: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}
impl<'info> Settle<'info> {
    fn transfer_ctx(&self) -> CpiContext<'_, '_, '_, 'info, TransferChecked<'info>> {
        CpiContext::new(self.token_program.key(), TransferChecked {
            from: self.vault.to_account_info(),
            mint: self.mint.to_account_info(),
            to: self.owner_token.to_account_info(),
            authority: self.market.to_account_info(),
        })
    }
}

#[derive(Accounts)]
pub struct Sweep<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"market", market.id.to_le_bytes().as_ref()], bump = market.bump, has_one = vault, has_one = mint)]
    pub market: Account<'info, Market>,
    #[account(mut)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = config.treasury_owner, token::token_program = token_program)]
    pub treasury: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: market + vault rent goes back to the proposer, the key that pays it when markets are opened, so the
    /// operator's hot key funds itself instead of draining into the admin; address enforced.
    #[account(mut, address = config.proposer)]
    pub rent_dest: UncheckedAccount<'info>,
    pub signer: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}
impl<'info> Sweep<'info> {
    fn transfer_ctx(&self) -> CpiContext<'_, '_, '_, 'info, TransferChecked<'info>> {
        CpiContext::new(self.token_program.key(), TransferChecked {
            from: self.vault.to_account_info(),
            mint: self.mint.to_account_info(),
            to: self.treasury.to_account_info(),
            authority: self.market.to_account_info(),
        })
    }
    fn close_ctx(&self) -> CpiContext<'_, '_, '_, 'info, CloseAccount<'info>> {
        CpiContext::new(self.token_program.key(), CloseAccount {
            account: self.vault.to_account_info(),
            destination: self.rent_dest.to_account_info(),
            authority: self.market.to_account_info(),
        })
    }
}

// ---------- events & errors ----------

#[event]
pub struct MarketCreated { pub market: Pubkey, pub id: u64, pub mint: Pubkey, pub metric: [u8; 32], pub n_buckets: u8, pub thresholds: [i64; MAX_THRESHOLDS], pub open_ts: i64, pub close_ts: i64 }
#[event]
pub struct BetPlaced { pub market: Pubkey, pub user: Pubkey, pub bucket: u8, pub amount: u64, pub fee_bps: u16, pub pools: [u64; MAX_BUCKETS] }
#[event]
pub struct ResolutionProposed { pub market: Pubkey, pub bucket: u8, pub observed_value: i64, pub snapshot_hash: [u8; 32], pub proposed_at: i64 }
#[event]
pub struct MarketResolved { pub market: Pubkey, pub bucket: u8, pub voided: bool }
#[event]
pub struct PositionSettled { pub market: Pubkey, pub user: Pubkey, pub payout: u64, pub fee: u64 }

#[error_code]
pub enum PotError {
    #[msg("unauthorized")] Unauthorized,
    #[msg("fee above hard ceiling")] FeeTooHigh,
    #[msg("bad schedule")] BadSchedule,
    #[msg("amount must be > 0")] ZeroAmount,
    #[msg("below minimum bet")] BelowMinBet,
    #[msg("market is not open")] MarketNotOpen,
    #[msg("betting has not started")] BettingNotStarted,
    #[msg("betting is closed")] BettingClosed,
    #[msg("protocol paused")] Paused,
    #[msg("too early to resolve")] TooEarlyToResolve,
    #[msg("no resolution proposed")] NotProposed,
    #[msg("dispute window still open")] DisputeWindowOpen,
    #[msg("market already final")] AlreadyFinal,
    #[msg("market not resolved")] NotResolved,
    #[msg("positions still outstanding")] PositionsOutstanding,
    #[msg("bad bucket definition or index")] BadBuckets,
    #[msg("arithmetic overflow")] MathOverflow,
    #[msg("token not supported: it has an active transfer hook")] UnsupportedMint,
}
