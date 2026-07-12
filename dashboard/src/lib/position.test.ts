import { describe, expect, it } from "vitest";
import { decodePosition } from "./position";

function buildPositionBuffer(opts: {
  side: boolean;
  amount: bigint;
  claimed: boolean;
}): Buffer {
  const buf = Buffer.alloc(88);
  // discriminator(8) + market(32) + bettor(32) left zeroed (unused by the decoder)
  buf.writeUInt8(opts.side ? 1 : 0, 72);
  buf.writeBigUInt64LE(opts.amount, 73);
  buf.writeUInt8(opts.claimed ? 1 : 0, 81);
  return buf;
}

describe("decodePosition", () => {
  it("decodes an unclaimed YES position", () => {
    const buf = buildPositionBuffer({
      side: true,
      amount: 10_000_000n,
      claimed: false,
    });
    expect(decodePosition(buf)).toEqual({
      side: true,
      amount: 10_000_000n,
      claimed: false,
    });
  });

  it("decodes a claimed NO position", () => {
    const buf = buildPositionBuffer({
      side: false,
      amount: 5_000_000n,
      claimed: true,
    });
    expect(decodePosition(buf)).toEqual({
      side: false,
      amount: 5_000_000n,
      claimed: true,
    });
  });

  it("throws on a too-small buffer", () => {
    expect(() => decodePosition(Buffer.alloc(10))).toThrow();
  });
});
