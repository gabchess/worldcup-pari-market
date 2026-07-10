use crate::constants::TXORACLE_PROGRAM_ID;
use crate::errors::PariMarketError;
use crate::market::TraderPredicate;
use crate::proof::ProofNode;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::{get_return_data, invoke};

// ── Types mirroring the txoracle IDL (confirmed via M0 live calls) ─────────
//
// These types byte-match client/validate-stat-borsh.ts's hand-rolled Borsh
// encoder (M0 used that encoder in place of @coral-xyz/anchor -- socket
// flagged transitive CVEs on bigint-buffer/uuid for that dependency during
// the M0 dispatch). The on-chain CPI side uses Anchor's own Borsh derive,
// so field order and types must match the IDL exactly:
// validate_stat(ts, fixture_summary, fixture_proof, main_tree_proof,
//                predicate, stat_a, stat_b: Option<StatTerm>, op: Option<BinaryExpression>)

/// Mirrors the txoracle IDL `ScoreStat` struct.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ScoreStat {
    pub key: u32,
    pub value: i32,
    pub period: i32,
}

/// Mirrors the txoracle IDL `StatTerm` struct.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct StatTerm {
    pub stat_to_prove: ScoreStat,
    pub event_stat_root: [u8; 32],
    pub stat_proof: Vec<ProofNode>,
}

/// Mirrors the txoracle IDL `ScoresUpdateStats` struct.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ScoresUpdateStats {
    pub update_count: i32,
    pub min_timestamp: i64,
    pub max_timestamp: i64,
}

/// Mirrors the txoracle IDL `ScoresBatchSummary` struct.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ScoresBatchSummary {
    pub fixture_id: i64,
    pub update_stats: ScoresUpdateStats,
    pub events_sub_tree_root: [u8; 32],
}

/// validate_stat instruction discriminator (from the official txoracle IDL,
/// v1.4.7, confirmed against a live devnet call in M0).
pub const VALIDATE_STAT_DISCRIMINATOR: [u8; 8] = [107, 197, 232, 90, 191, 136, 105, 185];

// ── Instruction-data builder ────────────────────────────────────────────────
//
// Byte-for-byte mirror of client/validate-stat-borsh.ts's encodeValidateStatArgs
// (M0's working hand-rolled Borsh encoder). Anchor's own AnchorSerialize derive
// on these mirror structs (ScoreStat, StatTerm, ScoresBatchSummary, ProofNode,
// TraderPredicate) already produces the identical byte layout struct-by-struct,
// so this function only has to sequence the top-level instruction args in the
// txoracle IDL's declared order:
//   validate_stat(ts, fixture_summary, fixture_proof, main_tree_proof,
//                 predicate, stat_a, stat_b: Option<StatTerm>, op: Option<BinaryExpression>)
fn encode_validate_stat_args(
    ts: i64,
    fixture_summary: &ScoresBatchSummary,
    fixture_proof: &[ProofNode],
    main_tree_proof: &[ProofNode],
    predicate: &TraderPredicate,
    stat_a: &StatTerm,
    stat_b: &Option<StatTerm>,
    op: &Option<crate::market::BinaryExpression>,
) -> Result<Vec<u8>> {
    let mut data = Vec::with_capacity(256);
    data.extend_from_slice(&VALIDATE_STAT_DISCRIMINATOR);
    ts.serialize(&mut data)?;
    fixture_summary.serialize(&mut data)?;
    fixture_proof.serialize(&mut data)?;
    main_tree_proof.serialize(&mut data)?;
    predicate.serialize(&mut data)?;
    stat_a.serialize(&mut data)?;
    stat_b.serialize(&mut data)?;
    op.serialize(&mut data)?;
    Ok(data)
}

/// Invokes the CPI, then decodes + domain-checks the return data.
///
/// Dayo M4a P0 #2 (post-CPI trust boundary): `get_return_data()` reads a
/// single global buffer set by whichever program last called
/// `set_return_data`. Trusting its contents without first confirming the
/// returning `program_id == TXORACLE_PROGRAM_ID` is the load-bearing check --
/// a CPI depth increase, or any future upstream change that adds an inner CPI
/// inside validate_stat, could otherwise let a stale or foreign return-data
/// buffer be silently accepted as this call's result.
///
/// Domain check: the decoded byte must be strictly 0 or 1. Any other value is
/// a decode failure (InvalidReturnDataDomain), never silently coerced to false.
fn invoke_and_decode_bool(
    instruction: &Instruction,
    account_infos: &[AccountInfo],
) -> Result<bool> {
    invoke(instruction, account_infos)?;

    let (returned_program_id, data) =
        get_return_data().ok_or(PariMarketError::UnexpectedReturnDataProgram)?;
    require_keys_eq!(
        returned_program_id,
        TXORACLE_PROGRAM_ID,
        PariMarketError::UnexpectedReturnDataProgram
    );

    match data.first() {
        Some(0) => Ok(false),
        Some(1) => Ok(true),
        _ => Err(PariMarketError::InvalidReturnDataDomain.into()),
    }
}

