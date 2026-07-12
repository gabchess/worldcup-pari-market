/**
 * Position account decode (T3/T4, S194 continuation) -- mirrors
 * programs/pari-market/src/position/state.rs field-for-field: discriminator
 * (8) + market (32) + bettor (32) + side (1) + amount (8, u64 LE) + claimed
 * (1) + bump (1). Only the fields the deposit/claim UI actually needs are
 * decoded (side/amount/claimed) -- market/bettor aren't re-decoded since the
 * caller already knows both (it derived the PDA from them).
 */

const SIDE_OFFSET = 8 + 32 + 32; // 72
const AMOUNT_OFFSET = SIDE_OFFSET + 1; // 73
const CLAIMED_OFFSET = AMOUNT_OFFSET + 8; // 81
const MIN_SIZE = CLAIMED_OFFSET + 1;

export interface DecodedPosition {
  side: boolean; // true = YES, false = NO
  amount: bigint; // cumulative deposit, raw USDC base units
  claimed: boolean;
}

export function decodePosition(buffer: Buffer): DecodedPosition {
  if (buffer.length < MIN_SIZE) {
    throw new Error(
      `decodePosition: buffer too small (${buffer.length} bytes, need >= ${MIN_SIZE})`,
    );
  }
  return {
    side: buffer.readUInt8(SIDE_OFFSET) === 1,
    amount: buffer.readBigUInt64LE(AMOUNT_OFFSET),
    claimed: buffer.readUInt8(CLAIMED_OFFSET) === 1,
  };
}
