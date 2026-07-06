use anchor_lang::prelude::*;

// ── TxODDS program (M0 winner, confirmed 2026-07-02) ───────────────────────
//
// M0 empirically derived daily_scores_roots PDAs under BOTH candidate program
// IDs (see ~/projects/worldcup-settlement/devnet-config.json). The winner:
// 6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J holds live World Cup roots for
// epochDays 20632-20636 (9232 bytes each, fresh through the M0 session date).
// 9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA (the IDL v1.4.7 top-level
// metadata address) is executable on devnet but has ZERO daily_scores_roots
// PDAs -- it is the mainnet program ID reused as IDL metadata, not a second
// devnet deployment. Confirmed against official docs
// (documentation/programs/devnet.mdx, documentation/programs/addresses.mdx).
pub const TXORACLE_PROGRAM_ID: Pubkey = pubkey!("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");

// ── PDA seeds (frozen; reference these everywhere, no inline literals) ─────

/// Market account PDA seed. Derivation: [MARKET_SEED, market_id.to_le_bytes()]
pub const MARKET_SEED: &[u8] = b"market";

/// Position account PDA seed. Derivation: [POSITION_SEED, market.key(), bettor.key()]
pub const POSITION_SEED: &[u8] = b"position";

/// Market USDC vault PDA seed. Derivation: [VAULT_SEED, market.key()]
pub const VAULT_SEED: &[u8] = b"vault";

/// TxODDS daily_scores_roots PDA seed (owned by TXORACLE_PROGRAM_ID, not us).
/// Derivation: [DAILY_SCORES_ROOTS_SEED, epoch_day.to_le_bytes()] under TXORACLE_PROGRAM_ID.
/// M0 gotcha: epoch_day = floor(minTimestamp_ms / 86_400_000) where minTimestamp
/// comes from the stat-validation response's summary.updateStats.minTimestamp field
/// (NOT the top-level ts field -- using the wrong timestamp produces AnchorError
/// TimestampMismatch, custom error 6010, confirmed live in M0).
pub const DAILY_SCORES_ROOTS_SEED: &[u8] = b"daily_scores_roots";

// ── Classic SPL Token Program (USDC pool accounting; not Token-2022) ───────
pub const SPL_TOKEN_PROGRAM_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

// ── Compute budget note (M0 finding) ────────────────────────────────────────
//
// M0 measured ~179,000-179,190 CU for a single standalone validate_stat CPI
// call (2-stat, 584-byte instruction data). Solana's default 200,000 CU/tx
// budget is nearly exhausted by that leg alone. resolve() adds its own
// account-loading + payout-accounting CU on top of the validate_stat CPI, so
// resolve() MUST request a raised compute unit limit via
// ComputeBudgetProgram::set_compute_unit_limit as a pre-instruction.
// Recommend 400_000-600_000 CU to leave headroom above the ~179k CPI floor.
pub const RESOLVE_RECOMMENDED_COMPUTE_UNITS: u32 = 500_000;
