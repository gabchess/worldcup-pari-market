# M4a Trust-Boundary Spec: pari-market Program

Scope: `programs/pari-market/src` at commit `79b4a45` (constants frozen, Accounts constraints in place, instruction bodies are `NotImplemented`/`todo!` stubs pending M1). This is a structural spec and audit, not an exploit report. Every item below states a checkable assertion, a severity, and who closes it.

Oracle ground truth (M0): `txoracle` program is `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J` on devnet. `daily_scores_roots` is a PDA owned by that program, seeded by `daily_scores_roots` + `epoch_day` as `u16` LE. `validate_stat` is Ok-with-bool: it does not revert on a false predicate, so the result is only observable by decoding CPI return data (first byte 0/1). The CPI costs roughly 179k compute units, so `resolve()` must request a raised compute budget (`constants::RESOLVE_RECOMMENDED_COMPUTE_UNITS = 500_000`).

---

## 1. CPI Trust-Boundary Spec for resolve()

Three checkpoints: before the CPI, during the CPI, after the CPI. Each assertion is written so M2a can turn it directly into a test.

### Before the CPI

| # | Assertion | Status |
|---|---|---|
| B1 | `txoracle_program.key() == TXORACLE_PROGRAM_ID`, enforced by an Anchor `constraint` on the `Resolve` accounts struct. | CLOSED-IN-SCAFFOLD, `resolve.rs:89` |
| B2 | `daily_scores_merkle_roots` is re-derived under `TXORACLE_PROGRAM_ID` from `DAILY_SCORES_ROOTS_SEED` + `market.epoch_day`, using `seeds::program = TXORACLE_PROGRAM_ID`. Anchor rejects the instruction if a caller substitutes an account at a different address. | CLOSED-IN-SCAFFOLD, `resolve.rs:80-84` |
| B3 | `market.locked == true` and `market.resolved == false`, enforced by Anchor constraints on the `market` account. | CLOSED-IN-SCAFFOLD, `resolve.rs:71-72` |
| B4 | The CPI arguments (`fixture_summary`, `stat_a`, `stat_b`, `predicate`) are built from `market.fixture_id`, `market.stat_a_key`, `market.stat_b_key`, `market.op`, and `market.predicate`, not from unchecked instruction args. Currently `resolve()` takes `fixture_summary`, `stat_a`, `stat_b` as raw caller-supplied instruction args with no comparison against the stored `market` fields. | **P0, open.** M1 body must assert `fixture_summary.fixture_id == market.fixture_id` and that the stat keys embedded in `stat_a`/`stat_b` match `market.stat_a_key`/`market.stat_b_key` before invoking the CPI. Without this, a caller can pass a `fixture_summary` for a different fixture while still targeting this market's `daily_scores_merkle_roots` PDA (the PDA is keyed by `epoch_day` only, not by `fixture_id`), and get a CPI success against the wrong game's proof data. Closes in: M1 body (Bram). |

### During the CPI

| # | Assertion | Status |
|---|---|---|
| D1 | The CPI passes `daily_scores_merkle_roots` as a read-only, non-signer account, matching the txoracle IDL's `validate_stat` account list (single account, not a signer). | Verifiable once M1 body exists; currently the `validate_stat_single`/`validate_stat_two` functions in `cpi/txoracle.rs` are `todo!()`. Closes in: M1 body (Bram). |
| D2 | `resolve()` does not pass any writable or signer account into the CPI beyond what `validate_stat` expects. The current `Resolve` Accounts struct exposes only `market` (mut, our own PDA), `daily_scores_merkle_roots` (read-only), `txoracle_program`, and `caller` (signer, not passed into the CPI). No excess writable/signer surface is exposed to the CPI target today. | CLOSED-IN-SCAFFOLD, `resolve.rs:65-95` |
| D3 | The transaction requests a compute budget of at least `RESOLVE_RECOMMENDED_COMPUTE_UNITS` (500k) via a `ComputeBudgetProgram::set_compute_unit_limit` pre-instruction, since the CPI alone measured ~179k CU against a 200k default. | **P1, open.** Nothing in the current scaffold enforces this at the instruction level (it is a client-side/tx-builder responsibility, and Anchor cannot self-request compute budget from within the invoked instruction). Document as a MUST in the client SDK and add an M2a fork test that resolves with a default (200k) budget and confirms it fails, then with 500k and confirms it succeeds. Closes in: M2a spec + client SDK docs. |

### After the CPI

