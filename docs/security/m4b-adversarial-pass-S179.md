# M4b: Late Adversarial Pass on resolve() and claim_payout()

Scope: `programs/pari-market/src` at the tree live on devnet
(565SYmLeQ64r8kNujRpVhnfGgAybQrXz72knMyUj1xc3). This is the LATE pass on the
built and deployed reality, following the M4a spec (structural, pre-body) and
the M4a autofixer scan (clean, static). M4b attacks the actual shipped
resolve()/claim_payout() code with reproducing tests, not another read-only
review.

Method: 10 attack hypotheses across CPI trust boundary, access control,
state-machine ordering, and fund conservation, each written as a litesvm test
in `programs/pari-market/tests/m4b_adversarial.rs`. resolve() attacks run
against the REAL dumped txoracle.so and real devnet-fetched proof fixtures
(same harness as `tests/resolve.rs`); claim_payout() attacks use the
force-resolve pattern (no CPI needed, M2a/M2.5 already own oracle-CPI
correctness). Every test is an attack: a PASS on a rejection-asserting test
means the guard held under adversarial input; no test in this pass asserted
an unexpected success.

## Section 1: Prior Artifact Summary

`m4a-trust-boundary-spec.md` (pre-M1, structural spec): 2 P0 findings against
resolve()'s CPI trust boundary (B4: CPI args must be checked against stored
market fields before invoking validate_stat; A1: CPI return-data program_id
must be checked before trusting the decoded bool). Both closed in M2a per
source comments at `resolve.rs:14-39` and `cpi/txoracle.rs:88-116`, and
independently confirmed live in this pass (see Section 4). 5 P1 findings
(compute budget enforcement, decoded-byte domain check, Position
side-mismatch design, lock_market time gate, claim_payout winning-side
has_one/constraint) and 1 P2 (duplicate-account-passing defense-in-depth),
all either closed in scaffold, closed in M1/M2a, or explicitly deferred.

`m4a-autofixer-scan-S179.md`: mcp.solana.com static scan, 16/16 files, 0
issues, 0 suggestions. Confirmed the two M4a P0 fixes are present in source
(resolve.rs:81-82 fixture/stat_a_key checks, cpi/txoracle.rs:103-107
program_id check). A static scan cannot exercise adversarial input paths;
that is this pass's job.

## Section 2: Source Read (resolve.rs, claim_payout.rs)

`resolve.rs` (173 lines): pre-CPI, checks `fixture_summary.fixture_id ==
market.fixture_id` and `stat_a.stat_to_prove.key == market.stat_a_key`
unconditionally, and (when `market.stat_b_key` is `Some`) requires the
caller's `stat_b` argument to be `Some` with a matching key, else rejects
with `FixtureMismatch` before the CPI runs. Post-CPI, `validate_stat_single`/
`validate_stat_two` (in `cpi/txoracle.rs`) decode `get_return_data()`,
require the returning program to equal `TXORACLE_PROGRAM_ID`, and only then
decode the first byte as a strict 0/1 domain check. The `Resolve` Accounts
struct pins `market.locked`, `!market.resolved`, the foreign
`daily_scores_merkle_roots` PDA via cross-program seed re-derivation, and
`txoracle_program.key() == TXORACLE_PROGRAM_ID`.

`claim_payout.rs` (178 lines): payout math is `amount * total_pool /
winning_pool` in a u128 intermediate, floor division, checked cast back to
u64; dust from floor division stays in the vault by design (no
redistribution). The empty-winning-pool refund path lets every position
(any side) reclaim exactly `position.amount` when nobody backed the winner.
The `ClaimPayout` Accounts struct binds `has_one = market`, `has_one =
bettor`, `!position.claimed`, and the winner-or-empty-pool OR'd constraint,
all at account-validation time (fails before payout math runs). Vault
outbound transfers sign via `CpiContext::new_with_signer` with the Market
PDA's own seeds; `token::mint`/`token::authority` constraints pin both the
vault and the destination token account.

## Section 3: Hypothesis Enumeration

Ranked by severity times plausibility, prioritizing fund-safety depth over
low-severity breadth per the 14-day window.

