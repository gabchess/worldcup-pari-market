/**
 * Decimal-text -> base-units bigint parsing for the deposit amount input
 *. Never routes through `Number` -- USDC has 6
 * decimals and JS's safe-integer range (2^53-1) is smaller than u64::MAX, so
 * a Number-based parse would silently lose precision on large inputs.
 */

export const USDC_DECIMALS = 6;
const USDC_SCALE = 10n ** BigInt(USDC_DECIMALS);
export const U64_MAX = 2n ** 64n - 1n;

export type ParsedAmount =
  { ok: true; amount: bigint } | { ok: false; error: string };

/** Parses a decimal-string USDC amount (e.g. "12.5") into raw base units
 * (e.g. 12_500_000n). Rejects empty/non-numeric input, more than 6 decimal
 * places, zero, and anything outside u64 range. Does not check against a
 * wallet balance -- callers compare the returned bigint against a
 * separately-fetched balance for that distinct error. */
export function parseUsdcAmount(input: string): ParsedAmount {
  const trimmed = input.trim();
  if (trimmed === "") {
    return { ok: false, error: "Enter an amount." };
  }
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    return { ok: false, error: "Enter a valid positive number." };
  }

  const [wholePart, fracPart = ""] = trimmed.split(".");
  if (fracPart.length > USDC_DECIMALS) {
    return {
      ok: false,
      error: `USDC supports at most ${USDC_DECIMALS} decimal places.`,
    };
  }

  const paddedFrac = fracPart.padEnd(USDC_DECIMALS, "0");
  const amount = BigInt(wholePart) * USDC_SCALE + BigInt(paddedFrac || "0");

  if (amount === 0n) {
    return { ok: false, error: "Amount must be greater than zero." };
  }
  if (amount > U64_MAX) {
    return { ok: false, error: "Amount is too large." };
  }

  return { ok: true, amount };
}

/** Renders a raw base-units bigint back to a decimal string, e.g.
 * 12_500_000n -> "12.5". Trims trailing zeros; never shows "12.000000". */
export function formatUsdcAmount(amount: bigint): string {
  const whole = amount / USDC_SCALE;
  const frac = amount % USDC_SCALE;
  if (frac === 0n) return whole.toString();
  const fracStr = frac
    .toString()
    .padStart(USDC_DECIMALS, "0")
    .replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}