| # | Assertion | Status |
|---|---|---|
| A1 | `resolve()` calls `get_return_data()` and verifies the returned `(program_id, data)` tuple's `program_id` equals `TXORACLE_PROGRAM_ID` before trusting `data`. Solana's CPI return-data slot is a single global buffer set by whichever program last called `set_return_data`; if `validate_stat` itself makes a further CPI to another program that also sets return data, or if a future upgrade to txoracle adds an inner CPI, `get_return_data()` could return a tuple whose `program_id` is not `TXORACLE_PROGRAM_ID`. Trusting `data` without checking `program_id` first is the load-bearing CPI trust-boundary check for this instruction. | **P0, open.** `cpi/txoracle.rs` functions are `todo!()`; the doc comment on both (`txoracle.rs:64-69`, `txoracle.rs:98-100`) states the decode requirement but does not yet state the `program_id` check explicitly. Closes in: M1 body (Bram), spec requirement below. |
| A2 | The decoded first byte is checked against the domain `{0, 1}` only; any other byte value is treated as a decode failure, not silently coerced to `false`. | **P1, open.** Not yet written (CPI body is `todo!()`). Closes in: M1 body (Bram). |
| A3 | Outcome recording (`market.resolved = true; market.outcome = Some(decoded_bool)`) happens atomically with the CPI result decode, in a single instruction execution with no intermediate persisted state. Solana instructions are atomic by default (an error anywhere in the instruction reverts the whole transaction), so this is a property of "don't split resolve() across multiple instructions," not something that needs extra code. | Verifiable once M1 body exists as a single function. Closes in: M1 body (Bram), confirm no cross-instruction state split introduced. |
| A4 | A second `resolve()` call on an already-resolved market fails before reaching the CPI (saves the ~179k CU CPI cost on the guaranteed-fail path). | CLOSED-IN-SCAFFOLD, `resolve.rs:72` (`constraint = !market.resolved`) runs as part of account validation, before the instruction body executes. |

**Required M1 addition, stated as one line for the M1 body:** before invoking `validate_stat`, decode `get_return_data()` and require `program_id == TXORACLE_PROGRAM_ID`; only then decode `data[0]` as the bool. This must be phrased as an explicit `require!` or early return, not implied by "the CPI succeeded."

---

## 2. Seed-Freeze Audit

Per-PDA: seed composition, collision risk, bump handling, authority model.

### Market PDA

Seeds: `[MARKET_SEED, market_id.to_le_bytes()]` (`constants.rs:19`, `init_market.rs:45`).

- **Collision analysis:** `market_id` is a caller-chosen `u64` with no on-chain uniqueness enforcement beyond Anchor's `init` (which fails if the PDA already exists). Collision-free by construction: `init` on an existing PDA errors, so two markets can never share a `market_id`. No open item.
- **Bump handling:** stored in `market.bump` at init, re-derived via `bump = market.bump` on every subsequent instruction that touches `Market` (`deposit.rs:29`, `lock_market.rs:31`, `resolve.rs:70`, `claim_payout.rs:29`). Correct pattern (canonical bump, not re-searched). No open item.
- **Authority model:** the `Market` struct has no `authority` field. `lock_market` and `resolve` are permissionless by design per `docs/pm-research.md`'s trustless model. This is intentional, not a gap; see the lock_market griefing analysis below for the one place this needs a time gate.

### Position PDA

Seeds: `[POSITION_SEED, market.key(), bettor.key()]` (`constants.rs:22`, `deposit.rs:38`).

- **Collision analysis, P0:** the seed does not include `side`. One `(market, bettor)` pair maps to exactly one `Position` account, but `deposit(ctx, amount, side)` takes `side` as a free instruction argument with no constraint tying it to a value already stored on an existing `Position`. Given `init_if_needed`, the second deposit call from the same bettor on the same market reuses the existing `Position` PDA (does not re-init) and the M1 body must decide what happens if `side` differs from `position.side` on that second call. Two coherent designs exist: (a) reject a `side` mismatch with a new error, or (b) treat `Position.side` as immutable after first deposit and silently apply subsequent deposits to the stored side regardless of the `side` arg passed in. Either is defensible, but the scaffold currently implements neither: nothing in the `Deposit` Accounts struct prevents inconsistent `side` values across repeated calls, and the instruction body is `NotImplemented`. This is a genuine open product-and-security question, not purely cosmetic: a wrong implementation lets a bettor's later deposit silently land on the opposite side from what they intended, or lets the on-chain state hold a stale `position.side` from init while `market.yes_pool`/`market.no_pool` accounting drifts against it. **Closes in: M1 body must pick one design and enforce it with an explicit check; M2a spec should test the case where a second `deposit()` passes a different `side` than the first.**
- **Bump handling:** stored in `position.bump` at (re)init, re-derived via `bump = position.bump` in `claim_payout.rs:38`. Correct. No open item.
- **Authority model:** `claim_payout`'s `has_one = market` and `has_one = bettor` constraints (`claim_payout.rs:39-40`) bind the `Position` PDA's stored `market`/`bettor` fields to the accounts actually passed into the instruction, closing the "pass someone else's Position PDA" attack at the account-validation layer. CLOSED-IN-SCAFFOLD.

