use anchor_lang::prelude::*;

pub mod constants;
pub mod cpi;
pub mod errors;
pub mod instructions;
pub mod market;
pub mod position;
pub mod proof;

use instructions::*;
use market::{BinaryExpression, TraderPredicate};

declare_id!("565SYmLeQ64r8kNujRpVhnfGgAybQrXz72knMyUj1xc3");

#[program]
pub mod pari_market {
    use super::*;

    /// Creates a Market PDA for a World Cup fixture, keyed on market_id.
    /// See instructions::init_market for the full verifier + account layout.
    #[allow(clippy::too_many_arguments)]
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
        instructions::init_market::init_market(
            ctx,
            market_id,
            fixture_id,
            epoch_day,
            stat_a_key,
            stat_b_key,
            op,
            predicate,
            lock_ts,
        )
    }

    /// Deposits USDC into a market's YES or NO pool.
    /// See instructions::deposit for the full verifier + account layout.
    pub fn deposit(ctx: Context<Deposit>, amount: u64, side: bool) -> Result<()> {
        instructions::deposit::deposit(ctx, amount, side)
    }

    /// Locks a market, permanently closing the deposit window.
    /// See instructions::lock_market for the full verifier + account layout.
    pub fn lock_market(ctx: Context<LockMarket>) -> Result<()> {
        instructions::lock_market::lock_market(ctx)
    }

    /// Resolves a market via a validate_stat CPI into the TxODDS oracle
    /// program. See instructions::resolve for the two M0-driven design facts
    /// (no-revert-on-false CPI return decoding + raised compute budget) this
    /// instruction must implement.
    pub fn resolve(
        ctx: Context<Resolve>,
        ts: i64,
        fixture_summary: cpi::txoracle::ScoresBatchSummary,
        fixture_proof: Vec<proof::ProofNode>,
        main_tree_proof: Vec<proof::ProofNode>,
        stat_a: cpi::txoracle::StatTerm,
        stat_b: Option<cpi::txoracle::StatTerm>,
    ) -> Result<()> {
        instructions::resolve::resolve(
            ctx,
            ts,
            fixture_summary,
            fixture_proof,
            main_tree_proof,
            stat_a,
            stat_b,
        )
    }

    /// Pays out a resolved market's pooled USDC proportionally to a winning
    /// depositor. See instructions::claim_payout for the full verifier +
    /// account layout.
    pub fn claim_payout(ctx: Context<ClaimPayout>) -> Result<()> {
        instructions::claim_payout::claim_payout(ctx)
    }
}
