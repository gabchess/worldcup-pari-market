# Deployment Provenance

This note records the evidence connecting the public devnet deployment to the audit-fixed source state.

## Verdict

The deployed program is contemporaneous with the audit-fix commit: Solana records the deployment 69 seconds before the commit timestamp during the project's build, deploy, verify, and commit sequence. The evidence supports source-level and behavioral provenance, but not byte-for-byte reproducibility.

## Deployment

- Program: `565SYmLeQ64r8kNujRpVhnfGgAybQrXz72knMyUj1xc3`
- ProgramData account: `9Yvfz2bXXDFTtfkKjWGBZH642XeJGjveg5UNZwfcxkzz`
- Last deployment slot: `475385301`
- Chain-recorded deployment time: `2026-07-10 22:41:16 UTC`
- Audit-fix commit: `027d518`
- Commit time: `2026-07-10 22:42:25 UTC`

The deployment therefore preceded the recorded commit by 69 seconds. No program-source change occurred between that commit and the provenance review.

## Reproducibility boundary

A fresh local build did not reproduce the deployed binary's SHA-256 hash or file size. The project did not pin a verifiable-build environment, so the toolchain and build-container inputs required for byte-identical output are unavailable.

This repository does not claim byte-for-byte reproducible builds. That work remains on the [roadmap](../ROADMAP.md).

## Behavioral evidence

The deployed program completed the full market lifecycle on devnet: initialization, deposits on both sides, lock, TxODDS `validate_stat` CPI resolution, and payout. The finalized transaction links appear in [PROJECT-OVERVIEW.md](../PROJECT-OVERVIEW.md).

Behavioral verification and deployment timing reduce ambiguity; they do not replace a pinned verifiable-build pipeline.
