import type { DecodedMarket } from "./pari";

export const STAT_KEY_DICTIONARY: Record<number, string> = {
  1: "home goals",
  2: "away goals",
};

export const COMPARISON_SYMBOL: Record<string, string> = {
  GreaterThan: ">",
  LessThan: "<",
  EqualTo: "=",
};

export const BINARY_EXPR_SYMBOL: Record<string, string> = {
  Add: "+",
  Subtract: "−",
};

export interface FixtureDisplayEntry {
  label: string;
  homeGoals: number;
  awayGoals: number;
}

// Team names + final score are display data, not onchain state. The program
// stores the fixture ID and the predicate it proved, never raw stat values.
export const FIXTURE_DISPLAY: Record<string, FixtureDisplayEntry> = {
  "18172379": {
    label: "USA vs Bosnia & Herzegovina",
    homeGoals: 2,
    awayGoals: 0,
  },
  "18179551": { label: "Spain vs Austria", homeGoals: 2, awayGoals: 0 },
};

export function formatUsdc(rawBaseUnits: string): string {
  const n = Number(BigInt(rawBaseUnits)) / 1e6;
  return n.toFixed(2);
}

export function renderPredicate(market: DecodedMarket): string {
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

/** Human-readable fixture name without revealing the final score pre-resolve. */
export function renderFixtureLabel(market: DecodedMarket): string {
  return FIXTURE_DISPLAY[market.fixtureId]?.label ?? `fixture ${market.fixtureId}`;
}

/** Human fixture reference line, e.g. "USA vs Bosnia & Herzegovina · 2–0". */
export function renderFixtureReference(market: DecodedMarket): string {
  const entry = FIXTURE_DISPLAY[market.fixtureId];
  if (!entry) return `fixture ${market.fixtureId}`;
  return `${entry.label} · ${entry.homeGoals}–${entry.awayGoals}`;
}

/** Plain-language question for the common home-goals-minus-away-goals market. */
export function renderMarketQuestion(market: DecodedMarket): string {
  if (
    market.statAKey === 1 &&
    market.statBKey === 2 &&
    market.op === "Subtract" &&
    market.predicate.comparison === "GreaterThan"
  ) {
    const margin = market.predicate.threshold;
    return `Will the home team win by more than ${margin} goal${
      margin === 1 ? "" : "s"
    }?`;
  }
  return `Will ${renderPredicate(market)}?`;
}
