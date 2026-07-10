use crate::constants::MARKET_SEED;
use crate::errors::PariMarketError;
use crate::market::{BinaryExpression, Market, TraderPredicate};
use anchor_lang::prelude::*;

/// Creates a Market PDA for a World Cup fixture, keyed on market_id.
///
/// Verifier (milestone plan): after init_market, the Market account exists
/// on-chain with locked=false, resolved=false, outcome=None, yes_pool=0,
/// no_pool=0, and all args stored verbatim.
///
/// lock_ts is validated to be strictly in the future (Clock::get()?.unix_timestamp)
/// so a market can never be created already-locked.
pub fn init_market(
    ctx: Context<InitMarket>,
    market_id: u64,
    fixture_id: i64,
    epoch_day: u16,
    stat_a_key: u32,
    stat_b_key: Option<u32>,
    op: Option<BinaryExpression>,
    predicate: TraderPredicate,
    lock_ts: i64,
) -> Result<()> {
    require!(
        lock_ts > Clock::get()?.unix_timestamp,
        PariMarketError::LockNotYetDue
    );

    // stat_b_key and op must be both Some or both None (F1 adversarial
    // re-audit finding): a mismatched pair produces a market resolve()'s
    // joint-validation check can never satisfy, permanently locking
    // depositor funds with no refund path.
    require!(
        stat_b_key.is_some() == op.is_some(),
        PariMarketError::InconsistentTwoStatConfig
    );

    let market = &mut ctx.accounts.market;
    market.market_id = market_id;
    market.fixture_id = fixture_id;
    market.epoch_day = epoch_day;
    market.stat_a_key = stat_a_key;
    market.stat_b_key = stat_b_key;
    market.op = op;
    market.predicate = predicate;
    market.yes_pool = 0;
    market.no_pool = 0;
    market.usdc_mint = ctx.accounts.usdc_mint.key();
    market.vault = ctx.accounts.vault.key();
    market.lock_ts = lock_ts;
    market.locked = false;
    market.resolved = false;
    market.outcome = None;
    market.bump = ctx.bumps.market;

    Ok(())
}

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct InitMarket<'info> {
    #[account(
        init,
        payer = authority,
        space = Market::SIZE,
        seeds = [MARKET_SEED, &market_id.to_le_bytes()],
        bump,
    )]
    pub market: Account<'info, Market>,

    /// USDC mint this market's pools will be denominated in.
    pub usdc_mint: Account<'info, anchor_spl::token::Mint>,

    /// Market's USDC vault token account. Created here so init_market is the
    /// single instruction that fully initializes a market (no separate
    /// vault-creation step for depositors to race against).
    #[account(
        init,
        payer = authority,
        seeds = [crate::constants::VAULT_SEED, market.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = market,
    )]
    pub vault: Account<'info, anchor_spl::token::TokenAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub token_program: Program<'info, anchor_spl::token::Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}
