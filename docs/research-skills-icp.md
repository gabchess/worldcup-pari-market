# RESEARCH 2: Build-helper skills, competitor + community intel, ICP + pain points

**Session:** S174 (2026-07-01). **Phase:** deep research (plan-hardening, pre-BUILD).
**Method:** 7-leg Rafi fan-out (skill marketplaces, GitHub references, Solana/SolanaBR ecosystem, X, Reddit, in-harness audit, ICP) + Garry direct backfill of 3 transient-failure legs. Feeds the whole-crew pair-think.

---

## 1. Skills / tools / MCP to consider adopting

### Adopt (strong provenance, on-target)
- **`solana-foundation/solana-dev-skill`** (Claude Code skill). Official Solana Foundation, 524 stars, MIT, `npx skills add`. Covers Anchor (primary), testing (LiteSVM / Mollusk / Surfpool), Codama typed-client generation, Anchor 0.30->0.31 migration matrices. Highest-trust publisher. Read `install.sh` before running (SKILL.md bundle, not an npm dep, so socket-install discipline is N/A but still inspect).
- **`mcp.solana.com`** (official remote MCP). `claude mcp add --transport http solana-mcp https://mcp.solana.com/mcp`. Exposes live Solana docs search + `program_autofixer`, which flags Anchor/Pinocchio security antipatterns. A free, zero-install pre-Dayo pass directly on the `resolve()` CPI. Lowest-risk item in the set (official domain, HTTP, no key, no local binary).
- **`anchor-bankrun` / `solana-bankrun`** (test harness, Kevin Heavey, officially documented). Fast BanksServer testing of the `init_market -> deposit -> lock -> resolve -> claim_payout` loop without devnet round-trips. Test-only, no funds.
- **`solana-test-validator`** (already in the standard CLI). Final pre-devnet integration pass after bankrun-speed iteration.
- **Two architecture disciplines (zero install risk):** freeze all PDA seed constants in one module before writing instructions (seed-order refactor is the top recurring Anchor bug); hardcode the CLASSIC SPL Token Program ID (devnet USDC is a classic SPL mint, not Token-2022) to close a CPI-owner-mismatch bug class.

### Trial (useful but thinner provenance -> security sign-off before adopt)
- **`Frankcastleauditor/safe-solana-builder`** (security-first skill). CPI-safety, PDA-validation, checked-arithmetic rules mapping onto `resolve()` + `claim_payout`. 128 stars; author self-identified security researcher with unverified contest claims; manual `.skill` upload. Dayo reads the contents before adoption (AR-568 untrusted-input firewall).
- **HackMD Anchor Escrow walkthrough** (ironaddicteddog). Nearest analog for the vault-PDA-signs-CPI mechanic in `deposit`/`claim_payout`. No pari-mutuel-specific template exists anywhere, so this is the closest reference.

### Reference
- **`solana-foundation/program-examples`** (1419 stars, pushed 2026-06-30). Canonical fresh escrow / CPI / token examples to model from.
- Target **Anchor 0.32.1** (current latest).
- `solanabr` (Superteam Brazil, 71 repos, `solanabr/wiki`) for BR-ecosystem / hackathon support context.

### Skip
- `GuiBibeau/solana-dev-skill` (indistinguishable from the Foundation upstream in this pass), `sendaifun/solana-mcp` (broad on-chain action surface, overkill for an Anchor program build), `quiknode-labs/solana-anchor-claude-skill` (fetch returned mismatched content, unverified).

## 2. What ARCANA already owns (do not re-adopt blindly)
- `/solana-anchor` (360 lines, Apr 2026, "minimal reusable Anchor code"), `/solana-dev` (160L, Apr), `/dev-solana` (329L, Mar), `/defi-security` (auto-invoke pre-deploy DeFi security), `lena-quant-defi-*`. No Solana MCP wired today.
- Open question for the crew: our skills predate Anchor 0.32.1. Adopt the official foundation skill + `mcp.solana.com` on top of ours, or refresh ours? (Net-new value: current version matrices, Codama, the autofixer.)

