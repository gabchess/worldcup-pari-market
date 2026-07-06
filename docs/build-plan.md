# BUILD PLAN v2: WorldCup Parametric Pari-Mutuel Prediction Market (Settlement track)

**Session:** S174 (2026-07-01). **Status:** LOCKED (Gabe ratified S174). BUILD deferred to S175 (next session). No code written S174.
**Grounded in:** `docs/pm-research.md` (validate_stat IDL-confirmed), `docs/research-skills-icp.md` (skills/competitor/ICP), `docs/think-reuse-vs-fresh.md` (Direction A). Crew pair-think: Ada, Vera, Kevin, Dayo, Tomas, Juno.
**Deadline:** Jul 19 23:59 UTC. Internal hard stop Jul 17. Today Jul 1 = ~16 days.

---

## Headline (what changed from v1)
v1 was a binary YES/NO pari-mutuel pool. A live competitor (@blitz_funn) already ships exactly that (binary micro-markets + TxODDS Merkle settlement on Solana). **The differentiator, ratified this session: parametric / compound markets** built on `validate_stat`'s two-stat predicate (`stat_a op stat_b` compared to a threshold), which a binary event market cannot express and which is the track's own "prop bet" showcase. Binary stays as the working base; the parametric market is the headline + demo centerpiece.

## Goal (verifiable end-states)
Ship a working Solana devnet pari-mutuel prediction market whose outcome is resolved **trustlessly by CPI into TxLINE's `validate_stat`**, supporting **compound/parametric predicates** (spreads, totals) that binary event markets cannot, with proportional USDC payouts. Done when:
1. `anchor test` exits 0 on the program suite, including a **2-stat parametric market** end-to-end and a **payout conservation fuzz test** (total-claimed <= total-deposited under adversarial deposit amounts).
2. Live devnet demo: create a parametric market (e.g. goal-spread or total-corners), deposit both sides, lock, resolve via `validate_stat` against real (historical) WC data, proportional USDC payout, proof-backed resolution receipt.
3. Sub-5-minute demo video, screen-capturable, script locked before M1.
4. Submitted on Superteam Earn (public repo + deployed devnet + demo link + TxLINE-endpoints doc + feedback).

---

## Architecture (the scaffold)
New Anchor program `pari-market` (fresh `declare_id`), **Anchor 0.32.1**. Reuses S171's `ProofNode` struct + Merkle-walk (fallback path only). The account model already supports binary AND parametric markets.

```
programs/pari-market/src/
  lib.rs
  constants.rs            # ALL PDA seeds frozen here FIRST + classic SPL Token Program ID hardcoded
  market/state.rs         # Market
  position/state.rs       # Position
  cpi/txoracle.rs         # validate_stat CPI construction (1-stat + 2-stat)
  instructions/{init_market, deposit, lock_market, resolve, claim_payout}.rs
  proof/                  # S171 reuse, FALLBACK verify only (NOT accounting)
  errors.rs
```
```rust
#[account] pub struct Market {
  pub market_id: u64,                                  // bound into resolve() root re-check (P0)
  pub fixture_id: i64, pub epoch_day: u16,
  pub stat_a_key: u32, pub stat_b_key: Option<u32>,    // 2-stat => parametric/compound market
  pub op: Option<BinaryExpression>,                    // Add/Subtract (the differentiator)
  pub predicate: TraderPredicate,                      // threshold + comparison (the YES condition)
  pub yes_pool: u64, pub no_pool: u64,
  pub usdc_mint: Pubkey, pub vault: Pubkey,
  pub lock_ts: i64, pub locked: bool,
  pub resolved: bool, pub outcome: Option<bool>,
  pub bump: u8,
}
#[account] pub struct Position { pub market: Pubkey, pub bettor: Pubkey, pub side: bool, pub amount: u64, pub claimed: bool, pub bump: u8 }
```
Same YES/NO pool mechanics for both market kinds; only the predicate complexity differs (1-stat binary vs 2-stat parametric).

**Settlement:** `resolve` CPIs `validate_stat(ts, fixture_summary, fixture_proof, main_tree_proof, predicate, stat_a, stat_b?, op?)` on the txoracle program, **re-checking that the passed `daily_scores_roots` PDA matches this market's bound identity** (P0, prevents proving a stat against the wrong root). Trustless: a false outcome cannot be recorded. Fallback: client-side Merkle verify (reuses `ProofNode` walk; needs hash-fn confirmed).

---

## Milestones (each with a verifier)