| ID | Category | Hypothesis | Plausibility |
|---|---|---|---|
| H1 | CPI trust boundary | stat_a/stat_b payload swap bypasses the key-binding guard | Medium (M4a flagged the guard as unverified under adversarial input) |
| H2 | CPI trust boundary | two-stat market resolves via single-stat CPI when caller omits stat_b | Medium (untested gap identified on source read) |
| H3 | CPI trust boundary | two-stat market accepts a wrong-keyed stat_b | Medium (adjacent to H2, untested gap) |
| H4 | Access control | attacker claims a victim's Position PDA by signing as a different bettor | Low-Medium (has_one=bettor should close this, worth proving) |
| H5 | Access control | cross-market Position PDA substitution drains a different market's vault | Low-Medium (seeds re-derivation should close this) |
| H6 | Access control | largest depositor in the market, on the losing side, bypasses winner-only gate | Low (deposit size should be irrelevant to the side check, worth confirming) |
| H8 | Fund conservation | empty-winning-pool refund pays multiple depositors a pooled/averaged amount instead of exact individual refunds | Low (body reads position.amount per-call, should be safe) |
| H9 | Access control | wrong-mint destination token account redirects or corrupts a payout | Low (token::mint constraint should close this) |
| H10 | State-machine ordering | claim_payout reachable before resolve(), reaching the misleadingly-named body guard | Low (Accounts-struct constraint should close this before the body runs) |
| Hardened fuzz | Fund conservation | conservation holds under 12-depositor prime-heavy, whale-vs-many-small-winners, and near-equal-odd-total distributions | Medium (M2b fuzz caps at 7 depositors; pushing further is cheap insurance) |

One hypothesis considered and DROPPED before writing a test: a market
created with `stat_a_key == stat_b_key` (identical stat referenced twice).
This is an `init_market`-time market-creator footgun, not caller-adversarial
input at `resolve()`/`claim_payout()` time (the values are frozen in market
state before either instruction runs), and `init_market` is out of this
pass's scope per the M4b brief.

## Section 4: Per-Hypothesis Findings Table

