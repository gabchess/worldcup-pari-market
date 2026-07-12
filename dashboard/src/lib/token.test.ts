import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { decodeTokenAccountAmount, findAssociatedTokenAddress } from "./token";

describe("findAssociatedTokenAddress", () => {
  it("is deterministic for a fixed owner+mint pair", () => {
    const owner = new PublicKey("So11111111111111111111111111111111111111112");
    const mint = new PublicKey("55aYKjhdFfHFbwuqw4wF1wToJuubFQBnmCNCfe24CXK");
    const a = findAssociatedTokenAddress(owner, mint);
    const b = findAssociatedTokenAddress(owner, mint);
    expect(a.toBase58()).toBe(b.toBase58());
  });

  it("differs for different owners", () => {
    const mint = new PublicKey("55aYKjhdFfHFbwuqw4wF1wToJuubFQBnmCNCfe24CXK");
    const ownerA = new PublicKey("So11111111111111111111111111111111111111112");
    const ownerB = new PublicKey("11111111111111111111111111111112");
    expect(findAssociatedTokenAddress(ownerA, mint).toBase58()).not.toBe(
      findAssociatedTokenAddress(ownerB, mint).toBase58(),
    );
  });
});

describe("decodeTokenAccountAmount", () => {
  it("reads the u64 LE amount at offset 64", () => {
    const buf = Buffer.alloc(72);
    buf.writeBigUInt64LE(123_456_789n, 64);
    expect(decodeTokenAccountAmount(buf)).toBe(123_456_789n);
  });

  it("throws on a too-small buffer", () => {
    expect(() => decodeTokenAccountAmount(Buffer.alloc(10))).toThrow();
  });
});
