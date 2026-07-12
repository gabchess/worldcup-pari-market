# Hackathon Submission

## Links

| | |
|---|---|
| Live dashboard | https://worldcup-pari-market.vercel.app |
| Repo | https://github.com/gabchess/worldcup-pari-market |
| Demo video | https://youtu.be/2Vh6RPLNd-U |
| Technical docs | [docs/ENDPOINTS.md](https://github.com/gabchess/worldcup-pari-market/blob/main/docs/ENDPOINTS.md) |

---

## Track

**Prediction Markets & Settlement**
TxODDS x Solana World Cup Hackathon

---

## What Was Built

A pari-mutuel prediction market on Solana devnet that settles trustlessly. Depositors put USDC into a YES or NO pool before a lock time. Once locked, anyone can trigger `resolve()`, which builds a proof from TxODDS's API and CPIs directly into TxODDS's own `validate_stat` instruction on their `txoracle` program. That instruction checks the proof against a Merkle root TxODDS already wrote to Solana and returns a verified true or false. The market records the result and winners claim a proportional share.

Resolution covers more than "who won." It supports parametric predicates: a stat compared against a threshold, or two stats combined with a comparison (`home_goals - away_goals > 1`, for instance). A spread or a total, alongside the plain moneyline bet.

## How It Works

1. `init_market` creates a Market PDA bound to a fixture, a stat (or two stats and a combining operation), and a threshold predicate.
2. `deposit` takes USDC into the YES or NO pool, before the lock time.
3. `lock_market` closes deposits once the lock time passes. Anyone can call it; there's no admin key gating this step.
4. `resolve` fetches a Merkle proof from TxODDS's API and CPIs into `validate_stat` on their program. The program checks the CPI response came from the right program, decodes the verified true/false result, and records it. The oracle's own on-chain program is the sole judge; no redundant off-chain check.
5. `claim_payout` pays winners proportionally out of the combined pool (or refunds everyone if nobody backed the winning side).

## What's Real

Every step below is a real devnet transaction, independently re-confirmed, not a simulation:

- **Program deployed on devnet:** `565SYmLeQ64r8kNujRpVhnfGgAybQrXz72knMyUj1xc3`
- **Full lifecycle, one run, all finalized (err: null):**
  - `create_market`: [`5stUkufA7...`](https://explorer.solana.com/tx/5stUkufA7pauU5oAoqqskKJU5ciVACCgkeMjEyYjpgpUimKPyaGvcKWzZd2iWyt3zjbv1X5b3NXLAQzf1zPrC9r5?cluster=devnet)
  - `deposit`: [`2kXbzjkK1...`](https://explorer.solana.com/tx/2kXbzjkK1mvXdfE5vVhs9z7p3jDY3uXQqrtaM2L2DZnZ4af8SwF9UQarJEUMjRiPgoRJcBRSC23fpWbfSTj48zGT?cluster=devnet)
  - `lock_market`: [`4D9ne8omv...`](https://explorer.solana.com/tx/4D9ne8omvokBGjrf88W76pvgYeRrd3GtiXfaaq57WJLbw5VES8o2Mwsj7yF2Qh6CYJaB1GJrhuJXqAH77dvBxtxJ?cluster=devnet)
  - `resolve` (the `validate_stat` CPI, 197,678 compute units): [`yG6afD4xu...`](https://explorer.solana.com/tx/yG6afD4xuxxT53wkicFzUX7zkpxStJNHk5Jqrxe9NW1U6BssATHdeM3uHnz4ng7RopHM83pZ8oZxKqSiC1NA6Qb?cluster=devnet)
  - `claim_payout`: [`2sK4XASuB...`](https://explorer.solana.com/tx/2sK4XASuB121JKgvyeU69xVPHar6JLRbUx2zHx2R2Hyqc7acq5jyhEmpkS5scHrkbwJK78NQDjS4xWRY4wVGscJ4?cluster=devnet)
- **39 program tests green** (`cargo test -p pari-market`), including a parametric two-stat market resolving live against the real `txoracle` program, and 10 adversarial hypotheses (fund conservation under extreme deposit sizes, cross-market and cross-position attacks, CPI trust-boundary spoofing) tried and rejected.
- **Live dashboard** reads the actual Market account off devnet on every load. No mocked data: pool ratio and resolution receipt come straight from chain state.

## Honesty Notes

- The oracle's devnet feed runs on a 60-second delay (TxODDS's free service tier), and the demo settles a historical, already-finished fixture rather than a live in-progress match.
- The pool deposits shown are operator-seeded so both sides visibly move. No organic trading in this build.
- Settlement uses one verified proof call, not several independent checks. TxODDS's on-chain Merkle root is the trust anchor, so a single check against it is the design, not a shortcut.
- `init_market` now validates the `stat_b_key`/`op` two-stat invariant at creation, rejecting the mismatched-Option config that could otherwise create a market with no valid resolution path. Enforced on-chain as of the S191 remediation.

---

## Team

Solo submission.
