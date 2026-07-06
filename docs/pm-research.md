# RESEARCH: Prediction Markets & Settlement track (TxLINE architecture + PM design)

**Session:** S174 (2026-07-01). **Phase:** RESEARCH (deliverable). Feeds the PLAN gate.
**Method:** 6-leg fan-out research workflow (TxLINE docs, on-chain oracle program, proof format + npm package, socials/blog, PM-design survey, Solana primitives) + adversarial verification + Garry direct verification of the load-bearing conflict against the official repo and devnet RPC.
**Track:** TxODDS x Solana World Cup, Prediction Markets & Settlement ($18k: 12k / 4k / 2k USDT). Deadline Jul 19 23:59 UTC; internal hard stop Jul 17. Direction ratified this session: reuse the TxODDS oracle/proof layer, greenfield a USDC market layer.

---

## TL;DR

The core finding changes the plan from "hope the proof layer works" to "build on a confirmed native primitive." TxLINE ships a real on-chain instruction, `validate_stat`, that is a **generic stat-threshold verifier**: prove a numeric match stat via Merkle proof against the `daily_scores_roots` PDA, then evaluate a `TraderPredicate` (threshold + comparison), optionally combining two stats. Verified from the official Anchor IDL (`txoracle` v1.4.7) and official reference code, both fetched directly this session.

That primitive maps **natively** onto a prediction market: any outcome ("home wins" = home_goals minus away_goals > 0) or parametric prop ("total corners > 10") is a `TraderPredicate` over one or two `ScoreStat`s. Recommendation: **USDC pari-mutuel pool** (deposit / lock / claim_payout), where `claim_payout` **CPIs into `validate_stat`** to confirm the market's resolution condition trustlessly. This is the smallest-diff, best-demo, most-differentiated design, and it is the exact integration the track prompt rewards ("CPI into TxLINE's validate_stat to confirm outcomes trustlessly").

No pivot warranted. Remaining unknowns are honest Day-1 smoke-test items, not blockers.

---

## Part 1: TxLINE / TxODDS architecture (the deep-study)

### 1.1 What TxLINE is
TxODDS's real-time sports data layer. Streams World Cup fixtures, scores, and odds, backed by cryptographic Merkle roots written on-chain by their Solana oracle program. The verifiable-settlement angle (prove a match stat on-chain without trusting an external oracle) is the thing they pitch and the thing this track's judges reward.

### 1.2 Auth (confirmed, reused from S171, one correction to re-verify)
- `POST /auth/guest/start` returns `{token}` (Bearer JWT, ~30-day expiry).
- `POST /api/token/activate` returns `X-Api-Token` as **text/plain** (`txoracle_api_<hex>`). Body: `{txSig, walletSignature (base64 Ed25519), leagues:[]}`. `leagues` must be `[]` on devnet (`["world_cup"]` returns HTTP 500). `txSig` is single-use per activation; subscription lasts ~4 weeks.
- Data endpoints require **both** headers: `Authorization: Bearer <jwt>` and `X-Api-Token: <apiToken>`.
- **Correction to re-verify live:** the docs show the signed message as `` `${txSig}:${leagues}:${jwt}` `` (colon-joined, includes leagues), whereas S171 used `txSig::jwt`. Confirm against a live activate call before any auth-dependent work. This one is load-bearing: wrong format blocks everything downstream.

### 1.3 Data endpoints and stream
- `GET /api/fixtures/snapshot[/{epochDay}]`, `GET /api/scores/snapshot/{fixtureId}`, `GET /api/odds/snapshot/{fixtureId}`.
- `GET /api/scores/historical/{fixtureId}` (fixtures started between two weeks and six hours ago). **Directly useful for the demo**, since matches are over by judging time.
- SSE streams: `GET /api/odds/stream` and `GET /api/scores/stream` (same dual-header auth + `Accept: text/event-stream`). Subscription/filtering and reconnection are undocumented.
- **Devnet is hard-capped at SL=1**: World Cup + international friendlies, **60-second delayed** data, free. Real-time (SL=12) is mainnet-only. The demo narrative must not claim real-time data.

### 1.4 The settlement primitive (the crux, IDL-confirmed)
Official Anchor IDL `txoracle` **v1.4.7** (fetched from `github.com/txodds/tx-on-chain/idl/txoracle.json` this session). Full instruction set includes `insert_scores_root`, `insert_batch_root`, `insert_fixtures_root`, `validate_stat`, `validate_odds`, `validate_fixture`, `subscribe`, `purchase_subscription_token_usdt`, and USDT treasury instructions.

