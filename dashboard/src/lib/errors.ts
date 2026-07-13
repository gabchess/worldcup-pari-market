/**
 * Program-error -> friendly-message translation for <TxButton>. Matches by
 * Anchor's error variant name first (the string
 * Anchor prints in program logs as "Error Code: <Name>"), falling back to
 * the program's own #[msg("...")] text when present in the logs, and
 * finally to the raw error message.
 *
 * Variant list + numbering mirrors programs/pari-market/src/errors.rs
 * exactly (base 6000 + declaration order); only the variants this dashboard
 * can actually surface (deposit + claim_payout paths) get a friendly
 * override here; resolve()/init_market() variants are operator-side,
 * never user-facing in this UI.
 */

const PROGRAM_ERROR_MESSAGES: Record<string, string> = {
  MarketLocked: "This market is locked. Deposits are no longer accepted.",
  DepositAfterLock:
    "The market's lock time has passed. Deposits are no longer accepted.",
  SideMismatch: "You already have a position on the other side of this market.",
  ZeroAmount: "Deposit amount must be greater than zero.",
  AlreadyClaimed: "This position has already been claimed.",
  LosingPosition:
    "This position lost and the winning pool isn't empty -- nothing to claim.",
  MarketNotResolved: "This market hasn't resolved yet.",
};

/** Best-effort extraction of whatever text a wallet-adapter / web3.js
 * send/confirm error carries -- `.message`, plus `.logs` if the error came
 * from a simulated transaction (SendTransactionError-shaped errors carry a
 * `logs: string[]` array with the on-chain program's own log lines). */
function extractRawText(err: unknown): string {
  if (err && typeof err === "object") {
    const anyErr = err as { message?: unknown; logs?: unknown };
    const message = typeof anyErr.message === "string" ? anyErr.message : "";
    const logs = Array.isArray(anyErr.logs)
      ? anyErr.logs.filter((l): l is string => typeof l === "string").join("\n")
      : "";
    return `${message}\n${logs}`;
  }
  return String(err ?? "");
}

/** Translates a deposit/claim_payout transaction error into a friendly,
 * user-facing inline message. Never throws -- always returns a string. */
export function translateProgramError(err: unknown): string {
  const raw = extractRawText(err);

  for (const [name, friendly] of Object.entries(PROGRAM_ERROR_MESSAGES)) {
    if (raw.includes(name)) return friendly;
  }

  const logMsgMatch = raw.match(/Error Message: ([^\n.]+)\.?/);
  if (logMsgMatch) return logMsgMatch[1].trim();

  if (raw.trim().length > 0) {
    // First non-empty line of whatever the underlying error gave us --
    // avoids dumping a full program-log dump into the inline error UI.
    const firstLine = raw.split("\n").find((l) => l.trim().length > 0);
    if (firstLine) return firstLine.trim();
  }

  return "Transaction failed.";
}
