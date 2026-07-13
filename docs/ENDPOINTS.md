# Technical Endpoints Reference

Reference documentation for the pari-market program's on-chain instructions, the TxLINE API calls it depends on, the dashboard's read API, and the stat-key dictionary used to build resolution predicates.

## On-chain program: `pari-market`

Devnet address: `565SYmLeQ64r8kNujRpVhnfGgAybQrXz72knMyUj1xc3`

### `init_market(market_id, fixture_id, epoch_day, stat_a_key, stat_b_key, op, predicate, lock_ts)`

Creates a Market PDA. Accounts: `market` (init, PDA `["market", market_id]`), `usdc_mint`, `vault` (init, PDA `["vault", market]`, token account owned by the market), `authority` (payer), token/system programs, rent sysvar.

`lock_ts` must be strictly in the future or the call is rejected. `stat_b_key` and `op` are both `None` for a single-stat (binary win/lose) market, or both `Some` for a two-stat parametric market (spread, total). `predicate` is the threshold/comparison the resolved stat value gets checked against.

### `deposit(amount, side)`

Transfers `amount` USDC from the caller into the market's vault and credits it to their Position on `side` (true = YES, false = NO). Accounts: `market` (mut, rejects if locked), `position` (init-if-needed, PDA `["position", market, bettor]`), `vault`, `bettor_usdc` (source), `bettor` (signer), token/system programs.

Rejected once the market is locked, once the deposit lands after `lock_ts` (even if `lock_market` hasn't been explicitly called yet), or if `amount` is zero. A repeat deposit on an existing Position must match the side already recorded; a mismatched side is rejected rather than silently ignored.

### `lock_market()`

Closes the deposit window. Permissionless: any signer can call it once the current time reaches `lock_ts`. Cannot be called twice on the same market.

### `resolve(ts, fixture_summary, fixture_proof, main_tree_proof, stat_a, stat_b)`

CPIs into TxODDS's `validate_stat` instruction and records the verified outcome. Accounts: `market` (mut, must be locked and not already resolved), `daily_scores_merkle_roots` (TxODDS-owned PDA for the market's `epoch_day`), `txoracle_program` (must match the known TxODDS program ID), `caller` (signer, permissionless).

The caller supplies only proof material (`ts`, `fixture_summary`, `fixture_proof`, `main_tree_proof`, `stat_a`, `stat_b`); the predicate configuration (`predicate`, `stat_a_key`, `stat_b_key`, `op`) always comes from the market's own stored state, never the caller. Before the CPI fires, the instruction checks the supplied proof's fixture ID and stat keys match what this market is bound to.

