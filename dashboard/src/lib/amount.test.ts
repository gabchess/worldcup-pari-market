import { describe, expect, it } from "vitest";
import { formatUsdcAmount, parseUsdcAmount, U64_MAX } from "./amount";

describe("parseUsdcAmount", () => {
  it("parses a whole number", () => {
    expect(parseUsdcAmount("12")).toEqual({ ok: true, amount: 12_000_000n });
  });

  it("parses a decimal amount", () => {
    expect(parseUsdcAmount("12.5")).toEqual({ ok: true, amount: 12_500_000n });
  });

  it("parses the maximum 6-decimal precision", () => {
    expect(parseUsdcAmount("0.000001")).toEqual({ ok: true, amount: 1n });
  });

  it("rejects empty input", () => {
    const result = parseUsdcAmount("");
    expect(result.ok).toBe(false);
  });

  it("rejects whitespace-only input", () => {
    const result = parseUsdcAmount("   ");
    expect(result.ok).toBe(false);
  });

  it("rejects non-numeric input", () => {
    const result = parseUsdcAmount("abc");
    expect(result.ok).toBe(false);
  });

  it("rejects negative numbers", () => {
    const result = parseUsdcAmount("-5");
    expect(result.ok).toBe(false);
  });

  it("rejects zero", () => {
    const result = parseUsdcAmount("0");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/greater than zero/i);
  });

  it("rejects zero with decimal padding", () => {
    const result = parseUsdcAmount("0.000000");
    expect(result.ok).toBe(false);
  });

  it("rejects more than 6 decimal places", () => {
    const result = parseUsdcAmount("1.1234567");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/6 decimal/i);
  });

  it("rejects amounts above u64::MAX", () => {
    const tooLarge = (U64_MAX + 1n).toString();
    const result = parseUsdcAmount(tooLarge);
    expect(result.ok).toBe(false);
  });

  it("accepts an amount exactly at u64::MAX base units", () => {
    // u64::MAX base units = u64::MAX / 1e6 USDC (integer part) -- construct
    // directly from base units to avoid a fractional round-trip.
    const whole = U64_MAX / 1_000_000n;
    const result = parseUsdcAmount(whole.toString());
    expect(result.ok).toBe(true);
  });

  it("never routes through Number for large amounts (precision check)", () => {
    // 2^60 base units, well past Number.MAX_SAFE_INTEGER (2^53-1). A
    // Number-based parse would silently round this.
    const large = 2n ** 60n;
    const asDecimal = formatUsdcAmount(large);
    const result = parseUsdcAmount(asDecimal);
    expect(result).toEqual({ ok: true, amount: large });
  });
});

describe("formatUsdcAmount", () => {
  it("formats a whole number without trailing decimal", () => {
    expect(formatUsdcAmount(12_000_000n)).toBe("12");
  });

  it("formats a fractional amount, trimming trailing zeros", () => {
    expect(formatUsdcAmount(12_500_000n)).toBe("12.5");
  });

  it("formats the smallest unit", () => {
    expect(formatUsdcAmount(1n)).toBe("0.000001");
  });

  it("formats zero", () => {
    expect(formatUsdcAmount(0n)).toBe("0");
  });
});
