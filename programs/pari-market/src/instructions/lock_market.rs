use crate::constants::MARKET_SEED;
use crate::errors::PariMarketError;
use crate::market::Market;
use anchor_lang::prelude::*;

/// Locks a market, permanently closing the deposit window.
///
/// Permissionless + time-gated: the Market struct (per LOCKED plan v2) carries
/// no `authority` field, so lock_market is not admin-gated. Any signer may
/// call it once Clock::get()?.unix_timestamp >= market.lock_ts -- matching the
/// trustless design in docs/pm-research.md (resolution reads only from the
/// oracle, never from a privileged key).
///
/// Verifier (milestone plan): after lock_market, market.locked == true and
/// any subsequent deposit() call on this market fails with MarketLocked.
/// Idempotent guard: a second lock_market() call on an already-locked market
/// is rejected (not a no-op) -- already enforced by the `constraint =
/// !market.locked` on the LockMarket Accounts struct below, which runs at
/// account-validation time, before this body executes.
pub fn lock_market(ctx: Context<LockMarket>) -> Result<()> {
    require!(
        Clock::get()?.unix_timestamp >= ctx.accounts.market.lock_ts,
        PariMarketError::LockNotYetDue
    );

    ctx.accounts.market.locked = true;

    Ok(())
}

#[derive(Accounts)]
pub struct LockMarket<'info> {
    #[account(
        mut,
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump,
        constraint = !market.locked @ PariMarketError::MarketLocked,
    )]
    pub market: Account<'info, Market>,

    /// Permissionless caller; no ownership constraint on this signer.
    pub caller: Signer<'info>,
}
