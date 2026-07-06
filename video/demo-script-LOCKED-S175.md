# M6 Demo Script — LOCKED (S175)
## WorldCup Parametric Pari-Mutuel Prediction Market — Superteam Earn Settlement Track

**Status:** LOCKED S175 (2026-07-02). Gates M1 per build-plan-v2-LOCKED.md.
**Hard cap:** 5:00. **Target:** under 4:30 (margin built in).
**Shot style:** ONE continuous shot. No cuts (this diverges from C13's 3-cut recommendation
by design — see reuse note below).

**Reuse note (Vera ruling, honored):** structure only reused from
`docs/C13-demo-shot-script.md` (S171 track) — the beat-sequencing shape (hook, live proof,
decision/action, on-chain settlement, resolution artifact, close), the explorer-overlay
staging pattern (paste tx sig, wait for Finalized, hold 2 seconds), and the timing-table
format. Every disclosure line below is re-derived from this session's plan requirements
(build-plan-v2-LOCKED.md M6 row + Explicit non-goals + Part 7 of pm-research.md), not
copied from C13 — C13's honesty beats (TxLINE live-data, no-human-pushed-button) answer a
different track's claims and do not apply here. This script is a single continuous shot
(the plan's M6 row requires "one continuous shot"); C13 used 3 invisible cuts for a live
in-running match, which this demo does not have (historical fixture, no live risk window).

---

## RECORD-DAY PREFLIGHT (run same-day as recording, before touching the camera)

This fixture is a SLOT, not a hard lock (Juno adversarial guard, ratified by Garry).
Devnet `daily_scores_roots` PDAs are only proven fresh through Jul 2 and may be pruned by
record day (~Jul 12-15). Do not record until every box below is checked the same day.

- [ ] **Fixture-slot re-proof.** Run `npx ts-node --project tsconfig.json client/m0-smoke.ts`
      from repo root. Must print `M0 SMOKE TEST: PASS` with a real devnet tx signature and
      `Evaluate predicate to: true`. If it fails with `daily_scores_roots PDA not found` or
      any PDA-pruning error: swap `FIXTURE_ID` in `client/m0-smoke.ts` to the backup fixture
      **18179551** (ESP-AUT 2-0). If that also fails, pick any finished fixture from
      `GET /api/scores/historical/{fixtureId}` whose `daily_scores_roots` PDA still resolves
      on-chain. **The shot beats below do not change** — only the fixture ID, team names,
      score, and the fresh explorer tx link get swapped into the overlay text.
- [ ] **Wallet liveness.** Confirm the devnet signer wallet (`~/.config/solana/id.json` or
      `~/secrets/solana-worldcup-devnet-wallet.md`) has enough devnet SOL for the
      `validate_stat` CPI compute budget (recommend >= 0.05 SOL headroom; the standalone
      call costs ~179k CU against a 1.4M budget — resolve() will cost more, budget for it).
- [ ] **Token liveness.** Confirm `~/secrets/txline-api-token.env` has a non-expired
      `TXLINE_JWT` (~30-day expiry) and `TXLINE_API_TOKEN`. If expired, re-run the
      subscribe + activate flow before recording (subscribe tx is single-use — do not
      burn it on a rehearsal check the same day you need it for recording).
- [ ] **UI liveness.** Confirm the M5 minimal UI is deployed and renders: pool ratio /
      implied odds panel, resolution receipt panel (fixture, stat(s), predicate,
      proof-verified badge, payout amount). Load it once before recording starts; do not
      load it live on camera (avoids a cold-start stall mid-shot).
- [ ] **Explorer tab pre-staged.** Open a blank Solana Explorer devnet search tab
      (`https://explorer.solana.com/?cluster=devnet`), ready to paste the fresh
      `resolve()` tx signature the moment it prints.
- [ ] **Screen recorder.** 1080p, full active-window capture, font size 20px+ in any
      terminal pane shown. Start recording BEFORE triggering the deposit sequence.

**If any box fails and cannot be fixed same-day:** STOP per AR-381. Do not record on a
fixture whose PDA cannot be proven fresh. Escalate to Gabe with the specific failure.

---

## THE SHOT SCRIPT (one continuous shot, no cuts)

Default fixture (pending preflight confirmation): **18172379, USA vs Bosnia & Herzegovina,
final score 2-0.** Market: parametric goal-spread, `home_goals - away_goals > 1`
(stat_a key 1 = home total goals, stat_b key 2 = away total goals, period 0 = full game,
op = Subtract). On this fixture the predicate evaluates TRUE (2 - 0 = 2 > 1).

---

### BEAT 1 — HOOK
**Time:** 0:00–0:15 (15s) | **Running total:** 0:15
**On screen:** UI landing view, market card visible: "USA vs Bosnia & Herzegovina · goal
spread > 1" with pool ratio panel at rest (pre-deposit state, roughly even split or a
starting ratio).
**Overlay:** none yet.

