/**
 * SPL token account helpers for deposit and claim preflight checks.
 * No @solana/spl-token dependency; matches the
 * project-wide decision recorded in client/pari-client.ts's header comment
 * (socket flagged transitive CVEs -- bigint-buffer high, uuid moderate -- on
 * @coral-xyz/anchor + @solana/spl-token for this workspace).
 */
import { PublicKey } from "@solana/web3.js";
import { SPL_TOKEN_PROGRAM_ID as SPL_TOKEN_PROGRAM_ID_STR } from "./pari";

const SPL_TOKEN_PROGRAM_ID = new PublicKey(SPL_TOKEN_PROGRAM_ID_STR);

// Associated Token Account program -- same well-known ID on every cluster,
// mirroring the pattern already established in scripts/m3-lifecycle-verify.ts.
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

/** Derives an owner's associated token account address for `mint`. */
export function findAssociatedTokenAddress(
  owner: PublicKey,
  mint: PublicKey,
): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), SPL_TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return ata;
}

// SPL Token account layout: mint(32) + owner(32) + amount(8, u64 LE) + ...
// (delegate/state/native/close-authority fields follow, unused here).
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64;
const TOKEN_ACCOUNT_MIN_SIZE = TOKEN_ACCOUNT_AMOUNT_OFFSET + 8;

/** Decodes the `amount` (u64 LE) field from a raw SPL token account buffer. */
export function decodeTokenAccountAmount(data: Buffer): bigint {
  if (data.length < TOKEN_ACCOUNT_MIN_SIZE) {
    throw new Error(
      `decodeTokenAccountAmount: buffer too small (${data.length} bytes, need >= ${TOKEN_ACCOUNT_MIN_SIZE})`,
    );
  }
  return data.readBigUInt64LE(TOKEN_ACCOUNT_AMOUNT_OFFSET);
}
