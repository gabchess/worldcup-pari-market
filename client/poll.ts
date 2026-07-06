/**
 * TxLINE poll loop.
 *
 * Usage:
 *   npm run poll                  # fixture mode (default, offline)
 *   USE_LIVE=1 npm run poll       # live mode (requires apiToken from token/activate)
 *
 * Polls all active fixtures every POLL_INTERVAL_MS (default 5000ms in live,
 * runs once in fixture mode for verifier output).
 *
 * Emits a normalised MatchState object to stdout on each tick.
 */

import { TxLineClient } from "./txline-client";
import { normalizeMatchState } from "./normalize";
import { MatchState } from "./types";

const USE_LIVE = process.env["USE_LIVE"] === "1";
// ponytail: parseInt("") → NaN; NaN || 5000 gives the sane default;
// Math.max(1000, ...) prevents a 0ms hot loop if someone passes a tiny value in live mode
const POLL_MS = Math.max(
  1000,
  parseInt(process.env["POLL_INTERVAL_MS"] ?? "", 10) || 5000
);

// In fixture mode: run one tick then exit (for verifier / CI).
// In live mode: run until SIGINT.
const RUN_ONCE = !USE_LIVE;

async function tick(client: TxLineClient): Promise<MatchState[]> {
  const fixtures = await client.fixturesSnapshot("latest");
  const states: MatchState[] = [];

  for (const fixture of fixtures) {
    const [scores, odds] = await Promise.all([
      client.scoresSnapshot(fixture.fixtureId),
      client.oddsSnapshot(fixture.fixtureId),
    ]);

    const state = normalizeMatchState(fixture.fixtureId, scores, odds);
    states.push(state);
  }

  return states;
}

function printState(state: MatchState): void {
  console.log("\n--- MatchState ---");
  console.log(JSON.stringify(state, null, 2));

  // Human-readable summary
  const score =
    state.homeScore !== null && state.awayScore !== null
      ? `${state.homeScore}–${state.awayScore}`
      : "DEFERRED";
  const minute =
    state.currentMinute !== null ? `${state.currentMinute}'` : "DEFERRED";
  const phase =
    state.matchPhase !== null ? `phase=${state.matchPhase}` : "phase=DEFERRED";
  const cards =
    state.redCardDelta !== null
      ? `red_card_delta=${state.redCardDelta}`
      : "red_card_delta=DEFERRED";
  const liveFlag = state.isLive ? "LIVE" : "PRE-MATCH";

  console.log(
    `  [${liveFlag}] fixture=${state.fixtureId} score=${score} ` +
      `min=${minute} ${phase} ${cards} ` +
      `prices=[${state.prices.join(", ")}] pct=${state.pct}`
  );
}

async function main(): Promise<void> {
  const client = new TxLineClient({ useFixture: !USE_LIVE });

  console.log(
    `TxLINE poll loop starting. mode=${USE_LIVE ? "LIVE" : "FIXTURE"} ` +
      `interval=${POLL_MS}ms runOnce=${RUN_ONCE}`
  );

  if (USE_LIVE) {
    // Live auth flow: guestStart → activateToken
    // token/activate currently returns HTTP 500 on devnet — the error is
    // descriptive and tells you to fall back to fixture mode.
    try {
      console.log("Authenticating via /auth/guest/start...");
      await client.guestStart();
      console.log("Activating API token via /api/token/activate...");
      // NOTE: walletSignature must be a real Ed25519 sig over the txSig bytes.
      // Pass via env for live use; this path is exercised only when USE_LIVE=1.
      // C12: leagues must be [] (empty), not ["world_cup"] — confirmed fix
      await client.activateToken({
        txSig: process.env["TX_SIG"] ?? "",
        walletSignature: process.env["WALLET_SIG"] ?? "",
        leagues: [],
      });
      console.log("Auth succeeded.");
    } catch (err) {
      console.error("Auth failed:", err instanceof Error ? err.message : err);
      console.error(
        "Tip: token/activate returns HTTP 500 on devnet (known bug)."
      );
      console.error("     Run without USE_LIVE=1 to use fixture mode.");
      process.exit(1);
    }
  }

  const runTick = async (): Promise<void> => {
    try {
      const states = await tick(client);
      for (const s of states) {
        printState(s);
      }
      if (RUN_ONCE) {
        console.log("\nFixture mode: one tick complete. Exiting.");
        // Also emit a machine-readable summary line for the verifier
        const live = states.filter((s) => s.isLive);
        console.log(
          `\nVERIFIER_SUMMARY: fixtures=${states.length} live=${live.length} ` +
            `deferred_scores=${
              states.filter((s) => s.homeScore === null).length
            }`
        );
      }
    } catch (err) {
      console.error("Tick error:", err instanceof Error ? err.message : err);
      if (RUN_ONCE) process.exit(1);
    }
  };

  await runTick();

  if (!RUN_ONCE) {
    setInterval(runTick, POLL_MS);
    process.on("SIGINT", () => {
      console.log("\nStopped.");
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