/// Builds and sends the single-stat validate_stat CPI.
///
/// Mirrors the official reference (backup/examples/data_validation/
/// validate_scores_onchain.ts, single-stat call, lines 194-213) and M0's
/// working client/validate-stat-call.ts.
///
/// M0 gotcha (load-bearing): `ts` MUST be fixture_summary.update_stats.min_timestamp,
/// NOT a separately-sourced top-level timestamp -- passing the wrong value
/// produces AnchorError TimestampMismatch (custom error 6010), confirmed live.
///
/// Return-data contract (M0 FACT 3, confirmed by two live devnet transactions,
/// one true-predicate and one false-predicate, both with err:null): validate_stat
/// is Ok-with-bool. It does NOT revert/error when the predicate evaluates false.
/// The caller MUST invoke this via `anchor_lang::solana_program::program::invoke`
/// (or invoke_signed) and then read the CPI return data via
/// `anchor_lang::solana_program::program::get_return_data()`, decoding the first
/// byte as the bool (0 = false, 1 = true; matches M0's observed AA==/AQ== return
/// payloads). A successful CPI (Ok(())) is NOT sufficient signal on its own --
/// resolve() must branch on the decoded bool.
pub fn validate_stat_single<'info>(
    daily_scores_merkle_roots: &AccountInfo<'info>,
    ts: i64,
    fixture_summary: ScoresBatchSummary,
    fixture_proof: Vec<ProofNode>,
    main_tree_proof: Vec<ProofNode>,
    predicate: TraderPredicate,
    stat_a: StatTerm,
) -> Result<bool> {
    let data = encode_validate_stat_args(
        ts,
        &fixture_summary,
        &fixture_proof,
        &main_tree_proof,
        &predicate,
        &stat_a,
        &None,
        &None,
    )?;

    let instruction = Instruction {
        program_id: TXORACLE_PROGRAM_ID,
        accounts: vec![AccountMeta::new_readonly(
            *daily_scores_merkle_roots.key,
            false,
        )],
        data,
    };

    invoke_and_decode_bool(
        &instruction,
        std::slice::from_ref(daily_scores_merkle_roots),
    )
}

/// Builds and sends the two-stat validate_stat CPI (e.g. home_goals - away_goals > threshold).
///
/// Mirrors the official reference two-stat call (validate_scores_onchain.ts
/// lines 241-260) and M0's working two-stat call
/// (fixture 18172379: statToProve key=1 value=2, statToProve2 key=2 value=0,
/// op=Subtract, confirmed live -- see M0_EVIDENCE FACT 3 tx signatures).
///
/// Same return-data contract as validate_stat_single above: Ok-with-bool,
/// caller must decode and branch, CPI success alone does not signal the
/// predicate outcome.
pub fn validate_stat_two<'info>(
    daily_scores_merkle_roots: &AccountInfo<'info>,
    ts: i64,
    fixture_summary: ScoresBatchSummary,
    fixture_proof: Vec<ProofNode>,
    main_tree_proof: Vec<ProofNode>,
    predicate: TraderPredicate,
    stat_a: StatTerm,
    stat_b: StatTerm,
    op: crate::market::BinaryExpression,
) -> Result<bool> {
    let data = encode_validate_stat_args(
        ts,
        &fixture_summary,
        &fixture_proof,
        &main_tree_proof,
        &predicate,
        &stat_a,
        &Some(stat_b),
        &Some(op),
    )?;

    let instruction = Instruction {
        program_id: TXORACLE_PROGRAM_ID,
        accounts: vec![AccountMeta::new_readonly(
            *daily_scores_merkle_roots.key,
            false,
        )],
        data,
    };

    invoke_and_decode_bool(
        &instruction,
        std::slice::from_ref(daily_scores_merkle_roots),
    )
}
