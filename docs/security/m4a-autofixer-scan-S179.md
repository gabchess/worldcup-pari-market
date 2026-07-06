# M4a Autofixer Scan (S179)

Scope: `programs/pari-market/src/**/*.rs` at commit `95acb28` (M1.5, post-M2a security fixes,
post-M2b claim_payout, post-M2.5 parametric tests). This is the explicit M4a remainder flagged
in `m4a-trust-boundary-spec.md` ("the mcp.solana.com autofixer scan... did not run this session
because that MCP loads next session; it remains the explicit M4a remainder").

Tool: `mcp.solana.com` `program_autofixer` MCP tool, invoked via headless HTTP bridge (the MCP
server is not loaded in this Claude Code session). Server confirmed **stateless**: no
`Mcp-Session-Id` issued or required, and each `tools/call` succeeds independently after a bare
POST with no prior `initialize`/`notifications/initialized` handshake needed per call. Requests
sent as JSON-RPC 2.0 to `https://mcp.solana.com/mcp` with `Accept: application/json,
text/event-stream`; responses parsed out of the returned SSE `data:` line.

Scope note: 16 total `.rs` files under `programs/pari-market/src/`, which exceeds the 12-file
threshold for folding in `tests/`, so tests were excluded from this scan per the dispatch brief.
The sibling `programs/worldcup-settlement/` legacy program is out of scope per brief.

## Per-file findings

| File | framework_detected | issues | suggestions | require_another_call | Verdict |
|---|---|---|---|---|---|
| `constants.rs` | anchor | 0 | 0 | false | CLEAN |
| `cpi/mod.rs` | unknown (re-export module, no logic) | 0 | 0 | false | CLEAN |
| `cpi/txoracle.rs` | anchor | 0 | 0 | false | CLEAN |
| `errors.rs` | anchor | 0 | 0 | false | CLEAN |
| `instructions/claim_payout.rs` | anchor | 0 | 0 | false | CLEAN |
| `instructions/deposit.rs` | anchor | 0 | 0 | false | CLEAN |
| `instructions/init_market.rs` | anchor | 0 | 0 | false | CLEAN |
| `instructions/lock_market.rs` | anchor | 0 | 0 | false | CLEAN |
| `instructions/mod.rs` | unknown (re-export module, no logic) | 0 | 0 | false | CLEAN |
| `instructions/resolve.rs` | anchor | 0 | 0 | false | CLEAN |
| `lib.rs` | anchor | 0 | 0 | false | CLEAN |
| `market/mod.rs` | unknown (re-export module, no logic) | 0 | 0 | false | CLEAN |
| `market/state.rs` | anchor | 0 | 0 | false | CLEAN |
| `position/mod.rs` | unknown (re-export module, no logic) | 0 | 0 | false | CLEAN |
| `position/state.rs` | anchor | 0 | 0 | false | CLEAN |
| `proof/mod.rs` | anchor | 0 | 0 | false | CLEAN |

**16/16 files scanned. 0 critical, 0 high, 0 medium, 0 low findings. 0 suggestions.**
`require_another_tool_call_after_fixing` was `false` on every file on the first pass, so no
fix/rescan loop was triggered.

`framework_detected: unknown` on the four `mod.rs` re-export-only files (`cpi/mod.rs`,
`instructions/mod.rs`, `market/mod.rs`, `position/mod.rs`) is expected: these files contain only
`pub mod` / `pub use` statements with no Anchor macros or program logic for the autofixer's
framework detector to key on. `proof/mod.rs` contains real logic (Merkle proof verification) and
was correctly detected as `anchor`.

## Fix rounds

None. No critical/high issues or syntax errors were reported on any file, so no fix/rescan loop
ran. Zero medium/low findings were logged either (advisory or otherwise); the scan came back
fully clean.

## Why the scan is clean (cross-reference to `m4a-trust-boundary-spec.md`)

The M4a trust-boundary spec (written against commit `79b4a45`, pre-M1) documented two P0 findings
against the `resolve()` CPI trust boundary:

- **B4** (pre-CPI): `fixture_summary`/`stat_a`/`stat_b` instruction args were not checked against
  `market.fixture_id`/`market.stat_a_key`/`market.stat_b_key` before the CPI.
- **A1** (post-CPI): `get_return_data()`'s `program_id` was not checked against
  `TXORACLE_PROGRAM_ID` before trusting the returned `data`.

Verified in the current tree (commit `95acb28`) that both are implemented:

- `instructions/resolve.rs:81-82` and surrounding lines assert `fixture_summary.fixture_id ==
  market.fixture_id`, `stat_a.stat_to_prove.key == market.stat_a_key`, and the conditional
  `stat_b` key check, per the doc comment at `resolve.rs:11-33` (`FixtureMismatch` error).
- `cpi/txoracle.rs:103-107` decodes `get_return_data()` and requires
  `returned_program_id == TXORACLE_PROGRAM_ID` (erroring with
  `PariMarketError::UnexpectedReturnDataProgram`) before decoding `data[0]` as the bool.

Both P0s were closed in M2a (commit `b2a187c` per the M2a to M3 gate context), so the autofixer
scan finding zero issues here is consistent with the prior manual audit, not a scan gap. The five
P1s and one P2 from the spec (compute-budget enforcement, decoded-byte domain check, Position
`side`-mismatch design, `lock_market` time gate, `claim_payout` winning-side `has_one`/`constraint`
check, duplicate-account-passing defense-in-depth) are out of scope for an automated Rust-level
static scan: they are either client-side tx-builder concerns (compute budget), already-decided
product/business logic that would need spec confirmation before enforcing at the Accounts-struct
level, or explicitly deferred to M2b/M4b. None of them surfaced as autofixer findings, which is
expected since they are design decisions the tool cannot infer, not code defects.

## Advisories (medium/low, route to M4b)

None reported by the tool on this pass. No advisory items to log.

## Test verification

No fixes were applied (scan came back clean), so the pre-existing test suite was not touched.
Baseline `cargo test -p pari-market` run before this scan (for gate verification) was 24/24
green across 5 test binaries (unit lib tests: 1; `resolve.rs` integration: 6; two other
integration binaries: 3 + 8; `claim_payout`-adjacent binary: 6; doc-tests: 0). No test changes
were required or made.

## Gate verdict

**AUTOFIXER_CLEAN.** M4a autofixer scan (the explicit remainder from S175/prior session) is
complete against the current `pari-market` tree. No `.rs` files were modified this session. This
closes the last open condition on the M2a to M3 gate per the dispatch brief (M4a remainder).
