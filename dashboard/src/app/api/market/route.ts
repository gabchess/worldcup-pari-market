/**
 * M5 pari-market live view: server-side devnet RPC reads only. No caching
 * (dynamic = "force-dynamic") so every poll reflects current chain state.
 *
 * GET /api/market            -> discover latest market via getProgramAccounts,
 *                                decode + return it plus its tx timeline.
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
  marketSeedBuffer,
  decodeMarket,
  matchDiscriminator,
  decodeDepositArgs,
  labelTx,
  DecodedMarket,
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
      // Discover: getProgramAccounts filtered to the fixed 144-byte Market
      // account size, decode all, pick the max market_id.
      const accounts = await connection.getProgramAccounts(programId, {
        filters: [{ dataSize: MARKET_ACCOUNT_SIZE }],
      });
      if (accounts.length === 0) {
        return NextResponse.json(
          {
            error:
              "No market accounts found via getProgramAccounts (dataSize 144)",
          },
          { status: 404 },
        );
      }
      let best: { pubkey: PublicKey; decoded: DecodedMarket } | null = null;
      for (const acc of accounts) {
        const d = decodeMarket(acc.account.data);
        if (!best || BigInt(d.marketId) > BigInt(best.decoded.marketId)) {
          best = { pubkey: acc.pubkey, decoded: d };
        }
      }
      marketAddr = best!.pubkey;
      decoded = best!.decoded;
    }

    const timeline = await buildTimeline(connection, marketAddr);

    return NextResponse.json({
      marketAddress: marketAddr.toBase58(),
      market: decoded,
      timeline,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