## 3. Build gotchas (community / Reddit / X)
- **CPI depth ceiling ~5 nested levels, shared compute budget.** Map `resolve() -> validate_stat() -> (nested CPIs inside txoracle)` and confirm headroom before building.
- **PDA seed-order fragility.** Swapping seed order mid-refactor passes local tests, throws on deploy. Freeze seeds first.
- **Token-2022 vs classic SPL.** Hardcode the classic Token Program ID for devnet USDC.
- **Proportional-payout rounding / dust.** No Solana or pari-mutuel rounding case study exists (only a Balancer V2 precedent). This is the novel, highest-risk math: test dust-rounds-to-zero and last-claimer-remainder. Dayo-owned at M4.
- **No public pari-mutuel Anchor template** (0 GitHub hits, confirmed across three legs). Core logic is from-scratch; do not burn cycles hunting a template.

## 4. Competitor + community intel (X)
- **`@blitz_funn` (@Savage27z) shipped a LIVE entry in the same TxODDS track:** real-time football micro-markets, pari-mutuel odds shifting with stake, TxODDS Merkle-proof settlement in under 2s on Solana. Functionally close to our plan. Their settlement path (true on-chain CPI vs off-chain-verify-then-settle) is unclear, which is exactly the seam our differentiation targets: a clearly-shown on-chain `validate_stat` CPI + the verifiable-fact framing.
- **SolBet (`@HKsoldev`):** pari-mutuel on Solana devnet, full create/buy/resolve lifecycle (no public repo found). ~7 active Solana prediction-market projects in the field.
- **Hackathon-winning pattern (judge-corroborated):** demo video is mandatory even with a live demo; record with visible enthusiasm; a strong theme-interpretation edge scores.

## 5. ICP + pain points (the wedge)
World Cup 2026 already proved on-chain prediction-market demand at scale ($2B+ Polymarket volume, ~60% first-time crypto users). Every incumbent leaks trust:
- **Polymarket** froze withdrawals and got frontend-hacked for $3.1M (Jun 2026), days after a refund pledge.
- **Offshore sportsbooks** geo-block, delay withdrawals, and can shut down with no regulator to appeal to.
- **Betfair** takes a 5% commission plus a 20-40% "Expert Fee" on winning accounts ("a tax on success").
- **Most on-chain rivals** (Polymarket, Hedgehog, Azuro) still rely on optimistic-oracle or multisig-overridable resolution that is disputable.

**The wedge:** `validate_stat` CPI against a cryptographically-timestamped Merkle root makes settlement a **verifiable on-chain fact**, not a token-holder vote or a company decision.

**ICPs (5):** crypto-native sports bettor (Polymarket/Kalshi power user), DeFi degen, football-fan speculator (offshore-book user), quant/analytics trader, and the hackathon judge. The recurring 3 pains: custody/freeze risk, disputable/opaque resolution, fee extraction.

**Differentiation vs a betting-AGENT entry** (the adjacent track): agents automate WHO bets and HOW MUCH; we automate WHETHER a bet resolves fairly at all. We compete on trustless settlement infrastructure, not prediction intelligence.

**Demo narrative (judge-facing):** open on the Polymarket-freeze / $3.1M-hack headline; show the YES/NO pool ratio shifting as deposits land; at resolution show the literal `resolve()` CPI into `validate_stat` plus the Merkle-anchored proof; a contrast card ("Polymarket: dispute window + token vote" vs "Ours: one CPI, one proof"); `claim_payout` fires instantly.

---

*Feeds the S174 whole-crew pair-think (Ada, Vera, Bram, Kevin, Dayo, Tomas, Juno, Anders). Adoption decisions + new-hire recommendation land there; BUILD remains gated on Gabe's plan LOCK.*
