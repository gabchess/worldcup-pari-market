/**
 * TxLINE client.
 *
 * Auth flow (live mode):
 *   1. POST /auth/guest/start  → Bearer JWT
 *   2. POST /api/token/activate  → X-Api-Token
 *      Body: {txSig, walletSignature (base64 Ed25519 over txSig bytes), leagues:[]}
 *      Dual header on data endpoints: Authorization:Bearer jwt + X-Api-Token:apiToken
 *
 * C12: token/activate CONFIRMED WORKING with leagues:[] (not ["world_cup"]).
 * Prior HTTP 500 was caused by leagues:["world_cup"] payload.
 *
 * When useFixture:true, all data methods return from fixture.json (offline mode).
 */

import {
  GuestAuthResponse,
  TokenActivateRequest,
  TokenActivateResponse,
  FixturesSnapshot,
  OddsSnapshot,
  ScoresSnapshot,
} from "./types";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

const API_BASE = "https://txline-dev.txodds.com";
const FIXTURE_PATH = path.join(__dirname, "fixture.json");

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type Headers = Record<string, string>;

/** HTTP error carrying the response status code. */
export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

function authHeaders(jwt: string, apiToken?: string): Headers {
  const h: Headers = { "Content-Type": "application/json" };
  if (jwt) h["Authorization"] = `Bearer ${jwt}`;
  if (apiToken) h["X-Api-Token"] = apiToken;
  return h;
}