**NARRATION (spoken):**
"This market pays out on a fact. [pause] Not a vote. [pause] Here's how it works."

**Delivery note:** Flat, confident, no wind-up. Three short beats. The word "fact" is the
thesis word — say it clean, no emphasis needed yet, it lands harder later at the close.

---

### BEAT 2 — POOL SHIFTS DURING DEPOSITS
**Time:** 0:15–1:05 (50s) | **Running total:** 1:05
**On screen:** Live UI, pool ratio / implied odds panel updating as deposits land on
both sides (YES: spread > 1, NO: spread <= 1). Numbers move in real time on screen.
**Overlay (lower-third, stays up the whole beat):** "Demo deposits — operator-seeded to
show both sides of the pool. Final payout math is what you'll see resolve on-chain."

**NARRATION (spoken):**
"Right now people are putting USDC on both sides of one question. [short pause] Will the
US beat Bosnia by more than one goal? [pause] Watch the pool. [pause] Every deposit
moves the ratio. That's the market's live price."

[pause 2-3 seconds — let the numbers actually move on screen, no talking]

"One thing I want to be upfront about: [short pause] these deposits are seeded by me,
not organic traffic. It's a demo. [pause] What happens next is not."

**Delivery note:** This is disclosure #1 (operator-seeded liquidity), placed right where
the pool visual is on screen — the honesty lands exactly where the claim could be
misread. Do not bury it in a description field. Let the pool numbers do the visual work;
narration is sparse here.

---

### BEAT 3 — LOCK + THE PROOF REQUEST
**Time:** 1:05–1:35 (30s) | **Running total:** 1:35
**On screen:** UI shows "Market locked" state. Cut to terminal (still one continuous
shot — screen switch, not a video cut): `client/m0-smoke.ts`-equivalent resolve script
starting, printing "Fetching stat-validation proof: fixtureId=18172379..."
**Overlay:** "Historical World Cup fixture, TxODDS devnet feed (SL=1, delayed test
data), not a live match."

**NARRATION (spoken):**
"Deposits are closed. [pause] Now the market needs one thing to settle: the real match
result, proven on-chain. [short pause] This fixture already finished: USA two,
Bosnia and Herzegovina zero. [pause] We're pulling a cryptographic proof of that score
from TxODDS's oracle."

**Delivery note:** This is disclosure #2 (SL=1 devnet simulated/historical fixture data).
Say "already finished" plainly — do not let the viewer think this is live. The overlay
carries the disclosure text so it survives even if narration timing drifts.

---

### BEAT 4 — THE CPI (THE CLIMAX)
**Time:** 1:35–2:35 (60s) | **Running total:** 2:35
**On screen:** Terminal — the proof loads, then the `resolve()` transaction fires,
printing the tx signature. Switch to the pre-staged Explorer tab, paste the signature,
watch it go Finalized. **Explorer tx link ON SCREEN** — this is the plan's required
visual (build-plan-v2-LOCKED.md M6 row).
**Overlay (appears once tx confirms):** "validate_stat CPI · txoracle program ·
one proof, one on-chain check."

**NARRATION (spoken):**
"Our contract sends that proof straight into TxODDS's own on-chain program, a function
called validate_stat. [short pause] It checks the score against a Merkle root TxODDS
already wrote to Solana. [pause] Not our word. [emphasis]Their[/emphasis] proof,
verified on-chain."

