/**
 * pari-market server-side decode + tx-labeling helpers for the M5 dashboard
 * view. Self-contained (no import from client/'s ts-node context per SCOPE) --
 * fixed-offset Borsh decoder mirroring programs/pari-market/src/market/state.rs
 * SIZE comment (144 bytes total) and the instruction discriminators copied
 * verbatim from client/pari-client.ts's IX_DISCRIMINATOR table.
 *
 * ponytail: hand-rolled decoder, no Anchor client dep in the dashboard.
 * Upgrade path: if pari-client ever ships as a publishable package with a
 * Next.js-safe entrypoint, swap this file for a thin re-export.
 */

// ── Program constants (mirrors client/pari-client.ts) ──────────────────────

export const PARI_MARKET_PROGRAM_ID =
  "565SYmLeQ64r8kNujRpVhnfGgAybQrXz72knMyUj1xc3";

const MARKET_SEED = Buffer.from("market");

// ── Shared program-account constants (Kent fix-first, S194 continuation) ──
// Hoisted here (rather than re-declared in instructions.ts) so both
// lib/pari.ts's decode helpers and lib/instructions.ts's instruction
// builders read the same single source for these well-known Solana program
// IDs. String form (not wrapped in PublicKey) to keep this file's existing
// zero-@solana/web3.js-dependency pattern; instructions.ts wraps them.
export const SPL_TOKEN_PROGRAM_ID =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

// ── Instruction discriminators (copied verbatim from client/pari-client.ts
//    IX_DISCRIMINATOR; re-copy both files together if the program is rebuilt
//    with a renamed instruction) ───────────────────────────────────────────

export type IxName =
  "init_market" | "deposit" | "lock_market" | "resolve" | "claim_payout";

export const IX_DISCRIMINATORS: Record<IxName, number[]> = {
  init_market: [33, 253, 15, 116, 89, 25, 127, 236],
  deposit: [242, 35, 198, 137, 82, 225, 242, 182],
  lock_market: [107, 8, 184, 91, 223, 13, 180, 38],
  resolve: [246, 150, 236, 206, 108, 63, 58, 10],
  claim_payout: [127, 240, 132, 62, 227, 198, 146, 133],
};

const IX_DISPLAY_LABEL: Record<IxName, string> = {
  init_market: "CREATE",
  deposit: "DEPOSIT",
  lock_market: "LOCK",
  resolve: "RESOLVE",
  claim_payout: "CLAIM",
};

/** Match the first 8 bytes of raw instruction data against the known
 * discriminator table. Returns null if no instruction on this program
 * matches (e.g. a compute-budget ix bundled in the same tx). */
export function matchDiscriminator(ixDataBase64: string): IxName | null {
  const data = Buffer.from(ixDataBase64, "base64");
  if (data.length < 8) return null;
  const prefix = Array.from(data.subarray(0, 8));
  for (const name of Object.keys(IX_DISCRIMINATORS) as IxName[]) {
    const disc = IX_DISCRIMINATORS[name];
    if (disc.every((b, i) => b === prefix[i])) return name;
  }
  return null;
}

export function labelTx(ixName: IxName | null): string {
  if (ixName === null) return "UNKNOWN";
  return IX_DISPLAY_LABEL[ixName];
}

/** Decode a deposit instruction's args (amount: u64 LE, side: bool) from
 * raw instruction data, past the 8-byte discriminator prefix. */
export function decodeDepositArgs(ixDataBase64: string): {
  amount: bigint;
  side: boolean;
} {
  const data = Buffer.from(ixDataBase64, "base64");
  const amount = data.readBigUInt64LE(8);
  const side = data.readUInt8(16) === 1;
  return { amount, side };
}

// ── Market PDA derivation (no @solana/web3.js PublicKey dependency needed
//    here since the API route does its own PublicKey.findProgramAddressSync
//    call with this seed; exported for reuse/clarity) ──────────────────────

