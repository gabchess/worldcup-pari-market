/**
 * M5 pari-market live view: server-side devnet RPC reads only. No caching
 * (dynamic = "force-dynamic") so every poll reflects current chain state --
 * EXCEPT for the short in-memory response cache below, which exists purely
 * to bound RPC amplification (security review), not to serve stale
 * data on purpose. See "Amplification protection" for details.
 *
 * GET /api/market            -> resolve the default market: CANONICAL_MARKET_ID
 *                                pinned to an exact PDA if set (required in
 *                                production), else a mint-filtered scan
 *                                (local dev only) -- decode + return it plus
 *                                its tx timeline. See lib/pari.ts for why the
 *                                pin, not the mint filter, is the guarantee
 *                                against a permissionless u64::MAX market
 *                                spoofing the "latest market" slot
 *                                (security review).
 * GET /api/market?id=<id>    -> decode that specific market_id + timeline.
 *
 * Reads the Helius devnet RPC key from a server-side environment variable
 * or local credential file. The key is never sent to the client or logged.
 */
import { NextRequest, NextResponse } from "next/server";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  PARI_MARKET_PROGRAM_ID,
  CANONICAL_USDC_MINT,
  USDC_MINT_OFFSET,
  marketSeedBuffer,
  decodeMarket,
  matchDiscriminator,
  decodeDepositArgs,
  labelTx,
  parseCanonicalMarketId,
  refusesUnpinnedProduction,
  resolveDiscoveredMarket,
  DecodedMarket,
  CandidateAccount,
} from "@/lib/pari";

export const dynamic = "force-dynamic";

const MARKET_ACCOUNT_SIZE = 144;
const HELIUS_KEY_PATH = path.join(
  os.homedir(),
  "secrets",
  "helius-api-key.txt",
);

function loadHeliusRpc(): string {
  // Vercel/serverless: env var. Local dev fallback: key file outside the repo.
  const key =
    process.env.HELIUS_API_KEY?.trim() ||
    fs.readFileSync(HELIUS_KEY_PATH, "utf-8").trim();
  return `https://devnet.helius-rpc.com/?api-key=${key}`;
}

function marketPda(marketId: bigint): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    marketSeedBuffer(marketId),
    new PublicKey(PARI_MARKET_PROGRAM_ID),
  );
  return pda;
}

interface TimelineEntry {
  signature: string;
  label: string;
  blockTime: number | null;
  detail?: { side: boolean; amount: string };
}

interface MarketResponsePayload {
  marketAddress: string;
  market: DecodedMarket;
  timeline: TimelineEntry[];
  source: "pinned" | "scan" | null;
}

/**
 * Thrown for expected, already-safe-to-show error conditions (bad id,
 * missing CANONICAL_MARKET_ID, etc). Message text here is authored by us,
 * never derived from a caught exception, so it's safe to return as-is.
 */
class MarketApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Amplification protection (security review: "Public market API can
// amplify requests into Helius quota exhaustion"). The browser polls this
// route every 2.5s and, pre-fix, each request re-fetched up to 25
// transactions sequentially with zero caching -- an unauthenticated caller
// could hammer this endpoint and burn the shared Helius devnet quota.
//
// Three layers, all dependency-free (Map + Promise, no redis/rate-limit lib):
//   1. Short TTL response cache, keyed per market (default vs ?id=), so
//      repeated polls inside one TTL window cost zero RPC calls.
//   2. In-flight coalescing: concurrent requests for the same key share one
//      upstream fetch instead of each firing their own RPC calls.
//   3. A persistent immutable-tx cache keyed by signature -- a confirmed
//      transaction's contents never change, so once decoded it is never
//      refetched for the life of this serverless instance, and a cap on how
//      many *new* signatures get resolved per request bounds the worst case.
//
// ponytail: per-instance in-memory Map, not Redis/shared cache -- accepted
// for this demo because each serverless instance independently bounds its
// own RPC usage (cache resets on cold start, which is fine: worst case is
// one full-cost request per fresh instance). Upgrade path if this needs a
// cross-instance guarantee: Upstash/Redis-backed cache + counter.
const RESPONSE_CACHE_TTL_MS = 2_500; // matches the client's poll cadence
const NEW_TX_FETCH_CAP_PER_REQUEST = 10; // bounds worst-case getTransaction calls/request (max possible: 25)

interface CacheEntry {
  data: MarketResponsePayload | null;
  expiresAt: number;
  inFlight: Promise<MarketResponsePayload> | null;
}

const responseCache = new Map<string, CacheEntry>();

// ponytail: unbounded for the life of the instance -- fine at demo scale (one
// market's worth of signatures, capped at 25 per timeline). Upgrade path if
// this ever needs a size ceiling: evict oldest entries past N.
const txCache = new Map<string, TimelineEntry>();

/**
 * Serve `key` from cache if fresh, coalesce onto an in-flight fetch for the
 * same key if one is already running, or fetch fresh and cache the result.
 * Failures are never cached -- a transient RPC error should not stick around
 * for the full TTL.
 */
async function getCachedOrFetch(
  key: string,
  fetcher: () => Promise<MarketResponsePayload>,
): Promise<{ data: MarketResponsePayload; cacheStatus: string }> {
  const now = Date.now();
  const entry = responseCache.get(key);

  if (entry?.data && entry.expiresAt > now) {
    return { data: entry.data, cacheStatus: "HIT" };
  }

  if (entry?.inFlight) {
    const data = await entry.inFlight;
    return { data, cacheStatus: "HIT-COALESCED" };
  }

  const inFlight = fetcher();
  responseCache.set(key, {
    data: entry?.data ?? null,
    expiresAt: entry?.expiresAt ?? 0,
    inFlight,
  });

  try {
    const data = await inFlight;
    responseCache.set(key, {
      data,
      expiresAt: Date.now() + RESPONSE_CACHE_TTL_MS,
      inFlight: null,
    });
    return { data, cacheStatus: "MISS" };
  } catch (err) {
    // Don't cache the failure; clear inFlight so the next request retries
    // instead of awaiting a promise that already rejected.
    responseCache.set(key, {
      data: entry?.data ?? null,
      expiresAt: entry?.expiresAt ?? 0,
      inFlight: null,
    });
    throw err;
  }
}

async function buildTimeline(
  connection: Connection,
  marketAddr: PublicKey,
): Promise<TimelineEntry[]> {
  const sigInfos = await connection.getSignaturesForAddress(marketAddr, {
    limit: 25,
  });

  const entries: TimelineEntry[] = [];
  let newFetches = 0;

  for (const sigInfo of sigInfos) {
    const cached = txCache.get(sigInfo.signature);
    if (cached) {
      entries.push(cached);
      continue;
    }

    if (newFetches >= NEW_TX_FETCH_CAP_PER_REQUEST) {
      // Cap hit for this request: skip the getTransaction round-trip. The
      // persistent tx cache means this signature gets resolved (and cached
      // forever) on a later poll once the fetches ahead of it are done --
      // it is never silently dropped, only deferred.
      entries.push({
        signature: sigInfo.signature,
        label: "PENDING",
        blockTime: sigInfo.blockTime ?? null,
      });
      continue;
    }
    newFetches++;

    const tx = await connection.getTransaction(sigInfo.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx) {
      // Not found yet (e.g. not fully propagated) -- don't cache; a real
      // tx that lands late should still resolve on the next poll.
      entries.push({
        signature: sigInfo.signature,
        label: "UNKNOWN",
        blockTime: sigInfo.blockTime ?? null,
      });
      continue;
    }

    const accountKeys = tx.transaction.message.getAccountKeys({
      accountKeysFromLookups: tx.meta?.loadedAddresses,
    });
    const programIdIndex = accountKeys
      .keySegments()
      .flat()
      .findIndex((k) => k.toBase58() === PARI_MARKET_PROGRAM_ID);

    let label = "UNKNOWN";
    let detail: TimelineEntry["detail"];

    const compiledIxs = tx.transaction.message.compiledInstructions;
    for (const ix of compiledIxs) {
      if (ix.programIdIndex !== programIdIndex) continue;
      const dataBase64 = Buffer.from(ix.data).toString("base64");
      const ixName = matchDiscriminator(dataBase64);
      label = labelTx(ixName);
      if (ixName === "deposit") {
        const args = decodeDepositArgs(dataBase64);
        detail = { side: args.side, amount: args.amount.toString() };
      }
      break;
    }

    const entry: TimelineEntry = {
      signature: sigInfo.signature,
      label,
      blockTime: sigInfo.blockTime ?? null,
      detail,
    };
    // Confirmed transaction contents are immutable -- safe to cache forever.
    txCache.set(sigInfo.signature, entry);
    entries.push(entry);
  }
  return entries;
}

async function resolveMarketData(
  connection: Connection,
  programId: PublicKey,
  idParam: string | null,
): Promise<MarketResponsePayload> {
  let marketAddr: PublicKey;
  let decoded: DecodedMarket;
  // "pinned" | "scan" for the no-id discovery branch below; null for the
  // explicit ?id= branch, where there's no discovery ambiguity to report.
  // Surfaces Kent's flag: a live auditor can see straight from the response
  // whether the dashboard is in the weaker fallback-scan mode.
  let discoverySource: "pinned" | "scan" | null = null;

  if (idParam) {
    const marketId = BigInt(idParam);
    marketAddr = marketPda(marketId);
    const info = await connection.getAccountInfo(marketAddr);
    if (!info) {
      throw new MarketApiError(
        `Market account not found for id ${idParam} at ${marketAddr.toBase58()}`,
        404,
      );
    }
    decoded = decodeMarket(info.data);
  } else {
    // Discover: CANONICAL_MARKET_ID pins the dashboard's default market to
    // an exact PDA (same derivation as the ?id= branch above) so a
    // permissionless market created at market_id = u64::MAX can never
    // become the "latest market" (security review). Falls back to
    // a mint-filtered scan only when unset (local dev); production MUST
    // set CANONICAL_MARKET_ID -- see docs/ENDPOINTS.md.
    const canonicalMarketId = parseCanonicalMarketId(
      process.env.CANONICAL_MARKET_ID,
    );

    // Refuse to silently serve the weaker fallback on a real Vercel
    // production deployment that forgot to set CANONICAL_MARKET_ID --
    // documentation alone doesn't stop that deployment mistake.
    if (refusesUnpinnedProduction(process.env.VERCEL_ENV, canonicalMarketId)) {
      throw new MarketApiError(
        "CANONICAL_MARKET_ID is required on production deployments (see docs/ENDPOINTS.md) -- refusing to fall back to an unpinned scan.",
        500,
      );
    }

    let pinnedAccount: CandidateAccount | null = null;
    let scanCandidates: CandidateAccount[] = [];

    if (canonicalMarketId !== null) {
      const pinnedAddr = marketPda(canonicalMarketId);
      const info = await connection.getAccountInfo(pinnedAddr);
      if (info) {
        pinnedAccount = { pubkey: pinnedAddr.toBase58(), data: info.data };
      }
    } else {
      // Defense-in-depth fallback (local dev only): filter by the fixed
      // 144-byte Market account size AND the canonical usdc_mint before
      // decoding (decodeMarket also rejects a mismatched discriminator).
      // Does not by itself stop an attacker using our canonical mint on
      // their own market -- see the comment in lib/pari.ts.
      const accounts = await connection.getProgramAccounts(programId, {
        filters: [
          { dataSize: MARKET_ACCOUNT_SIZE },
          {
            memcmp: {
              offset: USDC_MINT_OFFSET,
              bytes: CANONICAL_USDC_MINT,
            },
          },
        ],
      });
      scanCandidates = accounts.map((acc) => ({
        pubkey: acc.pubkey.toBase58(),
        data: acc.account.data,
      }));
    }

    const result = resolveDiscoveredMarket(
      canonicalMarketId,
      pinnedAccount,
      scanCandidates,
    );
    if (!result) {
      throw new MarketApiError(
        canonicalMarketId !== null
          ? `Canonical market not found for id ${canonicalMarketId}`
          : "No canonical market accounts found via getProgramAccounts (dataSize 144, canonical mint)",
        404,
      );
    }
    marketAddr = new PublicKey(result.pubkey);
    decoded = result.decoded;
    discoverySource = result.source;
  }

  const timeline = await buildTimeline(connection, marketAddr);

  return {
    marketAddress: marketAddr.toBase58(),
    market: decoded,
    timeline,
    source: discoverySource,
  };
}

export async function GET(request: NextRequest) {
  const idParam = request.nextUrl.searchParams.get("id");
  const cacheKey = idParam ? `id:${idParam}` : "default";

  try {
    const { data, cacheStatus } = await getCachedOrFetch(cacheKey, () => {
      const connection = new Connection(loadHeliusRpc(), "confirmed");
      const programId = new PublicKey(PARI_MARKET_PROGRAM_ID);
      return resolveMarketData(connection, programId, idParam);
    });

    return NextResponse.json(data, {
      headers: { "x-cache": cacheStatus },
    });
  } catch (err) {
    if (err instanceof MarketApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    // Unexpected failure (RPC error, decode failure, etc). Log full detail
    // server-side only; the client gets a stable, non-identifying message --
    // raw err.message can leak filesystem paths, RPC provider detail, or
    // implementation internals (security review).
    console.error("[/api/market] unexpected error:", err);
    return NextResponse.json(
      {
        error: "Market data temporarily unavailable. Please try again shortly.",
      },
      { status: 500 },
    );
  }
}