[pause — let the tx signature print, 2 seconds of silence]

"There it is. [short pause] Let me pull that up."

[switch to Explorer, paste sig, show Finalized]

"[emphasis]Finalized.[/emphasis] [pause] That's the CPI. One proof, checked once,
on-chain. That's disclosure number three, by the way: this market resolves off a
single proof call, not a redundant multi-source check. One proof is enough here because
the oracle's Merkle root is itself the trust anchor. But it is one call, and I want you
to see that plainly, not gloss over it."

**Delivery note:** This is the emotional peak AND disclosure #3 (single-proof
resolution), delivered together — the plan requires the disclosure on-screen, and the
moment right after "Finalized" is the natural beat where the claim needs the caveat.
Do not rush past "Finalized" — hold 2 full seconds before continuing, same pattern as
C13's silence-is-proof beat.

---

### BEAT 5 — INSTANT PAYOUT
**Time:** 2:35–3:15 (40s) | **Running total:** 3:15
**On screen:** Terminal or UI — `claim_payout` firing, then switch to UI wallet balance
or a payout confirmation panel showing USDC landing.
**Overlay:** none new (disclosures already up from prior beats, can fade out here).

**NARRATION (spoken):**
"Now that the outcome is verified on-chain, the payout is instant. [pause] Winning side
claims their share of the pool, proportional to what they put in. [short pause] No
committee. No dispute window. The proof already settled it."

**Delivery note:** Keep this tight. The emotional work happened in Beat 4; this beat is
the payoff, not a second climax. Two sentences, then move.

---

### BEAT 6 — RESOLUTION RECEIPT CLOSE-UP + THESIS
**Time:** 3:15–4:05 (50s) | **Running total:** 4:05
**On screen:** UI resolution receipt panel, full-screen close-up. Panel shows: fixture
(USA vs Bosnia & Herzegovina), the stat(s) checked (home_goals=2, away_goals=2,
predicate: home - away > 1), a proof-verified badge, and the payout amount.
**Overlay:** none needed — the receipt panel IS the overlay.

**NARRATION (spoken):**
"This is the receipt. [short pause] Fixture, the exact stat we checked, the predicate we
resolved against, a proof-verified badge, and the payout. [pause] Anyone can look at
this and check our work against the same on-chain root."

[pause]

"This market settled by verifiable fact. [short pause, let it land] Not a vote."

**Delivery note:** This is the closing thesis line from the plan's competitor-response
framing (build-plan-v2-LOCKED.md: "verifiable fact, not a token-holder vote," positioned
against the Polymarket freeze/hack baseline). Say it flat, no sell. The receipt on
screen already did the selling.

---

### BEAT 7 — CLOSE + CTA
**Time:** 4:05–4:25 (20s) | **Running total:** 4:25
**On screen:** Receipt panel still up, or cut to program ID / repo link as a lower-third
text overlay.
**Overlay:** Program ID (from `devnet-config.json` once M1+ programs deploy) as
Geist Mono text.

**NARRATION (spoken):**
"Any two-stat sports fact can be a market this way: spreads, totals, any predicate
TxODDS can prove. [short pause] This one's goal spread. [pause] Settlement track,
built solo."

**Delivery note:** Do not oversell the extensibility claim — say "can be," not "will be."
The demo already proved one instance; the line is scope, not a promise.

---

## TIMING BUDGET

| Beat | Content | Duration | Running Total |
|---|---|---|---|
| 1 | Hook | 0:15 | 0:15 |
| 2 | Pool shifts during deposits (disclosure 1: operator-seeded) | 0:50 | 1:05 |
| 3 | Lock + proof request (disclosure 2: SL=1 devnet historical fixture) | 0:30 | 1:35 |
| 4 | The CPI — validate_stat, explorer tx link on screen (disclosure 3: single-proof) | 1:00 | 2:35 |
| 5 | Instant payout | 0:40 | 3:15 |
| 6 | Resolution receipt close-up + thesis line | 0:50 | 4:05 |
| 7 | Close + CTA | 0:20 | 4:25 |