export function marketSeedBuffer(marketId: bigint): Buffer[] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(marketId, 0);
  return [MARKET_SEED, buf];
}

// ── Market account decode (fixed Borsh offsets per state.rs SIZE comment) ──
// discriminator(8) + market_id(8) + fixture_id(8) + epoch_day(2)
// + stat_a_key(4) + stat_b_key(1 tag + 4) + op(1 tag + 1)
// + predicate(4 threshold + 1 comparison) + yes_pool(8) + no_pool(8)
// + usdc_mint(32) + vault(32) + lock_ts(8) + locked(1) + resolved(1)
// + outcome(1 tag + 1) + bump(1) = 135 bytes of real data, padded to 144.

export type Comparison = "GreaterThan" | "LessThan" | "EqualTo";
export type BinaryExpression = "Add" | "Subtract";

const COMPARISON_NAMES: Comparison[] = ["GreaterThan", "LessThan", "EqualTo"];
const BINARY_EXPR_NAMES: BinaryExpression[] = ["Add", "Subtract"];

export interface DecodedMarket {
  marketId: string; // u64, stringified (exceeds JS safe-int range)
  fixtureId: string; // i64, stringified
  epochDay: number;
  statAKey: number;
  statBKey: number | null;
  op: BinaryExpression | null;
  predicate: { threshold: number; comparison: Comparison };
  yesPool: string; // u64 raw (base units), stringified
  noPool: string; // u64 raw (base units), stringified
  usdcMint: string; // base58
  vault: string; // base58
  lockTs: string; // i64, stringified
  locked: boolean;
  resolved: boolean;
  outcome: boolean | null;
  bump: number;
}

/** base58 encode (Bitcoin alphabet), zero external deps -- for rendering the
 * 32-byte usdc_mint / vault fields as base58 pubkeys without pulling in
 * @solana/web3.js's PublicKey class inside this pure-decode module. */
