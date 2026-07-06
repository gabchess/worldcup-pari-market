/**
 * C12 live capture script.
 *
 * Authenticates against TxLINE devnet, fetches all World Cup fixtures,
 * captures scores + odds for the live/most-recent match, and writes
 * ~/.arcana/c12-live-capture.json.
 *
 * READ-ONLY. No bets, no on-chain writes.
 *
 * Usage:
 *   WALLET_KEY_B58=<base58_privkey> TX_SIG=<devnet_txSig> npx ts-node live-capture.ts
 *
 * Or with path-based credential loading (default, reads from WALLET_KEY_PATH):
 *   npx ts-node live-capture.ts
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { TxLineClient } from "./txline-client";

// ---------------------------------------------------------------------------
// Credential loading (read at point-of-use, never logged)
// ---------------------------------------------------------------------------

/** Parse base58 private key and txSig from the devnet wallet secrets file. */
function loadWalletCreds(): { privKeyB58: string; txSig: string } {
  // Allow env override for CI / non-interactive use
  if (process.env["WALLET_KEY_B58"] && process.env["TX_SIG"]) {
    return {
      privKeyB58: process.env["WALLET_KEY_B58"],
      txSig: process.env["TX_SIG"],
    };
  }

  // Default: parse from the secrets file (path only, no logging of values)
  const walletPath = path.join(
    os.homedir(),
    "secrets",
    "solana-worldcup-devnet-wallet.md"
  );
  const content = fs.readFileSync(walletPath, "utf-8");

  const keyMatch = content.match(/private key\s*=\s*(\S+)/i);
  if (!keyMatch)
    throw new Error("Could not parse private key from wallet file");
  const privKeyB58 = keyMatch[1];

  // Prefer fresh txSig from c12-subscribe.json (written by subscribe-fresh.ts).
  // Fall back to the stale schema-spike-live.json meta.txSig.
  const freshPath = path.join(os.homedir(), ".arcana", "c12-subscribe.json");
  let txSig: string;
  if (fs.existsSync(freshPath)) {
    const fresh = JSON.parse(fs.readFileSync(freshPath, "utf-8")) as {
      txSig: string;
    };
    txSig = fresh.txSig;
  } else {
    const spikePath = path.join(
      os.homedir(),
      ".arcana",
      "schema-spike-live.json"
    );
    const spike = JSON.parse(fs.readFileSync(spikePath, "utf-8")) as {
      meta: { txSig: string };
    };
    txSig = spike.meta.txSig;
  }

  return { privKeyB58, txSig };
}

// ---------------------------------------------------------------------------
// Raw TxLINE fixture type (actual live schema — differs from FixtureEntry)
// ---------------------------------------------------------------------------

interface LiveFixture {
  FixtureId: number;
  Participant1: string;
  Participant2: string;
  StartTime: number; // unix ms
  Competition: string;
  CompetitionId: number;
  FixtureGroupId: number;
  Participant1Id: number;
  Participant2Id: number;
  Participant1IsHome: boolean;
  Ts?: number;
}