| # | Category | Attack | Severity if it held | Reproduced? | Verdict | Test name |
|---|---|---|---|---|---|---|
| H1 | CPI trust boundary | Swap stat_a/stat_b payloads (stat_b's key=2 payload submitted in the stat_a slot) | Critical (would let a caller evaluate a different predicate than the market's bound stat) | Yes, attack rejected | CLEARED-with-proof (FixtureMismatch, code 6009) | `attack_resolve_stat_a_stat_b_swapped_rejected` |
| H2 | CPI trust boundary | Two-stat market, caller omits stat_b entirely | High (would silently fall through to single-stat CPI against the wrong predicate) | Yes, attack rejected | CLEARED-with-proof (FixtureMismatch, code 6009) | `attack_resolve_two_stat_market_missing_stat_b_rejected` |
| H3 | CPI trust boundary | Two-stat market, caller supplies stat_b with the wrong embedded key | High (same class as H2) | Yes, attack rejected | CLEARED-with-proof (FixtureMismatch, code 6009) | `attack_resolve_two_stat_market_wrong_stat_b_key_rejected` |
| H1b | CPI trust boundary (safety, not attack) | Single-stat market, caller attaches an unrequested stat_b | N/A (confirming inert behavior, not a vuln) | Yes, resolves correctly using stat_a alone | CLEARED-with-proof (outcome unaffected by injected stat_b) | `attack_resolve_single_stat_market_extra_stat_b_ignored_safely` |
| H4 | Access control | Attacker signs as themselves, passes victim's Position PDA, redirects payout to attacker's token account | Critical (direct fund theft) | Yes, attack rejected | CLEARED-with-proof (Anchor has_one=bettor constraint violation, InstructionError::Custom) | `attack_claim_payout_steal_via_victim_position_pda` |
| H5 | Access control | Reuse a winning Position PDA from market A against market B's vault | Critical (cross-market drain) | Yes, attack rejected | CLEARED-with-proof (Anchor seeds/has_one=market constraint violation) | `attack_claim_payout_cross_market_position_substitution_rejected` |
| H6 | Access control | Largest single depositor in the market (9,000,000 units), on the losing side, attempts to claim | High (would let deposit size override the side check) | Yes, attack rejected, and winners still received exact correct payout after the rejected attempt | CLEARED-with-proof (LosingPosition, code 6012; no state corruption) | `attack_claim_payout_largest_depositor_on_losing_side_still_rejected` |
| H8 | Fund conservation | Empty-winning-pool refund, three depositors with unequal non-round amounts (123,456 / 7,777 / 999,999) | Medium (would indicate the refund path pools/averages rather than reading per-position) | Yes, each got exactly their own deposit back, vault drained to 0 | CLEARED-with-proof | `attack_claim_payout_empty_winning_pool_refund_multiple_depositors_exact_amounts` |
| H9 | Access control | Claim payout redirected through a wrong-mint destination token account | Medium-High (mint confusion) | Yes, attack rejected, legitimate claim still succeeds afterward via the correct account | CLEARED-with-proof (Anchor token::mint constraint violation) | `attack_claim_payout_wrong_mint_destination_rejected` |
| H10 | State-machine ordering | claim_payout attempted before resolve() ever ran | High (would let a bettor drain an unresolved market's vault) | Yes, attack rejected before the body runs | CLEARED-with-proof (AlreadyResolved, code 6003, fires as the Accounts-struct-level not-yet-resolved guard) | `attack_claim_payout_before_resolve_rejected_at_account_validation_layer` |
| Hardened fuzz | Fund conservation | 12-depositor prime-heavy set, whale-vs-9-tiny-winners set, near-equal-odd-total set | Critical if conservation broke (fund drain) | Yes, conservation held on all three cases; every eligible claim received the exact floor-divided share, every ineligible claim was rejected, no vault under/overrun | CLEARED-with-proof (sum_payouts <= total_deposited, vault balance exact on all three cases) | `attack_conservation_fuzz_hardened` |

No VULN findings. No GATE_NEEDED items (every attack in this pass was
fully reproducible in litesvm; none required a live devnet value-transaction).

One naming note, not a fund-safety finding: `claim_payout`'s body line
`market.outcome.ok_or(PariMarketError::AlreadyResolved)?` uses a
backwards-sounding error name for the "not yet resolved" case (the body can
only reach this line after the Accounts-struct `constraint =
market.resolved @ AlreadyResolved` already passed, so `market.outcome` can
never actually be `None` there in the real instruction flow -- H10 confirms
the rejection happens at the Accounts-struct layer, before the body). This
is a cosmetic dead-code/naming observation, not an exploitable path;
flagging for awareness, not filing as a severity-scored finding.

## Section 5: Test Results

```
cargo test -p pari-market
```

All 5 test binaries green, 35/35 total (24 original + 11 new):

- `pari_market.rs`: 8/8 (unchanged, M1 instructions)
- `resolve.rs`: 6/6 (unchanged, M2a resolve() gold-path + guards)
- `claim_payout.rs`: 6/6 (unchanged, M2b claim_payout() gold-path + guards + original conservation fuzz)
- `parametric.rs`: 3/3 (unchanged, M2.5 parametric predicate tests)
- `m4b_adversarial.rs`: 11/11 (new, this pass)
- lib unit test + doc-tests: 1/1, 0/0

No existing test was modified. `m4b_adversarial.rs` is a new file; it does
not touch any of the four sibling test files.

## Section 6: Fund-Safety Verdict

Both P0 findings from the M4a structural spec (CPI arg vs. stored-market-field
mismatch, CPI return-data program_id check) are not just present in source
(confirmed by the M4a autofixer scan) but hold under active adversarial
input in this pass: payload swapping, missing/wrong-keyed stat_b, and
cross-stat confusion were all attempted against the real dumped txoracle
program and real proof fixtures, and every attempt was rejected pre-CPI with
the correct error code. The `claim_payout` winner-only constraint and its
empty-winning-pool refund carve-out held against victim-position substitution,
cross-market position reuse, wrong-mint redirection, deposit-size bypass
attempts, and pre-resolve claim attempts. The conservation invariant
(`sum(payouts) <= total_deposited`, exact vault balance after every claim)
held across a harder fuzz set than M2b's original five cases (up to 12
depositors, a 50,000,000-to-1 whale-vs-tiny-winners ratio, and non-round
near-equal pools), with every payout matching its exact floor-divided share.

No fund-safety vulnerability was found in resolve() or claim_payout() in this
pass. All ten attack hypotheses resulted in the targeted guard rejecting the
adversarial input, and each rejection is now a permanent regression lock in
`tests/m4b_adversarial.rs`. This is a late-pass confirmation, not a
first-pass claim: the guards were attacked with adversarial inputs the M4a
structural spec explicitly could not exercise (it predates the M1 body), and
every attack failed against the shipped, devnet-deployed code.

## Section 7: GATE_NEEDED Items (devnet tx not fired)

None. Every hypothesis in this pass was fully reproducible via litesvm
(in-process SVM against the real dumped txoracle.so for resolve() attacks,
and force-resolve for claim_payout() attacks). No finding in this pass
required firing a new devnet value-transaction.
