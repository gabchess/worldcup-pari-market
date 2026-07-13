"use client";

/**
 * Reusable tx-sending state-machine button.
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
import { useRef, useState } from "react";
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
  // `lastValidBlockHeight` is carried so the "check status" action (below)
  // can prove the original blockhash provably expired without landing --
  // never resent on nothing more than "the client stopped waiting".
  // `checking` gates a status check already in flight (button stays
  // disabled) so a double-click can't fire two overlapping status reads.
  | {
      phase: "timeout";
      signature: string;
      lastValidBlockHeight: number;
      checking?: boolean;
    }
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
  // Generation counter (P1-2 fix, AR-mandated wallet-switch/disconnect
  // guard): bumped every time the connected wallet changes. `run()` and
  // `checkStatus()` capture the generation at entry and re-check it after
  // every await; a mismatch means the wallet changed mid-flight, so the
  // resumed code silently abandons (no setState, no onConfirmed) instead of
  // committing a stale wallet's result on top of the new wallet's UI.
  const generationRef = useRef(0);
  if (currentPubkey !== renderedPubkey) {
    generationRef.current += 1;
    setRenderedPubkey(currentPubkey);
    setState({ phase: "idle" });
  }

  // Single-flight lock for checkStatus() (Kent-gate finding 2). A useRef
  // mutation is synchronous and immediately visible to the very next call,
  // unlike `state.checking`, which only reflects reality after React
  // commits -- two clicks batched into the same commit would both read the
  // pre-update `state.checking`. See checkStatus() below for the guard.
  const checkingRef = useRef(false);

  const busy =
    state.phase === "signing" ||
    state.phase === "pending" ||
    (state.phase === "timeout" && state.checking === true);
  const terminal = state.phase === "confirmed";

  async function run() {
    if (!publicKey) return;
    const generation = generationRef.current;
    setState({ phase: "signing" });

    let blockhash: string;
    let lastValidBlockHeight: number;
    try {
      ({ blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash("confirmed"));
    } catch (err) {
      if (generationRef.current !== generation) return;
      setState({ phase: "failed", message: translateProgramError(err) });
      return;
    }
    if (generationRef.current !== generation) return;

    const tx = new Transaction({
      recentBlockhash: blockhash,
      feePayer: publicKey,
    }).add(buildInstruction());

    let signature: string;
    try {
      signature = await sendTransaction(tx, connection);
    } catch (err) {
      if (generationRef.current !== generation) return;
      if (isUserRejection(err)) {
        setState({ phase: "rejected" });
      } else if (isBlockhashExpired(err)) {
        setState({ phase: "expired-blockhash" });
      } else {
        setState({ phase: "failed", message: translateProgramError(err) });
      }
      return;
    }
    if (generationRef.current !== generation) return;

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
      if (generationRef.current !== generation) return;

      if (confirmation === "timeout") {
        setState({ phase: "timeout", signature, lastValidBlockHeight });
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
      if (generationRef.current !== generation) return;
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

  // P1-1 fix: the timeout phase's primary action is a STATUS CHECK of the
  // original signature, never a resend. A fresh send (via `run()`) is only
  // reachable once the original signature is PROVEN dead: either it landed
  // with an on-chain error, or its blockhash provably expired without ever
  // landing (current block height has passed `lastValidBlockHeight`).
  // Anything else -- not found yet, but blockhash still technically valid,
  // or an RPC hiccup on the status read itself -- keeps the user in
  // "timeout" with the original signature still displayed.
  //
  // Kent-gate finding 2: `state.checking` alone is a render-timed guard --
  // two clicks batched into the same React commit (e.g. two DOM click
  // events dispatched before React flushes the first `setState`) would both
  // read the same stale `state.checking === false` and both pass. The
  // `disabled` attribute covers the common case, but a ref mutation is
  // synchronous and visible to the very next call regardless of render
  // timing, so `checkingRef` is the actual single-flight lock; `disabled`
  // is belt-and-suspenders on top of it.
  async function checkStatus() {
    if (state.phase !== "timeout" || checkingRef.current) return;
    checkingRef.current = true;
    const { signature, lastValidBlockHeight } = state;
    const generation = generationRef.current;
    setState({
      phase: "timeout",
      signature,
      lastValidBlockHeight,
      checking: true,
    });

    try {
      const [statusResult, currentBlockHeight] = await Promise.all([
        connection.getSignatureStatuses([signature], {
          searchTransactionHistory: true,
        }),
        connection.getBlockHeight("confirmed"),
      ]);
      if (generationRef.current !== generation) return;

      const status = statusResult.value[0];

      if (status) {
        if (status.err) {
          setState({
            phase: "failed",
            message: translateProgramError(status.err),
            signature,
          });
          return;
        }
        const landed =
          status.confirmationStatus === "confirmed" ||
          status.confirmationStatus === "finalized";
        if (landed) {
          setState({ phase: "confirmed", signature });
          onConfirmed?.(signature);
          return;
        }
        // Found but not yet at "confirmed" commitment (e.g. still
        // "processed") -- still might land, keep waiting.
        setState({
          phase: "timeout",
          signature,
          lastValidBlockHeight,
          checking: false,
        });
        return;
      }

      // No status found by the RPC. Only a provably-expired blockhash
      // permits a fresh send; otherwise the signature may still land.
      if (currentBlockHeight > lastValidBlockHeight) {
        setState({ phase: "expired-blockhash" });
        return;
      }
      setState({
        phase: "timeout",
        signature,
        lastValidBlockHeight,
        checking: false,
      });
    } catch {
      if (generationRef.current !== generation) return;
      // A transient RPC failure on the status read is not proof of
      // anything -- never treat it as license for a fresh send.
      setState({
        phase: "timeout",
        signature,
        lastValidBlockHeight,
        checking: false,
      });
    } finally {
      // Runs on every exit path (early returns above and the catch block),
      // so the lock never survives past its own call.
      checkingRef.current = false;
    }
  }

  function handleClick() {
    if (disabled || !publicKey) return;
    if (state.phase === "timeout") {
      if (state.checking) return;
      void checkStatus();
      return;
    }
    if (busy || terminal) return;
    void run();
  }

  let label = idleLabel;
  if (state.phase === "signing") label = "Approve in wallet…";
  else if (state.phase === "pending") label = "Confirming…";
  else if (state.phase === "timeout")
    label = state.checking
      ? "Checking status…"
      : "Still confirming. Click to check status.";
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