async function apiGet<T>(url: string, headers: Headers): Promise<T> {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new HttpError(res.status, `GET ${url} → HTTP ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

async function apiPost<T>(
  url: string,
  headers: Headers,
  body: unknown
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HttpError(
      res.status,
      `POST ${url} → HTTP ${res.status}: ${text}`
    );
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Fixture loader (offline mode)
// ---------------------------------------------------------------------------

interface FixtureFile {
  fixtures: FixturesSnapshot;
  scores: Record<number, ScoresSnapshot>;
  odds: Record<number, OddsSnapshot>;
}

// ---------------------------------------------------------------------------
// TxLineClient
// ---------------------------------------------------------------------------

export interface TxLineClientOptions {
  /** When true, all data methods return from fixture.json. Default: true (blocked). */
  useFixture?: boolean;
}

export class TxLineClient {
  private jwt = "";
  private apiToken = "";
  private readonly useFixture: boolean;
  // ponytail: cache parsed fixture to avoid 4 reads/tick; invalidate on restart
  private fixture: FixtureFile | null = null;

  constructor(opts: TxLineClientOptions = {}) {
    // ponytail: default useFixture=true until token/activate HTTP 500 is resolved
    this.useFixture = opts.useFixture ?? true;
  }

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  /**
   * Step 1: obtain a guest JWT from /auth/guest/start.
   * Returns the JWT; also caches it internally.
   */
  async guestStart(): Promise<string> {
    const data = await apiPost<GuestAuthResponse>(
      `${API_BASE}/auth/guest/start`,
      { "Content-Type": "application/json" },
      {}
    );
    this.jwt = data.token;
    return this.jwt;
  }

  /**
   * Step 2: exchange on-chain txSig for an X-Api-Token.
   * C12: CONFIRMED WORKING with leagues:[] (empty, not ["world_cup"]).
   * Populates this.apiToken and returns it.
   */
  async activateToken(req: TokenActivateRequest): Promise<string> {
    // activate returns the raw apiToken as text/plain (e.g. "txoracle_api_<32hex>"),
    // NOT JSON — res.json() throws "Unexpected token". Read as text.
    const res = await fetch(`${API_BASE}/api/token/activate`, {
      method: "POST",
      headers: authHeaders(this.jwt),
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new HttpError(
        res.status,
        `POST /api/token/activate → HTTP ${res.status}: ${errText}`
      );
    }
    this.apiToken = (await res.text()).trim();
    return this.apiToken;
  }

  /**
   * Full live auth in one call.
   * Reads the base58-encoded Solana private key at point-of-use; never logs it.
   * Signs txSig bytes with Ed25519 → base64 walletSignature for token/activate.
   *
   * @param txSig   - on-chain subscribe tx signature (base58)
   * @param privKeyB58 - Solana keypair private key (64-byte base58: seed‖pubkey)
   */
  async liveAuth(txSig: string, privKeyB58: string): Promise<void> {
    // Sign txSig bytes with Ed25519 (Node crypto, no external dep needed)
    // Solana keypair: 64 bytes, first 32 = seed
    const bs58 = require("bs58") as { decode: (s: string) => Uint8Array };
    const keyBytes = Buffer.from(bs58.decode(privKeyB58));
    const seed = keyBytes.slice(0, 32);
    // PKCS8 DER header for Ed25519 private key: 302e020100300506032b657004220420
    const derPrefix = Buffer.from("302e020100300506032b657004220420", "hex");
    const privKey = crypto.createPrivateKey({
      key: Buffer.concat([derPrefix, seed]),
      format: "der",
      type: "pkcs8",
    });

    // Guest JWT must be obtained FIRST: the signed message is `txSig::jwt`
    // (confirmed working format per schema-spike-live.json meta.messageFormat).
    // Signing txSig alone → HTTP 403 "payload was tampered with".
    await this.guestStart();
    const message = `${txSig}::${this.jwt}`;
    const walletSignature = crypto
      .sign(null, Buffer.from(message, "utf8"), privKey)
      .toString("base64");

    await this.activateToken({ txSig, walletSignature, leagues: [] });
  }

  /**
   * GET /api/odds/validation — Merkle proof for a specific odds message.
   * Returns 404 on devnet for future fixtures (expected).
   */
  async oddsValidation(messageId: string, ts: number): Promise<unknown> {
    return apiGet<unknown>(
      `${API_BASE}/api/odds/validation?messageId=${encodeURIComponent(
        messageId
      )}&ts=${ts}`,
      authHeaders(this.jwt, this.apiToken)
    );
  }

  /** Raw GET /api/fixtures/snapshot (no epochDay path segment) — live TxLINE schema */
  async rawFixturesSnapshot(): Promise<unknown> {
    return apiGet<unknown>(
      `${API_BASE}/api/fixtures/snapshot`,
      authHeaders(this.jwt, this.apiToken)
    );
  }

  // -------------------------------------------------------------------------
  // Fixture helpers
  // -------------------------------------------------------------------------

  private loadFixture(): FixtureFile {
    // ponytail: lazy-init once per process lifetime; no cache-bust needed (fixture is static)
    this.fixture ??= JSON.parse(
      fs.readFileSync(FIXTURE_PATH, "utf-8")
    ) as FixtureFile;
    return this.fixture;
  }

  private fixtureFor<T>(
    store: "scores" | "odds",
    fixtureId: number,
    label: string
  ): T {
    const val = this.loadFixture()[store][fixtureId] as T | undefined;
    if (!val)
      throw new Error(`Fixture has no ${label} for fixtureId ${fixtureId}`);
    return val;
  }

  // -------------------------------------------------------------------------
  // Data methods — live vs fixture branching
  // -------------------------------------------------------------------------

  /** GET /api/fixtures/snapshot/{epochDay} or /latest */
  async fixturesSnapshot(
    epochDay: number | "latest"
  ): Promise<FixturesSnapshot> {
    if (this.useFixture) {
      return this.loadFixture().fixtures;
    }
    return apiGet<FixturesSnapshot>(
      `${API_BASE}/api/fixtures/snapshot/${epochDay}`,
      authHeaders(this.jwt, this.apiToken)
    );
  }

  /** GET /api/scores/snapshot/{fixtureId} */
  async scoresSnapshot(fixtureId: number): Promise<ScoresSnapshot> {
    if (this.useFixture) {
      return this.fixtureFor<ScoresSnapshot>("scores", fixtureId, "scores");
    }
    return apiGet<ScoresSnapshot>(
      `${API_BASE}/api/scores/snapshot/${fixtureId}`,
      authHeaders(this.jwt, this.apiToken)
    );
  }

  /** GET /api/odds/snapshot/{fixtureId} */
  async oddsSnapshot(fixtureId: number): Promise<OddsSnapshot> {
    if (this.useFixture) {
      return this.fixtureFor<OddsSnapshot>("odds", fixtureId, "odds");
    }
    return apiGet<OddsSnapshot>(
      `${API_BASE}/api/odds/snapshot/${fixtureId}`,
      authHeaders(this.jwt, this.apiToken)
    );
  }
}
