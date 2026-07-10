#!/usr/bin/env -S node --experimental-strip-types
/**
 * Regression check for the Codex audit P1 finding (codex-audit-report.md):
 * permissionless market creation + "pick max market_id" discovery let any
 * attacker create a market at market_id = u64::MAX and permanently occupy
 * the dashboard's default "latest market" view.
 *
 * DONE-WHEN (from the audit): given [official market, attacker market with
 * market_id = u64::MAX], GET /api/market still returns the official market.
 *
 * This is a standalone assertion script, not a framework test -- the
 * dashboard has no JS test runner configured (package.json has no test
 * script/devDep). No new dependency needed: Node >= 22.6 strips TypeScript
 * types natively (--experimental-strip-types; unflagged on Node >= 23.6).
 *
 * Run from the dashboard/ directory:
 *   node --experimental-strip-types scripts/verify-discovery-pinning.mts
 *
 * To confirm this is red-capable (fails when the fix is absent), see the
 * BRAM_REPORT self_critique: reverting resolveDiscoveredMarket to always
 * scan (ignore canonicalMarketId) makes the "Codex DONE-WHEN" check below
 * fail, because the attacker's higher market_id (u64::MAX) wins the max-id
 * scan even when it shares our canonical mint.
 */
import { strict as assert } from "node:assert";
import { PublicKey } from "@solana/web3.js";
import {
  decodeMarket,
  hasCanonicalMint,
  parseCanonicalMarketId,
  refusesUnpinnedProduction,
  resolveDiscoveredMarket,
  selectCanonicalMarket,
  CANONICAL_USDC_MINT,
  MARKET_DISCRIMINATOR,
  type CandidateAccount,
} from "../src/lib/pari.ts";

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL: ${name}`);
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Synthetic Market account buffers ───────────────────────────────────────
// Byte offsets mirror decodeMarket()'s read sequence exactly (see
// src/lib/pari.ts): disc(0-8) market_id(8-16) fixture_id(16-24)
// epoch_day(24-26) stat_a_key(26-30) stat_b_key tag(30) op tag(35)
// threshold(37-41) comparison(41) yes_pool(42-50) no_pool(50-58)
// usdc_mint(58-90) vault(90-122) lock_ts(122-130) locked(130) resolved(131)
// outcome tag(132) bump(134).

const CANONICAL_MINT_BYTES = new PublicKey(CANONICAL_USDC_MINT).toBytes();
const ATTACKER_MINT_BYTES = Buffer.from(CANONICAL_MINT_BYTES);
ATTACKER_MINT_BYTES[0] ^= 0xff; // guaranteed different 32 bytes, no Keypair needed

function buildMarketBuffer(opts: {
  marketId: bigint;
  usdcMint: Uint8Array;
  badDiscriminator?: boolean;
}): Buffer {
  const buf = Buffer.alloc(144);
  const disc = opts.badDiscriminator
    ? MARKET_DISCRIMINATOR.map((b) => (b + 1) & 0xff)
    : MARKET_DISCRIMINATOR;
  Buffer.from(disc).copy(buf, 0);
  buf.writeBigUInt64LE(opts.marketId, 8); // market_id
  buf.writeBigInt64LE(18172379n, 16); // fixture_id (real demo fixture)
  buf.writeUInt16LE(1, 24); // epoch_day
  buf.writeUInt32LE(1, 26); // stat_a_key (home goals)
  buf.writeUInt8(0, 30); // stat_b_key tag: None
  buf.writeUInt8(0, 35); // op tag: None
  buf.writeInt32LE(1, 37); // predicate.threshold
  buf.writeUInt8(0, 41); // predicate.comparison: GreaterThan
  buf.writeBigUInt64LE(1_000_000n, 42); // yes_pool
  buf.writeBigUInt64LE(1_000_000n, 50); // no_pool
  Buffer.from(opts.usdcMint).copy(buf, 58); // usdc_mint
  // vault (90-122) left zeroed -- unused by these assertions
  buf.writeBigInt64LE(0n, 122); // lock_ts
  buf.writeUInt8(0, 130); // locked
  buf.writeUInt8(0, 131); // resolved
  buf.writeUInt8(0, 132); // outcome tag: None
  buf.writeUInt8(7, 134); // bump
  return buf;
}

const OFFICIAL_MARKET_ID = 42n;
const ATTACKER_MARKET_ID = 18446744073709551615n; // u64::MAX

const officialBuf = buildMarketBuffer({
  marketId: OFFICIAL_MARKET_ID,
  usdcMint: CANONICAL_MINT_BYTES,
});
const officialCandidate: CandidateAccount = {
  pubkey: "Officia1PdaAddressGoesHere111111111111111111",
  data: officialBuf,
};

// Attacker uses OUR canonical mint (per audit: mint filter alone does NOT
// stop this) -- the pinned path must still ignore it completely.
const attackerBufSameMint = buildMarketBuffer({
  marketId: ATTACKER_MARKET_ID,
  usdcMint: CANONICAL_MINT_BYTES,
});
const attackerCandidateSameMint: CandidateAccount = {
  pubkey: "Attacker1PdaAddressSameMint11111111111111111",
  data: attackerBufSameMint,
};

// Attacker uses an arbitrary (non-canonical) mint -- the fallback filter
// rejects this one on mint grounds alone.
const attackerBufOtherMint = buildMarketBuffer({
  marketId: ATTACKER_MARKET_ID,
  usdcMint: ATTACKER_MINT_BYTES,
});
const attackerCandidateOtherMint: CandidateAccount = {
  pubkey: "Attacker2PdaAddressOtherMint1111111111111111",
  data: attackerBufOtherMint,
};

// ── 1. parseCanonicalMarketId ───────────────────────────────────────────────
check("parseCanonicalMarketId: unset/blank -> null", () => {
  assert.equal(parseCanonicalMarketId(undefined), null);
  assert.equal(parseCanonicalMarketId(""), null);
  assert.equal(parseCanonicalMarketId("   "), null);
});
check("parseCanonicalMarketId: set -> bigint", () => {
  assert.equal(parseCanonicalMarketId("42"), 42n);
  assert.equal(parseCanonicalMarketId("  42  "), 42n);
});

// ── 2. decodeMarket discriminator guard (closes Codex P2 decoder finding) ──
check("decodeMarket: rejects mismatched account discriminator", () => {
  const badBuf = buildMarketBuffer({
    marketId: 1n,
    usdcMint: CANONICAL_MINT_BYTES,
    badDiscriminator: true,
  });
  assert.throws(() => decodeMarket(badBuf));
});
check("decodeMarket: accepts a valid discriminator", () => {
  const d = decodeMarket(officialBuf);
  assert.equal(d.marketId, OFFICIAL_MARKET_ID.toString());
});

// ── 3. hasCanonicalMint ──────────────────────────────────────────────────────
check("hasCanonicalMint: true for the canonical mint's bytes", () => {
  assert.equal(hasCanonicalMint(officialBuf), true);
});
check("hasCanonicalMint: false for a different mint's bytes", () => {
  assert.equal(hasCanonicalMint(attackerBufOtherMint), false);
});

// ── 4. selectCanonicalMarket (fallback scan, defense-in-depth only) ────────
check("selectCanonicalMarket: filters out a non-canonical-mint attacker", () => {
  const best = selectCanonicalMarket([officialCandidate, attackerCandidateOtherMint]);
  assert.ok(best);
  assert.equal(best!.decoded.marketId, OFFICIAL_MARKET_ID.toString());
});
check(
  "selectCanonicalMarket: KNOWN LIMITATION -- a same-mint attacker still wins the max-id scan (documents why CANONICAL_MARKET_ID pinning, not the mint filter, is the real guarantee)",
  () => {
    const best = selectCanonicalMarket([officialCandidate, attackerCandidateSameMint]);
    assert.ok(best);
    assert.equal(best!.decoded.marketId, ATTACKER_MARKET_ID.toString());
  },
);

// ── 5. resolveDiscoveredMarket -- THE CODEX DONE-WHEN CHECK ────────────────
check(
  "resolveDiscoveredMarket: CANONICAL_MARKET_ID pinned -> official wins, attacker's u64::MAX market is never consulted (Codex DONE-WHEN)",
  () => {
    const result = resolveDiscoveredMarket(
      OFFICIAL_MARKET_ID,
      officialCandidate,
      [officialCandidate, attackerCandidateSameMint, attackerCandidateOtherMint],
    );
    assert.ok(result);
    assert.equal(result!.decoded.marketId, OFFICIAL_MARKET_ID.toString());
    assert.notEqual(result!.decoded.marketId, ATTACKER_MARKET_ID.toString());
    assert.equal(result!.source, "pinned");
  },
);
check(
  "resolveDiscoveredMarket: CANONICAL_MARKET_ID unset -> falls back to the filtered scan (local dev only)",
  () => {
    const result = resolveDiscoveredMarket(null, null, [
      officialCandidate,
      attackerCandidateOtherMint,
    ]);
    assert.ok(result);
    assert.equal(result!.decoded.marketId, OFFICIAL_MARKET_ID.toString());
    assert.equal(result!.source, "scan");
  },
);
check(
  "resolveDiscoveredMarket: pinned id set but account not found -> null (never silently falls back to scanning)",
  () => {
    const result = resolveDiscoveredMarket(OFFICIAL_MARKET_ID, null, [
      attackerCandidateSameMint,
    ]);
    assert.equal(result, null);
  },
);

// ── 6. refusesUnpinnedProduction (AR-518 self-critique close: a Vercel
//    production deploy that never actually set CANONICAL_MARKET_ID must
//    refuse the unpinned scan, not silently fall back to it) ──────────────
check("refusesUnpinnedProduction: true on production with no pin", () => {
  assert.equal(refusesUnpinnedProduction("production", null), true);
});
check("refusesUnpinnedProduction: false on production once pinned", () => {
  assert.equal(refusesUnpinnedProduction("production", OFFICIAL_MARKET_ID), false);
});
check("refusesUnpinnedProduction: false on local dev / preview with no pin", () => {
  assert.equal(refusesUnpinnedProduction(undefined, null), false);
  assert.equal(refusesUnpinnedProduction("preview", null), false);
});

console.log(
  failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
