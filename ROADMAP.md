# Roadmap

Pari-Market is a working devnet proof of concept. This roadmap separates what the current build proves from work required for a safe, scalable product. It does not promise release dates.

## Proven in the current build

- Permissionless market locking and resolution
- Devnet USDC pari-mutuel deposits and proportional payouts
- Single-stat and two-stat predicates for moneylines, spreads, and totals
- TxODDS `validate_stat` CPI settlement against an on-chain Merkle root
- Fixture and predicate binding before the CPI
- CPI return-program and boolean-domain checks after the CPI
- On-chain market state and transaction receipts in the dashboard
- LiteSVM integration tests against dumped TxODDS bytecode and captured proof fixtures

## Next engineering milestones

1. **Reproducible deployments.** Pin the Solana build environment and publish verifiable-build artifacts that link source commits to deployed bytecode.
2. **Independent security review.** Add property-based accounting tests, fuzz instruction inputs, and commission an external review before handling production funds.
3. **Oracle-failure policy.** Define behavior for missing proofs, delayed roots, incorrect roots, TxODDS program upgrades, and optional independent data sources.
4. **Automated keeper.** Monitor lock times and final fixtures, then submit lock and resolution transactions permissionlessly.
5. **Indexed market discovery.** Replace the single canonical-market presentation with a creator registry or indexed market factory that supports many markets safely.
6. **Operational hardening.** Add monitoring, alerting, RPC failover, rate limits, incident procedures, and deployment controls.
7. **Legal review.** Determine where and how a real-money product could operate before any mainnet launch.

## Product expansion

- Full World Cup market discovery and filtering
- Live TxLINE SSE updates for match state and pool context
- Permissionless market-creation interface with predicate previews
- Portfolio, position history, and claim notifications
- More parametric markets, including team totals and card or corner combinations
- Accessible mobile layouts and clearer proof-receipt explanations

## Deliberate non-goals for the proof of concept

- Mainnet or real-money operation
- AMM, order book, or secondary position trading
- Claims of organic liquidity
- Claims of oracle independence beyond the TxODDS trust anchor
