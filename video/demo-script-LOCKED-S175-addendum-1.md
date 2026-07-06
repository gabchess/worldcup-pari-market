# Demo Script Addendum 1

**Status:** ADDENDUM-1 (2026-07-04, S180-reopen). Amends the beat script, does not
replace it. `demo-script-LOCKED-S175.md` stays LOCKED and untouched — this file is
additive, read alongside it.

---

## 1. Ratified change — Beat 4 animated diagram (PiP overlay)

Beat 4 (the CPI climax, 1:35–2:35) gains a 3-node animated diagram, composited as a
picture-in-picture overlay in post:

**Pari-Market program → `validate_stat` CPI → TxODDS oracle / Merkle root**

Duration ~6-8s, timed to appear as the `resolve()` tx fires and clear before the
Explorer tab switch. Built with DESIGN.md tokens only (ivory panel, fresco-ochre
accent, Geist Mono labels on the two program nodes) — no shader, no new color pairs.

**One-shot reading, ratified:** the script's "ONE continuous shot, no cuts" rule
(header, line 5-7) is honored as **unbroken take + post-composited overlays**. This
is the same mechanism the locked script already uses for its lower-third disclosure
overlays (Beat 2, lines 87-88: "Overlay (lower-third, stays up the whole beat)") —
an overlay composited over a continuous take is not a cut. The PiP diagram is that
same mechanism applied to a diagram instead of text.

Build owner: Marta, S181.

---

## 2. Ratified change — receipt fidelity (M5 UI)

The M5 resolution receipt panel now matches what Beat 6 + the record-day preflight
checklist (lock lines 44-47, 180-183) already expect. Added fields:

1. **Fixture reference** — teams + final score (e.g. "USA vs Bosnia & Herzegovina ·
   2–0"), captioned "fixture reference" in small ink-muted type. Team names and
   score are display metadata, not on-chain state — the caption keeps that honest.
2. **Stat values line** — the proved predicate evaluation, e.g. "home goals 2 − away
   goals 0 = 2 > 1 → TRUE".
3. **Proof Verified badge** — sage-on-sage-soft-bg pill, same recipe as the existing
   live badge, shown only once `resolved == true`.
4. **Payout amount line** — "Winners split 490.00 USDC pro-rata against the winning
   pool" (total-pot value; per-position claim amounts stay out of scope).

---

## 3. Cadence parameterization

`scripts/m5-capture-demo.ts` now reads env overrides: `N_DEPOSITS`,
`DEPOSIT_SLEEP_MS_MIN`, `DEPOSIT_SLEEP_MS_MAX`, `LOCK_WINDOW_SECONDS`. The locked
script's beat table (Beat 2 deposits ~50s, Beat 3 lock+proof ~30s) is the target
rhythm the cadence is tuned against. Demo-cadence preset:

```
N_DEPOSITS=5 DEPOSIT_SLEEP_MS_MIN=4000 DEPOSIT_SLEEP_MS_MAX=6000 LOCK_WINDOW_SECONDS=85
```

`PRINT_PLAN=1` prints the computed plan and projected phase timings before touching
any wallet or RPC — use it to sanity-check cadence params ahead of a real capture run.

---

## 4. Provenance

Ratified via Gabe AskUserQuestion, S180-reopen (2026-07-04). Pair-think: Vera, Ada,
Sarah, Marta. Feedback input: Delba. Build dispatch: Bram (this addendum + the M5
cadence/receipt changes above).
