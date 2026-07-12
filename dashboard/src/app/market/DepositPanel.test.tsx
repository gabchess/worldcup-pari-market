// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DepositPanel } from "./DepositPanel";
import { findAssociatedTokenAddress } from "@/lib/token";

// jsdom's vm-context gives Node's `Buffer` a stale `Uint8Array` prototype
// link (see vitest.config.ts comment). @solana/web3.js's PDA derivation
// (findAssociatedTokenAddress / positionPda, both used by DepositPanel)
// depends on @noble's strict `instanceof Uint8Array` checks, so this file
// rebinds Buffer's prototype chain before any PDA derivation runs.
Object.setPrototypeOf(Buffer.prototype, Uint8Array.prototype);

// Regression: codex-review-final.md P1-2 -- "In-flight wallet work can
// overwrite state after a Phantom account switch". This test targets
// `refreshPreflight`'s own vulnerability (separate from TxButton.test.tsx,
// which covers the same class of bug in TxButton.run()/checkStatus()).
//
// `refreshPreflight` is a closure inside DepositPanel, not exported --
// mounting the real component (rather than extracting it to a standalone
// function purely for testability) keeps the fix surgical (no new exports
// invented just to satisfy a test).

const mockWalletState: { publicKey: PublicKey | null } = { publicKey: null };

const mockConnection = {
  getBalance: vi.fn(),
  getAccountInfo: vi.fn(),
  getMinimumBalanceForRentExemption: vi.fn(),
};

vi.mock("@solana/wallet-adapter-react", () => ({
  useConnection: () => ({ connection: mockConnection }),
  useWallet: () => mockWalletState,
}));

const MARKET = "11111111111111111111111111111111";
const MINT = "55aYKjhdFfHFbwuqw4wF1wToJuubFQBnmCNCfe24CXK";
const PUBKEY_A = new PublicKey("So11111111111111111111111111111111111111112");
const PUBKEY_B = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

const mintPk = new PublicKey(MINT);
const ataA = findAssociatedTokenAddress(PUBKEY_A, mintPk);
const ataB = findAssociatedTokenAddress(PUBKEY_B, mintPk);

function validAtaBuffer(): Buffer {
  const buf = Buffer.alloc(72);
  buf.writeBigUInt64LE(50_000_000n, 64);
  return buf;
}

beforeEach(() => {
  mockConnection.getAccountInfo.mockImplementation((addr: PublicKey) => {
    if (addr.equals(ataA) || addr.equals(ataB)) {
      return Promise.resolve({ data: validAtaBuffer() } as never);
    }
    return Promise.resolve(null); // Position PDA: no existing position.
  });
  mockConnection.getMinimumBalanceForRentExemption.mockResolvedValue(2_000_000);
});

afterEach(() => {
  // `test.globals` is off -- @testing-library/react's auto-cleanup
  // registration never fires, so this must be explicit (see TxButton.test.tsx
  // for the same note).
  cleanup();
});

describe("DepositPanel refreshPreflight wallet-generation guard (P1-2)", () => {
  it("account-switch mid-fetch: wallet A's late balance never overwrites wallet B's preflight state", async () => {
    let resolveBalanceA!: (v: number) => void;
    const balanceAPromise = new Promise<number>((resolve) => {
      resolveBalanceA = resolve;
    });

    mockConnection.getBalance
      .mockImplementationOnce(() => balanceAPromise) // wallet A: held pending
      .mockImplementationOnce(() => Promise.resolve(10_000_000)); // wallet B: resolves fast, sufficient SOL

    mockWalletState.publicKey = PUBKEY_A;
    const { rerender } = render(
      <DepositPanel
        marketAddress={MARKET}
        usdcMint={MINT}
        lockTs="99999999999"
        locked={false}
        onDeposited={vi.fn()}
      />,
    );

    // Wallet A's fetch is in flight (blocked on the deferred getBalance).
    expect(screen.getByText(/checking wallet balance/i)).toBeInTheDocument();

    // Account switch: A -> B, mid-fetch.
    mockWalletState.publicKey = PUBKEY_B;
    rerender(
      <DepositPanel
        marketAddress={MARKET}
        usdcMint={MINT}
        lockTs="99999999999"
        locked={false}
        onDeposited={vi.fn()}
      />,
    );

    // Wallet B's own fetch resolves quickly with sufficient SOL -- no
    // blocker text once it lands.
    await waitFor(() =>
      expect(
        screen.queryByText(/checking wallet balance/i),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByText(/insufficient devnet sol/i),
    ).not.toBeInTheDocument();

    // Wallet A's original (insufficient-balance) fetch now resolves, late.
    await act(async () => {
      resolveBalanceA(1_000_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    // Must still reflect wallet B's state -- A's stale insufficient-balance
    // result must never have been committed.
    expect(
      screen.queryByText(/insufficient devnet sol/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/checking wallet balance/i),
    ).not.toBeInTheDocument();
  });
});
