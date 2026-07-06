use anchor_lang::prelude::*;

#[error_code]
pub enum PariMarketError {
    // Scaffold-phase guard: every instruction body is a stub until M1.
    #[msg("Instruction not implemented yet (M1 scaffold stub)")]
    NotImplemented,

    // Deposit-window guard: no deposits after lock_market has run.
    #[msg("Market is locked; deposits are no longer accepted")]
    MarketLocked,

    // Deposit-window guard: reject any deposit attempted after lock_ts.
    #[msg("Deposit attempted after the market's lock timestamp")]
    DepositAfterLock,

    // resolve() double-run guard.
    #[msg("Market has already been resolved")]
    AlreadyResolved,

    // claim_payout() double-claim guard.
    #[msg("Position has already been claimed")]
    AlreadyClaimed,

    // validate_stat CPI returned a root that does not match the market's
    // expected daily_scores_roots PDA (wrong epoch_day / fixture mismatch).
    #[msg("On-chain root does not match the market's expected daily_scores_roots PDA")]
    WrongRoot,

    // deposit() side-consistency guard. Position PDA is seeded [market, bettor]
    // with no `side` component (M4a audit, Dayo, S175), so a repeat deposit
    // must be rejected outright if its `side` arg disagrees with the side
    // already recorded on the existing Position -- silently ignoring the arg
    // would let a bettor's later deposit land on the opposite side from what
    // they intended while market.yes_pool/no_pool accounting drifts against it.
    #[msg("Deposit side does not match the existing position's recorded side")]
    SideMismatch,

    // deposit() zero-amount guard.
    #[msg("Deposit amount must be greater than zero")]
    ZeroAmount,

    // lock_market() time-gate guard.
    #[msg("Market cannot be locked before its lock timestamp")]
    LockNotYetDue,

    // resolve() pre-CPI guard (Dayo M4a P0 #1, structural fix): the caller
    // supplies only proof material, never the fixture identity. If the
    // supplied fixture_summary does not describe market.fixture_id, reject
    // before spending the ~179k CU validate_stat CPI on the wrong game.
    #[msg("Supplied fixture_summary does not match this market's bound fixture_id")]
    FixtureMismatch,

    // resolve() post-CPI guard (Dayo M4a P0 #2): the CPI return-data buffer
    // is a single global slot; trusting its contents without first checking
    // which program set it is the load-bearing CPI trust-boundary check.
    #[msg("CPI return data was not set by the expected txoracle program")]
    UnexpectedReturnDataProgram,

    // resolve() post-CPI domain guard: the decoded outcome byte must be
    // strictly 0 or 1. Any other byte is a decode failure, not a coerced false.
    #[msg("CPI return data decoded to a byte outside the valid 0/1 domain")]
    InvalidReturnDataDomain,

    // claim_payout() winner-only guard (Dayo M4a P1). A position on the
    // losing side has no proportional claim UNLESS the winning-side pool is
    // empty (see the empty-winning-pool refund path, claim_payout doc
    // comment): in that one case every position, regardless of side, is
    // refund-eligible since no legitimate winner exists to be paid from an
    // empty pool. This error fires only for the ordinary losing-side case
    // (winning pool non-empty, your side lost) -- a clean, explicit error
    // rather than a silent zero-payout.
    #[msg("Position is on the losing side and the winning pool is non-empty; nothing to claim")]
    LosingPosition,

    // claim_payout() pre-resolve guard. market.outcome is None (and
    // market.resolved is false) until resolve() runs, so a claim attempted
    // before resolution has no outcome to pay against. This is the OPPOSITE
    // condition to AlreadyResolved (the resolve() double-run guard) -- "not
    // resolved yet", not "resolved twice" -- so it must not reuse that name
    // (Dayo M4b adversarial pass, S179). The ClaimPayout Accounts struct's
    // `constraint = market.resolved` rejects this at the account-validation
    // layer before the body runs; the body's `market.outcome.ok_or(..)`
    // carries the same error for the (currently unreachable) defense-in-depth
    // path. Appended at the end of the enum so existing error codes are
    // unchanged.
    #[msg("Market has not been resolved yet; no payout is available")]
    MarketNotResolved,
}
