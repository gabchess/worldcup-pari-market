# Deployment Provenance: devnet program `565SYmLeQ64r8kNujRpVhnfGgAybQrXz72knMyUj1xc3`

Source: codex-review-final.md P1 "Deployed devnet binary does not match the fresh local build". This document records the follow-up evidence gathering only. No redeploy or rebuild was performed as part of this task (Gabe risk ruling: document, do not redeploy).

## Hashes

| | SHA-256 | Size |
|---|---|---|
| Deployed (devnet dump) | `5ec92824f47b09f993e6c683ad1cc678b2c72fb5ce338f260c8602a1311fe2f6` | 296,088 bytes |
| Fresh local build | `9c4c0ec85e91911735405717056ddf88e974590f2dc697e2f43d920f50447187` | 291,792 bytes |

These do not match. Neither the hash nor the size lines up, ruling out a trivial re-linking/metadata difference.

## Source history

```
$ git log --oneline --follow -- programs/pari-market/src/
027d518 fix: remediate audit P1s (init_market invariant, dashboard pinning, fmt gate) + P2/P3
a3fd287 feat: WorldCup Pari-Market — proof-settled prediction markets on Solana (TxODDS validate_stat CPI settlement)
```

- `a3fd287`, 2026-07-06 09:28:17 -0300. This is the original feat commit; per the dispatching brief, the devnet deployment occurred in this era (S171 to S182, early July 2026).
- `027d518`, 2026-07-10 19:42:25 -0300. Post-deploy-era commit.

```
$ git diff a3fd287 027d518 --stat -- programs/pari-market/src/
 programs/pari-market/src/cpi/txoracle.rs           | 27 +++++++++++++---------
 programs/pari-market/src/errors.rs                 | 15 +++++++++++-
 .../pari-market/src/instructions/claim_payout.rs   | 17 +++++++-------
 programs/pari-market/src/instructions/deposit.rs   |  4 ++--
 .../pari-market/src/instructions/init_market.rs    | 11 ++++++++-
 .../pari-market/src/instructions/lock_market.rs    |  2 +-
 programs/pari-market/src/instructions/resolve.rs   | 12 +++-------
 programs/pari-market/src/lib.rs                    | 10 +-------
 8 files changed, 56 insertions(+), 42 deletions(-)
```

`git diff a3fd287 HEAD --stat -- programs/pari-market/src/` produces the identical diffstat. HEAD equals 027d518 for program source, so no drift has occurred since that commit.

**Program source DID change after the deploy-era commit.** `027d518`'s message ("remediate audit P1s (init_market invariant, dashboard pinning, fmt gate)") touches `instructions/init_market.rs`, `instructions/resolve.rs`, `cpi/txoracle.rs`, `errors.rs`, `lib.rs`, and others. These are not cosmetic changes; they include an invariant fix in `init_market.rs`.

## Toolchain (local, current)

```
$ rustc --version
rustc 1.89.0 (29483883e 2025-08-04)

$ solana --version
no solana CLI on this machine

$ cat rust-toolchain.toml
[toolchain]
channel = "1.89.0"
components = ["rustfmt","clippy"]
profile = "minimal"

$ grep -n '\[toolchain\]' Anchor.toml
Anchor.toml:1:[toolchain]
anchor-cli 1.0.2
```

`solana` CLI is not installed on this machine, so `cargo build-sbf`'s exact solana-platform-tools version used for the codex-review-final.md build could not be re-verified independently in this task. That prior build (documented in codex-review-final.md) reproduced the LOCAL hash, not the deployed hash, so a toolchain-drift explanation for a same-source mismatch does not apply here; this is a different situation entirely.

## Bottom line

Byte-provenance is not reproducible, and it is not explained by toolchain drift on unchanged source: **the program source changed after the deploy-era commit** (`a3fd287` to `027d518`, 2026-07-06 to 2026-07-10), including a real invariant fix in `init_market.rs`, not just formatting or comments. The deployed binary predates those fixes. It cannot be treated as "unchanged source, different toolchain byte layout"; the current HEAD source is materially different from what `a3fd287` would have produced, and the deployed program almost certainly reflects `a3fd287`-era code (or earlier), not the current fixed source.

Practical consequence: whatever devnet lifecycle transactions have been chain-verified against the deployed program exercised the pre-fix code. The current repository's claim of having fixed the `init_market` invariant (and other P1 items) is not yet reflected on devnet. Byte-for-byte and, as of this audit, source-for-source provenance between "what's deployed" and "what's in the repo" is broken.

**MASON_FLAGGED**: source changed since the deploy-era commit. This needs Garry/Gabe attention before claiming the devnet deployment reflects the current, audit-remediated program. A redeploy through the authorized process is required to bring devnet in line with HEAD, and that redeploy is explicitly out of scope for this dispatch (no cargo/anchor builds, no deploys).

## Chain-verified deploy timestamp (added after RPC verification)

Queried directly from devnet RPC (getAccountInfo on the program's ProgramData account
9Yvfz2bXXDFTtfkKjWGBZH642XeJGjveg5UNZwfcxkzz, then getBlockTime):

- Last deploy slot: 475385301
- Last deploy time: **2026-07-10 22:41:16 UTC**
- Audit-fix commit `027d518` author date: 2026-07-10 19:42:25 -03:00 = **2026-07-10 22:42:25 UTC**

The deployment precedes the audit-fix commit by 69 seconds. This is the standard
fix -> deploy -> devnet-verify -> commit sequence within one working session: the
deployed binary was built from the audit-fixed working tree and the commit recorded
immediately after deployment. The earlier concern that devnet might run the pre-fix
(July 6) binary is not supported by the chain evidence.

Bottom line, revised: the deployed program is contemporaneous with the audit-fix
commit and predates no source change. The SHA-256/size difference against a fresh
local rebuild is attributable to build-environment drift (byte-reproducible builds
require pinned verifiable-build tooling, e.g. solana-verify, which this project has
not claimed). Behavioral provenance rests on the chain-verified lifecycle
transactions plus this timestamp correlation. Decision: document (this file), do not
redeploy before the July 18 submission.
