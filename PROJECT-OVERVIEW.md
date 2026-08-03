# Pari-Market project overview

Pari-Market is an independent Solana project exploring proof-settled prediction markets.

## Links

| Resource | Link |
|---|---|
| Live dashboard | [worldcup-pari-market.vercel.app/market](https://worldcup-pari-market.vercel.app/market) |
| Repository | [github.com/gabchess/worldcup-pari-market](https://github.com/gabchess/worldcup-pari-market) |
| Demo video | [Watch on YouTube](https://youtu.be/1HDvlMr-Fl0) |
| Technical docs | [docs/ENDPOINTS.md](https://github.com/gabchess/worldcup-pari-market/blob/main/docs/ENDPOINTS.md) |

## What it is

Pari-Market is a pari-mutuel prediction market on Solana devnet. Users deposit USDC into a YES or NO pool before a lock time. Anyone can then submit proof material. The program calls TxODDS's `validate_stat` instruction through CPI, checks the result against an on-chain Merkle root, and records the outcome. Winners claim a proportional share of the pool.

The market supports parametric predicates as well as a plain win or lose condition. A predicate can compare one stat with a threshold or combine two stats, such as `home_goals - away_goals > 1`.

## Lifecycle

1. `init_market` creates a Market PDA bound to a fixture, stat configuration, and predicate.
2. `deposit` accepts USDC into the YES or NO pool before the lock time.
3. `lock_market` closes deposits once the lock time passes. Anyone can call it.
4. `resolve` submits proof material and CPIs into TxODDS `validate_stat`.
5. `claim_payout` pays winners from the combined pool, or refunds depositors when the winning pool is empty.

## Verification evidence

Every step below is a finalized devnet transaction, independently re-confirmed:

- **Program:** `565SYmLeQ64r8kNujRpVhnfGgAybQrXz72knMyUj1xc3`
- **Create:** [`5stUkufA7...`](https://explorer.solana.com/tx/5stUkufA7pauU5oAoqqskKJU5ciVACCgkeMjEyYjpgpUimKPyaGvcKWzZd2iWyt3zjbv1X5b3NXLAQzf1zPrC9r5?cluster=devnet)
- **Deposit:** [`2kXbzjkK1...`](https://explorer.solana.com/tx/2kXbzjkK1mvXdfE5vVhs9z7p3jDY3uXQqrtaM2L2DZnZ4af8SwF9UQarJEUMjRiPgoRJcBRSC23fpWbfSTj48zGT?cluster=devnet)
- **Lock:** [`4D9ne8omv...`](https://explorer.solana.com/tx/4D9ne8omvokBGjrf88W76pvgYeRrd3GtiXfaaq57WJLbw5VES8o2Mwsj7yF2Qh6CYJaB1GJrhuJXqAH77dvBxtxJ?cluster=devnet)
- **Resolve:** [`yG6afD4xu...`](https://explorer.solana.com/tx/yG6afD4xuxxT53wkicFzUX7zkpxStJNHk5Jqrxe9NW1U6BssATHdeM3uHnz4ng7RopHM83pZ8oZxKqSiC1NA6Qb?cluster=devnet)
- **Claim:** [`2sK4XASuB...`](https://explorer.solana.com/tx/2sK4XASuB121JKgvyeU69xVPHar6JLRbUx2zHx2R2Hyqc7acq5jyhEmpkS5scHrkbwJK78NQDjS4xWRY4wVGscJ4?cluster=devnet)
- **Tests:** 38 LiteSVM integration tests cover normal lifecycle behavior, compound predicates, return-data spoofing, account substitution, payout conservation, and repeat claims. The suite uses dumped TxODDS bytecode and captured TxLINE proofs rather than a mock oracle.
- **Dashboard:** reads the Market account from devnet and displays pool state, transaction history, and the resolution receipt.

## Scope and trust assumptions

- The demonstration uses a historical fixture so the result and proof remain stable for repeatable verification.
- TxODDS's devnet feed runs roughly 60 seconds behind its source.
- Deposits in the recorded flow are operator-seeded to show both pool sides moving.
- Settlement has one oracle trust anchor: TxODDS's program and its published Merkle root.
- The project runs on devnet and has no independent professional audit. It is not a production or real-money service.

## Ownership

Independent project by Gabriel Abreu. I owned the product direction, technical scope, architecture, risk decisions, verification gates, and final delivery.
