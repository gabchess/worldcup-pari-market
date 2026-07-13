/**
 * M0 FACT 3 + reference validate_stat call.
 *
 * Sends a real validate_stat transaction (not .view()) against a live
 * stat-validation proof, mirroring the official validate_scores_onchain.ts
 * reference. No @coral-xyz/anchor dependency (see validate-stat-borsh.ts
 * header for why) -- instruction data is hand-encoded Borsh.
 *
 * Usage:
 *   npx ts-node --project tsconfig.json validate-stat-call.ts <fixtureId> <seq> [--false]
 *
 * DEVNET_RPC env var overrides the default api.devnet.solana.com endpoint
 * (that endpoint's TLS chain fails to validate on this machine's OpenSSL/
 * LibreSSL builds -- unrelated new Sectigo root not yet trusted locally;
 * Helius devnet RPC is used instead, see M0_EVIDENCE for detail).
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const web3 = require("../node_modules/@solana/web3.js");
import {
  encodeValidateStatArgs,
  ScoresBatchSummary,
  ProofNode,
  StatTerm,
  TraderPredicate,
} from "./validate-stat-borsh";

const DEVNET_RPC = process.env["DEVNET_RPC"] ?? "https://api.devnet.solana.com";
const API_BASE = "https://txline-dev.txodds.com";

// Confirmed live on devnet (M0 FACT 1): 6pW64... holds fresh daily_scores_roots
// PDAs; 9Exb... (the IDL top-level metadata address) has none on devnet.
const PROGRAM_ID = new web3.PublicKey(
  "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J"
);

const VALIDATE_STAT_DISCRIMINATOR = [107, 197, 232, 90, 191, 136, 105, 185];

interface StatValidationResponse {
  ts: number;
  statToProve: { key: number; value: number; period: number };
  eventStatRoot: number[];
  summary: {
    fixtureId: number;
    updateStats: {
      updateCount: number;
      minTimestamp: number;
      maxTimestamp: number;
    };
    eventStatsSubTreeRoot: number[];
  };
  statProof: ProofNode[];
  subTreeProof: ProofNode[];
  mainTreeProof: ProofNode[];
  statToProve2?: { key: number; value: number; period: number };
  statProof2?: ProofNode[];
}

function loadPrivKey(): Uint8Array {
  // ponytail: id.json is a plain JSON array of 64 secret-key bytes (standard
  // solana-keygen format); no bs58 decode needed like the devnet-only wallet.
  const walletPath = path.join(os.homedir(), ".config", "solana", "id.json");
  const raw = JSON.parse(fs.readFileSync(walletPath, "utf-8")) as number[];
  return Uint8Array.from(raw);
}

// Fallback wallet: our confirmed devnet subscriber key (secrets/solana-worldcup-devnet-wallet.md)
function loadSubscriberPrivKey(): Uint8Array {
  const walletPath = path.join(
    os.homedir(),
    "secrets",
    "solana-worldcup-devnet-wallet.md"
  );
  const content = fs.readFileSync(walletPath, "utf-8");
  const keyMatch = content.match(/private key\s*=\s*(\S+)/i);
  if (!keyMatch) throw new Error("no private key found");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const bs58 = require("../node_modules/bs58");
  return bs58.decode(keyMatch[1]) as Uint8Array;
}

async function fetchProof(
  fixtureId: number,
  seq: number,
  statKey: number,
  statKey2?: number
): Promise<StatValidationResponse> {
  const jwt = process.env["TXLINE_JWT"];
  const apiToken = process.env["TXLINE_API_TOKEN"];
  if (!jwt || !apiToken) {
    throw new Error(
      "TXLINE_JWT / TXLINE_API_TOKEN not set (set TXLINE_JWT and TXLINE_API_TOKEN)"
    );
  }
  const qs = new URLSearchParams({
    fixtureId: String(fixtureId),
    seq: String(seq),
    statKey: String(statKey),
  });
  if (statKey2 !== undefined) qs.set("statKey2", String(statKey2));

  const res = await fetch(`${API_BASE}/api/scores/stat-validation?${qs}`, {
    headers: { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken },
  });
  if (!res.ok) {
    throw new Error(`stat-validation HTTP ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as StatValidationResponse;
}

async function main(): Promise<void> {
  const [fixtureIdArg, seqArg, ...rest] = process.argv.slice(2);
  const forceFalse = rest.includes("--false");
  const falseThreshold = rest.includes("--false")
    ? Number(rest[rest.indexOf("--false") + 1] ?? "9999")
    : undefined;

  const fixtureId = Number(fixtureIdArg);
  const seq = Number(seqArg);
  if (!fixtureId || !seq) {
    console.error(
      "Usage: validate-stat-call.ts <fixtureId> <seq> [--false <threshold>]"
    );
    process.exit(1);
  }

  console.log(
    `Fetching stat-validation proof: fixtureId=${fixtureId} seq=${seq} statKey=1 statKey2=2`
  );
  const validation = await fetchProof(fixtureId, seq, 1, 2);
  console.log(
    `statToProve: key=${validation.statToProve.key} value=${validation.statToProve.value} period=${validation.statToProve.period}`
  );
  if (validation.statToProve2) {
    console.log(
      `statToProve2: key=${validation.statToProve2.key} value=${validation.statToProve2.value} period=${validation.statToProve2.period}`
    );
  }

  const connection = new web3.Connection(DEVNET_RPC, "confirmed");

  // Signer: prefer ~/.config/solana/id.json, fall back to the devnet subscriber wallet.
  let signer;
  try {
    signer = web3.Keypair.fromSecretKey(loadPrivKey());
  } catch {
    signer = web3.Keypair.fromSecretKey(loadSubscriberPrivKey());
  }
  console.log("Signer:", signer.publicKey.toBase58());

  const balance = await connection.getBalance(signer.publicKey);
  console.log("Signer balance:", balance / 1e9, "SOL");

  const epochDay = Math.floor(
    validation.summary.updateStats.minTimestamp / (24 * 60 * 60 * 1000)
  );
  const epochDayBuf = Buffer.alloc(2);
  epochDayBuf.writeUInt16LE(epochDay, 0);
  const [dailyScoresPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("daily_scores_roots"), epochDayBuf],
    PROGRAM_ID
  );
  console.log(
    `epochDay=${epochDay} dailyScoresPda=${dailyScoresPda.toBase58()}`
  );

  const pdaInfo = await connection.getAccountInfo(dailyScoresPda);
  if (!pdaInfo)
    throw new Error(
      `daily_scores_roots PDA not found for epochDay ${epochDay}`
    );
  console.log(`PDA confirmed on-chain: ${pdaInfo.data.length} bytes`);

  const fixtureSummary: ScoresBatchSummary = {
    fixtureId: validation.summary.fixtureId,
    updateStats: {
      updateCount: validation.summary.updateStats.updateCount,
      minTimestamp: validation.summary.updateStats.minTimestamp,
      maxTimestamp: validation.summary.updateStats.maxTimestamp,
    },
    eventsSubTreeRoot: validation.summary.eventStatsSubTreeRoot,
  };

  const statA: StatTerm = {
    statToProve: validation.statToProve,
    eventStatRoot: validation.eventStatRoot,
    statProof: validation.statProof,
  };

  let statB: StatTerm | null = null;
  let op: "Add" | "Subtract" | null = null;
  let predicate: TraderPredicate;

  if (validation.statToProve2 && validation.statProof2) {
    statB = {
      statToProve: validation.statToProve2,
      eventStatRoot: validation.eventStatRoot,
      statProof: validation.statProof2,
    };
    op = "Subtract";
    // home_goals - away_goals > threshold
    const diff = validation.statToProve.value - validation.statToProve2.value;
    if (forceFalse) {
      predicate = {
        threshold: falseThreshold ?? diff + 100,
        comparison: "GreaterThan",
      };
      console.log(
        `FALSE-PREDICATE PROBE: diff=${diff}, threshold=${predicate.threshold} (diff > threshold should be FALSE)`
      );
    } else {
      predicate = { threshold: diff - 1, comparison: "GreaterThan" };
      console.log(
        `TRUE-PREDICATE: diff=${diff}, threshold=${predicate.threshold} (diff > threshold should be TRUE)`
      );
    }
  } else {
    // Single-stat: prove home goals against a threshold
    if (forceFalse) {
      predicate = {
        threshold: falseThreshold ?? validation.statToProve.value + 100,
        comparison: "GreaterThan",
      };
    } else {
      predicate = {
        threshold: validation.statToProve.value - 1,
        comparison: "GreaterThan",
      };
    }
  }

  const data = encodeValidateStatArgs({
    discriminator: VALIDATE_STAT_DISCRIMINATOR,
    // ts arg for seed generation must match updateStats.minTimestamp (the value
    // used to derive epochDay), NOT the top-level validation.ts event timestamp --
    // confirmed by TimestampMismatch (error 6010) when validation.ts was used.
    ts: validation.summary.updateStats.minTimestamp,
    fixtureSummary,
    fixtureProof: validation.subTreeProof,
    mainTreeProof: validation.mainTreeProof,
    predicate,
    statA,
    statB,
    op,
  });

  console.log(`Instruction data length: ${data.length} bytes`);

  const ix = new web3.TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [{ pubkey: dailyScoresPda, isSigner: false, isWritable: false }],
    data,
  });

  const computeIx = web3.ComputeBudgetProgram
    ? web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })
    : new web3.TransactionInstruction({
        programId: new web3.PublicKey(
          "ComputeBudget111111111111111111111111111111"
        ),
        keys: [],
        data: Buffer.concat([
          Buffer.from([0x02]),
          (() => {
            const b = Buffer.alloc(4);
            b.writeUInt32LE(1_400_000, 0);
            return b;
          })(),
        ]),
      });

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  const tx = new web3.Transaction({
    recentBlockhash: blockhash,
    feePayer: signer.publicKey,
  });
  tx.add(computeIx);
  tx.add(ix);
  tx.sign(signer);

  console.log(
    `Sending validate_stat tx (${forceFalse ? "FALSE" : "TRUE"} predicate)...`
  );
  try {
    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true, // capture the real program error instead of a preflight-simulation short-circuit
      preflightCommitment: "confirmed",
    });
    console.log("Tx sent:", sig);
    const conf = await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed"
    );
    console.log("Confirmation:", JSON.stringify(conf.value));

    const txInfo = await connection.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    console.log("Compute units consumed:", txInfo?.meta?.computeUnitsConsumed);
    console.log(
      "Accounts touched:",
      txInfo?.transaction.message.getAccountKeys().staticAccountKeys.length ??
        "unknown"
    );
    console.log("Logs:");
    for (const l of txInfo?.meta?.logMessages ?? []) console.log("  " + l);

    if (conf.value.err) {
      console.log(
        `RESULT: transaction reported error (predicate=${
          forceFalse ? "FALSE" : "TRUE"
        }):`,
        JSON.stringify(conf.value.err)
      );
      console.log(
        `Explorer: https://explorer.solana.com/tx/${sig}?cluster=devnet`
      );
      process.exit(forceFalse ? 0 : 3); // for the true-predicate call, an error is a FAIL
    }
    console.log(
      `RESULT: transaction succeeded (predicate=${
        forceFalse ? "FALSE" : "TRUE"
      })`
    );
    console.log(
      `Explorer: https://explorer.solana.com/tx/${sig}?cluster=devnet`
    );
  } catch (err) {
    console.log(
      `RESULT: sendRawTransaction threw for predicate=${
        forceFalse ? "FALSE" : "TRUE"
      }:`,
      err instanceof Error ? err.message : err
    );
    if (!forceFalse) throw err;
  }
}

main().catch((e) => {
  console.error("FAILED:", e.message ?? e);
  process.exit(1);
});
