use crate::constants::{MARKET_SEED, POSITION_SEED, VAULT_SEED};
use crate::errors::PariMarketError;
use crate::market::Market;
use crate::position::Position;
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Transfer};

/// Pays out a resolved market's pooled USDC to a depositor: proportionally
/// if they backed the winning side, or a full refund of their own deposit
/// in the empty-winning-pool edge case (see below).
///
/// ── Payout math ──────────────────────────────────────────────────────────
/// `payout = position.amount * total_pool / winning_pool`, where
/// `total_pool = yes_pool + no_pool` and `winning_pool` is whichever pool
/// matches `market.outcome`. Computed in a u128 intermediate (the u64 * u64
/// numerator can overflow u64 well before either pool reaches u64::MAX),
/// floor division, then checked-cast back to u64.
///
/// ── Dust policy (deliberate design) ─────────────────────────────────────
/// Floor division means `sum(all payouts) <= total_pool` almost always
/// strictly less: the remainder from every floor-divided claim (the "dust")
/// stays in the vault permanently. No last-claimer sweep, no dust
/// redistribution. This is the simpler and conservation-safe choice: a
/// last-claimer sweep would need to know it IS the last claim (extra state,
/// extra failure mode -- what if a winner never claims?), and any dust
/// redistribution scheme risks paying out more than was deposited under
/// adversarial rounding. Unclaimed dust sitting in the vault forever is a
/// strictly safer failure mode than a conservation violation.
///
/// ── Empty-winning-pool refund (edge case, deliberate design) ────────────
/// If `market.outcome` lands on a side nobody deposited on (winning_pool ==
/// 0), there is no legitimate winner to construct a proportional payout for.
/// Funds must not be stuck: in this case ONLY, every position -- regardless
/// of `position.side` -- may claim back exactly `position.amount` (a refund,
/// not a "win"). The `ClaimPayout` Accounts struct's winner-only constraint
/// (`position.side == market.outcome`) is OR'd with this refund condition,
/// so the account-validation layer itself distinguishes "ordinary losing
/// position, winning pool has money in it, nothing to claim" (rejected with
/// LosingPosition) from "winning pool is empty, everyone refunds" (allowed
/// through to this body, which then branches on the same condition to pick
/// refund vs. proportional-payout math).
///
/// ── Reentrancy hygiene ───────────────────────────────────────────────────
/// `position.claimed = true` is set BEFORE the token transfer CPI runs.
/// Solana instructions are atomic (a later failure in the same instruction
/// reverts the whole transaction, including this write), so this is not
/// closing a real reentrancy hole the way it would on EVM -- there is no
/// concept of a CPI callback re-entering claim_payout mid-execution here.
/// Cheap discipline anyway: state-before-external-call is the right shape
/// to reach for by default, and it means a future refactor that adds an
/// early return after the transfer can never accidentally skip marking the
/// position claimed.
///
/// ── Vault authority ──────────────────────────────────────────────────────
/// The vault's SPL token authority is the Market PDA (`token::authority =
/// market` at init_market / deposit). Outbound transfers here sign via
/// `CpiContext::new_with_signer` using `[MARKET_SEED,
/// &market.market_id.to_le_bytes(), &[market.bump]]` as the signer seeds --
/// this is claim_payout's first runtime exercise of that authority model
/// (deposit only ever transfers INTO the vault, bettor-signed).
///
/// Verifier (milestone plan): after claim_payout, position.claimed == true,
/// the bettor's USDC token account balance increases by exactly the
/// proportional share (or refund), and the vault balance decreases by the
/// same amount. A second claim_payout call on the same position fails with
/// AlreadyClaimed; a call on an ordinary losing-side position (winning pool
/// non-empty) fails with LosingPosition.
pub fn claim_payout(ctx: Context<ClaimPayout>) -> Result<()> {
    let market = &ctx.accounts.market;
    let position = &ctx.accounts.position;

    let winning_side = market.outcome.ok_or(PariMarketError::MarketNotResolved)?;
    let winning_pool: u64 = if winning_side {
        market.yes_pool
    } else {
        market.no_pool
    };
    let total_pool: u64 = market
        .yes_pool
        .checked_add(market.no_pool)
        .ok_or(ProgramError::ArithmeticOverflow)?;

    let payout: u64 = if winning_pool == 0 {
        // Empty-winning-pool refund: nobody backed the winning outcome, so
        // every position (whichever side it's on) gets exactly its own
        // deposit back. The Accounts struct's constraint already gated entry
        // here to only this refund case OR a genuine winner; a genuine
        // winner claiming while winning_pool == 0 is impossible (winning_pool
        // is the sum of exactly the positions with position.side ==
        // winning_side, so if it's 0, no such position exists to reach here
        // via the winner branch -- only the refund branch is reachable).
        position.amount
    } else {
        // Proportional payout: payout = amount * total_pool / winning_pool,
        // u128 intermediate (amount * total_pool can exceed u64::MAX even
        // when each individual value fits), floor division (the dust policy
        // above), checked cast back to u64.
        let numerator: u128 = (position.amount as u128)
            .checked_mul(total_pool as u128)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        let payout_u128: u128 = numerator / (winning_pool as u128); // winning_pool != 0, checked above
        u64::try_from(payout_u128).map_err(|_| ProgramError::ArithmeticOverflow)?
    };

    // Reentrancy hygiene: mark claimed before the transfer CPI (see doc
    // comment above).
    ctx.accounts.position.claimed = true;

    let market_id_bytes = ctx.accounts.market.market_id.to_le_bytes();
    let market_bump = ctx.accounts.market.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[MARKET_SEED, &market_id_bytes, &[market_bump]]];

    let cpi_accounts = Transfer {
        from: ctx.accounts.vault.to_account_info(),
        to: ctx.accounts.bettor_usdc.to_account_info(),
        authority: ctx.accounts.market.to_account_info(),
    };
    let cpi_ctx =
        CpiContext::new_with_signer(ctx.accounts.token_program.key(), cpi_accounts, signer_seeds);
    token::transfer(cpi_ctx, payout)?;

    Ok(())
}