`validate_stat` signature (verbatim from IDL):
- **account:** `daily_scores_merkle_roots` (the on-chain root store; PDA seed `daily_scores_roots` + `epochDay` as u16 LE, derived under the txoracle program).
- **args:** `ts:i64`, `fixture_summary:ScoresBatchSummary`, `fixture_proof:Vec<ProofNode>`, `main_tree_proof:Vec<ProofNode>`, `predicate:TraderPredicate`, `stat_a:StatTerm`, `stat_b:Option<StatTerm>`, `op:Option<BinaryExpression>`.

Types (verbatim):
- `ProofNode { hash:[u8;32], is_right_sibling:bool }` **identical to S171's struct**, so the S171 Merkle-walk code is reusable.
- `ScoreStat { key:u32, value:i32, period:i32 }` a numeric stat by key/period, **not** a match_id+outcome-byte (S171's leaf assumption was wrong).
- `StatTerm { stat_to_prove:ScoreStat, event_stat_root:[u8;32], stat_proof:Vec<ProofNode> }`.
- `ScoresBatchSummary { fixture_id:i64, update_stats:ScoresUpdateStats, events_sub_tree_root:[u8;32] }`.
- `TraderPredicate { threshold:i32, comparison:Comparison }`, `Comparison ∈ {GreaterThan, LessThan, EqualTo}`.
- `BinaryExpression ∈ {Add, Subtract}` for compound two-stat conditions.

**Invocation pattern (verified):** the official reference `backup/examples/data_validation/validate_scores_onchain.ts` calls `program.methods.validateStat(...).rpc()` (single-stat lines 194-213; two-stat with `op:{subtract:{}}` lines 241-260). It is a **real instruction that sends a transaction**, not a read-only `.view()`. That is what makes it **CPI-able** from our own program: `claim_payout` can CPI `validate_stat`, and the resolution condition is enforced trustlessly on-chain.

Proof source: `GET /api/scores/stat-validation?fixtureId=..&seq=..&statKey=..[&statKey2=..]` returns `{ts, statToProve, eventStatRoot, statProof[], summary{...}, subTreeProof[], mainTreeProof[], ...}`. The reference code builds the `validate_stat` args directly from this response.

### 1.5 Program IDs (a real ambiguity to settle at build start)
Direct devnet + mainnet RPC this session:
- `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J` executable on **devnet only** (what S171 hardcoded).
- `9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA` executable on **both devnet and mainnet**, and it is the IDL v1.4.7 metadata address + what the official reference resolves to via `program.programId`.

Both are live txoracle deployments on devnet. **Build-day task:** confirm which one holds the current World Cup `daily_scores_roots` data on devnet (derive the PDA under each, check which account exists and carries roots). Working assumption: target `9Exb…` (matches the current IDL and reference), but verify empirically.

### 1.6 What TxODDS prizes (socials/blog)
Their positioning is "tamper-evident verifiable settlement." The track prompt explicitly elevates the "experimental verification layer" (custom on-chain check gates using their Merkle proofs) and CPI into `validate_stat`. A build that foregrounds trustless resolution scores where judges look.

---

## Part 2: The conflict that was resolved (provenance)

The research surfaced a HIGH-severity internal conflict worth recording, because the whole entry rested on it:
- Leg A2-oracle (live RPC + `anchor idl fetch` + repo-tree listing) concluded **no IDL, no `validate_stat`**, recommended against CPI, and preferred a client-side Merkle-verify design.
- Leg A2b-proof (IDL + reference-code fetch) concluded `validate_stat` is **real** with a full typed schema.

Garry direct-verified against the official repo: the IDL (`idl/txoracle.json` and `backup/idl/txoracle.json`) and reference code (`backup/examples/data_validation/validate_scores_onchain.ts`) **do exist** and **do define `validate_stat`**. A2-oracle's tree listing missed the `backup/` subtree. Its `anchor idl fetch` "no account" result was a true-but-non-refuting fact (the IDL ships as a repo file, not an on-chain IDL account). **A2b was right.** The Merkle-verify path A2-oracle recommended remains a valid fallback, not the primary.

Lesson carried: two agents disagreed, the synthesizer papered it over, the adversarial verifier caught it, and a 4-call direct check settled it. The direct check is why this doc can claim the primitive is real rather than assumed.

---

## Part 3: PM design comparison

| Design | create / trade / resolve fit | Oracle + proof fit | Settlement verifiability | Demo fitness (matches over by review) | Build cost | Verdict |
|---|---|---|---|---|---|---|
| **Pari-mutuel USDC pool** | deposit into a side before lock; resolve = one claim reading the oracle. 3 instructions, no matching/curve. | Cleanest: resolution condition IS a `TraderPredicate`; one `validate_stat` CPI. | Best: payout is a pure function of (pool totals, verified outcome), independently auditable on-chain. | Best: pool-ratio shift during the window + a claim tx showing USDC + resolution receipt. No live trading needed. | Lowest. | **Recommended** |
| CPMM / LMSR AMM | continuous buy/sell needs live activity to look interesting; resolves to a 0/1 extreme. | Oracle only at resolution; curve has no natural predicate hook. | Weaker: LVR blows up near the resolved extreme a finished match sits at (Paradigm pm-AMM). | Poor: nothing dynamic to show without live trading. | Highest (curve math, LP accounting). | Rejected |
| Binary outcome tokens (mint/burn, no AMM) | mint YES+NO vs collateral; trade = free transfer (no price discovery); resolve = burn winner, redeem 1:1. | Same oracle gate at redemption. | Fine, but no pool economics to audit; weaker story. | Weak: binary balances, no pool-ratio visual; crowded pattern. | Second-lowest. | Viable fallback |
| Order-book / CLOB | needs a matching engine for any real trading. | Same gate, buried under matching-engine surface. | Not differentiated; verifiability lives in the oracle layer anyway. | Worst: needs an OpenBook fork or fabricated order flow. | Highest realistic. | Rejected |

---

## Part 4: Ranked recommendation

**1st: USDC pari-mutuel pool, resolution gated by `validate_stat`.**

Rationale, grounded in the confirmed primitive: `validate_stat` is a stat-threshold check, and pari-mutuel is the only design that maps onto it with zero translation. Define the market's win condition as a `TraderPredicate` over one or two `ScoreStat`s; settle with a single `validate_stat` CPI from `claim_payout`; run proportional-share math off the verified result. It wins demo fitness (pool-ratio shift + claim receipt, no live trading required) and build cost (three instructions, leaving budget for the oracle CPI work judges score). It differentiates from the S171 agent entry by foregrounding **market infrastructure others settle against**, not an agent that bets.

**2nd (fallback): binary outcome tokens (mint/burn, no AMM).** Same oracle gate, simpler payout math if proportional pari-mutuel math gets messy, but weaker visual and a more generic pattern. Only if pari-mutuel stalls.

**Rejected:** CPMM/LMSR (LVR blowup at the resolved-price extreme; nothing to show on a finished match), order-book (matching engine is not a 2-week build; buries the oracle work).

---

## Part 5: Settlement design

- **Mechanism (primary):** `claim_payout` CPIs `validate_stat` on the txoracle program, passing the proof fetched from `/api/scores/stat-validation` plus the market's stored `TraderPredicate` and `ScoreStat` target(s). The CPI enforces the resolution condition trustlessly; on success, `claim_payout` disburses the pooled USDC proportionally to winning-side depositors.
- **Mechanism (fallback):** if a clean CPI proves impractical in the window, independently Merkle-verify the proof against the `daily_scores_roots` PDA root inside our program (reuses S171's `ProofNode` walk). This needs the hash function + leaf byte-encoding confirmed, which the CPI path does not.
- **Do not** default to a trusted-oracle Plan-B. A real, schema-confirmed instruction exists; use it.
- **TxLINE primitive:** `validate_stat(ts, fixture_summary, fixture_proof, main_tree_proof, predicate, stat_a, stat_b?, op?)` on the txoracle program; root PDA seed `daily_scores_roots` + `epochDay` u16 LE; proof from `GET /api/scores/stat-validation`.
- **Reuse verbatim from S171:** the full auth flow (with the `txSig:leagues:jwt` correction to re-verify), the `ProofNode` struct + Merkle-walk, the general escrow-in-PDA pattern.
- **Build new:** the market layer accounts (per-side USDC pool accumulators), `deposit` / `lock_market` / `claim_payout` instructions, the `validate_stat` CPI construction (predicate + StatTerm), the outcome-to-`TraderPredicate` mapping (since no outcome enum exists, the market computes the condition from stats), and USDC/SPL plumbing.

---

## Part 6: Solana primitives and reference code

| Item | Use | Note |
|---|---|---|
| `validate_stat` (txoracle program) | **build-on** | Primary settlement CPI target. Schema confirmed (IDL v1.4.7 + reference code). |
| `daily_scores_roots` PDA (seed + epochDay u16 LE) | **build-on** | Correct scores root store. Corrects S171's `daily_batch_roots` (that is the odds pipeline). |
| Official reference `backup/examples/data_validation/validate_scores_onchain.ts` | **build-on** | The exact working `validate_stat` call construction. Single-stat + two-stat variants. Highest-value BUILD artifact. |
| `backup/examples/subscription/fake_usdt_faucet.ts` + `purchase_tokens.ts` | **build-on** | Official devnet test-USDT faucet + token purchase. Directly answers the devnet-USDC-plumbing risk. |
| SPL Token / Anchor `token::transfer` | **build-on** | Standard USDC pool deposit/claim; no custom token logic needed. |
| `@srivtx/sports-workbench` (npm, third-party) | **reference (caution)** | A **competing entrant** in this same track. Its `verifyOddsView` is a non-functional stub (`{ok:true}`). Use only for orientation; do not reuse its validation logic, and mind similarity concerns with a rival submission. |
| CPMM/LMSR AMM patterns | **avoid** | LVR blowup near resolved prices; demo-poor for a finished match. |
| OpenBook / Serum CLOB | **avoid** | Too large for 2 weeks; buries the oracle work. |
| `daily_batch_roots` PDA | reference only | Real but odds-pipeline; relevant only if an odds-based market variant is added later. |

Note: leg B2 (broader Solana-native PM protocol scan: Monaco Protocol, Drift BET) failed on a transient API-overload and did not complete. Impact is low: the direction is locked to a purpose-built pari-mutuel on the confirmed oracle, so a survey of alternative venues is not load-bearing. Retrievable later if a reference implementation is wanted.

---

## Part 7: Demo plan (focused PoC + key visual)

The one required visual: the **pari-mutuel pool ratio shifting** across outcome sides during the deposit window, then a **single `claim_payout` transaction** on screen showing the `validate_stat` oracle verification passing, the resolved `ScoreStat`/predicate it checked, and USDC landing in a winner's wallet with a proof-backed resolution receipt (fixture id, stat checked, proof-verified badge). One continuous shot: pool before, oracle verification, payout after.

**Honesty constraints to state in the video, not hide:**
- The pool-ratio activity is **operator-seeded** (funded devnet wallets depositing on both sides). Matches are final by review, so there is no organic live trading; this is staged demonstration data, and the settlement verification against the real on-chain root is the trustless part.
- Data is **devnet SL=1 (60-second delay)**. Do not imply real-time.
- Use `GET /api/scores/historical/{fixtureId}` (or a past WC fixture with roots on devnet) so the resolution runs against real, already-final data.

---

## Part 8: Risks and open build-time unknowns

**Risks:**
1. The Merkle **hash function + leaf encoding are unconfirmed**. Mitigated by the CPI-primary design: the txoracle program hashes internally, so this only bites the fallback path.
2. **No live round-trip** was run against `validate_stat` or `/api/scores/stat-validation`. First build task is a live authenticated smoke test.
3. **No stat-key dictionary** (which `key:u32` is home_goals vs away_goals, which `period`). Needed to build the resolution predicate. Recoverable from a live stat-validation response + the reference code.
4. **Program-ID ambiguity** (`6pW…` devnet-only vs `9Exb…` devnet+mainnet/IDL). Confirm which holds WC roots on devnet.
5. **walletSignature format** discrepancy (`txSig:leagues:jwt` vs `txSig::jwt`). Re-verify live before auth-dependent work.
6. **CPI feasibility** of `validate_stat` from our program (vs standalone `.rpc()`): high-confidence buildable, but confirm on Day 1-2 with a test CPI; fallback is the client-side Merkle verify.
7. `@srivtx/sports-workbench` is a **rival entrant**; keep clear of its code beyond orientation.

**Day-1 smoke-test gate (must pass before writing settlement code):**
1. Auth end-to-end against devnet (nail the walletSignature format).
2. `GET /api/scores/stat-validation` against a finished WC fixture returns a real proof.
3. Confirm which program ID holds the `daily_scores_roots` data.
4. Run the official `validate_scores_onchain.ts` reference `validate_stat` call and get a success.
5. From (2)+(4), extract the stat-key mapping for the stats we need (goals per side).

If (1)-(4) pass, CPI-primary is green. If (4) fails, fall back to client-side Merkle verify (and then hash-fn + leaf-encoding become in-scope).

---

## Part 9: Adversarial verifier must-fixes, addressed
The RESEARCH adversarial pass returned RECOMMENDATION_NEEDS_REVISION with five must-fixes. Disposition:
1. **Resolve the IDL-existence conflict before committing to CPI.** Done: Garry direct-verified `validate_stat` is real (Part 2).
2. **Turn CPI-vs-view from a deferred contingency into a gated decision.** Done: Day-1 smoke-test gate (Part 8) with an explicit pass/fail and a pre-committed fallback.
3. **Source the stat-key dictionary before finalizing predicate logic.** Captured as smoke-test item 5; blocks predicate construction, flagged as such.
4. **State the pool-ratio visual is operator-seeded.** Done: Part 7 honesty constraints.
5. **Re-verify walletSignature format live.** Done: Part 8 risk 5 + smoke-test item 1.