**Total: 4:25.** Hard cap 5:00. **Margin: 0:35** (11.7% buffer below cap).

---

## APPENDIX — Beat-to-On-Chain-Artifact Mapping

| Beat | On-chain / off-chain artifact shown | Type | Link / reference |
|---|---|---|---|
| 1 | Market account (UI read) | account state | UI only, no tx |
| 2 | Position accounts (deposit txs, both sides) | tx (multiple, background) | UI pool panel reflects live state; individual deposit tx sigs not required on screen |
| 3 | `lock_market` tx + `GET /api/scores/stat-validation` proof fetch | tx + off-chain API call | lock tx sig printed in terminal; proof fetch is API, not on-chain |
| 4 | **`resolve()` tx — CPIs `validate_stat` on the txoracle program** | **on-chain CPI tx (the required visual)** | Fresh signature from record-day run, pasted into `https://explorer.solana.com/tx/<SIG>?cluster=devnet`. **Confirmed pattern proven this session (M0):** `https://explorer.solana.com/tx/4oJugYCyuQPXn5B6sWnop7tzTwHTtKFBicfdyLKwMH5KwJ3gvmszxdvgcnnjBeouHBuxcQy5fiKs815arocsm8hZ?cluster=devnet` (standalone validate_stat call, fixture 18172379, TRUE predicate — the resolve() version will be a fresh tx once M2a ships, same CPI target) |
| 5 | `claim_payout` tx | on-chain tx | Signature printed in terminal; explorer link optional (time-budget permitting) |
| 6 | Resolution receipt UI panel (fixture id, stat(s), predicate, proof-verified badge, payout amount) | UI render of on-chain state (M5 deliverable) | UI only — reads Market account post-resolve |
| 7 | Program ID (deployed `pari-market` program) | static reference | `devnet-config.json` once M1+ deploys; not yet populated as of S175 script-lock |

**Note on placeholders:** Beat 4's explorer link is a placeholder pattern (real link
proven via the M0 standalone `validate_stat` call above) until `resolve()` ships at M2a
and the record-day preflight generates the actual demo-take signature. The shot
composition does not change — only the pasted signature updates.

---

## Self-Check (4-point, per OUTPUT_CONTRACT)

1. **One continuous shot:** YES — 7 beats, no video cuts, only in-shot screen/tab
   switches (UI to terminal to Explorer to UI), matching the plan's M6 requirement.
2. **Under 5:00 with margin:** YES — 4:25 total, 0:35 margin (11.7% buffer).
3. **3 disclosures on-screen (not buried):** YES — disclosure 1 (operator-seeded
   liquidity) at Beat 2 lower-third + narration; disclosure 2 (SL=1 devnet historical
   fixture) at Beat 3 overlay + narration; disclosure 3 (single-proof resolution) at
   Beat 4 narration immediately after the Finalized moment.
4. **Fixture-slot + preflight present:** YES — RECORD-DAY PREFLIGHT block at top of
   file, 6-item checklist including fixture re-proof via `client/m0-smoke.ts` with
   named backup fixture (18179551) and generic historical-fixture fallback.

**C13 reuse note (repeated from header):** structure only — beat sequencing, timing-table
format, explorer-overlay staging (paste sig, hold for Finalized, 2-second silence). All
disclosure language re-derived line-by-line against build-plan-v2-LOCKED.md's M6 row and
Explicit non-goals; none copied verbatim from C13 (C13's disclosures answer a different
track's live-data claims and do not apply to this historical-fixture, single-shot demo).

---

## Gate note

Femi humanizer pass + Tomas Sentinel external-ship gate fire at M6 video ship (once
footage is recorded and cut), not at this script-lock step. This document is the locked
blueprint; narration lines above are already written clean (8-year-old simplicity filter
applied, no em-dash, no puffery, no hedge filler) so the ship-gate pass should be fast.

*Internal planning doc. Narration copy above is external-audience (spoken, first-person,
8yo simplicity filter + writing-style mechanics applied at authoring time). ernest_routing: SKIP.*
