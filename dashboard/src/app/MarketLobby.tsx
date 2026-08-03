"use client";

import { useEffect, useState } from "react";
import type { DecodedMarket } from "@/lib/pari";
import {
  formatUsdc,
  renderFixtureLabel,
  renderMarketQuestion,
  renderPredicate,
} from "@/lib/market-display";

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

const PREVIEW_STAGES = [
  {
    number: "01",
    label: "OPEN",
    title: "Set the rule",
    body: "A fixture, a predicate, and a lock time define the market before deposits close.",
  },
  {
    number: "02",
    label: "LOCKED",
    title: "Follow the pool",
    body: "YES and NO liquidity stay visible while the market moves toward settlement.",
  },
  {
    number: "03",
    label: "SETTLED",
    title: "Read the proof",
    body: "The outcome, oracle check, and claim path live together in one receipt.",
  },
];

function statusLabel(market: DecodedMarket): string {
  if (market.resolved) return "RESOLVED";
  if (market.locked) return "LOCKED";
  return "OPEN";
}

function MarketLobby() {
  const [data, setData] = useState<MarketApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/market", { cache: "no-store" })
      .then(async (response) => {
        const json = await response.json();
        if (!response.ok) throw new Error(json.error ?? "Market unavailable");
        return json as MarketApiResponse;
      })
      .then((json) => {
        if (!cancelled) setData(json);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const market = data?.market ?? null;
  const yesPool = market ? Number(BigInt(market.yesPool)) : 0;
  const noPool = market ? Number(BigInt(market.noPool)) : 0;
  const totalPool = yesPool + noPool;
  const yesPct = totalPool > 0 ? (yesPool / totalPool) * 100 : 50;

  return (
    <main className="lobby-container">
      <header className="lobby-topbar">
        <a className="lobby-brand" href="/">
          <span className="lobby-brand-name">World Cup Pari-Market</span>
          <span className="lobby-brand-note">Proof-settled markets on Solana</span>
        </a>
        <div className="lobby-topbar-actions">
          <span className="pill-devnet">devnet</span>
          <a className="lobby-topbar-link" href="/market">
            Open featured market ↗
          </a>
        </div>
      </header>

      <section className="lobby-hero" aria-labelledby="lobby-title">
        <div>
          <p className="lobby-eyebrow">MARKET INDEX</p>
          <h1 id="lobby-title">Markets with rules you can check.</h1>
          <p className="lobby-hero-copy">
            Browse a market, follow its pool, and open the proof behind the
            result.
          </p>
          <p className="lobby-flow">Question → pool → proof → claim</p>
        </div>
        <div className="lobby-hero-stat" aria-label="Featured market count">
          <span className="num">{market ? "1" : "—"}</span>
          <span>featured demo</span>
        </div>
      </section>

      <section className="lobby-section" aria-labelledby="featured-heading">
        <div className="lobby-section-heading">
          <div>
            <p className="lobby-eyebrow">FEATURED MARKET</p>
            <h2 id="featured-heading">The full proof path, in one place.</h2>
          </div>
          {market && <span className="status-badge status-badge-resolved">{statusLabel(market)}</span>}
        </div>

        {error && (
          <div className="lobby-error" role="alert">
            <p>Featured market unavailable.</p>
            <span>{error}</span>
          </div>
        )}

        {!market && !error && (
          <div className="featured-market-card featured-market-card-loading">
            <span className="lobby-eyebrow">LOADING MARKET</span>
          </div>
        )}

        {market && (
          <a className="featured-market-card" href="/market">
            <div className="featured-market-copy">
              <p className="market-card-kicker">WORLD CUP · {statusLabel(market)}</p>
              <h3>{renderFixtureLabel(market)}</h3>
              <p className="featured-market-question">
                {renderMarketQuestion(market)}
              </p>
              <div className="featured-market-facts">
                <span>{renderPredicate(market)}</span>
                <span>{formatUsdc((BigInt(market.yesPool) + BigInt(market.noPool)).toString())} USDC pool</span>
                <span className="featured-market-open">Open market ↗</span>
              </div>
            </div>
            <div className="featured-market-probability">
              <span className="hero-label">YES IMPLIED</span>
              <strong className="num">{yesPct.toFixed(1)}%</strong>
              <div
                className="lobby-ratio"
                role="img"
                aria-label={`Yes ${yesPct.toFixed(1)}%, No ${(100 - yesPct).toFixed(1)}%`}
              >
                <span style={{ width: `${yesPct}%` }} />
                <span style={{ width: `${100 - yesPct}%` }} />
              </div>
              <span className="lobby-probability-note">
                {formatUsdc(market.yesPool)} YES · {formatUsdc(market.noPool)} NO
              </span>
            </div>
          </a>
        )}
      </section>

      <section className="lobby-section lobby-preview-section" aria-labelledby="preview-heading">
        <div className="lobby-section-heading lobby-section-heading-preview">
          <div>
            <p className="lobby-eyebrow">PRODUCT PREVIEW</p>
            <h2 id="preview-heading">A market set built around the same proof path.</h2>
          </div>
          <p className="lobby-section-note">
            The demo features one market. This is the surface it can grow into.
          </p>
        </div>
        <div className="lobby-preview-grid">
          {PREVIEW_STAGES.map((stage) => (
            <article className="lobby-preview-card" key={stage.number}>
              <div className="lobby-preview-meta">
                <span>{stage.label}</span>
                <span className="num">{stage.number}</span>
              </div>
              <h3>{stage.title}</h3>
              <p>{stage.body}</p>
            </article>
          ))}
        </div>
      </section>

      <footer className="lobby-footer">
        <span>One featured devnet market · public proof path</span>
        <a href="/market">View market detail ↗</a>
      </footer>
    </main>
  );
}

export default MarketLobby;
