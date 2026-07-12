"use client";

/**
 * Deposit UI (T3, S194 continuation): amount input + YES/NO toggle +
 * <TxButton>. Preflight-checks the bettor's wallet before enabling submit so
 * a doomed transaction never reaches the wallet (the program's own guards
 * would otherwise surface as an opaque simulation failure).
 *
 * Single source-of-truth pubkey: every derivation below (the bettor's USDC
 * ATA, the Position PDA) comes from the connected adapter `publicKey` --
 * nothing is cached from a prior connection.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { TxButton } from "./TxButton";
import { buildDepositInstruction, positionPda } from "@/lib/instructions";
import {
  decodeTokenAccountAmount,
  findAssociatedTokenAddress,
} from "@/lib/token";
import { formatUsdcAmount, parseUsdcAmount } from "@/lib/amount";
import { POSITION_ACCOUNT_SIZE } from "@/lib/pari";

// ponytail: a flat conservative estimate for the base (single-signature, no
// priority fee) transaction cost. Upgrade path: fetch a real fee estimate
// via connection.getFeeForMessage if priority fees ever get added here.
const TX_FEE_LAMPORTS = 5_000n;
const LAMPORTS_PER_SOL = 1_000_000_000;

interface DepositPanelProps {
  marketAddress: string;
  usdcMint: string;
  lockTs: string; // unix seconds, stringified i64
  locked: boolean;
  onDeposited: () => void;
}

interface PreflightState {
  loading: boolean;
  solLamports: bigint;
  usdcBalance: bigint;
  ataExists: boolean;
  minRequiredLamports: bigint;
}

const INITIAL_PREFLIGHT: PreflightState = {
  loading: true,
  solLamports: 0n,
  usdcBalance: 0n,
  ataExists: false,
  minRequiredLamports: TX_FEE_LAMPORTS,
};

export function DepositPanel({
  marketAddress,
  usdcMint,
  lockTs,
  locked,
  onDeposited,
}: DepositPanelProps) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [amountInput, setAmountInput] = useState("");
  const [side, setSide] = useState(true); // YES default
  const [preflight, setPreflight] = useState<PreflightState>(INITIAL_PREFLIGHT);

  const marketPk = useMemo(() => new PublicKey(marketAddress), [marketAddress]);
  const mintPk = useMemo(() => new PublicKey(usdcMint), [usdcMint]);
  const bettorUsdc = useMemo(
    () => (publicKey ? findAssociatedTokenAddress(publicKey, mintPk) : null),
    [publicKey, mintPk],
  );

  // Reset wallet-derived state SYNCHRONOUSLY during render on
  // publicKey/bettorUsdc change (Kent B1 fix) -- compares against a
  // rendered "previous key" state var and calls setState in the render body
  // itself (React's documented "adjusting state during render" pattern), so
  // a stale balance or amount from a previous wallet can never paint even
  // for one frame before the effect below re-fetches.
  const currentBettorKey =
    publicKey && bettorUsdc
      ? `${publicKey.toBase58()}:${bettorUsdc.toBase58()}`
      : null;
  const [renderedBettorKey, setRenderedBettorKey] = useState(currentBettorKey);
  // Generation counter (P1-2 fix): bumped every time the connected wallet
  // changes. `refreshPreflight` captures the generation at entry and
  // re-checks it after each await boundary; a mismatch means the wallet
  // changed mid-fetch, so the resumed fetch silently abandons instead of
  // committing a stale wallet's balances/rent numbers into the new wallet's
  // preflight state.
  const generationRef = useRef(0);
  if (currentBettorKey !== renderedBettorKey) {
    generationRef.current += 1;
    setRenderedBettorKey(currentBettorKey);
    setPreflight(INITIAL_PREFLIGHT);
    setAmountInput("");
  }

  async function refreshPreflight(owner: PublicKey, ata: PublicKey) {
    const generation = generationRef.current;
    setPreflight((p) => ({ ...p, loading: true }));
    const [solLamports, ataInfo, positionInfo] = await Promise.all([
      connection.getBalance(owner),
      connection.getAccountInfo(ata),
      connection.getAccountInfo(positionPda(marketPk, owner)[0]),
    ]);
    if (generationRef.current !== generation) return;
    const ataExists = ataInfo !== null;
    const usdcBalance = ataInfo ? decodeTokenAccountAmount(ataInfo.data) : 0n;
    const rentForPosition = positionInfo
      ? 0n
      : BigInt(
          await connection.getMinimumBalanceForRentExemption(
            POSITION_ACCOUNT_SIZE,
          ),
        );
    if (generationRef.current !== generation) return;
    setPreflight({
      loading: false,
      solLamports: BigInt(solLamports),
      usdcBalance,
      ataExists,
      minRequiredLamports: TX_FEE_LAMPORTS + rentForPosition,
    });
  }

  // (Re)fetch preflight data whenever the connected account changes. The
  // synchronous reset above already guarantees no stale data is visible
  // while this fetch is in flight -- this effect only owns the async part,
  // which can't run during render.
  useEffect(() => {
    if (!publicKey || !bettorUsdc) return;
    void refreshPreflight(publicKey, bettorUsdc);
    // publicKey/bettorUsdc are the only wallet-derived inputs this effect
    // needs to react to; marketPk changes are covered by the initial mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicKey?.toBase58(), bettorUsdc?.toBase58()]);

  if (!publicKey || !bettorUsdc) {
    return (
      <section className="card-panel-greek" aria-label="Deposit">
        <p className="panel-title">Deposit</p>
        <p className="trace-prose">
          Connect a wallet to deposit into this market.
        </p>
      </section>
    );
  }

  const parsed = parseUsdcAmount(amountInput);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const optimisticallyLocked = locked || nowSeconds > Number(lockTs);

  function computeBlocker(): string | null {
    if (optimisticallyLocked) {
      return "This market is locked. Deposits are no longer accepted.";
    }
    if (preflight.loading) return "Checking wallet balance…";
    if (!preflight.ataExists) {
      return "No USDC account found for this wallet on devnet. Create a USDC associated token account before depositing.";
    }
    if (preflight.solLamports < preflight.minRequiredLamports) {
      const neededSol = (
        Number(preflight.minRequiredLamports) / LAMPORTS_PER_SOL
      ).toFixed(6);
      const rentNote =
        preflight.minRequiredLamports > TX_FEE_LAMPORTS
          ? " and account rent"
          : "";
      return `Insufficient devnet SOL for network fees${rentNote} (need at least ~${neededSol} SOL).`;
    }
    if (amountInput.trim() === "") return null;
    if (!parsed.ok) return parsed.error;
    if (parsed.amount > preflight.usdcBalance) {
      return `Insufficient USDC balance (have ${formatUsdcAmount(preflight.usdcBalance)}, need ${formatUsdcAmount(parsed.amount)}).`;
    }
    return null;
  }

  const blocker = computeBlocker();
  const canSubmit = blocker === null && parsed.ok && amountInput.trim() !== "";

  const idleLabel = parsed.ok
    ? `Deposit ${formatUsdcAmount(parsed.amount)} USDC on ${side ? "YES" : "NO"}`
    : "Deposit";

  function handleConfirmed() {
    setAmountInput("");
    if (publicKey && bettorUsdc) void refreshPreflight(publicKey, bettorUsdc);
    onDeposited();
  }

  return (
    <section className="card-panel-greek" aria-label="Deposit">
      <p className="panel-title">Deposit</p>
      <div className="action-panel-row">
        <div className="side-toggle" role="group" aria-label="Choose side">
          <button
            type="button"
            className={`pill-chip pill-chip-toggle${side ? " pill-chip-active-yes" : ""}`}
            onClick={() => setSide(true)}
          >
            YES
          </button>
          <button
            type="button"
            className={`pill-chip pill-chip-toggle${!side ? " pill-chip-active-no" : ""}`}
            onClick={() => setSide(false)}
          >
            NO
          </button>
        </div>
        <input
          className="amount-input"
          type="text"
          inputMode="decimal"
          placeholder="0.00"
          value={amountInput}
          onChange={(e) => setAmountInput(e.target.value)}
          aria-label="Deposit amount in USDC"
        />
      </div>
      <TxButton
        idleLabel={idleLabel}
        confirmedLabel="Deposited"
        disabled={!canSubmit}
        disabledReason={blocker}
        buildInstruction={() => {
          if (!parsed.ok) throw new Error("Invalid deposit amount");
          return buildDepositInstruction({
            market: marketPk,
            bettor: publicKey,
            bettorUsdc,
            side,
            amount: parsed.amount,
          });
        }}
        onConfirmed={handleConfirmed}
      />
    </section>
  );
}
