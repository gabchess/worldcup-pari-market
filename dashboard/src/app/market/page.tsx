"use client";

import { useEffect, useState } from "react";

const PARI_PROGRAM_ID = "565SYmLeQ64r8kNujRpVhnfGgAybQrXz72knMyUj1xc3";
const EXPLORER_ADDR = (addr: string) =>
  `https://explorer.solana.com/address/${addr}?cluster=devnet`;
const EXPLORER_TX = (sig: string) =>
  `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

const STAT_KEY_DICTIONARY: Record<number, string> = {
  1: "home goals",
  2: "away goals",
};
const COMPARISON_SYMBOL: Record<string, string> = {
  GreaterThan: ">",
  LessThan: "<",
  EqualTo: "=",
};
const BINARY_EXPR_SYMBOL: Record<string, string> = {
  Add: "+",
  Subtract: "−",
};

interface DecodedMarket {
  marketId: string;
  fixtureId: string;
  epochDay: number;
  statAKey: number;
  statBKey: number | null;
  op: string | null;
  predicate: { threshold: number; comparison: string };
  yesPool: string;
  noPool: string;
  usdcMint: string;
  vault: string;
  lockTs: string;
  locked: boolean;
  resolved: boolean;
  outcome: boolean | null;
  bump: number;
}

interface TimelineEntry {
  signature: string;
  label: string;
  blockTime: number | null;
  detail?: { side: boolean; amount: string };
}

interface MarketApiResponse {
  marketAddress: string;
  market: DecodedMarket;
  timeline: TimelineEntry[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Middle-truncate a long string: first8…last8 (matches page.tsx's helper). */
function truncateMiddle(s: string, chars = 8): string {
  if (s.length <= chars * 2 + 1) return s;
  return `${s.slice(0, chars)}…${s.slice(-chars)}`;
}

function relativeTime(unixSeconds: number | null): string {
  if (unixSeconds === null) return "pending";
  const diff = Date.now() - unixSeconds * 1000;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatUsdc(rawBaseUnits: string): string {
  const n = Number(BigInt(rawBaseUnits)) / 1e6;
  return n.toFixed(2);
}

function renderPredicate(market: DecodedMarket): string {
  const statA =
    STAT_KEY_DICTIONARY[market.statAKey] ?? `stat ${market.statAKey}`;
  let lhs = statA;
  if (market.statBKey !== null && market.op !== null) {
    const statB =
      STAT_KEY_DICTIONARY[market.statBKey] ?? `stat ${market.statBKey}`;
    lhs = `${statA} ${BINARY_EXPR_SYMBOL[market.op] ?? market.op} ${statB}`;
  }
  const symbol =
    COMPARISON_SYMBOL[market.predicate.comparison] ??
    market.predicate.comparison;
  return `${lhs} ${symbol} ${market.predicate.threshold}`;
}

// Fixture display metadata (S180-reopen addendum-1, receipt fidelity). Team
// names + final score are DISPLAY DATA, not on-chain state -- the program
// only stores fixture_id + the predicate it proved, never raw stat values.
// Copy, not shared import, matching this file's self-contained pattern (see
// header comment on the pari-client copy above).
interface FixtureDisplayEntry {
  label: string;
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

/** Human fixture reference line, e.g. "USA vs Bosnia & Herzegovina · 2–0".
 * Falls back to the raw fixture_id when not in the static display map. */
function renderFixtureReference(market: DecodedMarket): string {
  const entry = FIXTURE_DISPLAY[market.fixtureId];
  if (!entry) return `fixture ${market.fixtureId}`;
  return `${entry.label} · ${entry.homeGoals}–${entry.awayGoals}`;
}

/** Proved stat values + predicate evaluation, e.g. "home goals 2 − away
 * goals 0 = 2 > 1 → TRUE". Returns null pre-resolve or when the fixture has
 * no display entry (no stat values to show without fabricating a number). */
function renderStatValues(market: DecodedMarket): string | null {
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
    combined = `${statAName} ${statAValue} ${
      BINARY_EXPR_SYMBOL[market.op] ?? market.op
    } ${statBName} ${statBValue}`;
    result =
      market.op === "Add" ? statAValue + statBValue : statAValue - statBValue;
  }

  const symbol =
    COMPARISON_SYMBOL[market.predicate.comparison] ??
    market.predicate.comparison;
  return `${combined} = ${result} ${symbol} ${market.predicate.threshold} → ${
    market.outcome ? "TRUE" : "FALSE"
  }`;
}

function statusOf(market: DecodedMarket): "OPEN" | "LOCKED" | "RESOLVED" {
  if (market.resolved) return "RESOLVED";
  if (market.locked) return "LOCKED";
  return "OPEN";
}

// Meander SVG — identical pattern to the bot page (copy, not shared import,
// per SCOPE: bot page stays untouched and this is a self-contained view).
function MeanderSvg() {
  return (
    <svg
      className="meander-strip"
      xmlns="http://www.w3.org/2000/svg"
      height="8"
      preserveAspectRatio="xMidYMid repeat"
      aria-hidden="true"
    >
      <defs>
        <pattern
          id="meander-market"
          x="0"
          y="0"
          width="20"
          height="8"
          patternUnits="userSpaceOnUse"
        >
          <path
            d="M0 7 L0 1 L6 1 L6 4 L3 4 L3 7 L13 7 L13 4 L10 4 L10 1 L20 1"
            fill="none"
            stroke="oklch(0.619 0.01 100.1 / 0.35)"
            strokeWidth="1"
          />
        </pattern>
      </defs>
      <rect width="100%" height="8" fill="url(#meander-market)" />
    </svg>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function MarketPage() {
  const [data, setData] = useState<MarketApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("id");
    const url = id ? `/api/market?id=${encodeURIComponent(id)}` : "/api/market";

    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch(url, { cache: "no-store" });
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(json.error ?? `HTTP ${res.status}`);
          return;
        }
        setError(null);
        setData(json as MarketApiResponse);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    }

    poll();
    const interval = setInterval(poll, 2500);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const market = data?.market ?? null;
  const status = market ? statusOf(market) : null;

  const yesPool = market ? Number(BigInt(market.yesPool)) : 0;
  const noPool = market ? Number(BigInt(market.noPool)) : 0;
  const totalPool = yesPool + noPool;
  const yesPct = totalPool > 0 ? (yesPool / totalPool) * 100 : 50;
  const noPct = totalPool > 0 ? 100 - yesPct : 50;
  const impliedDisplay = totalPool > 0 ? `${yesPct.toFixed(1)}%` : "—";

  return (
    <div className="container">
      {/* Header */}
      <header className="page-header">
        <h1>World Cup Pari-Market</h1>
        <div className="header-right">
          {status === "OPEN" && (
            <span className="badge-live" aria-label="Market open">
              <span className="pulse-wrap" aria-hidden="true">
                <span className="pulse-ring" />
                <span className="pulse-dot" />
              </span>
              Open
            </span>
          )}
          {status === "LOCKED" && (
            <span className="status-badge status-badge-locked">Locked</span>
          )}
          {status === "RESOLVED" && (
            <span className="status-badge status-badge-resolved">Resolved</span>
          )}
          <a
            href={EXPLORER_ADDR(PARI_PROGRAM_ID)}
            target="_blank"
            rel="noopener noreferrer"
            className="program-id-link mono"
            title={PARI_PROGRAM_ID}
          >
            {truncateMiddle(PARI_PROGRAM_ID)}
          </a>
          <span className="pill-devnet">devnet</span>
        </div>
      </header>

      <MeanderSvg />

      {error && (
        <div className="card-panel-greek" role="alert">
          <p className="panel-title">Error</p>
          <p className="trace-prose">{error}</p>
        </div>
      )}

      {market && (
        <>
          {/* Pool hero card */}
          <div className="hero-card">
            <div className="hero-grid">
              <div className="hero-col">
                <span className="hero-label">Yes Pool</span>
                <span className="num hero-number-secondary">
                  {formatUsdc(market.yesPool)}
                </span>
              </div>
              <div className="hero-col">
                <span className="hero-label">Yes Implied</span>
                <span className="num hero-number-primary">
                  {impliedDisplay}
                </span>
              </div>
              <div className="hero-col">
                <span className="hero-label">No Pool</span>
                <span className="num hero-number-secondary">
                  {formatUsdc(market.noPool)}
                </span>
              </div>
            </div>

            {/* Ratio bar */}
            <div
              className="ratio-bar"
              role="img"
              aria-label={`Yes ${yesPct.toFixed(1)}%, No ${noPct.toFixed(1)}%`}
            >
              <div
                className={`ratio-bar-segment ratio-bar-yes${
                  totalPool === 0 ? " ratio-bar-empty" : ""
                }`}
                style={{ width: `${totalPool > 0 ? yesPct : 50}%` }}
              />
              <div
                className={`ratio-bar-segment ratio-bar-no${
                  totalPool === 0 ? " ratio-bar-empty" : ""
                }`}
                style={{ width: `${totalPool > 0 ? noPct : 50}%` }}
              />
            </div>
          </div>

          {/* Pill facts row */}
          <div className="pill-row" role="list" aria-label="Market facts">
            <span className="pill-chip" role="listitem">
              fixture <span className="num">{market.fixtureId}</span>
            </span>
            <span className="pill-chip" role="listitem">
              {renderPredicate(market)}
            </span>
            <span className="pill-chip" role="listitem">
              lock {new Date(Number(market.lockTs) * 1000).toLocaleString()}
            </span>
            <span className="pill-chip" role="listitem">
              market <span className="num">{market.marketId}</span>
            </span>
            <span className="pill-chip" role="listitem">
              devnet
            </span>
          </div>

          {/* Tx timeline panel */}
          <section
            className="card-panel-greek"
            aria-label="Transaction timeline"
          >
            <p className="panel-title">Transaction Timeline</p>
            {data && data.timeline.length === 0 ? (
              <div className="empty-state">No transactions yet.</div>
            ) : (
              data?.timeline.map((entry) => (
                <div key={entry.signature} className="timeline-row">
                  <span className="field-label mono">
                    {relativeTime(entry.blockTime)}
                  </span>
                  <span className="badge-side">{entry.label}</span>
                  {entry.detail && (
                    <span className="field-value num">
                      {entry.detail.side ? "YES" : "NO"}{" "}
                      {formatUsdc(entry.detail.amount)}
                    </span>
                  )}
                  <a
                    href={EXPLORER_TX(entry.signature)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="tx-hash mono"
                    title={entry.signature}
                  >
                    {truncateMiddle(entry.signature)}
                  </a>
                </div>
              ))
            )}
          </section>

          {/* Resolution receipt — conditional */}
          {market.resolved && (
            <section
              className="card-panel-greek receipt-panel"
              aria-label="Resolution receipt"
            >
              <p className="panel-title">Resolution Receipt</p>
              <div className="receipt-header-row">
                <p className="receipt-winner num">
                  {market.outcome ? "YES WINS" : "NO WINS"}
                </p>
                <span className="badge-proof-verified">Proof Verified</span>
              </div>
              <p className="receipt-fixture-caption">fixture reference</p>
              <p className="trace-prose">{renderFixtureReference(market)}</p>
              {renderStatValues(market) && (
                <p className="trace-prose">{renderStatValues(market)}</p>
              )}
              <p className="trace-prose">
                {renderPredicate(market)} resolved{" "}
                {market.outcome ? "TRUE" : "FALSE"} via txoracle validate_stat
                CPI.
              </p>
              <div className="field-row">
                <span className="field-label">Total pot</span>
                <span className="field-value num">
                  {formatUsdc(
                    (BigInt(market.yesPool) + BigInt(market.noPool)).toString(),
                  )}{" "}
                  USDC
                </span>
              </div>
              <div className="field-row">
                <span className="field-label">Winning pool</span>
                <span className="field-value num">
                  {formatUsdc(market.outcome ? market.yesPool : market.noPool)}{" "}
                  USDC
                </span>
              </div>
              <p className="pnl-disclaimer">
                Winners split{" "}
                <span className="num">
                  {formatUsdc(
                    (BigInt(market.yesPool) + BigInt(market.noPool)).toString(),
                  )}{" "}
                  USDC
                </span>{" "}
                pro-rata against the winning pool.
              </p>
              {data?.timeline
                .filter((e) => e.label === "RESOLVE" || e.label === "CLAIM")
                .map((e) => (
                  <div key={e.signature} className="field-row">
                    <span className="field-label">{e.label}</span>
                    <a
                      href={EXPLORER_TX(e.signature)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="tx-hash mono"
                      title={e.signature}
                    >
                      {truncateMiddle(e.signature)}
                    </a>
                  </div>
                ))}
            </section>
          )}
        </>
      )}

      {!market && !error && (
        <div className="card-panel-greek">
          <div className="empty-state">Loading market…</div>
        </div>
      )}
    </div>
  );
}
