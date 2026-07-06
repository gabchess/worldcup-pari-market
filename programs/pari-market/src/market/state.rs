use anchor_lang::prelude::*;

/// Mirrors the txoracle IDL `Comparison` enum (fieldless, u8 discriminant).
/// Used to build the `TraderPredicate` passed into the validate_stat CPI.
/// See client/validate-stat-borsh.ts (M0) for the working TS-side encoding
/// this type must byte-match.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Comparison {
    GreaterThan,
    LessThan,
    EqualTo,
}

/// Mirrors the txoracle IDL `BinaryExpression` enum (fieldless, u8 discriminant).
/// Combines stat_a and stat_b when a market's predicate spans two stats
/// (e.g. home_goals - away_goals > threshold).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum BinaryExpression {
    Add,
    Subtract,
}

/// Mirrors the txoracle IDL `TraderPredicate` struct.
/// threshold: i32, comparison: Comparison -- exact field order/types match
/// the on-chain validate_stat instruction args (see cpi::txoracle).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct TraderPredicate {
    pub threshold: i32,
    pub comparison: Comparison,
}

/// On-chain record of a single World Cup pari-mutuel prediction market.
///
/// PDA seeds: [MARKET_SEED, market_id.to_le_bytes()] (see constants::MARKET_SEED)
///
/// Resolution condition: stat_a_key (+ optional stat_b_key/op) evaluated
/// against `predicate` via a validate_stat CPI into TXORACLE_PROGRAM_ID
/// (see cpi::txoracle). M0 confirmed validate_stat is Ok-with-bool -- it does
/// NOT revert on a false predicate, so resolve() must decode the CPI return
/// data and branch on the bool explicitly.
#[account]
pub struct Market {
    /// Unique market identifier, chosen at init_market (not the TxODDS fixture ID).
    pub market_id: u64,
    /// TxODDS fixture ID this market resolves against.
    pub fixture_id: i64,
    /// epoch_day the daily_scores_roots PDA is derived under (see constants::DAILY_SCORES_ROOTS_SEED).
    pub epoch_day: u16,
    /// Primary stat key (soccer-feed.mdx encoding: (period * 1000) + base_key).
    /// M0 confirmed key=1 is home total goals, key=2 is away total goals.
    pub stat_a_key: u32,
    /// Optional second stat key, present when the predicate compares two stats.
    pub stat_b_key: Option<u32>,
    /// Combines stat_a and stat_b when stat_b_key is Some (e.g. Subtract for
    /// a goal-differential predicate). None when stat_b_key is None.
    pub op: Option<BinaryExpression>,
    /// The resolution condition evaluated against the combined stat value.
    pub predicate: TraderPredicate,
    /// Total USDC deposited on the YES side.
    pub yes_pool: u64,
    /// Total USDC deposited on the NO side.
    pub no_pool: u64,
    /// USDC mint this market's pools are denominated in.
    pub usdc_mint: Pubkey,
    /// Market's USDC vault token account (PDA-owned, see constants::VAULT_SEED).
    pub vault: Pubkey,
    /// Unix timestamp after which deposit() is rejected (see errors::DepositAfterLock).
    pub lock_ts: i64,
    /// Set true by lock_market(); gates deposit() (see errors::MarketLocked).
    pub locked: bool,
    /// Set true by resolve(); gates a second resolve() call (see errors::AlreadyResolved).
    pub resolved: bool,
    /// The resolved outcome: Some(true) = YES side won, Some(false) = NO side won.
    /// None until resolve() runs.
    pub outcome: Option<bool>,
    /// PDA bump, stored to avoid re-derivation on every instruction.
    pub bump: u8,
}

impl Market {
    // discriminator(8) + market_id(8) + fixture_id(8) + epoch_day(2)
    // + stat_a_key(4) + stat_b_key(1 tag + 4 = 5) + op(1 tag + 1 = 2)
    // + predicate(4 threshold + 1 comparison = 5) + yes_pool(8) + no_pool(8)
    // + usdc_mint(32) + vault(32) + lock_ts(8) + locked(1) + resolved(1)
    // + outcome(1 tag + 1 = 2) + bump(1)
    // = 8+8+8+2+4+5+2+5+8+8+32+32+8+1+1+2+1 = 135; pad to 144
    pub const SIZE: usize = 8 + 8 + 8 + 2 + 4 + 5 + 2 + 5 + 8 + 8 + 32 + 32 + 8 + 1 + 1 + 2 + 1 + 9; // 144 bytes total
}
