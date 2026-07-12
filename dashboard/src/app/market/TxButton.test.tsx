// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { TxButton } from "./TxButton";

// jsdom's vm-context gives Node's `Buffer` a stale `Uint8Array` prototype
// link (see vitest.config.ts comment). @solana/web3.js's `PublicKey`
// construction depends on @noble's strict `instanceof Uint8Array` checks,
// so this file rebinds Buffer's prototype chain before any PublicKey use.
//
// `Buffer.prototype` is process-global, not scoped to this file (see
// vitest.config.ts comment for the full explanation) -- capture the
// pre-mutation prototype so it can be put back once this file's own suite
// is done, rather than leaving the mutation to outlive this file
// indefinitely for whatever runs next in the same worker.
const originalBufferProto: object = Object.getPrototypeOf(Buffer.prototype);
Object.setPrototypeOf(Buffer.prototype, Uint8Array.prototype);

afterAll(() => {
  Object.setPrototypeOf(Buffer.prototype, originalBufferProto);
});

// Regression: codex-review-final.md P1-1 + P1-2
// Report: .arcana/../codex-review-final.md (see repo root)
//
// P1-1 -- a confirmation-timeout retry could resend a duplicate deposit
// (new blockhash, new signature) while the original signature might still
// land. P1-2 -- in-flight wallet work (confirmation polling) could commit
// setState/onConfirmed for a wallet that already disconnected or switched.
//
// `@solana/wallet-adapter-react`'s hooks are mocked directly rather than
// wired through real Connection/WalletProvider context -- TxButton only
// destructures `{ connection }` and `{ publicKey, sendTransaction }`, so a
// plain mock keeps the harness proportionate to what's under test.

const mockWalletState: {
  publicKey: PublicKey | null;
  sendTransaction: ReturnType<typeof vi.fn>;
} = {
  publicKey: null,
  sendTransaction: vi.fn(),
};

const mockConnection = {
  getLatestBlockhash: vi.fn(),
  confirmTransaction: vi.fn(),
  getSignatureStatuses: vi.fn(),
  getBlockHeight: vi.fn(),
};

vi.mock("@solana/wallet-adapter-react", () => ({
  useConnection: () => ({ connection: mockConnection }),
  useWallet: () => mockWalletState,
}));

const buildInstruction = () =>
  new TransactionInstruction({
    programId: new PublicKey("11111111111111111111111111111111"),
    keys: [],
    data: Buffer.alloc(0),
  });

const PUBKEY_A = new PublicKey("So11111111111111111111111111111111111111112");
const PUBKEY_B = new PublicKey("55aYKjhdFfHFbwuqw4wF1wToJuubFQBnmCNCfe24CXK");

function renderButton(onConfirmed: ReturnType<typeof vi.fn>) {
  return render(
    <TxButton
      buildInstruction={buildInstruction}
      idleLabel="Deposit 10 USDC on YES"
      confirmedLabel="Deposited"
      onConfirmed={onConfirmed}
    />,
  );
}

beforeEach(() => {
  mockWalletState.publicKey = PUBKEY_A;
  mockWalletState.sendTransaction = vi.fn().mockResolvedValue("SIG1");
  mockConnection.getLatestBlockhash.mockResolvedValue({
    blockhash: "hash1",
    lastValidBlockHeight: 100,
  });
  mockConnection.confirmTransaction.mockReset();
  mockConnection.getSignatureStatuses.mockReset();
  mockConnection.getBlockHeight.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  // `test.globals` is off (explicit `vitest` imports throughout this file),
  // so @testing-library/react's auto-cleanup registration -- which looks
  // for a global `afterEach` -- never fires. Without an explicit cleanup()
  // call here, each test's rendered button stays in the jsdom document and
  // later `getByRole("button")` calls fail with "multiple elements found".
  cleanup();
});

