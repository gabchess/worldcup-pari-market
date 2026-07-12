"use client";

/**
 * Reusable tx-sending state-machine button (T3/T4, S194 continuation).
 * ONE component, shared by DepositPanel and ClaimPanel -- not a framework,
 * just idle -> signing -> pending -> confirmed | rejected | failed, plus two
 * named edge phases (expired-blockhash, timeout) called out explicitly in
 * the brief.
 *
 * ponytail: builds a single-instruction Transaction directly (no
 * versioned-tx / lookup-table support) -- deposit and claim_payout are both
 * single-instruction, no lookup tables needed. Upgrade path: swap
 * `buildInstruction` for `buildVersionedTransaction` if a future instruction
 * needs more than one ix or a lookup table.
 */
import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  Transaction,
  TransactionExpiredBlockheightExceededError,
  TransactionInstruction,
} from "@solana/web3.js";
import { explorerTx } from "@/lib/explorer";
import { translateProgramError } from "@/lib/errors";

// How long to wait for `confirmTransaction` before treating the poll as
// timed-out (brief: "submitted signature stays visible if confirmation
// polling times out" -- this is what triggers that distinct phase).
const CONFIRM_TIMEOUT_MS = 30_000;

type TxState =
  | { phase: "idle" }
  | { phase: "signing" }
  | { phase: "pending"; signature: string }
  | { phase: "timeout"; signature: string }
  | { phase: "confirmed"; signature: string }
  | { phase: "rejected" }
  | { phase: "expired-blockhash" }
  | { phase: "failed"; message: string; signature?: string };

function isUserRejection(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /reject/i.test(message);
}

function isBlockhashExpired(err: unknown): boolean {
  if (err instanceof TransactionExpiredBlockheightExceededError) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /block height exceeded|blockhash not found/i.test(message);
}

export interface TxButtonProps {
  /** Builds the (single) instruction to send. Called fresh on every click
   * so callers always hand over their latest known accounts/amount. */
  buildInstruction: () => TransactionInstruction;
  /** Label shown in the idle state, e.g. "Deposit 10 USDC on YES". */
  idleLabel: string;
  /** Label shown once confirmed, e.g. "Deposited" / "Claimed" / "Refunded". */
  confirmedLabel: string;
  /** Disables the button entirely (preflight failed / market locked / no
   * eligible position) with an inline reason shown below it. */
  disabled?: boolean;
  disabledReason?: string | null;
  /** Called once the transaction is confirmed with no on-chain error. */
  onConfirmed?: (signature: string) => void;
}

export function TxButton({
  buildInstruction,
  idleLabel,
  confirmedLabel,
  disabled,
  disabledReason,
  onConfirmed,
}: TxButtonProps) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const [state, setState] = useState<TxState>({ phase: "idle" });

  // Reset all wallet-derived state on disconnect/account-switch (T3/T4
  // requirement; Kent B1 fix) -- done SYNCHRONOUSLY during render (React's
  // documented "adjusting state during render" pattern) rather than in a
  // useEffect, so a stale "Confirmed"/"Pending" from a previous wallet can
  // never paint even for one frame before an effect would have caught up.
  const currentPubkey = publicKey?.toBase58() ?? null;
  const [renderedPubkey, setRenderedPubkey] = useState(currentPubkey);
  if (currentPubkey !== renderedPubkey) {
    setRenderedPubkey(currentPubkey);
    setState({ phase: "idle" });
  }

  const busy = state.phase === "signing" || state.phase === "pending";
  const terminal = state.phase === "confirmed";

  async function run() {
    if (!publicKey) return;
    setState({ phase: "signing" });

    let blockhash: string;
    let lastValidBlockHeight: number;
    try {
      ({ blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash("confirmed"));
    } catch (err) {
      setState({ phase: "failed", message: translateProgramError(err) });
      return;
    }

    const tx = new Transaction({
      recentBlockhash: blockhash,
      feePayer: publicKey,
    }).add(buildInstruction());

    let signature: string;
    try {
      signature = await sendTransaction(tx, connection);
    } catch (err) {
      if (isUserRejection(err)) {
        setState({ phase: "rejected" });
      } else if (isBlockhashExpired(err)) {
        setState({ phase: "expired-blockhash" });
      } else {
        setState({ phase: "failed", message: translateProgramError(err) });
      }
      return;
    }

    setState({ phase: "pending", signature });

    try {
      const timeout = new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), CONFIRM_TIMEOUT_MS),
      );
      const confirmation = await Promise.race([
        connection.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          "confirmed",
        ),
        timeout,
      ]);

      if (confirmation === "timeout") {
        setState({ phase: "timeout", signature });
        return;
      }
      if (confirmation.value.err) {
        setState({
          phase: "failed",
          message: translateProgramError(confirmation.value.err),
          signature,
        });
        return;
      }

      setState({ phase: "confirmed", signature });
      onConfirmed?.(signature);
    } catch (err) {
      if (isBlockhashExpired(err)) {
        setState({ phase: "expired-blockhash" });
      } else {
        setState({
          phase: "failed",
          message: translateProgramError(err),
          signature,
        });
      }
    }
  }

  function handleClick() {
    if (busy || terminal || disabled || !publicKey) return;
    void run();
  }

  let label = idleLabel;
  if (state.phase === "signing") label = "Approve in wallet…";
  else if (state.phase === "pending") label = "Confirming…";
  else if (state.phase === "timeout")
    label = "Still confirming. Click to retry.";
  else if (state.phase === "confirmed") label = confirmedLabel;
  else if (state.phase === "rejected") label = "Rejected. Click to retry.";
  else if (state.phase === "expired-blockhash")
    label = "Blockhash expired. Click to retry.";
  else if (state.phase === "failed") label = `${idleLabel} (failed, retry)`;

  const signatureToShow =
    state.phase === "pending" ||
    state.phase === "timeout" ||
    state.phase === "confirmed"
      ? state.signature
      : state.phase === "failed"
        ? state.signature
        : undefined;

  return (
    <div className="tx-button-wrap">
      <button
        type="button"
        className="tx-button"
        onClick={handleClick}
        disabled={busy || terminal || disabled}
      >
        {busy && (
          // Reuses .pulse-dot/.pulse-ring (badge-live's liveness primitive)
          // for signing/pending -- no new animation vocabulary (C6).
          <span className="pulse-wrap pulse-wrap-on-tx" aria-hidden="true">
            <span className="pulse-ring" />
            <span className="pulse-dot" />
          </span>
        )}
        {label}
      </button>
      {disabled && disabledReason && (
        <p className="trace-prose tx-error-text">{disabledReason}</p>
      )}
      {state.phase === "failed" && (
        <p className="trace-prose tx-error-text">{state.message}</p>
      )}
      {signatureToShow && (
        <a
          href={explorerTx(signatureToShow)}
          target="_blank"
          rel="noopener noreferrer"
          className="tx-hash mono tx-button-sig"
        >
          {signatureToShow.slice(0, 8)}…{signatureToShow.slice(-8)}
        </a>
      )}
    </div>
  );
}
