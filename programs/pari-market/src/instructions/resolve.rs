use crate::constants::{
    DAILY_SCORES_ROOTS_SEED, MARKET_SEED, RESOLVE_RECOMMENDED_COMPUTE_UNITS, TXORACLE_PROGRAM_ID,
};
use crate::cpi::txoracle;
use crate::errors::PariMarketError;
use crate::market::Market;
use crate::proof::ProofNode;
use anchor_lang::prelude::*;

/// Resolves a market by CPI-ing into TXORACLE_PROGRAM_ID's validate_stat
/// instruction against the market's stored predicate/stat_a_key/stat_b_key/op,
/// then recording the outcome.
///
/// ── M2a structural fix (Dayo M4a P0 #1) ─────────────────────────────────────
///
/// The caller supplies ONLY proof material: `ts`, `fixture_summary`,
/// `fixture_proof`, `main_tree_proof`, `stat_a`, `stat_b`. The predicate
/// configuration -- `predicate`, `stat_a_key`, `stat_b_key`, `op` -- is never
/// caller-suppliable; it is read from `market` state and used to both build
/// the CPI args AND verify the supplied proof's embedded stat keys match what
/// this market is bound to. This is a design fix, not an assert-after: a
/// caller cannot even construct a resolve() call that targets a different
/// predicate than the one the market was created with.
///
/// Verified pre-CPI, in order:
///   1. `fixture_summary.fixture_id == market.fixture_id` (FixtureMismatch on
///      mismatch) -- the daily_scores_roots PDA is keyed by epoch_day only,
///      not fixture_id, so a caller could otherwise pass proof data for a
///      different fixture while still targeting this market's PDA.
///   2. `stat_a.stat_to_prove.key == market.stat_a_key` (FixtureMismatch on
///      mismatch) -- binds the supplied proof to the market's configured stat.
///   3. If `market.stat_b_key.is_some()`, `stat_b` must be `Some` and its
///      embedded key must equal `market.stat_b_key` (FixtureMismatch on any
///      mismatch, including a missing stat_b when the market requires one).
///
/// ── M0-driven design facts (both load-bearing for this instruction) ────────
///
/// (a) NO REVERT ON FALSE -- validate_stat is Ok-with-bool, not revert-vs-bool.
///     M0 confirmed this with two live devnet transactions (one true-predicate,
///     one false-predicate probe): BOTH returned err:null / a successful
///     transaction. The predicate result is only observable by decoding the
///     CPI return data (anchor_lang::solana_program::program::get_return_data(),
///     first byte: 0=false, 1=true -- matches M0's AA==/AQ== base64 payloads).
///     resolve() calls cpi::txoracle::validate_stat_single/_two, which decodes
///     and returns the bool explicitly. A CPI that completes without erroring
///     is NOT sufficient signal that the predicate is true -- false is a VALID
///     resolution (market resolves NO), not a failure.
///
/// (b) COMPUTE BUDGET -- M0 measured ~179,000-179,190 CU for the validate_stat
///     CPI alone (standalone, depth-1 call). resolve() adds a CPI level
///     (depth 2 of Solana's 4-level max) plus its own account-loading and
///     outcome-recording logic on top of that floor. The transaction MUST
///     request a raised compute unit limit
///     (ComputeBudgetProgram::set_compute_unit_limit, see
///     constants::RESOLVE_RECOMMENDED_COMPUTE_UNITS = 500_000) as a
///     pre-instruction, or the tx will exhaust Solana's default 200,000 CU
///     budget before completing. This is a client-side/tx-builder
///     responsibility; Anchor cannot self-request compute budget from within
///     the invoked instruction.
///
/// Verifier (milestone plan): after resolve, market.resolved == true and
/// market.outcome == Some(decoded_bool) matching what the validate_stat CPI
/// returned (including Some(false) as a valid resolution); a second resolve()
/// call on the same market fails with AlreadyResolved; a resolve() call
/// passing a fixture_summary for the wrong fixture_id fails with
/// FixtureMismatch before reaching the CPI; a resolve() call against a
/// daily_scores_roots account for the wrong epoch_day fails at the account-
/// constraint layer (seeds::program re-derivation, scaffold-level).
pub fn resolve(
    ctx: Context<Resolve>,
    ts: i64,
    fixture_summary: txoracle::ScoresBatchSummary,
    fixture_proof: Vec<ProofNode>,
    main_tree_proof: Vec<ProofNode>,
    stat_a: txoracle::StatTerm,
    stat_b: Option<txoracle::StatTerm>,
) -> Result<()> {
    let market = &ctx.accounts.market;

    require_eq!(
        fixture_summary.fixture_id,
        market.fixture_id,
        PariMarketError::FixtureMismatch
    );
    require_eq!(
        stat_a.stat_to_prove.key,
        market.stat_a_key,
        PariMarketError::FixtureMismatch
    );

    let op = match market.stat_b_key {
        Some(expected_stat_b_key) => {
            let supplied_stat_b = stat_b.as_ref().ok_or(PariMarketError::FixtureMismatch)?;
            require_eq!(
                supplied_stat_b.stat_to_prove.key,
                expected_stat_b_key,
                PariMarketError::FixtureMismatch
            );
            Some(market.op.ok_or(PariMarketError::FixtureMismatch)?)
        }
        None => None,
    };

    let decoded_outcome = match (stat_b, op) {
        (Some(stat_b_term), Some(op)) => txoracle::validate_stat_two(
            &ctx.accounts.daily_scores_merkle_roots.to_account_info(),
            ts,
            fixture_summary,
            fixture_proof,
            main_tree_proof,
            market.predicate,
            stat_a,
            stat_b_term,
            op,
        )?,
        _ => txoracle::validate_stat_single(
            &ctx.accounts.daily_scores_merkle_roots.to_account_info(),
            ts,
            fixture_summary,
            fixture_proof,
            main_tree_proof,
            market.predicate,
            stat_a,
        )?,
    };

    let market = &mut ctx.accounts.market;
    market.resolved = true;
    // false is a VALID resolution (market resolves NO), not an error path.
    market.outcome = Some(decoded_outcome);

    let _ = RESOLVE_RECOMMENDED_COMPUTE_UNITS; // client-side tx-builder responsibility; see doc comment (b)

    Ok(())
}

#[derive(Accounts)]
pub struct Resolve<'info> {
    #[account(
        mut,
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump,
        constraint = market.locked @ PariMarketError::MarketLocked,
        constraint = !market.resolved @ PariMarketError::AlreadyResolved,
    )]
    pub market: Account<'info, Market>,

    /// TxODDS-owned daily_scores_roots PDA for market.epoch_day.
    /// CHECK: address is derived and compared against DAILY_SCORES_ROOTS_SEED +
    /// market.epoch_day in the instruction body before the CPI (errors::WrongRoot
    /// on mismatch); ownership is enforced by the CPI itself.
    #[account(
        seeds = [DAILY_SCORES_ROOTS_SEED, &market.epoch_day.to_le_bytes()],
        bump,
        seeds::program = TXORACLE_PROGRAM_ID,
    )]
    pub daily_scores_merkle_roots: UncheckedAccount<'info>,

    /// TxODDS program invoked via CPI for validate_stat.
    /// CHECK: constraint enforces key == TXORACLE_PROGRAM_ID.
    #[account(constraint = txoracle_program.key() == TXORACLE_PROGRAM_ID @ PariMarketError::WrongRoot)]
    pub txoracle_program: UncheckedAccount<'info>,

    /// Permissionless caller; resolution is gated by the oracle CPI result,
    /// not by signer identity.
    pub caller: Signer<'info>,
}
