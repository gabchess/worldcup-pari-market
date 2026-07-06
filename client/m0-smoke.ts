/**
 * M0 smoke test: consolidated, idempotent repro of the confirmed M0 evidence.
 *
 * Runs: authenticated proof-pull (GET /api/scores/stat-validation) + a real
 * on-chain validate_stat TRUE-predicate call against fixture 18172379, and
 * asserts the transaction succeeds with a decoded `true` return value.
 *
 * Reads the API token from ~/secrets/txline-api-token.env (never prints the
 * value). Idempotent: re-running fires a new validate_stat tx each time
 * (the underlying call has no on-chain state mutation / no double-spend risk
 * -- it's a pure verification read), so repeat runs are safe and cheap
 * (~179k CU, devnet, free).
 *
 * Usage:
 *   npx ts-node --project tsconfig.json client/m0-smoke.ts
 *
 * Exit 0 on success, non-zero on any failure.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const web3 = require("../node_modules/@solana/web3.js");
import {
  encodeValidateStatArgs,
  ScoresBatchSummary,
  StatTerm,
  TraderPredicate,
} from "./validate-stat-borsh";

const API_BASE = "https://txline-dev.txodds.com";
const PROGRAM_ID = new web3.PublicKey(
  "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J"
);
const VALIDATE_STAT_DISCRIMINATOR = [107, 197, 232, 90, 191, 136, 105, 185];

// Confirmed-working smoke-test fixture (M0, S175). Devnet SL=1 test data.
const FIXTURE_ID = 18172379;
const SEQ = 1053;

interface StatValidationResponse {
  statToProve: { key: number; value: number; period: number };
  statToProve2: { key: number; value: number; period: number };
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
  statProof: { hash: number[]; isRightSibling: boolean }[];
  statProof2: { hash: number[]; isRightSibling: boolean }[];
  subTreeProof: { hash: number[]; isRightSibling: boolean }[];
  mainTreeProof: { hash: number[]; isRightSibling: boolean }[];
}

function loadTokenEnv(): { jwt: string; apiToken: string } {
  const envPath = path.join(os.homedir(), "secrets", "txline-api-token.env");
  if (!fs.existsSync(envPath)) {
    throw new Error(
      `Token file not found at ${envPath}. Run the auth flow (client/subscribe-fresh-helius.ts + activate) first.`
    );
  }
  const content = fs.readFileSync(envPath, "utf-8");
  const jwtMatch = content.match(/^TXLINE_JWT=(.+)$/m);
  const tokenMatch = content.match(/^TXLINE_API_TOKEN=(.+)$/m);
  if (!jwtMatch || !tokenMatch) {
    throw new Error(
      `Token file at ${envPath} is missing TXLINE_JWT or TXLINE_API_TOKEN`
    );
  }
  return { jwt: jwtMatch[1].trim(), apiToken: tokenMatch[1].trim() };
}

function loadHeliusRpc(): string {
  const keyPath = path.join(os.homedir(), "secrets", "helius-api-key.txt");
  const key = fs.readFileSync(keyPath, "utf-8").trim();
  return `https://devnet.helius-rpc.com/?api-key=${key}`;
}

function loadSigner() {
  // Prefer default CLI wallet; fall back to the devnet subscriber wallet used
  // for the txline subscribe flow (same wallet that funded prior M0 calls).
  try {
    const walletPath = path.join(os.homedir(), ".config", "solana", "id.json");
    const raw = JSON.parse(fs.readFileSync(walletPath, "utf-8")) as number[];
    return web3.Keypair.fromSecretKey(Uint8Array.from(raw));
  } catch {
    const walletPath = path.join(
      os.homedir(),
      "secrets",
      "solana-worldcup-devnet-wallet.md"
    );
    const content = fs.readFileSync(walletPath, "utf-8");
    const keyMatch = content.match(/private key\s*=\s*(\S+)/i);
    if (!keyMatch) throw new Error("no usable signer found");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const bs58 = require("../node_modules/bs58");
    return web3.Keypair.fromSecretKey(bs58.decode(keyMatch[1]));
  }
}

async function main(): Promise<void> {
  console.log("=== M0 smoke test ===");

  const { jwt, apiToken } = loadTokenEnv();
  console.log(
    "Token loaded from ~/secrets/txline-api-token.env (value not printed)"
  );

  console.log(
    `Fetching stat-validation proof: fixtureId=${FIXTURE_ID} seq=${SEQ} statKey=1 statKey2=2`
  );
  const qs = new URLSearchParams({
    fixtureId: String(FIXTURE_ID),
    seq: String(SEQ),
    statKey: "1",
    statKey2: "2",
  });
  const res = await fetch(`${API_BASE}/api/scores/stat-validation?${qs}`, {
    headers: { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken },
  });
  if (!res.ok) {
    throw new Error(`stat-validation HTTP ${res.status}: ${await res.text()}`);
  }
  const validation = (await res.json()) as StatValidationResponse;
  console.log(
    `Proof received: home_goals(key=1)=${validation.statToProve.value} away_goals(key=2)=${validation.statToProve2.value}`
  );

  const connection = new web3.Connection(loadHeliusRpc(), "confirmed");
  const signer = loadSigner();
  console.log("Signer:", signer.publicKey.toBase58());

  const epochDay = Math.floor(
    validation.summary.updateStats.minTimestamp / (24 * 60 * 60 * 1000)
  );
  const epochDayBuf = Buffer.alloc(2);
  epochDayBuf.writeUInt16LE(epochDay, 0);
  const [dailyScoresPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("daily_scores_roots"), epochDayBuf],
    PROGRAM_ID
  );

  const pdaInfo = await connection.getAccountInfo(dailyScoresPda);
  if (!pdaInfo) {
    throw new Error(
      `daily_scores_roots PDA not found on-chain for epochDay ${epochDay} (${dailyScoresPda.toBase58()})`
    );
  }
  console.log(
    `daily_scores_roots PDA confirmed on-chain: ${dailyScoresPda.toBase58()} (${
      pdaInfo.data.length
    } bytes)`
  );

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
  const statB: StatTerm = {
    statToProve: validation.statToProve2,
    eventStatRoot: validation.eventStatRoot,
    statProof: validation.statProof2,
  };
  const diff = validation.statToProve.value - validation.statToProve2.value;
  const predicate: TraderPredicate = {
    threshold: diff - 1,
    comparison: "GreaterThan",
  };

  const data = encodeValidateStatArgs({
    discriminator: VALIDATE_STAT_DISCRIMINATOR,
    ts: validation.summary.updateStats.minTimestamp,
    fixtureSummary,
    fixtureProof: validation.subTreeProof,
    mainTreeProof: validation.mainTreeProof,
    predicate,
    statA,
    statB,
    op: "Subtract",
  });

  const ix = new web3.TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [{ pubkey: dailyScoresPda, isSigner: false, isWritable: false }],
    data,
  });
  const computeIx = web3.ComputeBudgetProgram.setComputeUnitLimit({
    units: 1_400_000,
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

  console.log("Sending validate_stat TRUE-predicate transaction...");
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    preflightCommitment: "confirmed",
  });
  console.log("Tx:", sig);
  const conf = await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed"
  );

  if (conf.value.err) {
    throw new Error(
      `validate_stat transaction failed: ${JSON.stringify(conf.value.err)}`
    );
  }

  const txInfo = await connection.getTransaction(sig, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  const returnLog = (txInfo?.meta?.logMessages ?? []).find((l: string) =>
    l.startsWith("Program return:")
  );
  const evalLog = (txInfo?.meta?.logMessages ?? []).find((l: string) =>
    l.includes("Evaluate predicate to:")
  );

  console.log("Compute units consumed:", txInfo?.meta?.computeUnitsConsumed);
  console.log(evalLog ?? "(no eval log found)");
  console.log(returnLog ?? "(no return log found)");
  console.log(`Explorer: https://explorer.solana.com/tx/${sig}?cluster=devnet`);

  const b64 = returnLog?.split(" ").pop();
  const returnedBool = b64 ? Buffer.from(b64, "base64")[0] === 1 : null;

  if (!evalLog?.includes("true") || returnedBool !== true) {
    throw new Error(
      `Expected TRUE-predicate validate_stat to evaluate true; got evalLog=${evalLog} returnedBool=${returnedBool}`
    );
  }

  console.log(
    "\nM0 SMOKE TEST: PASS (validate_stat TRUE-predicate call succeeded on devnet, decoded return = true)"
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("M0 SMOKE TEST: FAIL —", e instanceof Error ? e.message : e);
    process.exit(1);
  });
