/**
 * TxLINE typed schema.
 * Source: @srivtx/sports-workbench dist/client/txline.js (npm 2026-06-26)
 *         + schema-spike.json (C1 decision artifact).
 *
 * DEFERRED fields: exact scores-endpoint field names are unconfirmed — live call
 * blocked by token/activate HTTP 500. Field names are inferred; swap in confirmed
 * names on the first authenticated call.
 */

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** Response from POST /auth/guest/start — ES256 JWT, role=guest, 30d expiry */
export interface GuestAuthResponse {
  token: string; // Bearer JWT
}

/** Request body for POST /api/token/activate */
export interface TokenActivateRequest {
  txSig: string;
  walletSignature: string; // base64 NaCl Ed25519 over the txSig bytes
  leagues: string[];
}

/** Response from POST /api/token/activate (when not 500) */
export interface TokenActivateResponse {
  apiToken: string; // X-Api-Token value
}

// ---------------------------------------------------------------------------
// Fixtures snapshot  (/api/fixtures/snapshot/{epochDay} or /latest)
// ---------------------------------------------------------------------------

export interface FixtureEntry {
  fixtureId: number;
  homeTeam: string;
  awayTeam: string;
  startTime: number; // unix ms
  leagueId?: string;
  status?: string;
}

export type FixturesSnapshot = FixtureEntry[];

// ---------------------------------------------------------------------------
// Odds object  (confirmed fields from oddsObjectFields in schema-spike.json)
// ---------------------------------------------------------------------------

export interface OddsObject {
  MessageId: string;
  Ts: number; // unix ms
  FixtureId: number;
  Bookmaker: string;
  BookmakerId?: number;
  SuperOddsType?: string;
  InRunning: boolean; // live-match gate: only act when true
  PriceNames?: string[]; // selection labels, e.g. ["home","draw","away"]
  Prices: number[]; // decimal odds per selection
  Pct?: number; // market overround percentage
}

// ---------------------------------------------------------------------------
// Odds snapshot   (/api/odds/snapshot/{fixtureId})
// ---------------------------------------------------------------------------

export type OddsSnapshot = OddsObject[];

// ---------------------------------------------------------------------------
// Scores snapshot  (/api/scores/snapshot/{fixtureId})
//
// DEFERRED — exact field names NOT confirmed from live call.
// Using inferred names from C2 signal-set-lock.md. Swap on first live call.
// ---------------------------------------------------------------------------

export interface ScoresSnapshot {
  fixtureId: number;
  /** DEFERRED: inferred field name; may differ on live API */
  home_score?: number;
  /** DEFERRED: inferred field name; may differ on live API */
  away_score?: number;
  /** DEFERRED: inferred field name; may differ on live API (currentMinute, matchMinute, etc.) */
  current_minute?: number;
  /** DEFERRED: inferred field name; may differ on live API */
  home_red_cards?: number;
  /** DEFERRED: inferred field name; may differ on live API */
  away_red_cards?: number;
  /** Any additional fields returned by the live API */
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Merkle proof  (/api/odds/validation?messageId={id}&ts={ms})
// ---------------------------------------------------------------------------

export interface MerkleProofNode {
  hash: string; // hex string
  isRightSibling: boolean;
}

export interface OddsValidationResponse {
  summary: {
    fixtureId: number;
    oddsSubTreeRoot: string; // 0x-prefixed hex
    updateStats?: Record<string, unknown>;
  };
  subTreeProof: MerkleProofNode[];
  mainTreeProof: MerkleProofNode[];
  odds: OddsObject[];
}

// ---------------------------------------------------------------------------
// Normalised MatchState  (output of the poll loop → consumed by C2 signals)
// ---------------------------------------------------------------------------

export interface MatchState {
  fixtureId: number;
  timestamp: number; // unix ms, when this state was captured
  isLive: boolean; // InRunning flag from odds object

  // Score fields — DEFERRED until live API call confirms field names
  homeScore: number | null; // null = DEFERRED
  awayScore: number | null; // null = DEFERRED
  scoreDifferential: number | null; // home − away; null when either score is null

  // Time field — DEFERRED
  currentMinute: number | null; // null = DEFERRED
  matchPhase: number | null; // 1–7 bucket; null when minute is null

  // Card field — DEFERRED
  homeRedCards: number | null; // null = DEFERRED
  awayRedCards: number | null; // null = DEFERRED
  redCardDelta: number | null; // home − away; null when either is null

  // Odds (confirmed fields)
  prices: number[]; // decimal odds array from best odds object
  pct: number | null; // market overround

  // Raw snapshots for downstream consumers
  rawOdds: OddsObject | null;
  rawScores: ScoresSnapshot | null;
}