| M | Deliverable | Verifier |
|---|---|---|
| **M0** | **Live smoke test + tooling setup + scaffold.** Adopt tools (below). Resolve program-ID. | **M0 PASSED (boolean) =** reference `validate_stat` call returns Ok on devnet against a real `daily_scores_roots` proof; program-ID + goal stat-keys committed to a `devnet-config` file; CPI depth/compute headroom traced + written down; scripted repro exits 0. **Program-ID go/no-go branch:** confirm `6pW` vs `9Exb` holds current WC roots; Plan B if neither resolves cleanly = document + escalate. Fail on the reference call => fall back to client-side Merkle verify (hash-fn + leaf-encoding become in-scope). |
| **M1** | Market accounts + `init_market` + `deposit` + `lock_market`. Seeds frozen; classic SPL Token ID hardcoded. | `anchor test` green: create, deposit both sides, pools update, lock closes deposits. **+ lock-race test:** same-slot deposit-at-lock is rejected. |
| **M1.5** | IDL/client codegen + devnet wallet funding. | Anchor IDL generated; TS client compiles against it; deployer funded (SOL); test wallets funded (fake USDC via official `fake_usdt_faucet.ts`). |
| **M2a** | `resolve` (validate_stat CPI, 1-stat) + happy-path settlement + **market-id/root re-check**. | `anchor test` green: resolve sets outcome from a real/mocked proof; wrong-root resolve rejected; double-resolve guard. |
| **M2b** | `claim_payout` + **payout-math hardening**. | `anchor test` green: proportional claim; double-claim guard; **conservation-invariant fuzz test** (total-claimed <= total-deposited across adversarial amounts, dust-rounds-to-zero, last-claimer-remainder). This is the highest-risk node; carries the majority of slack. |
| **M2.5** | **Parametric market (2-stat predicate) = the differentiator.** | `anchor test` green: a compound market (e.g. `home_goals - away_goals > threshold`, or `corners_a + corners_b > threshold`) resolves correctly via the 2-stat `validate_stat` path (`op = Add/Subtract`). |
| **M4a** | Early security (parallel M1). | Dayo: CPI trust-boundary spec + seed-freeze audit + `mcp.solana.com` autofixer scan clean. **M2a->M3 gated on M4a clearing.** |
| **M3** | USDC/SPL integration end-to-end on devnet. | Real SPL transfers on devnet test-USDT; ATAs wired; full lifecycle on-chain. |
| **M4b** | Late adversarial security (post-M2). | Dayo: adversarial pass on `resolve`/`claim_payout` (dust/rounding/double-claim/lock-race/wrong-root). `DAYO_CLEARED`. |
| **M5** | Minimal UI (the key visual). | Renders live: pool ratio / implied odds shifting during deposits + resolution receipt (fixture, stat(s), predicate, proof-verified badge, USDC payout). |
| **M6** | Demo video (<5 min). Script LOCKED before M1. | One continuous shot on a parametric market: pool shift -> `validate_stat` CPI (explorer tx link on screen) -> instant payout. Honesty disclosures shown (operator-seeded liquidity, SL=1 devnet, single-proof resolution). |
| **M7** | Submission. | Public repo, deployed devnet program id, demo link, TxLINE-endpoints doc, API feedback. Submitted before Jul 17. |

**Slack:** M2a+M2b+M2.5 (the CPI + novel payout math + 2-stat path) carry the majority of the 16-day buffer. If M2 slips 4 days it is absorbed here, not by M6/M7.

---

## Tools adopted this session (install at M0)
- `solana-dev-skill` (official, MIT, Anchor 0.32.1): `npx skills add https://github.com/solana-foundation/solana-dev-skill` (read `install.sh` first).
- `mcp.solana.com` autofixer (zero-install, continuous pre-Dayo gate): `claude mcp add --transport http solana-mcp https://mcp.solana.com/mcp`.
- `anchor-bankrun` (test-only, fast iteration): npm (socket-install discipline), pair with `solana-test-validator` for the final pre-devnet pass.
- REFERENCE: `solana-foundation/program-examples` (escrow/CPI/token patterns). `safe-solana-builder` = TRIAL only behind Dayo's full read (unlicensed, stale); promote to M4b only if clean.
- REJECTED: `sendaifun/solana-mcp` (broad write surface), GuiBibeau fork. Existing `/solana-anchor` etc. diffed against the official skill at M0 (refresh-in-place vs adopt-on-top).

## Competitor response (@blitz_funn is live in-track)
Blitz = binary in-play micro-markets + Merkle settlement, real-time. We do NOT compete on their real-time turf. We win on: (1) **compound/parametric markets** (2-stat predicate) they don't express; (2) **settlement depth** shown literally on camera (the `validate_stat` CPI + explorer tx), framed as "verifiable fact, not a token-holder vote" against the Polymarket freeze/hack baseline.

## Explicit non-goals
- No AMM / bonding curve / order-book. No mainnet. No real-time / live-in-play markets (Blitz's turf; we use historical fixtures). No full-tournament UI. No secondary market / position exit. No extending the S171 program.
- **No reuse of S171's Merkle module beyond the `ProofNode` struct** (no accounting/vault assumptions imported into the from-scratch payout math).

## Non-obvious decisions
- **Parametric (2-stat) is the differentiator, not new architecture.** Same YES/NO pool; richer predicate. Beats Blitz on a native `validate_stat` capability at minimal build delta.
- **New `pari-market` program**, not extending S171 (clean audit surface; S171 submission intact).
- **CPI-primary settlement** (txoracle hashes internally => hash-fn unknown only bites the fallback).
- **market-id bound at init, root re-checked at resolve** (a CPI that proves the right stat against the wrong root is a real bug even if txoracle is honest).
- **Payout conservation fuzz at end of M2**, not M4 (cumulative rounding that lets payouts exceed the pool is a fund drain, not cosmetic dust).
- **Security split M4a (early structural) / M4b (late adversarial)**; the riskiest code does not surface last.
- **Demo script locked before M1** (demo is the judged artifact; it drives the build, not vice versa).
- **Operator-seeded demo deposits, disclosed** (matches final by review; trustless part is the on-chain resolution).

## Loadout (confirmed no new hire)
Bram builds. Dayo runs M4a (early) + M4b (late) backed by a named payout-math checklist + the autofixer pre-gate. Sarah/Marta on the M6 demo, storyboarded to the parametric-market + CPI visual. Garry main-thread for M0 (GABE_GATE on the devnet wallet).

## Open at LOCK
1. Ratify this hardened plan to unlock BUILD (starts M0).
2. Devnet wallet + active subscription available for M0 (fresh on-chain subscribe; `txSig` single-use).
3. Demo market pick for the script (default: a finished WC fixture that resolves a clean goal-spread or total).