### Vault PDA (token account)

Seeds: `[VAULT_SEED, market.key()]` (`constants.rs:25`, `init_market.rs:59`).

- **Collision analysis:** one vault per market, collision-free by the same `init`-fails-on-existing argument as Market. No open item.
- **Authority model, P0-adjacent verification:** the vault's `token::authority = market` (`init_market.rs:63`, `deposit.rs:48`, `claim_payout.rs:50`) makes the Market PDA itself the SPL Token authority over the vault, not a separate keypair or a human-controlled multisig. This is the correct pattern for a program-controlled vault: outbound transfers in `claim_payout`'s M1 body must sign via `CpiContext::new_with_signer` using `[MARKET_SEED, &market.market_id.to_le_bytes(), &[market.bump]]` as the signer seeds. **Verify in M1 review that the M1 body actually uses `new_with_signer` with these exact seeds and not a raw `invoke` (which would fail, since a PDA cannot sign without the seeds+bump passed to the CPI context) or, worse, an authority mismatch that would need a separate signer.** Nothing to fix in the scaffold itself; this is a verification note for whoever reviews the M1 diff. Closes in: M1 review (Bram + reviewer).

### daily_scores_roots PDA (foreign, txoracle-owned)

Not one of our PDAs; covered under Section 1 (CPI trust boundary) since the risk is entirely about which root gets passed into `resolve()`, not about our own seed derivation.

### lock_market griefing analysis

`lock_market` is permissionless and intended to be time-gated on `Clock::get()?.unix_timestamp >= market.lock_ts` per the doc comment at `lock_market.rs:11`. **P1, open:** that time check is not present anywhere in the `LockMarket` Accounts struct (it can only live in the instruction body, which is currently `NotImplemented`), so nothing today prevents an early lock at the Anchor-constraint layer. Once the M1 body adds the check, the design is: no griefing vector for late lock (anyone can lock after `lock_ts`, which is the intended behavior, permissionless is a feature here since it means no single keyholder can grief by refusing to lock). Early-lock impossibility is what the M1 body must guarantee, not what the scaffold's constraints guarantee today. Closes in: M1 body (Bram), M2a spec should include a fork test that calls `lock_market` before `lock_ts` and confirms it fails.

`market.locked` double-lock: `constraint = !market.locked` on `LockMarket`'s `market` account (`lock_market.rs:32`) already causes a second `lock_market()` call to fail with `MarketLocked` before the instruction body runs. The open "no-op or rejected" question noted in the doc comment (`lock_market.rs:17-18`) is already answered by the existing constraint: it is rejected, not a no-op. No further design decision needed; the comment can be updated to reflect this once M1 lands.

---

## 3. Anchor Footgun Checklist

