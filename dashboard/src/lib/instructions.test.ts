/**
 * Field-level equivalence tests: assert dashboard's ported
 * instruction builders produce byte-identical instructions to
 * client/pari-client.ts's builders for the same fixed inputs -- program ID,
 * key ordering, isSigner/isWritable flags, and data bytes all compared.
 *
 * Imports client/pari-client.ts directly (not a fixture copy) so any future
 * divergence between the two files fails this test immediately. See
 * vitest.config.ts for the @solana/web3.js resolve alias that makes the
 * cross-directory import work.
 */
import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  buildClaimPayoutInstruction,
  buildDepositInstruction,
} from "./instructions";
// eslint-disable-next-line @typescript-eslint/no-var-requires
import { buildDeposit, buildClaimPayout } from "../../../client/pari-client";

// Fixed test fixture inputs (arbitrary valid base58 pubkeys, not real keys).
const MARKET = new PublicKey("11111111111111111111111111111112");
const MARKET_ID = 123456789n;
const BETTOR = new PublicKey("So11111111111111111111111111111111111111112");
const BETTOR_USDC = new PublicKey(
  "55aYKjhdFfHFbwuqw4wF1wToJuubFQBnmCNCfe24CXK",
);
const AMOUNT = 10_000_000n;

/** Compares a @solana/web3.js TransactionInstruction against a
 * client/pari-client.ts BuiltInstruction field-for-field. */
function expectEquivalentInstruction(
  ported: { programId: PublicKey; keys: any[]; data: Buffer },
  reference: { programId: PublicKey; keys: any[]; data: Buffer },
) {
  expect(ported.programId.toBase58()).toBe(reference.programId.toBase58());
  expect(Buffer.from(ported.data).equals(Buffer.from(reference.data))).toBe(
    true,
  );
  expect(ported.keys.length).toBe(reference.keys.length);
  ported.keys.forEach((k, i) => {
    const ref = reference.keys[i];
    expect(k.pubkey.toBase58(), `key[${i}].pubkey`).toBe(ref.pubkey.toBase58());
    expect(k.isSigner, `key[${i}].isSigner`).toBe(ref.isSigner);
    expect(k.isWritable, `key[${i}].isWritable`).toBe(ref.isWritable);
  });
}

describe("buildDepositInstruction vs client/pari-client.ts buildDeposit", () => {
  it("matches for the YES side", () => {
    const ported = buildDepositInstruction({
      market: MARKET,
      bettor: BETTOR,
      bettorUsdc: BETTOR_USDC,
      side: true,
      amount: AMOUNT,
    });
    const reference = buildDeposit(
      { amount: AMOUNT, side: true },
      {
        market: MARKET,
        marketId: MARKET_ID,
        bettor: BETTOR,
        bettorUsdc: BETTOR_USDC,
      },
    );
    expectEquivalentInstruction(ported, reference);
  });

  it("matches for the NO side", () => {
    const ported = buildDepositInstruction({
      market: MARKET,
      bettor: BETTOR,
      bettorUsdc: BETTOR_USDC,
      side: false,
      amount: AMOUNT,
    });
    const reference = buildDeposit(
      { amount: AMOUNT, side: false },
      {
        market: MARKET,
        marketId: MARKET_ID,
        bettor: BETTOR,
        bettorUsdc: BETTOR_USDC,
      },
    );
    expectEquivalentInstruction(ported, reference);
  });

  // Edge-case fixtures (decoder hardening): amount=0n (the
  // program's ZeroAmount guard rejects this on-chain, but the *encoding*
  // must still be byte-identical to the reference -- validation is the
  // caller's job, not the instruction builder's) and amount=2n**60n (well
  // within u64 range but far outside JS's safe-integer range, so this also
  // proves the builder never routes the amount through `Number`).
  it.each([0n, 2n ** 60n])("matches for amount=%s, YES side", (amount) => {
    const ported = buildDepositInstruction({
      market: MARKET,
      bettor: BETTOR,
      bettorUsdc: BETTOR_USDC,
      side: true,
      amount,
    });
    const reference = buildDeposit(
      { amount, side: true },
      {
        market: MARKET,
        marketId: MARKET_ID,
        bettor: BETTOR,
        bettorUsdc: BETTOR_USDC,
      },
    );
    expectEquivalentInstruction(ported, reference);
  });

  it.each([0n, 2n ** 60n])("matches for amount=%s, NO side", (amount) => {
    const ported = buildDepositInstruction({
      market: MARKET,
      bettor: BETTOR,
      bettorUsdc: BETTOR_USDC,
      side: false,
      amount,
    });
    const reference = buildDeposit(
      { amount, side: false },
      {
        market: MARKET,
        marketId: MARKET_ID,
        bettor: BETTOR,
        bettorUsdc: BETTOR_USDC,
      },
    );
    expectEquivalentInstruction(ported, reference);
  });
});

describe("buildClaimPayoutInstruction vs client/pari-client.ts buildClaimPayout", () => {
  it("matches", () => {
    const ported = buildClaimPayoutInstruction({
      market: MARKET,
      bettor: BETTOR,
      bettorUsdc: BETTOR_USDC,
    });
    const reference = buildClaimPayout({
      market: MARKET,
      bettor: BETTOR,
      bettorUsdc: BETTOR_USDC,
    });
    expectEquivalentInstruction(ported, reference);
  });
});