const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(bytes: Buffer): string {
  let digits = [0];
  for (let n = 0; n < bytes.length; n++) {
    const byte = bytes[n];
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  // Leading zero bytes -> leading '1's
  let leadingZeros = 0;
  for (let n = 0; n < bytes.length; n++) {
    if (bytes[n] === 0) leadingZeros++;
    else break;
  }
  const out =
    "1".repeat(leadingZeros) +
    digits
      .reverse()
      .map((d) => BASE58_ALPHABET[d])
      .join("");
  return out;
}

// ── Canonical discovery guarantee (closes Codex audit P1 spoofing + P2
//    decoder findings, codex-audit-report.md 2026-07-10) ───────────────────
// The Market account carries no creator/authority field (see
// programs/pari-market/src/market/state.rs), so discovery cannot filter by
// "official creator" on-chain. Discovery is pinned instead: production sets
// CANONICAL_MARKET_ID to the exact market_id chosen at deploy time, and the
// dashboard resolves that market directly via its PDA (same derivation as
// the ?id= route) -- Anchor's `init` constraint means an attacker cannot
// occupy that PDA once it exists, so a market created at market_id =
// u64::MAX is never even looked at. selectCanonicalMarket below is a
// defense-in-depth fallback used ONLY when CANONICAL_MARKET_ID is unset
// (local dev): it filters getProgramAccounts results by the canonical
// usdc_mint and a valid Market discriminator before picking the max
// market_id. It does NOT by itself stop an attacker who sets their own
// market's usdc_mint to our canonical mint -- CANONICAL_MARKET_ID pinning is
// the real guarantee and MUST be set in production.

export const CANONICAL_USDC_MINT =
  "55aYKjhdFfHFbwuqw4wF1wToJuubFQBnmCNCfe24CXK";

/** Byte offset of the usdc_mint field within a decoded Market account (see
 * the layout comment above decodeMarket()). Reused by both the local mint
 * check below and the dashboard route's getProgramAccounts memcmp filter. */
export const USDC_MINT_OFFSET = 58;

/** sha256("account:Market")[0:8] -- Anchor's account discriminator for the
 * Market struct. Verified against programs/pari-market/src/market/state.rs
 * (struct Market) via sha256; matches exactly. */
export const MARKET_DISCRIMINATOR = [219, 190, 213, 55, 0, 227, 198, 154];

/** Position account size in bytes (T3 preflight, S194 continuation) --
 * mirrors programs/pari-market/src/position/state.rs's Position::SIZE
 * exactly (discriminator 8 + market 32 + bettor 32 + side 1 + amount 8 +
 * claimed 1 + bump 1, padded to 88). deposit()'s Position account is
 * `init_if_needed`, so a bettor's first deposit on a market must pay this
 * account's rent-exemption in addition to the base tx fee -- the deposit
 * preflight uses this to compute the minimum SOL required. */
export const POSITION_ACCOUNT_SIZE = 88;

/** Parse the CANONICAL_MARKET_ID env var. Unset/blank -> null (fallback scan
 * mode, local dev only). Set -> the pinned market_id as a bigint. */
export function parseCanonicalMarketId(
  envValue: string | undefined,
): bigint | null {
  const trimmed = envValue?.trim();
  if (!trimmed) return null;
  return BigInt(trimmed);
}

/** True iff a Vercel production deployment (VERCEL_ENV === "production")
 * would silently fall back to the unpinned defense-in-depth scan -- i.e.
 * CANONICAL_MARKET_ID is documented as required but was never actually set
 * in that deployment's environment. The route MUST refuse this case (500)
 * rather than silently serving the weaker guarantee. */
export function refusesUnpinnedProduction(
  vercelEnv: string | undefined,
  canonicalMarketId: bigint | null,
): boolean {
  return vercelEnv === "production" && canonicalMarketId === null;
}

function hasMarketDiscriminator(data: Buffer): boolean {
  if (data.length < 8) return false;
  for (let i = 0; i < 8; i++) {
    if (data[i] !== MARKET_DISCRIMINATOR[i]) return false;
  }
  return true;
}

/** True iff the account's usdc_mint field matches CANONICAL_USDC_MINT. */
export function hasCanonicalMint(data: Buffer): boolean {
  if (data.length < USDC_MINT_OFFSET + 32) return false;
  return (
    base58Encode(data.subarray(USDC_MINT_OFFSET, USDC_MINT_OFFSET + 32)) ===
    CANONICAL_USDC_MINT
  );
}

export function decodeMarket(buffer: Buffer): DecodedMarket {
  if (!hasMarketDiscriminator(buffer)) {
    throw new Error(
      "decodeMarket: account discriminator does not match Market (Codex P2 decoder guard)",
    );
  }
  let offset = 8; // skip 8-byte account discriminator

  const marketId = buffer.readBigUInt64LE(offset);
  offset += 8;
  const fixtureId = buffer.readBigInt64LE(offset);
  offset += 8;
  const epochDay = buffer.readUInt16LE(offset);
  offset += 2;
  const statAKey = buffer.readUInt32LE(offset);
  offset += 4;

  const statBKeyTag = buffer.readUInt8(offset);
  offset += 1;
  let statBKey: number | null = null;
  if (statBKeyTag === 1) {
    statBKey = buffer.readUInt32LE(offset);
  }
  offset += 4;

  const opTag = buffer.readUInt8(offset);
  offset += 1;
  let op: BinaryExpression | null = null;
  if (opTag === 1) {
    op = BINARY_EXPR_NAMES[buffer.readUInt8(offset)] ?? null;
  }
  offset += 1;

  const threshold = buffer.readInt32LE(offset);
  offset += 4;
  const comparison = COMPARISON_NAMES[buffer.readUInt8(offset)] ?? "EqualTo";
  offset += 1;

  const yesPool = buffer.readBigUInt64LE(offset);
  offset += 8;
  const noPool = buffer.readBigUInt64LE(offset);
  offset += 8;

  const usdcMint = base58Encode(buffer.subarray(offset, offset + 32));
  offset += 32;
  const vault = base58Encode(buffer.subarray(offset, offset + 32));
  offset += 32;

  const lockTs = buffer.readBigInt64LE(offset);
  offset += 8;
  const locked = buffer.readUInt8(offset) === 1;
  offset += 1;
  const resolved = buffer.readUInt8(offset) === 1;
  offset += 1;

  const outcomeTag = buffer.readUInt8(offset);
  offset += 1;
  let outcome: boolean | null = null;
  if (outcomeTag === 1) {
    outcome = buffer.readUInt8(offset) === 1;
  }
  offset += 1;

  const bump = buffer.readUInt8(offset);

  return {
    marketId: marketId.toString(),
    fixtureId: fixtureId.toString(),
    epochDay,
    statAKey,
    statBKey,
    op,
    predicate: { threshold, comparison },
    yesPool: yesPool.toString(),
    noPool: noPool.toString(),
    usdcMint,
    vault,
    lockTs: lockTs.toString(),
    locked,
    resolved,
    outcome,
    bump,
  };
}

export interface CandidateAccount {
  pubkey: string;
  data: Buffer;
}

export interface DiscoveryResult {
  pubkey: string;
  decoded: DecodedMarket;
  source: "pinned" | "scan";
}

/** Defense-in-depth fallback selection (used only when CANONICAL_MARKET_ID
 * is unset). Keeps only accounts with the canonical usdc_mint, decodes them
 * (decodeMarket rejects a mismatched discriminator), and picks the max
 * market_id among the survivors. See the module comment above decodeMarket
 * for why this alone is not the real guarantee. */
export function selectCanonicalMarket(
  candidates: CandidateAccount[],
): { pubkey: string; decoded: DecodedMarket } | null {
  let best: { pubkey: string; decoded: DecodedMarket } | null = null;
  for (const c of candidates) {
    if (!hasCanonicalMint(c.data)) continue;
    let d: DecodedMarket;
    try {
      d = decodeMarket(c.data);
    } catch {
      continue;
    }
    if (!best || BigInt(d.marketId) > BigInt(best.decoded.marketId)) {
      best = { pubkey: c.pubkey, decoded: d };
    }
  }
  return best;
}

/** The discovery decision for the GET /api/market route's no-`id` branch.
 * Pinned mode (canonicalMarketId !== null) consults ONLY the pre-fetched
 * account at marketPda(canonicalMarketId) -- scanCandidates is never looked
 * at, so an attacker's market can never win regardless of its market_id or
 * usdc_mint. Scan mode (canonicalMarketId === null, local dev only) falls
 * back to selectCanonicalMarket. */
export function resolveDiscoveredMarket(
  canonicalMarketId: bigint | null,
  pinnedAccount: CandidateAccount | null,
  scanCandidates: CandidateAccount[],
): DiscoveryResult | null {
  if (canonicalMarketId !== null) {
    if (!pinnedAccount) return null;
    return {
      pubkey: pinnedAccount.pubkey,
      decoded: decodeMarket(pinnedAccount.data),
      source: "pinned",
    };
  }
  const best = selectCanonicalMarket(scanCandidates);
  if (!best) return null;
  return { pubkey: best.pubkey, decoded: best.decoded, source: "scan" };
}

// ── Predicate → human string renderer ───────────────────────────────────────

const STAT_KEY_DICTIONARY: Record<number, string> = {
  1: "home goals",
  2: "away goals",
};

const COMPARISON_SYMBOL: Record<Comparison, string> = {
  GreaterThan: ">",
  LessThan: "<",
  EqualTo: "=",
};

const BINARY_EXPR_SYMBOL: Record<BinaryExpression, string> = {
  Add: "+",
  Subtract: "−",
};

/** Renders "home goals - away goals > 1" style predicate strings from the
 * on-chain stat keys + op + predicate, for the pill facts row. */
export function renderPredicate(market: DecodedMarket): string {
  const statA =
    STAT_KEY_DICTIONARY[market.statAKey] ?? `stat ${market.statAKey}`;
  let lhs = statA;
  if (market.statBKey !== null && market.op !== null) {
    const statB =
      STAT_KEY_DICTIONARY[market.statBKey] ?? `stat ${market.statBKey}`;
    lhs = `${statA} ${BINARY_EXPR_SYMBOL[market.op]} ${statB}`;
  }
  const symbol = COMPARISON_SYMBOL[market.predicate.comparison];
  return `${lhs} ${symbol} ${market.predicate.threshold}`;
}

// ── Fixture display metadata (S180-reopen addendum-1, receipt fidelity) ────
// Team names + final score are DISPLAY DATA, not on-chain state -- the
// program only stores fixture_id + the predicate it proved (threshold,
// comparison, resolved outcome), never the raw stat values themselves. This
// map is a small static reference lookup keyed by fixture_id so the receipt
// can show a human-legible fixture + stat-values line; both are labeled
// "fixture reference" in the UI to keep that distinction honest -- this is
// display metadata, not something the chain attests to. Add an entry here
// whenever a new record-day fixture is used (see
// video/demo-script-LOCKED-S175.md preflight primary/backup pair).

interface FixtureDisplayEntry {
  label: string; // "USA vs Bosnia & Herzegovina"
  homeGoals: number;
  awayGoals: number;
}

const FIXTURE_DISPLAY: Record<string, FixtureDisplayEntry> = {
  "18172379": {
    label: "USA vs Bosnia & Herzegovina",
    homeGoals: 2,
    awayGoals: 0,
  },
  "18179551": { label: "Spain vs Austria", homeGoals: 2, awayGoals: 0 },
};

/** Human fixture reference line for the receipt panel, e.g. "USA vs Bosnia &
 * Herzegovina · 2–0". Falls back to the raw fixture_id when the fixture
 * isn't in the static display map. */
export function renderFixtureReference(market: DecodedMarket): string {
  const entry = FIXTURE_DISPLAY[market.fixtureId];
  if (!entry) return `fixture ${market.fixtureId}`;
  return `${entry.label} · ${entry.homeGoals}–${entry.awayGoals}`;
}

/** Renders the proved stat values + predicate evaluation, e.g.
 * "home goals 2 − away goals 0 = 2 > 1 → TRUE", from the fixture display map
 * (stat key 1 = home goals, stat key 2 = away goals -- same dictionary the
 * predicate string uses) + the on-chain predicate + resolved outcome.
 * Returns null pre-resolve, or when the fixture has no display entry (no
 * stat values to show without fabricating a number). */
export function renderStatValues(market: DecodedMarket): string | null {
  if (!market.resolved || market.outcome === null) return null;
  const entry = FIXTURE_DISPLAY[market.fixtureId];
  if (!entry) return null;

  const statAName =
    STAT_KEY_DICTIONARY[market.statAKey] ?? `stat ${market.statAKey}`;
  const statAValue = market.statAKey === 2 ? entry.awayGoals : entry.homeGoals;
  let combined = `${statAName} ${statAValue}`;
  let result = statAValue;

  if (market.statBKey !== null && market.op !== null) {
    const statBName =
      STAT_KEY_DICTIONARY[market.statBKey] ?? `stat ${market.statBKey}`;
    const statBValue =
      market.statBKey === 2 ? entry.awayGoals : entry.homeGoals;
    combined = `${statAName} ${statAValue} ${BINARY_EXPR_SYMBOL[market.op]} ${statBName} ${statBValue}`;
    result =
      market.op === "Add" ? statAValue + statBValue : statAValue - statBValue;
  }

  const symbol = COMPARISON_SYMBOL[market.predicate.comparison];
  return `${combined} = ${result} ${symbol} ${market.predicate.threshold} → ${
    market.outcome ? "TRUE" : "FALSE"
  }`;
}