`validate_stat` does not revert when the predicate is false. It returns `Ok` with a boolean in the CPI return data either way, so `resolve()` must decode that return data (checking it was actually set by TxODDS's program, not a stale value from an earlier call) rather than treating "the CPI didn't error" as the answer. Resolving to false is a valid, expected outcome, not a failure path.

The `validate_stat` CPI alone costs roughly 179,000 compute units. `resolve()` needs a raised compute budget (recommend 400,000 to 600,000 CU) requested by the client before this instruction runs, since the default 200,000 CU transaction budget doesn't leave enough room for the CPI plus this instruction's own account work.

### `claim_payout()`

Pays a resolved market's pooled USDC to a depositor. Accounts: `market` (must be resolved), `position` (mut, must belong to the caller, must not already be claimed, must be on the winning side or refund-eligible), `vault`, `bettor_usdc` (destination), `bettor` (signer), token program.

Payout is `position.amount * total_pool / winning_pool`, computed with a 128-bit intermediate to avoid overflow, floor-divided. The floor-division remainder (dust) stays in the vault rather than being redistributed, keeping total paid out always ≤ total deposited. If the market resolves to a side nobody deposited on, every position can claim back exactly its own deposit as a refund. A position can only be claimed once.

## TxODDS `txoracle` program (external, not ours)

Devnet address: `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`

### `validate_stat(ts, fixture_summary, fixture_proof, main_tree_proof, predicate, stat_a, stat_b, op)`

The instruction our `resolve()` CPIs into. Verifies a stat (or two stats combined) against a Merkle root TxODDS itself wrote on-chain, then returns a boolean in the CPI return data. Account: the `daily_scores_roots` PDA (seed `"daily_scores_roots"` plus the epoch day, owned by the TxODDS program) for the day the fixture's data was published.

`predicate` is a threshold and a comparison (greater than, less than, or equal to). When `stat_b` and `op` are supplied, the checked value is `stat_a op stat_b` (for example, subtracting away goals from home goals to get a goal spread) rather than a single stat on its own.

## TxLINE API (external, TxODDS's live data service)

Base URL: `https://txline-dev.txodds.com`

### Subscribe and activate flow

1. `POST /auth/guest/start` returns a Bearer JWT (roughly 30-day expiry).
2. `POST /api/token/activate` with body `{txSig, walletSignature, leagues: []}` returns an API token as plain text (not JSON). `txSig` is the on-chain subscribe transaction signature; it can only be used once. `walletSignature` is a base64 Ed25519 signature over the string `txSig + "::" + jwt` (the JWT from step 1, concatenated with two colons), signed by the subscribing wallet. `leagues` must be an empty array on devnet.
3. Data endpoints require both headers together: `Authorization: Bearer <jwt>` and `X-Api-Token: <apiToken>`.

### Data endpoints

- `GET /api/fixtures/snapshot/{epochDay}` (or `/latest`): fixture list for a day.
- `GET /api/scores/snapshot/{fixtureId}`: live score for one fixture.
- `GET /api/odds/snapshot/{fixtureId}`: current odds for one fixture.
- `GET /api/scores/historical/{fixtureId}`: score data for a fixture that finished between two weeks and six hours ago. This is the endpoint the demo resolves against, since the fixture needs a final, stable, provable result.
- `GET /api/scores/stat-validation?fixtureId=..&seq=..&statKey=..[&statKey2=..]`: the proof endpoint. Returns the timestamp, the stat(s) to prove, the Merkle proof material, and the fixture summary, all of which get passed directly into the `resolve()` instruction's arguments.

Devnet is capped at service level 1: World Cup and international friendlies only, roughly 60 seconds delayed, free. Real-time data (service level 12) is mainnet-only.

## Dashboard API

### `GET /api/market`

Resolves the dashboard's default market. If `CANONICAL_MARKET_ID` is set, it derives that market's PDA directly and returns its state plus a decoded transaction timeline. The deployed dashboard must set this value because `init_market` is permissionless: selecting the numerically latest market would allow an unrelated creator to replace the market shown by default.

If `CANONICAL_MARKET_ID` is unset during local development, the route falls back to `getProgramAccounts`, filters for the fixed Market account size and canonical mint, validates each discriminator, and selects the greatest market ID. This scan is a development fallback, not creator authentication and not a production discovery design.

The response includes a `source` field: `"pinned"` when the market was resolved via `CANONICAL_MARKET_ID`, or `"scan"` when it fell back to the weaker defense-in-depth scan. A live auditor can read this field directly off the response to confirm the dashboard isn't silently running in scan mode.

### `GET /api/market?id=<market_id>`

Same shape, but decodes a specific market by ID instead of resolving the default. `source` is `null` on this route -- fetching by an explicit ID has no discovery ambiguity to report.

Both routes read a devnet RPC endpoint at request time, so every poll reflects current on-chain state. Set `CANONICAL_MARKET_ID` to the chosen market ID before deploying the dashboard.

## Stat-key dictionary

Stat keys follow TxODDS's encoding: `(period_multiplier) + base_key`.

| Base key | Meaning |
|---|---|
| 1 | Home team total goals |
| 2 | Away team total goals |
| 3 | Home team total yellow cards |
| 4 | Away team total yellow cards |
| 5 | Home team total red cards |
| 6 | Away team total red cards |
| 7 | Home team total corners |
| 8 | Away team total corners |

| Period multiplier | Meaning |
|---|---|
| 0 | Full game (use the base key directly, no prefix) |
| 1000 | First half |
| 2000 | Second half |
| 3000 | Extra time, first period |
| 4000 | Extra time, second period |
| 5000 | Penalty shootout |

Example: key `1` (no multiplier) is full-game home goals. Key `2001` would be away goals in the first half.

The demo's goal-spread market uses `stat_a_key = 1` (home goals, full game), `stat_b_key = 2` (away goals, full game), `op = Subtract`, and a `predicate` threshold of 1 with `GreaterThan`, which evaluates the condition "home goals minus away goals is greater than one."

## PDAs and seeds

| Account | Seeds | Owner |
|---|---|---|
| Market | `["market", market_id (u64 little-endian)]` | pari-market program |
| Position | `["position", market_pubkey, bettor_pubkey]` | pari-market program |
| Vault (USDC token account) | `["vault", market_pubkey]` | pari-market program |
| `daily_scores_roots` | `["daily_scores_roots", epoch_day (u16 little-endian)]` | TxODDS `txoracle` program |

`epoch_day` is the floor of the fixture data's timestamp in milliseconds divided by the number of milliseconds in a day. Use the stat-validation response's `summary.updateStats.minTimestamp` field to compute it, not the response's top-level `ts` field; the two are different values and only the former matches the on-chain root TxODDS actually wrote for that epoch.
