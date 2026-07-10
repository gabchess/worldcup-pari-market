# WorldCup Pari-Market

A Solana prediction market that settles by cryptographic proof instead of a vote. Deposit USDC on a side, wait for the market to lock, then anyone can trigger settlement: the program calls TxODDS's own on-chain `validate_stat` check against a Merkle root TxODDS already published, and the payout follows automatically.

TxODDS x Solana World Cup Hackathon, Prediction Markets & Settlement track.

## Links

| | |
|---|---|
| Live dashboard | https://worldcup-pari-market.vercel.app |
| Repo | https://github.com/gabchess/worldcup-pari-market |
| Demo video | https://youtu.be/2Vh6RPLNd-U |
| Technical docs | [docs/ENDPOINTS.md](https://github.com/gabchess/worldcup-pari-market/blob/main/docs/ENDPOINTS.md) |

---

## Architecture

Three pieces, one proof call in the middle:

```
Depositors (USDC)
      |
      v
[pari-market program]  --  Market PDA: pools, predicate, fixture_id
      |
      | resolve() CPIs validate_stat
      v
[TxODDS txoracle program]  --  checks a Merkle proof against
      |                        the daily_scores_roots root it
      |                        already wrote on-chain
      v
Ok(true) or Ok(false), decoded by pari-market, payout follows
```

Depositors put USDC into a YES or NO pool before a lock time. Once locked, anyone can call `resolve()`, which fetches a proof from TxODDS's API and sends it into their `validate_stat` instruction on-chain. That instruction checks the proof against a root TxODDS itself wrote to Solana and returns true or false. The market records the result and winners claim a proportional share of the pool.

No dispute window, no committee. The oracle's own on-chain program is the judge, and the answer is re-checkable from the same public root.

## What makes it different

**Parametric predicates.** `validate_stat` can check one stat against a threshold, or combine two stats with a comparison (`home_goals - away_goals > 1`, for example). That covers spreads and totals, on top of a plain "did the favorite win."

**Proof-based settlement.** The resolution condition is verified by calling TxODDS's own program against a Merkle root they already published. Nobody votes, and nobody can flip it after the fact.

**Honesty disclosures, on camera.** The demo video says out loud, on screen, where the seams are: the pool deposits shown are operator-seeded to demonstrate both sides moving (not organic trading), the match data comes from TxODDS's devnet feed which runs on a 60-second delay on historical fixtures, and settlement in this demo runs off a single proof call, not a redundant multi-source check.

## Run it

Requires Rust and Anchor 0.32.1, Node 18+, and a Solana devnet wallet.

```bash
# Program tests (no validator needed, runs against a real dumped txoracle .so)
cargo test -p pari-market

# Dashboard (read-only live view, no wallet adapter)
cd dashboard && npm install && npm run dev
# -> http://localhost:3000/market

# Full on-chain lifecycle verifier -- fires real devnet transactions
# (create_market, deposit, lock_market, resolve, claim_payout)
cd client && npx ts-node --project tsconfig.json ../scripts/m3-lifecycle-verify.ts
```

The lifecycle script is not a simulation. It signs and sends five real transactions against the deployed devnet program and prints each signature.

## Security

Every trust boundary the CPI touches got a written spec before code: which fields the caller can supply, how the program checks the CPI return data actually came from TxODDS's program, and how payout math holds up under adversarial deposit sizes. That spec, an automated scan, and a 10-hypothesis adversarial pass (0 findings) live in [docs/security/](docs/security/).

Fund-safety highlights:
- Payout math runs in a 128-bit intermediate, so it can't silently overflow.
- Floor-division dust stays in the vault: total payouts can never exceed total deposits.
- Winners can't claim on the wrong market, the wrong side, or twice.
- If a market resolves to a side nobody backed, every depositor gets a full refund.

## Honest limitations

This is a hackathon build on devnet, not a production system. Specifically:

- **Devnet data runs about 60 seconds behind** (TxODDS's free service tier). Real-time settlement needs a paid tier or mainnet.
- **The demo resolves against a historical, already-finished fixture**, not a live match. Deliberate: a finished match has a stable, provable result.
- **The demo's deposits are operator-seeded** to show the pool ratio moving on both sides. No organic trading in this build; the trustless part is the on-chain resolution step, not the demo liquidity.
- **Settlement uses a single proof call**, not a redundant multi-source check. TxODDS's Merkle root is the trust anchor, so one verified proof is sufficient by design.
- **The dashboard's default-market lookup is pinned to `CANONICAL_MARKET_ID`** (required in production), resolved directly by PDA rather than scanning. Without that env var (local dev only), it falls back to scanning all program accounts (`getProgramAccounts`) filtered by the canonical mint. Fine at hackathon scale; would not hold up with thousands of live markets even with the pin in place.
