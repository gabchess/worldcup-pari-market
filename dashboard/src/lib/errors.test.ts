import { describe, expect, it } from "vitest";
import { translateProgramError } from "./errors";

describe("translateProgramError", () => {
  it("translates DepositAfterLock by error-code name", () => {
    const err = {
      message: "failed to send transaction",
      logs: [
        "Program log: AnchorError thrown in programs/pari-market/src/instructions/deposit.rs:36. Error Code: DepositAfterLock. Error Number: 6002. Error Message: Deposit attempted after the market's lock timestamp.",
      ],
    };
    expect(translateProgramError(err)).toMatch(/lock time has passed/i);
  });

  it("translates MarketLocked by error-code name", () => {
    const err = {
      message: "custom program error",
      logs: ["Error Code: MarketLocked."],
    };
    expect(translateProgramError(err)).toMatch(/is locked/i);
  });

  it("translates AlreadyClaimed by error-code name", () => {
    const err = { logs: ["Error Code: AlreadyClaimed. Error Number: 6004."] };
    expect(translateProgramError(err)).toMatch(/already been claimed/i);
  });

  it("translates LosingPosition by error-code name", () => {
    const err = { logs: ["Error Code: LosingPosition. Error Number: 6012."] };
    expect(translateProgramError(err)).toMatch(/nothing to claim/i);
  });

  it("falls back to the program's Error Message text when no known name matches", () => {
    const err = {
      logs: [
        "Error Code: SomeUnmappedFutureError. Error Message: A brand new failure mode.",
      ],
    };
    expect(translateProgramError(err)).toBe("A brand new failure mode");
  });

  it("falls back to a generic message for a plain Error with no logs", () => {
    expect(translateProgramError(new Error(""))).toBe("Transaction failed.");
  });

  it("falls back to the raw message when nothing else matches", () => {
    expect(translateProgramError(new Error("User rejected the request."))).toBe(
      "User rejected the request.",
    );
  });

  it("never throws on a non-object input", () => {
    expect(() => translateProgramError("plain string error")).not.toThrow();
    expect(translateProgramError(null)).toBe("Transaction failed.");
  });
});
