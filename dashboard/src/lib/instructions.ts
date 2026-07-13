/**
 * Deposit + claim_payout instruction builders for the dashboard's wallet UI
 *. Ported field-for-field from client/pari-client.ts -- same
 * discriminators (reused, not re-derived, from lib/pari.ts's
 * IX_DISCRIMINATORS table), same account ordering, same Borsh arg encoding --
 * wrapped directly in @solana/web3.js's TransactionInstruction so T3/T4's
 * <TxButton> can hand these straight to a wallet-adapter sendTransaction
 * call without an extra conversion step.
 *
 * ponytail: re-derives the position/vault PDAs and the (tiny) deposit-arg
 * encoding locally instead of importing client/pari-client.ts's builders at
 * runtime, because that file lives outside the dashboard package (client/ is
 * a sibling directory, not a dashboard dependency, and has no node_modules
 * of its own for @solana/web3.js to resolve from). Re-derivation here is ~30
 * lines, matches the same self-contained pattern lib/pari.ts already uses
 * ("Self-contained (no import from client/'s ts-node context per SCOPE)").
 * Field-level equivalence with client/pari-client.ts is enforced by
 * instructions.test.ts, which imports the real client/pari-client.ts builders
 * via a vitest resolve alias (see vitest.config.ts) and diffs every field.
 * Upgrade path: if pari-client.ts ever ships as a workspace-linked package
 * dashboard can depend on directly, replace this file with a thin re-export.
 */

import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  PARI_MARKET_PROGRAM_ID as PARI_MARKET_PROGRAM_ID_STR,
  SPL_TOKEN_PROGRAM_ID as SPL_TOKEN_PROGRAM_ID_STR,
  SYSTEM_PROGRAM_ID as SYSTEM_PROGRAM_ID_STR,
  IX_DISCRIMINATORS,
} from "./pari";

export const PARI_MARKET_PROGRAM_ID = new PublicKey(PARI_MARKET_PROGRAM_ID_STR);

// Mirrors client/pari-client.ts's constants exactly (values now hoisted to
// lib/pari.ts -- decoder hardening).
const SPL_TOKEN_PROGRAM_ID = new PublicKey(SPL_TOKEN_PROGRAM_ID_STR);
const SYSTEM_PROGRAM_ID = new PublicKey(SYSTEM_PROGRAM_ID_STR);

const POSITION_SEED = Buffer.from("position");
const VAULT_SEED = Buffer.from("vault");

// ── PDA derivation (mirrors client/pari-client.ts's vaultPda/positionPda) ──

export function vaultPda(market: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [VAULT_SEED, market.toBuffer()],
    PARI_MARKET_PROGRAM_ID,
  );
}

export function positionPda(
  market: PublicKey,
  bettor: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [POSITION_SEED, market.toBuffer(), bettor.toBuffer()],
    PARI_MARKET_PROGRAM_ID,
  );
}

// ── deposit ──────────────────────────────────────────────────────────────

export interface DepositParams {
  market: PublicKey;
  bettor: PublicKey;
  bettorUsdc: PublicKey;
  side: boolean; // true = YES, false = NO
  amount: bigint; // raw USDC base units (6 decimals)
}

// deposit's Borsh-encoded args: u64 amount (8 bytes) + bool side (1 byte).
const DEPOSIT_ARGS_LENGTH = 9;
const DEPOSIT_ARGS_SIDE_OFFSET = 8;

/** Borsh-encodes deposit's args: u64 amount + bool side (matches
 * client/pari-client.ts's Writer.u64().bool() output byte-for-byte). */
function encodeDepositArgs(amount: bigint, side: boolean): Buffer {
  const buf = Buffer.alloc(DEPOSIT_ARGS_LENGTH);
  buf.writeBigUInt64LE(amount, 0);
  buf.writeUInt8(side ? 1 : 0, DEPOSIT_ARGS_SIDE_OFFSET);
  return buf;
}

export function buildDepositInstruction(
  params: DepositParams,
): TransactionInstruction {
  const { market, bettor, bettorUsdc, side, amount } = params;
  const [position] = positionPda(market, bettor);
  const [vault] = vaultPda(market);

  const data = Buffer.concat([
    Buffer.from(IX_DISCRIMINATORS.deposit),
    encodeDepositArgs(amount, side),
  ]);

  return new TransactionInstruction({
    programId: PARI_MARKET_PROGRAM_ID,
    keys: [
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: position, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: bettorUsdc, isSigner: false, isWritable: true },
      { pubkey: bettor, isSigner: true, isWritable: true },
      { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ── claim_payout ─────────────────────────────────────────────────────────

export interface ClaimPayoutParams {
  market: PublicKey;
  bettor: PublicKey;
  bettorUsdc: PublicKey;
}

export function buildClaimPayoutInstruction(
  params: ClaimPayoutParams,
): TransactionInstruction {
  const { market, bettor, bettorUsdc } = params;
  const [position] = positionPda(market, bettor);
  const [vault] = vaultPda(market);

  return new TransactionInstruction({
    programId: PARI_MARKET_PROGRAM_ID,
    keys: [
      { pubkey: market, isSigner: false, isWritable: false },
      { pubkey: position, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: bettorUsdc, isSigner: false, isWritable: true },
      { pubkey: bettor, isSigner: true, isWritable: true },
      { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(IX_DISCRIMINATORS.claim_payout),
  });
}
