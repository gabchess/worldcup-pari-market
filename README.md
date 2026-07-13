# Pari-Market

Proof-settled prediction markets on Solana.

Users deposit devnet USDC into a YES or NO pool. After the market locks, anyone can submit TxLINE proof material. Pari-Market CPIs into TxODDS's `validate_stat` instruction, verifies the result against TxODDS's on-chain Merkle root, and releases proportional payouts—without an admin resolution key, committee, or token vote.

Built for the TxODDS World Cup Hackathon, Prediction Markets & Settlement track.

> Devnet demonstration only. Pari-Market is not a real-money service and has not been reviewed for production or jurisdiction-specific legal compliance.

## Try and verify

| Resource | Link |
|---|---|
| Live market | [worldcup-pari-market.vercel.app/market](https://worldcup-pari-market.vercel.app/market) |
| Demo video | [Watch on YouTube](https://youtu.be/2Vh6RPLNd-U) |
| Deployed program | [`565SYm...1xc3`](https://explorer.solana.com/address/565SYmLeQ64r8kNujRpVhnfGgAybQrXz72knMyUj1xc3?cluster=devnet) |
| Resolution transaction | [`yG6afD4x...`](https://explorer.solana.com/tx/yG6afD4xuxxT53wkicFzUX7zkpxStJNHk5Jqrxe9NW1U6BssATHdeM3uHnz4ng7RopHM83pZ8oZxKqSiC1NA6Qb?cluster=devnet) |
| Hackathon submission | [SUBMISSION.md](SUBMISSION.md) |
| TxLINE integration reference | [docs/ENDPOINTS.md](docs/ENDPOINTS.md) |
| TxLINE feedback | [docs/TXLINE-FEEDBACK.md](docs/TXLINE-FEEDBACK.md) |

## The 30-second flow

1. A creator initializes a market bound to a fixture, stat predicate, and lock time.
2. Users deposit devnet USDC into the YES or NO pool.
3. Once the lock time passes, anyone can lock the market.
4. Anyone can submit TxLINE proof material to `resolve()`.
5. `resolve()` CPIs into TxODDS `validate_stat`, which checks the proof against an on-chain Merkle root and returns true or false.
6. Winners claim a proportional share of the combined pool. If nobody backed the winning side, everyone receives a refund.

Pari-Market is a pari-mutuel pool, not an AMM or order book. The pool ratio implies the current price; users cannot trade or exit positions before settlement.

## Why it matters

Most prediction markets still need a person, committee, token vote, or dispute process to declare the result. Pari-Market makes resolution a deterministic program path: the market stores its predicate before deposits close, and TxODDS's on-chain program verifies the submitted match proof against a root already anchored on Solana.

### Parametric markets

`validate_stat` can compare one stat with a threshold or combine two stats before applying the comparison. That supports moneylines, spreads, and totals—for example, `home_goals - away_goals > 1`—through the same settlement interface.

### Permissionless lifecycle

No admin key decides when a market locks or resolves. Once the on-chain conditions are satisfied, any signer can call `lock_market` and `resolve`.

### Verifiable receipts

The dashboard reads market state from devnet and shows the transactions behind deposits, locking, resolution, and claims. The resolution receipt links to the transaction containing the TxODDS CPI.

## Architecture

```text
Depositors (devnet USDC)
          │
          ▼
┌──────────────────────────┐
│ Pari-Market program      │  Market PDA stores pools,
│ deposit / lock / resolve │  fixture, predicate, outcome
└────────────┬─────────────┘
             │ resolve() CPIs validate_stat
             ▼
┌──────────────────────────┐
│ TxODDS txoracle program  │  Verifies proof against its
│ validate_stat            │  daily_scores_roots PDA
└────────────┬─────────────┘
             │ verified true / false return data
             ▼
      Proportional payout
```

The caller supplies proof material, but cannot replace the fixture or predicate stored in the market. Before the CPI, `resolve()` binds the supplied fixture and stat keys to the market configuration. After the CPI, it checks that TxODDS set the return data and accepts only the boolean domain `{0, 1}`.

## Security model

The security review focuses on the CPI trust boundary, PDA bindings, payout conservation, and adversarial account substitution. Highlights:

- Payout math uses 128-bit intermediates and checked operations.
- Floor-division dust remains in the vault, so payouts cannot exceed deposits.
- Positions are bound to both market and bettor and cannot be claimed twice.
- A false predicate is decoded as a valid false result, not confused with CPI failure.
- Empty winning pools trigger refunds rather than trapped funds.

See [docs/SECURITY.md](docs/SECURITY.md) for scope, trust assumptions, tests, and remaining limitations. The project has not received an independent professional audit.

## Run locally

Requirements:

- Rust `1.89.0`
- Anchor CLI `0.32.1`
- Node.js `18+`
- A Solana devnet wallet
- TxLINE credentials for scripts that fetch fresh proofs

```bash
# Rust program tests; no local validator required
cargo test -p pari-market

# Dashboard
cd dashboard
npm install
npm run dev
# Open http://localhost:3000/market
```

The Rust suite runs against a checked-in dump of the real TxODDS `txoracle` program and captured TxLINE proof fixtures; the oracle is not mocked. The lifecycle verifier sends real devnet transactions and requires the environment variables documented in [docs/ENDPOINTS.md](docs/ENDPOINTS.md).

## Demo scope and trust assumptions

- **Historical fixture:** The demo resolves an already-finished fixture so the result and proof remain stable during judging.
- **Delayed devnet feed:** TxODDS's devnet feed runs at service level 1 and is roughly 60 seconds behind its source.
- **Seeded demo liquidity:** The recorded deposits are operator-seeded to make both pool sides and the ratio movement visible. The demo does not claim organic trading activity.
- **One oracle trust anchor:** Settlement verifies one TxODDS proof against the corresponding TxODDS Merkle root on Solana. Repeating the same verification would not create independent data-source redundancy. A production design would need an explicit policy for oracle outages, incorrect roots, and independent fallback sources.
- **Devnet PoC:** The program, dashboard, access controls, monitoring, and deployment process are not production-ready.

## Roadmap

See [ROADMAP.md](ROADMAP.md) for proven functionality, the next engineering milestones, and longer-term product expansion.

## Repository map

| Path | Purpose |
|---|---|
| `programs/pari-market/` | Anchor program and LiteSVM integration tests |
| `dashboard/` | Next.js market dashboard and wallet transaction UI |
| `client/` | TxLINE integration and instruction builders |
| `scripts/` | Devnet lifecycle and demo verification tools |
| `docs/` | Security, endpoint, provenance, and sponsor-feedback documentation |
| `video/` | Source for the demo-video overlays |

## Team and license

Solo hackathon submission. Source code is available under the [MIT License](LICENSE).