#[derive(Accounts)]
pub struct ClaimPayout<'info> {
    #[account(
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump,
        constraint = market.resolved @ PariMarketError::MarketNotResolved,
    )]
    pub market: Account<'info, Market>,

    #[account(
        mut,
        seeds = [POSITION_SEED, market.key().as_ref(), bettor.key().as_ref()],
        bump = position.bump,
        has_one = market,
        has_one = bettor,
        constraint = !position.claimed @ PariMarketError::AlreadyClaimed,
        // Winner-only claim (security review), OR'd with the empty-winning-pool
        // refund path: a position may claim if (a) its side matches the
        // resolved outcome (ordinary winner), or (b) the pool matching the
        // resolved outcome is empty (nobody backed the winner -- every
        // position, any side, refunds its own deposit; see claim_payout's
        // doc comment for the full rationale). Fails cheap, before any CU is
        // spent on payout math, matching the trust-boundary requirement to
        // express this at the Accounts-struct level rather than an in-body
        // require!.
        constraint = (
            Some(position.side) == market.outcome
            || (market.outcome == Some(true) && market.yes_pool == 0)
            || (market.outcome == Some(false) && market.no_pool == 0)
        ) @ PariMarketError::LosingPosition,
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

    /// Bettor's destination USDC token account.
    #[account(
        mut,
        token::mint = market.usdc_mint,
        token::authority = bettor,
    )]
    pub bettor_usdc: Account<'info, anchor_spl::token::TokenAccount>,

    #[account(mut)]
    pub bettor: Signer<'info>,

    pub token_program: Program<'info, anchor_spl::token::Token>,
}
