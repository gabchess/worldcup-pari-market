"use client";

import { useCallback, useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import {
  explorerAddr as EXPLORER_ADDR,
  explorerTx as EXPLORER_TX,
} from "@/lib/explorer";
import type { DecodedMarket } from "@/lib/pari";
import {
  BINARY_EXPR_SYMBOL,
  COMPARISON_SYMBOL,
  FIXTURE_DISPLAY,
  STAT_KEY_DICTIONARY,
  formatUsdc,
  renderFixtureLabel,
  renderFixtureReference,
  renderMarketQuestion,
  renderPredicate,
} from "@/lib/market-display";
import { DepositPanel } from "./DepositPanel";
import { ClaimPanel } from "./ClaimPanel";

const PARI_PROGRAM_ID = "565SYmLeQ64r8kNujRpVhnfGgAybQrXz72knMyUj1xc3";

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

// Wallet connect/disconnect pill. Wraps
// the real <WalletMultiButton /> (connect modal, dropdown, disconnect --
// none of that is reimplemented here) but overrides its label with our own
// truncateMiddle() once connected, since the library's own default (4/4
// truncation) doesn't match the rest of the page's 8/8 pattern. Restyled to
// a pill via the .wallet-pill-wrap descendant selector in globals.css --
// WalletMultiButton always sets its OWN className internally
// ("wallet-adapter-button-trigger"), so a className prop can't reach it;
// wrapping is the only styling hook available.
function WalletPill() {
  const { publicKey } = useWallet();
  // Mono only for the truncated pubkey; the default "Select Wallet" label
  // stays on the page's body font (C4).
  const className = publicKey
    ? "wallet-pill-wrap wallet-pill-connected"
    : "wallet-pill-wrap";
  return (
    <span className={className}>
      <WalletMultiButton>
        {publicKey ? truncateMiddle(publicKey.toBase58()) : undefined}
      </WalletMultiButton>
    </span>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function MarketPage() {
  const [data, setData] = useState<MarketApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Lifted to component scope (useCallback, not just an effect-local
  // closure) so DepositPanel/ClaimPanel can force an immediate refetch right
  // after a deposit/claim confirms -- "new tx must appear in the
  // Transaction Timeline within one poll cycle" means don't wait up to
  // 2.5s for the next interval tick when we already know state changed.
  const fetchMarket = useCallback(async () => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("id");
    const url = id ? `/api/market?id=${encodeURIComponent(id)}` : "/api/market";
    try {
      const res = await fetch(url, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      setError(null);
      setData(json as MarketApiResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (!cancelled) void fetchMarket();
    };
    tick();
    const interval = setInterval(tick, 2500);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [fetchMarket]);

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
        <a className="page-title-link" href="/">
          <h1>World Cup Pari-Market</h1>
        </a>
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
          <a
            href="https://github.com/gabchess/worldcup-pari-market/blob/main/docs/SECURITY.md"
            target="_blank"
            rel="noopener noreferrer"
            className="pill-security"
          >
            Security notes
          </a>
          <span className="pill-devnet">devnet</span>
          <WalletPill />
        </div>
      </header>

      <MeanderSvg />

      {error && (
        <div className="card-panel-greek" role="alert">
          <p className="panel-title">Error</p>
          <p className="trace-prose">{error}</p>
        </div>
      )}

      {market && data && (
        <>
          <section className="market-context" aria-label="Market question">
            <p className="market-context-kicker">Market question</p>
            <h2>{renderFixtureLabel(market)}</h2>
            <p className="market-context-question">{renderMarketQuestion(market)}</p>
            <p className="market-context-flow">Deposit → lock → proof → claim</p>
          </section>

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
              {renderFixtureLabel(market)}
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

          {/* Deposit panel (T3) */}
          <DepositPanel
            marketAddress={data.marketAddress}
            usdcMint={market.usdcMint}
            lockTs={market.lockTs}
            locked={market.locked}
            onDeposited={fetchMarket}
          />

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

          {/* Claim panel (T4) -- renders nothing unless the connected
              wallet has an eligible unclaimed position. */}
          <ClaimPanel
            marketAddress={data.marketAddress}
            usdcMint={market.usdcMint}
            resolved={market.resolved}
            outcome={market.outcome}
            yesPool={market.yesPool}
            noPool={market.noPool}
            onClaimed={fetchMarket}
          />

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