// ---------------------------------------------------------------------------
// Main capture
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const captureAt = new Date().toISOString();
  console.log(`C12 live capture starting at ${captureAt}`);

  // Load credentials at point-of-use (never log values)
  const { privKeyB58, txSig } = loadWalletCreds();
  console.log("Credentials loaded. Authenticating...");

  const client = new TxLineClient({ useFixture: false });
  await client.liveAuth(txSig, privKeyB58);
  console.log("Auth complete (jwt + apiToken obtained).");

  // Fetch fixtures
  console.log("Fetching /api/fixtures/snapshot ...");
  const rawFixtures = (await client.rawFixturesSnapshot()) as LiveFixture[];
  console.log(`  Received ${rawFixtures.length} fixtures.`);

  const nowMs = Date.now();

  // Identify live vs upcoming fixtures
  // "Live" = StartTime in the past and within ~150 min window
  const LIVE_WINDOW_MS = 150 * 60 * 1000;
  const liveFixtures = rawFixtures.filter(
    (f) => f.StartTime <= nowMs && nowMs - f.StartTime < LIVE_WINDOW_MS
  );
  const targetFixture =
    liveFixtures.length > 0
      ? // Most recently started live fixture
        liveFixtures.reduce((a, b) => (a.StartTime > b.StartTime ? a : b))
      : // No live match — take the most recently started one (for proof structure)
        rawFixtures
          .filter((f) => f.StartTime <= nowMs)
          .reduce(
            (a, b) => (a.StartTime > b.StartTime ? a : b),
            rawFixtures[0]
          );

  const isLiveMatch = liveFixtures.length > 0;
  console.log(
    `  Target fixture: ${targetFixture?.Participant1} vs ${targetFixture?.Participant2} ` +
      `(FixtureId=${targetFixture?.FixtureId}, live=${isLiveMatch})`
  );

  // Fetch scores and odds for target fixture
  console.log(
    `Fetching scores + odds for FixtureId=${targetFixture.FixtureId} ...`
  );
  const [rawScores, rawOdds] = await Promise.all([
    client.scoresSnapshot(targetFixture.FixtureId).catch((e: Error) => ({
      _error: e.message,
    })),
    client.oddsSnapshot(targetFixture.FixtureId).catch((e: Error) => ({
      _error: e.message,
    })),
  ]);

  // Attempt Merkle proof for the first odds message (will 404 on devnet for future fixtures)
  let merkleProof: unknown = null;
  const oddsArray = Array.isArray(rawOdds) ? rawOdds : [];
  const firstOdds = oddsArray[0] as
    | { MessageId?: string; Ts?: number }
    | undefined;
  if (firstOdds?.MessageId && firstOdds?.Ts) {
    console.log(`  Fetching Merkle proof for MessageId=${firstOdds.MessageId}`);
    merkleProof = await client
      .oddsValidation(firstOdds.MessageId, firstOdds.Ts)
      .catch((e: Error) => ({
        _error: e.message,
        _note: "404 expected on devnet for non-active batch",
      }));
  }

  // ---------------------------------------------------------------------------
  // Extract from nested live score schema:
  //   Score.Participant1.Total.{Goals,YellowCards,RedCards,Corners}
  //   Score.Participant2.Total.{...}
  //   Clock.Seconds → minutes
  //   Data → latest match event
  // ---------------------------------------------------------------------------
  interface ParticipantTotal {
    Goals?: number;
    YellowCards?: number;
    RedCards?: number;
    Corners?: number;
  }
  interface LiveScoreEntry {
    FixtureId?: number;
    Clock?: { Running?: boolean; Seconds?: number };
    Score?: {
      Participant1?: { Total?: ParticipantTotal };
      Participant2?: { Total?: ParticipantTotal };
    };
    Data?: unknown;
  }

  const scoresObj = rawScores as Record<string, unknown>;
  const hasScores =
    Array.isArray(rawScores) && (rawScores as unknown[]).length > 0;

  // Find the score entry matching our target fixture (search all, not just [0])
  let liveEntry: LiveScoreEntry | null = null;
  if (Array.isArray(rawScores)) {
    for (const entry of rawScores as LiveScoreEntry[]) {
      if (entry.FixtureId === targetFixture.FixtureId) {
        liveEntry = entry;
        break;
      }
    }
    if (!liveEntry && (rawScores as unknown[]).length > 0) {
      // Fallback: first entry (for single-match captures)
      liveEntry = (rawScores as LiveScoreEntry[])[0] ?? null;
    }
  }

  // Derive extracted fields from nested Score.ParticipantN.Total
  const p1Total = liveEntry?.Score?.Participant1?.Total ?? null;
  const p2Total = liveEntry?.Score?.Participant2?.Total ?? null;
  const clockSeconds = liveEntry?.Clock?.Seconds ?? null;
  const clockMinutes =
    clockSeconds !== null ? Math.floor(clockSeconds / 60) : null;
  const latestEvent = liveEntry?.Data ?? null;

  // Classify each field: POPULATED (value present, even if 0), ABSENT (key missing), or N_A
  function fieldStatus(
    total: ParticipantTotal | null,
    field: keyof ParticipantTotal
  ): "POPULATED" | "ABSENT" | "N_A" {
    if (total === null) return "N_A";
    return field in total ? "POPULATED" : "ABSENT";
  }

  const deferredFieldsStatus = {
    // Goals: England scored 1
    P1_Goals: fieldStatus(p1Total, "Goals"),
    P2_Goals: fieldStatus(p2Total, "Goals"),
    // YellowCards: both sides had 1
    P1_YellowCards: fieldStatus(p1Total, "YellowCards"),
    P2_YellowCards: fieldStatus(p2Total, "YellowCards"),
    // RedCards: absent means none occurred (0 is omitted from payload)
    P1_RedCards: fieldStatus(p1Total, "RedCards"),
    P2_RedCards: fieldStatus(p2Total, "RedCards"),
    // Extracted values
    p1Total,
    p2Total,
    clockMinutes,
    latestEvent,
  };

  // Check InRunning flag from odds
  const inRunning = oddsArray.some(
    (o: unknown) => (o as { InRunning?: boolean }).InRunning === true
  );

  // Build capture artifact
  const merklePresent =
    merkleProof !== null && !(merkleProof as Record<string, unknown>)["_error"];

  const capture = {
    summary: {
      capturedAt: captureAt,
      targetFixture: {
        fixtureId: targetFixture.FixtureId,
        homeTeam: targetFixture.Participant1,
        awayTeam: targetFixture.Participant2,
        startTime: targetFixture.StartTime,
        minutesElapsed: Math.floor((nowMs - targetFixture.StartTime) / 60000),
      },
      liveMatchFound: isLiveMatch,
      inRunningFlag: inRunning,
      scoresEndpointStatus: hasScores
        ? "data_present"
        : Array.isArray(rawScores) && (rawScores as unknown[]).length === 0
        ? "empty_array_200_ok"
        : "_error" in scoresObj
        ? `error: ${scoresObj["_error"]}`
        : "unknown",
      deferredFieldsStatus,
      merkleProofPresent: merklePresent,
      merkleNote: merklePresent
        ? "Merkle proof obtained and present in rawMerkleProof"
        : "404 expected on devnet for non-active batch msgIds",
      oddsCount: oddsArray.length,
    },
    rawFixtures,
    rawScores,
    rawOdds,
    rawMerkleProof: merkleProof,
  };

  // Write artifact
  const outPath = path.join(os.homedir(), ".arcana", "c12-live-capture.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(capture, null, 2), "utf-8");
  console.log(`\nCapture written to ${outPath}`);
  console.log("Summary:", JSON.stringify(capture.summary, null, 2));
}

main().catch((err) => {
  console.error(
    "live-capture failed:",
    err instanceof Error ? err.message : err
  );
  process.exit(1);
});