| Footgun | Present? | Assessment |
|---|---|---|
| `init_if_needed` reinit attack | Yes, `deposit.rs:35` on `Position`. | **Flagged at scaffold time, Bram closing in M1 tonight per brief.** Spec requirement for verifiability: the M1 body must NOT re-set `position.market`, `position.bettor`, or `position.claimed` on a repeat call (only `position.amount` should mutate, via `checked_add`); re-running the init-only fields on an existing account is the actual `init_if_needed` reinit risk (a caller could otherwise reset `claimed` back to `false` on a position that already paid out, if the M1 body carelessly re-writes all fields on every call instead of only updating `amount`). M2a should add a fork test: deposit, claim, deposit again on the same `(market, bettor)`, and confirm `claimed` stays `true` and the second deposit either fails (market already resolved, expected) or is rejected on other grounds, never resets `claimed`. |
| `UncheckedAccount` justification | Two instances, both in `resolve.rs`. | `daily_scores_merkle_roots` (`resolve.rs:85`): justified via `seeds`+`seeds::program` re-derivation (Section 1, B2), CLOSED-IN-SCAFFOLD. `txoracle_program` (`resolve.rs:90`): justified via the `constraint` pinning to `TXORACLE_PROGRAM_ID` (Section 1, B1), CLOSED-IN-SCAFFOLD. Both `CHECK:` comments correctly state the enforcing mechanism inline, matching Anchor's required-comment convention. |
| `has_one`/`constraint` coverage on `claim_payout` | Present. | `has_one = market`, `has_one = bettor`, `constraint = !position.claimed` all present (`claim_payout.rs:39-41`). `market.resolved` is checked on the `market` account itself (`claim_payout.rs:31`). One gap: **P1, open.** Nothing in the `ClaimPayout` Accounts struct checks that `position.side == market.outcome` (i.e., that the claimant was on the winning side). This can only be checked in the instruction body today since `market.outcome` is an `Option<bool>` compared against `position.side`, which Anchor's declarative `constraint` syntax can express (`constraint = market.outcome == Some(position.side)`) but does not currently include. Recommend adding this as a struct-level `constraint` rather than an in-body `require!`, since it belongs to account validation, not business logic, and fails cheaper (before any CU is spent on payout math). Closes in: M1 body or Accounts struct addition (Bram). |
| Missing `mut` | None found. | All accounts that are written to (`market` in `resolve`/`lock_market`/`deposit`, `position` in `deposit`/`claim_payout`, `vault` and `bettor_usdc` in `deposit`/`claim_payout`, `bettor`/`authority` as fee payers) carry `mut`. Verified by direct read of all five instruction files. No open item. |
| Duplicate-account passing (same account as two params) | Not enforced anywhere. | **P2, open.** None of the five `Accounts` structs have a `constraint` preventing, for example, `bettor_usdc` and `vault` from being passed as the same token account, or `market.usdc_mint` mismatches being silently accepted (though `token::mint = market.usdc_mint` on both `vault` and `bettor_usdc` does catch a genuine mint mismatch, it does not catch the same account being passed twice for two different roles if the mints happen to match, e.g. a degenerate single-account market where authority also equals bettor). Realistic exposure here is low given the `token::authority` constraints already differentiate `vault` (authority = market PDA) from `bettor_usdc` (authority = bettor signer), which makes true duplicate-passing self-defeating for an attacker in most of these flows. Still worth a explicit deny for defense in depth. Closes in: M2b (lower priority, not required for M1). |
| Token program spoofing | Not possible. | `pub token_program: Program<'info, anchor_spl::token::Token>` on `init_market`, `deposit`, and `claim_payout`. Anchor's `Program<'info, T>` wrapper type enforces `account.key() == T::id()` at deserialization time, independent of any manual `constraint`. This closes token-program spoofing by construction, not by an explicit check the M1 author could forget. CLOSED-IN-SCAFFOLD, no action needed. |
| `remaining_accounts` discipline for the CPI | N/A. | `resolve()`'s CPI to `validate_stat` does not use `remaining_accounts`; the `daily_scores_merkle_roots` and `txoracle_program` accounts are named, typed struct fields, which is the safer pattern. No open item. |

---

## Findings Summary

- **P0 (2):** CPI arg vs. stored-market-field mismatch check missing before invoking `validate_stat` (Section 1, B4); CPI return-data `program_id` check missing after the CPI (Section 1, A1). Both close in the M1 body.
- **P1 (5):** compute budget request is unenforced (Section 1, D3, closes in client SDK + M2a); decoded-byte domain check missing (Section 1, A2, closes in M1); Position `side`-mismatch-on-repeat-deposit is undecided (Section 2, Position PDA, closes in M1 + M2a); `lock_market` time gate not yet implemented (Section 2, lock_market griefing, closes in M1 + M2a); `claim_payout` missing a winning-side check at the Accounts-struct level (Section 3, has_one coverage, closes in M1).
- **P2 (1):** no defense-in-depth guard against duplicate-account passing across roles (Section 3, deferred to M2b, not required for M1).
- **CLOSED-IN-SCAFFOLD (9):** txoracle program ID pin (B1), root PDA cross-program re-derivation (B2), market locked/not-resolved gate (B3), CPI account surface minimality (D2), double-resolve guard runs pre-CPI (A4), Market PDA collision-freedom + bump handling, Position `has_one` binding, Vault PDA collision-freedom, Token program spoofing closed by Anchor's `Program<T>` type.

## M4a Status

The CPI trust-boundary spec, seed-freeze audit, and Anchor footgun checklist above are complete for the current scaffold (commit `79b4a45`). This document is read-only analysis: no `.rs` files were modified. The third planned M4a item, the `mcp.solana.com` autofixer scan, did not run this session because that MCP loads next session; it remains the explicit M4a remainder and should run against this same commit (or whatever M1 lands as) before M4a is declared fully closed.