describe("TxButton timeout path (P1-1)", () => {
  it("timeout-then-confirm: sendTransaction called exactly once, final state confirmed", async () => {
    vi.useFakeTimers();
    // confirmTransaction never resolves within the 30s window -- the race
    // is won by the internal timeout.
    mockConnection.confirmTransaction.mockReturnValue(new Promise(() => {}));

    const onConfirmed = vi.fn();
    renderButton(onConfirmed);

    fireEvent.click(screen.getByRole("button"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(screen.getByRole("button").textContent).toMatch(/still confirming/i);

    // checkStatus()'s own await chain needs no fake timer (just Promise.all
    // of already-resolved mocks) -- switch back to real timers so RTL's
    // waitFor (whose internal polling uses real timers) can progress.
    vi.useRealTimers();

    // The original signature later confirms -- status check must transition
    // to "confirmed" WITHOUT ever calling sendTransaction a second time.
    mockConnection.getSignatureStatuses.mockResolvedValue({
      value: [
        {
          err: null,
          confirmationStatus: "confirmed",
          confirmations: null,
          slot: 1,
        },
      ],
    });
    mockConnection.getBlockHeight.mockResolvedValue(50);

    fireEvent.click(screen.getByRole("button"));
    await waitFor(() =>
      expect(screen.getByRole("button").textContent).toMatch(/deposited/i),
    );

    expect(mockWalletState.sendTransaction).toHaveBeenCalledTimes(1);
    expect(onConfirmed).toHaveBeenCalledTimes(1);
    expect(onConfirmed).toHaveBeenCalledWith("SIG1");
  });
});

describe("TxButton wallet-generation guard (P1-2)", () => {
  it("account-switch mid-flight: wallet A's late completion produces zero state writes/callbacks under B", async () => {
    let resolveConfirm!: (v: { value: { err: null } }) => void;
    mockConnection.confirmTransaction.mockReturnValue(
      new Promise((resolve) => {
        resolveConfirm = resolve;
      }),
    );

    const onConfirmed = vi.fn();
    const { rerender } = renderButton(onConfirmed);

    fireEvent.click(screen.getByRole("button"));
    await waitFor(() =>
      expect(screen.getByRole("button").textContent).toMatch(/confirming/i),
    );

    // Account switch: A -> B, mid-confirmation-poll.
    mockWalletState.publicKey = PUBKEY_B;
    rerender(
      <TxButton
        buildInstruction={buildInstruction}
        idleLabel="Deposit 10 USDC on YES"
        confirmedLabel="Deposited"
        onConfirmed={onConfirmed}
      />,
    );

    // Visible reset already lands synchronously.
    expect(screen.getByRole("button").textContent).toMatch(
      /deposit 10 usdc on yes/i,
    );

    // Wallet A's original transaction now confirms, late.
    await act(async () => {
      resolveConfirm({ value: { err: null } });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onConfirmed).not.toHaveBeenCalled();
    expect(screen.getByRole("button").textContent).toMatch(
      /deposit 10 usdc on yes/i,
    );
  });

  it("disconnect mid-flight: wallet A's late completion produces zero state writes/callbacks after publicKey -> null", async () => {
    let resolveConfirm!: (v: { value: { err: null } }) => void;
    mockConnection.confirmTransaction.mockReturnValue(
      new Promise((resolve) => {
        resolveConfirm = resolve;
      }),
    );

    const onConfirmed = vi.fn();
    const { rerender } = renderButton(onConfirmed);

    fireEvent.click(screen.getByRole("button"));
    await waitFor(() =>
      expect(screen.getByRole("button").textContent).toMatch(/confirming/i),
    );

    // Disconnect mid-confirmation-poll.
    mockWalletState.publicKey = null;
    rerender(
      <TxButton
        buildInstruction={buildInstruction}
        idleLabel="Deposit 10 USDC on YES"
        confirmedLabel="Deposited"
        onConfirmed={onConfirmed}
      />,
    );

    expect(screen.getByRole("button").textContent).toMatch(
      /deposit 10 usdc on yes/i,
    );

    await act(async () => {
      resolveConfirm({ value: { err: null } });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onConfirmed).not.toHaveBeenCalled();
    expect(screen.getByRole("button").textContent).toMatch(
      /deposit 10 usdc on yes/i,
    );
  });
});

// Kent-gate finding 1: locks the OTHER half of P1-1 -- once the original
// signature is provably dead (no status found by the RPC, AND the current
// block height has already passed the original lastValidBlockHeight), a
// fresh send must actually be reachable and must use a fresh blockhash,
// never the stale one from the dead attempt.
describe("TxButton timeout -> expired-blockhash recovery (P1-1 legitimate resend)", () => {
  it("proof-of-death (no status, blockhash provably expired): expired-blockhash phase allows a fresh resend with a new blockhash", async () => {
    vi.useFakeTimers();
    mockConnection.confirmTransaction.mockReturnValue(new Promise(() => {}));

    renderButton(vi.fn());

    fireEvent.click(screen.getByRole("button"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(screen.getByRole("button").textContent).toMatch(/still confirming/i);

    vi.useRealTimers();

    // No status found for the original signature, and the current block
    // height (150) has already passed the original lastValidBlockHeight
    // (100) -- this is the proof the original blockhash is dead, not just
    // "not found yet".
    mockConnection.getSignatureStatuses.mockResolvedValue({ value: [null] });
    mockConnection.getBlockHeight.mockResolvedValue(150);

    fireEvent.click(screen.getByRole("button"));
    await waitFor(() =>
      expect(screen.getByRole("button").textContent).toMatch(
        /blockhash expired/i,
      ),
    );

    expect(mockWalletState.sendTransaction).toHaveBeenCalledTimes(1);

    // A fresh blockhash for the legitimate resend -- distinct from "hash1"
    // used by the original (now-dead) attempt.
    mockConnection.getLatestBlockhash.mockResolvedValue({
      blockhash: "hash2",
      lastValidBlockHeight: 200,
    });

    fireEvent.click(screen.getByRole("button"));
    await waitFor(() =>
      expect(mockWalletState.sendTransaction).toHaveBeenCalledTimes(2),
    );

    const secondTx = mockWalletState.sendTransaction.mock.calls[1][0];
    expect(secondTx.recentBlockhash).toBe("hash2");
  });
});

// Kent-gate finding 2: `state.checking` is a render-timed guard; two clicks
// batched into the same React commit both read the same stale
// `state.checking === false`. checkStatus()'s useRef-backed lock is the
// actual single-flight guard, independent of render timing.
describe("TxButton checkStatus single-flight guard (belt-and-suspenders ref)", () => {
  it("rapid double-click during timeout: getSignatureStatuses called exactly once", async () => {
    vi.useFakeTimers();
    mockConnection.confirmTransaction.mockReturnValue(new Promise(() => {}));

    renderButton(vi.fn());

    fireEvent.click(screen.getByRole("button"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(screen.getByRole("button").textContent).toMatch(/still confirming/i);

    vi.useRealTimers();
    mockConnection.getSignatureStatuses.mockResolvedValue({ value: [null] });
    mockConnection.getBlockHeight.mockResolvedValue(50);

    const button = screen.getByRole("button");

    // Both clicks fire inside ONE act() batch -- no render commits between
    // them, so `state.checking` is still false when the second handler
    // runs. Only the useRef in-flight flag (not the state-derived
    // `disabled` attribute, which hasn't re-rendered yet either) can
    // prevent a second overlapping checkStatus() call here.
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
    });

    await waitFor(() =>
      expect(mockConnection.getSignatureStatuses).toHaveBeenCalledTimes(1),
    );
  });
});
