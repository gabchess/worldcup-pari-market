"use client";

/**
 * Claim UI (T4, S194 continuation): reuses <TxButton>. Renders nothing
 * unless the connected wallet has an eligible position -- a losing position
 * (story 10) or an already-claimed one simply shows no control at all.
 *
 * Eligibility mirrors instructions/claim_payout.rs's Accounts-struct
 * constraint exactly: winner-only, OR'd with the empty-winning-pool refund
 * case (every position refunds when nobody backed the resolved outcome).
 * The two cases are mutually exclusive by construction -- a winning
 * position's side IS the outcome, so its pool can't be the empty one (it
 * contains that position's own nonzero deposit).
 *
 * Deliberately does NOT re-fetch the position after a successful claim: the
 * TxButton's "confirmed" phase (label: "Claimed") is the terminal state the
 * brief asks for, and it should stay visible, not vanish the instant the
 * position flips to claimed=true. `onClaimed` only refreshes the parent's
 * market/timeline view, not this component's own position snapshot.
 */
import { useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { TxButton } from "./TxButton";
import { buildClaimPayoutInstruction, positionPda } from "@/lib/instructions";
import { findAssociatedTokenAddress } from "@/lib/token";
import { decodePosition, type DecodedPosition } from "@/lib/position";

interface ClaimPanelProps {
  marketAddress: string;
  usdcMint: string;
  resolved: boolean;
  outcome: boolean | null;
  yesPool: string;
  noPool: string;
  onClaimed: () => void;
}

export function ClaimPanel({
  marketAddress,
  usdcMint,
  resolved,
  outcome,
  yesPool,
  noPool,
  onClaimed,
}: ClaimPanelProps) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [position, setPosition] = useState<DecodedPosition | null>(null);
  const [loading, setLoading] = useState(true);

  const marketPk = useMemo(() => new PublicKey(marketAddress), [marketAddress]);
  const mintPk = useMemo(() => new PublicKey(usdcMint), [usdcMint]);
  const bettorUsdc = useMemo(
    () => (publicKey ? findAssociatedTokenAddress(publicKey, mintPk) : null),
    [publicKey, mintPk],
  );

  // Reset the fetched position SYNCHRONOUSLY during render on publicKey
  // change (Kent B1 fix) -- same pattern as DepositPanel/TxButton: compare
  // against a rendered "previous pubkey" state var and setState in the
  // render body, so a stale position from a previous wallet can never paint
  // even for one frame before the effect below re-fetches. The early-return
  // below already treats `!position` as "nothing eligible to show yet".
  const currentPubkey = publicKey?.toBase58() ?? null;
  const [renderedPubkey, setRenderedPubkey] = useState(currentPubkey);
  if (currentPubkey !== renderedPubkey) {
    setRenderedPubkey(currentPubkey);
    setPosition(null);
  }

  useEffect(() => {
    if (!publicKey || !resolved) {
      setPosition(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      const [posAddr] = positionPda(marketPk, publicKey);
      const info = await connection.getAccountInfo(posAddr);
      if (cancelled) return;
      setPosition(info ? decodePosition(info.data) : null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicKey?.toBase58(), marketAddress, resolved]);

  if (
    !publicKey ||
    !bettorUsdc ||
    !resolved ||
    loading ||
    !position ||
    position.claimed
  ) {
    return null;
  }

  const winningPoolEmpty =
    outcome !== null &&
    ((outcome === true && BigInt(yesPool) === 0n) ||
      (outcome === false && BigInt(noPool) === 0n));
  const isWinner = outcome !== null && position.side === outcome;
  const isRefund = winningPoolEmpty && !isWinner;
  const eligible = isWinner || isRefund;

  if (!eligible) return null; // losing side, winning pool non-empty -- story 10

  return (
    <section className="card-panel-greek" aria-label="Claim">
      <p className="panel-title">{isWinner ? "Claim Winnings" : "Refund"}</p>
      <TxButton
        idleLabel={isWinner ? "Claim winnings" : "Refund"}
        confirmedLabel="Claimed"
        buildInstruction={() =>
          buildClaimPayoutInstruction({
            market: marketPk,
            bettor: publicKey,
            bettorUsdc,
          })
        }
        onConfirmed={onClaimed}
      />
    </section>
  );
}
