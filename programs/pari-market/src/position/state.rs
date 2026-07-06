use anchor_lang::prelude::*;

/// On-chain record of a single bettor's deposit into a pari-mutuel market.
///
/// PDA seeds: [POSITION_SEED, market.key(), bettor.key()] (see constants::POSITION_SEED)
#[account]
pub struct Position {
    /// Parent Market PDA.
    pub market: Pubkey,
    /// Who deposited.
    pub bettor: Pubkey,
    /// true = YES side, false = NO side. Matches Market.outcome's bool convention.
    pub side: bool,
    /// USDC amount deposited. All mutations use checked_add / checked_sub.
    pub amount: u64,
    /// Payout guard -- prevents double-claim in claim_payout() (see errors::AlreadyClaimed).
    pub claimed: bool,
    /// PDA bump, stored to avoid re-derivation.
    pub bump: u8,
}

impl Position {
    // discriminator(8) + market(32) + bettor(32) + side(1) + amount(8) + claimed(1) + bump(1) = 83; pad to 88
    pub const SIZE: usize = 8 + 32 + 32 + 1 + 8 + 1 + 1 + 5; // 88 bytes total
}
