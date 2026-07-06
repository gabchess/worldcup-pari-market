/**
 * Normalise raw TxLINE snapshots into a MatchState object.
 *
 * Two schemas are supported:
 *
 * 1. LIVE schema (confirmed from c12-live-capture.json):
 *    Score.Participant1/2.Total.{Goals,RedCards,YellowCards,Corners}
 *    Clock.Seconds → minutes
 *    Missing keys in Total → 0 (field absent means no event occurred).
 *
 * 2. FIXTURE/FLAT schema (offline fixture.json, legacy):
 *    home_score, away_score, current_minute, home_red_cards, away_red_cards
 *
 * normalizeMatchState auto-detects the schema: if `Score` is present on the
 * ScoresSnapshot, it uses the live schema; otherwise falls back to flat.
 */

import { OddsObject, OddsSnapshot, ScoresSnapshot, MatchState } from "./types";

/**
 * Encode current_minute → match_phase bucket (1–7).
 * Returns null when minute is null.
 */
export function minuteToPhase(minute: number | null): number | null {
  if (minute === null) return null;
  if (minute <= 15) return 1;
  if (minute <= 30) return 2;
  if (minute <= 45) return 3;
  if (minute <= 60) return 4;
  if (minute <= 75) return 5;
  if (minute <= 90) return 6;
  return 7; // ET / penalties
}

/**
 * Pick the "best" odds object from a snapshot (first InRunning one, or first overall).
 */
export function bestOdds(odds: OddsSnapshot): OddsObject | null {
  if (odds.length === 0) return null;
  return odds.find((o) => o.InRunning) ?? odds[0];
}

// Internal: live-schema nested total block
interface ParticipantTotal {
  Goals?: number;
  RedCards?: number;
  YellowCards?: number;
  Corners?: number;
}

/**
 * Extract score fields from the live nested schema.
 * Absent keys in Total mean 0 (TxLINE omits fields when count is 0).
 */
function extractLiveSchema(scores: ScoresSnapshot): {
  homeScore: number | null;
  awayScore: number | null;
  minute: number | null;
  homeRed: number | null;
  awayRed: number | null;
} {
  const scoreBlock = scores["Score"] as
    | {
        Participant1?: { Total?: ParticipantTotal };
        Participant2?: { Total?: ParticipantTotal };
      }
    | undefined;

  const p1 = scoreBlock?.Participant1?.Total ?? null;
  const p2 = scoreBlock?.Participant2?.Total ?? null;

  // Goals absent = 0 (no goal yet); null only when Participant block is absent
  const homeScore = p1 !== null ? p1.Goals ?? 0 : null;
  const awayScore = p2 !== null ? p2.Goals ?? 0 : null;

  // ponytail: RedCards absent = 0 (same convention as Goals)
  const homeRed = p1 !== null ? p1.RedCards ?? 0 : null;
  const awayRed = p2 !== null ? p2.RedCards ?? 0 : null;

  const clockBlock = scores["Clock"] as
    | { Running?: boolean; Seconds?: number }
    | undefined;
  const clockSeconds =
    typeof clockBlock?.Seconds === "number" ? clockBlock.Seconds : null;
  const minute = clockSeconds !== null ? Math.floor(clockSeconds / 60) : null;

  return { homeScore, awayScore, minute, homeRed, awayRed };
}

export function normalizeMatchState(
  fixtureId: number,
  scores: ScoresSnapshot,
  odds: OddsSnapshot
): MatchState {
  const now = Date.now();
  const oddsObj = bestOdds(odds);

  // Schema auto-detection: live schema has a "Score" key with nested structure
  const isLiveSchema = "Score" in scores && scores["Score"] !== null;

  let homeScore: number | null;
  let awayScore: number | null;
  let minute: number | null;
  let homeRed: number | null;
  let awayRed: number | null;

  if (isLiveSchema) {
    ({ homeScore, awayScore, minute, homeRed, awayRed } =
      extractLiveSchema(scores));
  } else {
    // Flat/fixture schema (offline fixture.json or legacy)
    homeScore =
      typeof scores.home_score === "number" ? scores.home_score : null;
    awayScore =
      typeof scores.away_score === "number" ? scores.away_score : null;
    minute =
      typeof scores.current_minute === "number" ? scores.current_minute : null;
    homeRed =
      typeof scores.home_red_cards === "number" ? scores.home_red_cards : null;
    awayRed =
      typeof scores.away_red_cards === "number" ? scores.away_red_cards : null;
  }

  return {
    fixtureId,
    timestamp: now,
    isLive: oddsObj?.InRunning ?? false,

    homeScore,
    awayScore,
    scoreDifferential:
      homeScore !== null && awayScore !== null ? homeScore - awayScore : null,

    currentMinute: minute,
    matchPhase: minuteToPhase(minute),

    homeRedCards: homeRed,
    awayRedCards: awayRed,
    redCardDelta:
      homeRed !== null && awayRed !== null ? homeRed - awayRed : null,

    prices: oddsObj?.Prices ?? [],
    pct: oddsObj?.Pct ?? null,

    rawOdds: oddsObj,
    rawScores: scores,
  };
}
