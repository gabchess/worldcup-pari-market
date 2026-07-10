use crate::constants::{MARKET_SEED, POSITION_SEED, VAULT_SEED};
use crate::errors::PariMarketError;
use crate::market::Market;
use crate::position::Position;
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Transfer};

/// Deposits USDC into a market's YES or NO pool, opening (or adding to) the
/// caller's Position.
///
/// Verifier (milestone plan): after deposit, position.amount reflects the
/// cumulative deposit for (market, bettor, side); market.yes_pool or
/// market.no_pool increases by exactly `amount`; the caller's USDC token
/// account balance decreases by `amount` and the vault increases by `amount`.
///
/// Deposit-window guard: rejected once market.locked is true (errors::MarketLocked,
/// enforced by the Deposit Accounts struct constraint) or once
/// Clock::get()?.unix_timestamp > market.lock_ts (errors::DepositAfterLock,
/// same-slot lock-race case -- a deposit landing at/after lock_ts must fail
/// even if lock_market() itself hasn't been called yet).
///
/// Reinit-guard (M4a audit, Dayo, S175): `position` is `init_if_needed`, so a
/// repeat deposit reuses the same PDA instead of re-initializing. Only
/// `amount` mutates on a repeat call (via checked_add) -- `market`, `bettor`,
/// and `claimed` are never re-written, so a stale `claimed = true` can never
/// be reset back to `false` by a later deposit.
///
/// Side-consistency guard (M4a audit, Dayo, S175 -- Position PDA is seeded
/// [market, bettor] with no `side` component): a repeat deposit whose `side`
/// arg disagrees with the side already recorded on an existing position is
/// rejected outright with SideMismatch, never silently ignored.
pub fn deposit(ctx: Context<Deposit>, amount: u64, side: bool) -> Result<()> {
    require!(amount > 0, PariMarketError::ZeroAmount);
    require!(
        Clock::get()?.unix_timestamp <= ctx.accounts.market.lock_ts,
        PariMarketError::DepositAfterLock
    );

    let position = &mut ctx.accounts.position;
    let is_new_position = position.bettor == Pubkey::default();

    if is_new_position {
        position.market = ctx.accounts.market.key();
        position.bettor = ctx.accounts.bettor.key();
        position.side = side;
        position.amount = 0;
        position.claimed = false;
        position.bump = ctx.bumps.position;
    } else {
        require!(position.side == side, PariMarketError::SideMismatch);
    }

    position.amount = position
        .amount
        .checked_add(amount)
        .ok_or(ProgramError::ArithmeticOverflow)?;

    let market = &mut ctx.accounts.market;
    if side {
        market.yes_pool = market
            .yes_pool
            .checked_add(amount)
            .ok_or(ProgramError::ArithmeticOverflow)?;
    } else {
        market.no_pool = market
            .no_pool
            .checked_add(amount)
            .ok_or(ProgramError::ArithmeticOverflow)?;
    }

    let cpi_accounts = Transfer {
        from: ctx.accounts.bettor_usdc.to_account_info(),
        to: ctx.accounts.vault.to_account_info(),
        authority: ctx.accounts.bettor.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(ctx.accounts.token_program.key(), cpi_accounts);
    token::transfer(cpi_ctx, amount)?;

    Ok(())
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(
        mut,
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump,
        constraint = !market.locked @ PariMarketError::MarketLocked,
    )]
    pub market: Account<'info, Market>,

    #[account(
        init_if_needed,
        payer = bettor,
        space = Position::SIZE,
        seeds = [POSITION_SEED, market.key().as_ref(), bettor.key().as_ref()],
        bump,
    )]
    pub position: Account<'info, Position>,

    #[account(
        mut,
        seeds = [VAULT_SEED, market.key().as_ref()],
        bump,
        token::mint = market.usdc_mint,
        token::authority = market,
    )]
    pub vault: Account<'info, anchor_spl::token::TokenAccount>,

    /// Bettor's source USDC token account.
    #[account(
        mut,
        token::mint = market.usdc_mint,
        token::authority = bettor,
    )]
    pub bettor_usdc: Account<'info, anchor_spl::token::TokenAccount>,

    #[account(mut)]
    pub bettor: Signer<'info>,

    pub token_program: Program<'info, anchor_spl::token::Token>,
    pub system_program: Program<'info, System>,
}
