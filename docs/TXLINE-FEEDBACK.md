# TxLINE API Feedback: Devnet Integration Notes

These are notes from building a World Cup settlement system on devnet during the hackathon. The API works well once you know the right call shapes. Each item below is a place where I lost time and a suggested doc fix that would save the next builder that time.

---

## 1. `leagues` must be an empty array on SL=1 devnet

The `token/activate` endpoint accepts a `leagues` parameter. Sending `leagues: ["world_cup"]` returns HTTP 500 ("Could not issue custom API token due to an internal error"). The working call is `leagues: []`.

**Suggested doc addition:** note that `leagues` is empty on SL=1 devnet and that populated values apply to higher service levels or mainnet.

---

## 2. `walletSignature` message format is `txSig::jwt` (two colons)

The Ed25519 signature must be over the exact string formed by concatenating the onchain subscribe transaction signature, two colons, and the guest JWT: `txSig::jwt`. Order matters: obtain the guest JWT first, then sign. Signing `txSig` alone returns HTTP 403 ("Wallet signature verification failed or payload was tampered with").

**Suggested doc addition:** show the exact concatenation pattern (`txSig + "::" + guestJwt`) and specify that the JWT must already exist before signing.

---

## 3. Data endpoints require both `Authorization` and `X-Api-Token` headers

Authenticated data requests need two headers simultaneously: `Authorization: Bearer <jwt>` and `X-Api-Token: <apiToken>`. Sending only one returns a 401 or 403. Easy to miss when reading the auth flow.

**Suggested doc addition:** a minimal working request example showing both headers together.

---

## 4. `token/activate` response is `text/plain`, not JSON

The endpoint returns the raw API token string (format: `txoracle_api_<hex>`) as plain text, not a JSON object. Calling `.json()` on the response throws. Calling `.text()` works.

**Suggested doc addition:** specify the `Content-Type: text/plain` response and show `.text()` as the correct parser.

---

## 5. Subscribe transaction signatures are single-use

Each call to `token/activate` consumes the onchain subscribe transaction. Re-activating with the same signature returns HTTP 403 ("This transaction has already been used to activate a subscription"). A fresh onchain subscribe is required per activation. The subscription itself stays valid for roughly four weeks.

**Suggested doc addition:** a note that `txSig` values are one-time-use for activation, separate from subscription validity.

---

## 6. Merkle proof endpoint vs. onchain settlement root

`GET /api/odds/validation?messageId=...&ts=...` returns HTTP 404 for live in-running odds message IDs on devnet. The verifiable settlement source is the `daily_scores_roots` PDA written by the oracle program, which was confirmed present on devnet for the current epoch.

**Suggested doc addition:** clarify which settlement verification path is canonical for onchain use cases. If the Merkle proof endpoint is mainnet-only or epoch-gated, a note to that effect would help integrators pick the right path without trial and error.

---

## 7. SL=12 is mainnet-only; devnet pricingMatrix has SL=1 and SL=2

A Discord note mentioned SL=12 as a working service level. On devnet, pricingMatrix only returns SL=1 and SL=2; SL=12 appears mainnet-only. This sent me down a path trying to activate SL=12 before checking pricingMatrix directly.

**Suggested doc addition:** a table or note showing which service levels are available per environment (devnet vs. mainnet).

---

## 8. `validate_stat` does not revert on a false predicate

The `validate_stat` instruction returns `Ok(())` whether the predicate evaluates true or false. Both show up as a successful, finalized transaction (`err: null`); the only way to tell them apart is reading the CPI return data (a single boolean byte, `AQ==` for true, `AA==` for false, base64). A caller assuming "transaction succeeded" means "predicate was true" will silently treat every false resolution as true.

**Suggested doc addition:** state explicitly, next to the instruction's description, that a false predicate is a successful call with a false return value, not an error, and show how to read the return data (which program set it, and how to decode the boolean) in the same code sample that shows the instruction call.

---

## 9. Two `txoracle` program IDs are both live on devnet, only one holds current roots

Both `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J` and `9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA` are executable on devnet. Only the first holds `daily_scores_roots` data for current World Cup fixtures; the second is the mainnet program ID (the address the published IDL metadata points at), deployed on devnet with no roots written under it. Deriving the PDA under the wrong one silently returns "account not found," with nothing indicating which ID is live.

**Suggested doc addition:** a devnet-specific note stating which of the two addresses is the one integrators should target, or a way to query which program ID currently holds root data for a given epoch day without trial and error against both.

---

## 10. `validate_stat` CPI compute cost is close to the default transaction budget

A single `validate_stat` call, standalone, costs roughly 179,000 compute units, close enough to Solana's default 200,000 CU per-transaction budget that any caller doing meaningful work of its own in the same instruction (as any real settlement contract will) needs to explicitly raise the compute budget, or it fails with a compute-exhaustion error that has nothing obviously to do with `validate_stat` itself.

**Suggested doc addition:** publish the expected compute unit cost for `validate_stat` (ideally broken out by proof size, since deeper Merkle trees cost more) next to the instruction reference, with a recommended `ComputeBudgetProgram` request size for callers CPI-ing into it.

---

Thanks for building this. The authentication model is clean once the pieces click, and the onchain settlement root as canonical truth source is a good design. These notes are all from a solved state, so they should translate directly into doc improvements.
