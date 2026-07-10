/**
 * M5 pari-market live view: server-side devnet RPC reads only. No caching
 * (dynamic = "force-dynamic") so every poll reflects current chain state.
 *
 * GET /api/market            -> resolve the default market: CANONICAL_MARKET_ID
 *                                pinned to an exact PDA if set (required in
 *                                production), else a mint-filtered scan
 *                                (local dev only) -- decode + return it plus
 *                                its tx timeline. See lib/pari.ts for why the
 *                                pin, not the mint filter, is the guarantee
 *                                against a permissionless u64::MAX market
 *                                spoofing the "latest market" slot
 *                                (codex-audit-report.md P1).
 * GET /api/market?id=<id>    -> decode that specific market_id + timeline.
 *
 * Reads the Helius devnet RPC key from ~/secrets/helius-api-key.txt at point
 * of use only -- never sent to the client, never logged.
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

async function buildTimeline(
  connection: Connection,
  marketAddr: PublicKey,
): Promise<TimelineEntry[]> {
  const sigInfos = await connection.getSignaturesForAddress(marketAddr, {
    limit: 25,
  });

  const entries: TimelineEntry[] = [];
  for (const sigInfo of sigInfos) {
    const tx = await connection.getTransaction(sigInfo.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx) {
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

    entries.push({
      signature: sigInfo.signature,
      label,
      blockTime: sigInfo.blockTime ?? null,
      detail,
    });
  }
  return entries;
}

export async function GET(request: NextRequest) {
  try {
    const connection = new Connection(loadHeliusRpc(), "confirmed");
    const programId = new PublicKey(PARI_MARKET_PROGRAM_ID);
    const idParam = request.nextUrl.searchParams.get("id");

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
        return NextResponse.json(
          {
            error: `Market account not found for id ${idParam} at ${marketAddr.toBase58()}`,
          },
          { status: 404 },
        );
      }
      decoded = decodeMarket(info.data);
    } else {
      // Discover: CANONICAL_MARKET_ID pins the dashboard's default market to
      // an exact PDA (same derivation as the ?id= branch above) so a
      // permissionless market created at market_id = u64::MAX can never
      // become the "latest market" (codex-audit-report.md P1). Falls back to
      // a mint-filtered scan only when unset (local dev); production MUST
      // set CANONICAL_MARKET_ID -- see docs/ENDPOINTS.md.
      const canonicalMarketId = parseCanonicalMarketId(
        process.env.CANONICAL_MARKET_ID,
      );

      // Refuse to silently serve the weaker fallback on a real Vercel
      // production deployment that forgot to set CANONICAL_MARKET_ID --
      // documentation alone doesn't stop that deployment mistake.
      if (
        refusesUnpinnedProduction(process.env.VERCEL_ENV, canonicalMarketId)
      ) {
        return NextResponse.json(
          {
            error:
              "CANONICAL_MARKET_ID is required on production deployments (see docs/ENDPOINTS.md) -- refusing to fall back to an unpinned scan.",
          },
          { status: 500 },
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
        return NextResponse.json(
          {
            error:
              canonicalMarketId !== null
                ? `Canonical market not found for id ${canonicalMarketId}`
                : "No canonical market accounts found via getProgramAccounts (dataSize 144, canonical mint)",
          },
          { status: 404 },
        );
      }
      marketAddr = new PublicKey(result.pubkey);
      decoded = result.decoded;
      discoverySource = result.source;
    }

    const timeline = await buildTimeline(connection, marketAddr);

    return NextResponse.json({
      marketAddress: marketAddr.toBase58(),
      market: decoded,
      timeline,
      source: discoverySource,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
