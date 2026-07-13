# Security Review and Trust Model

This document summarizes Pari-Market's current security posture. It describes a hackathon proof of concept, not an independent professional audit or a claim of production readiness.

## Scope

The review covers the Anchor program in `programs/pari-market/src`, with emphasis on:

- the `resolve()` CPI into TxODDS `validate_stat`;
- market, position, vault, and foreign-root account bindings;
- deposit, lock, resolution, refund, and payout state transitions;
- arithmetic conservation and rounding behavior; and
- adversarial account substitution and repeat calls.

The Next.js dashboard received regression tests for wallet transaction state and canonical-market discovery. Infrastructure, dependency supply chains, wallet extensions, RPC providers, and TxODDS itself are outside the program review boundary.

## Trust assumptions

Pari-Market removes discretionary market resolution; it does not remove the oracle trust anchor.

- TxODDS publishes the correct daily scores Merkle root.
- The pinned TxODDS program ID executes the expected `validate_stat` semantics.
- Solana devnet remains available and preserves the relevant accounts and transactions.
- Clients obtain proof material that corresponds to the market's stored fixture and stat keys.

The program enforces the last assumption before CPI. It cannot independently prove that the real-world match data underlying a TxODDS root is correct.

## Implemented controls

### Before the CPI

- The market must be locked and unresolved.
- The foreign Merkle-root PDA is re-derived under the pinned TxODDS program ID.
- The supplied fixture ID must equal the fixture stored in the market.
- The supplied stat keys must equal the market's stored stat configuration.
- The predicate and optional two-stat operation come from market state, not caller input.

### After the CPI

- The return-data program ID must equal the pinned TxODDS program ID.
- The returned byte must be exactly `0` or `1`.
- Both true and false are valid resolution outcomes; transaction success alone is not treated as true.
- A market cannot resolve twice.

### Funds and accounts

- Market, position, and vault addresses use fixed PDA seeds.
- Positions are bound to their market and bettor.
- Token accounts are constrained to the market mint and expected authority.
- Deposits close at the stored lock time even if nobody has called `lock_market` yet.
- Repeat deposits cannot switch sides.
- Claims are restricted to winners or the empty-winning-pool refund path.
- Each position can be claimed once.
- Payout arithmetic uses checked operations and a 128-bit intermediate.
- Floor-division dust remains in the vault, so aggregate payouts cannot exceed deposits.

## Verification

The Rust integration suite uses LiteSVM with a checked-in dump of the real TxODDS `txoracle` bytecode and captured TxLINE Merkle proofs. It does not replace the oracle with a mock.

The suite covers normal lifecycle behavior, one-stat and two-stat resolution, false predicates, wrong roots, fixture and stat mismatches, return-data spoofing, cross-market positions, wrong token mints, repeat claims, lock-time races, empty winning pools, and extreme deposit sizes.

Run the current suite with:

```bash
cargo test -p pari-market
```

Devnet transaction links for a complete lifecycle are recorded in [../SUBMISSION.md](../SUBMISSION.md).

## Remaining limitations

- No independent external audit has been performed.
- Build output is not yet byte-for-byte reproducible across environments.
- Settlement has one oracle trust anchor: the TxODDS program and its published roots.
- The protocol has no defined recovery path for a missing, delayed, or incorrect oracle root.
- The demonstration uses devnet USDC and operator-seeded liquidity.
- Operational monitoring, incident response, upgrade policy, and mainnet controls are not complete.

These limitations block any claim of production or real-money readiness.
