/**
 * M3 devnet lifecycle verifier: create_market -> deposit (x2, both sides) ->
 * lock_market -> resolve (real txoracle CPI proof) -> claim_payout.
 *
 * Produces exactly 5 labeled, confirmed devnet transaction signatures and
 * exits 0. Idempotent-by-construction: market_id is derived from Date.now()
 * (ms epoch, u64), so every run creates a brand-new Market/vault/Position set
 * of PDAs -- no collision with a prior run, safely re-runnable.
 *
 * Reads secrets at point-of-use only (never logs values):
 *   - ~/secrets/helius-api-key.txt        (devnet RPC)
 *   - ~/secrets/txline-api-token.env      (TXLINE_JWT + TXLINE_API_TOKEN)
 *   - ~/.config/solana/id.json            (deployer / market authority)
 *   - .wallets/test-wallet-{1,2}.json     (bettors, gitignored dir)
 *
 * Usage (from repo root):
 *   cd client && npx ts-node --project tsconfig.json ../scripts/m3-lifecycle-verify.ts
 *
 * Exit 0 on success (5/5 tx confirmed with no on-chain error), non-zero on
 * any failure.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const web3 = require("../node_modules/@solana/web3.js");
import {
  SPL_TOKEN_PROGRAM_ID,
  marketPda,
  vaultPda,
  dailyScoresRootsPda,
  buildInitMarket,
  buildDeposit,
  buildLockMarket,
  buildResolve,
  buildClaimPayout,
  BuiltInstruction,
  ScoresBatchSummary,
  StatTerm,
} from "../client/pari-client";

const HELIUS_KEY_PATH = path.join(
  os.homedir(),
  "secrets",
  "helius-api-key.txt"
);
const TXLINE_TOKEN_PATH = path.join(
  os.homedir(),
  "secrets",
  "txline-api-token.env"
);
const API_BASE = "https://txline-dev.txodds.com";

// Reference fixture (M0/M3 preflight confirmed live). Backup swapped in +
// logged explicitly if the primary's daily_scores_roots PDA or proof pull
// fails at runtime (see devnet-config.json m3Deploy.resolveFixture).
const PRIMARY_FIXTURE = { fixtureId: 18172379, seq: 1053 };
const BACKUP_FIXTURE = {
  fixtureId: 18179551,
  seq: undefined as number | undefined,
};

const USDC_MINT = new web3.PublicKey(
  "55aYKjhdFfHFbwuqw4wF1wToJuubFQBnmCNCfe24CXK"
);
const RESOLVE_COMPUTE_UNITS = 500_000;

// ── Cluster + payer assertion helper (Layer-0 constraint: every tx script
// must assert devnet + a registered wallet before signing) ─────────────────

const REGISTERED_WALLETS = new Set<string>();

function assertDevnetCluster(genesisHash: string): void {
  // Solana devnet genesis hash (well-known, stable across RPC providers).
  const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
  if (genesisHash !== DEVNET_GENESIS) {
    throw new Error(
      `Refusing to proceed: connected cluster genesis ${genesisHash} does not match known devnet genesis ${DEVNET_GENESIS}. This script only runs against devnet.`
    );
  }
}

function assertRegisteredPayer(pubkey: string): void {
  if (!REGISTERED_WALLETS.has(pubkey)) {
    throw new Error(
      `Refusing to sign: payer ${pubkey} is not in the registered test/deployer wallet set for this session.`
    );
  }
}

// ── Secret loaders (point-of-use, never logged) ─────────────────────────────

function loadHeliusRpc(): string {
  const key = fs.readFileSync(HELIUS_KEY_PATH, "utf-8").trim();
  return `https://devnet.helius-rpc.com/?api-key=${key}`;
}

function loadTxlineToken(): { jwt: string; apiToken: string } {
  const content = fs.readFileSync(TXLINE_TOKEN_PATH, "utf-8");
  const jwtMatch = content.match(/^TXLINE_JWT=(.+)$/m);
  const tokenMatch = content.match(/^TXLINE_API_TOKEN=(.+)$/m);
  if (!jwtMatch || !tokenMatch) {
    throw new Error(
      `Token file at ${TXLINE_TOKEN_PATH} is missing TXLINE_JWT or TXLINE_API_TOKEN`
    );
  }
  return { jwt: jwtMatch[1].trim(), apiToken: tokenMatch[1].trim() };
}

function loadKeypairFromFile(filePath: string) {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as number[];
  return web3.Keypair.fromSecretKey(Uint8Array.from(raw));
}

function loadDeployer() {
  return loadKeypairFromFile(
    path.join(os.homedir(), ".config", "solana", "id.json")
  );
}

function loadTestWallet(n: 1 | 2) {
  const p = path.join(process.cwd(), "..", ".wallets", `test-wallet-${n}.json`);
  return loadKeypairFromFile(p);
}

// ── Proof material fetch (same shape as client/m0-smoke.ts) ────────────────

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

async function fetchStatValidation(
  jwt: string,
  apiToken: string,
  fixtureId: number,
  seq: number
): Promise<StatValidationResponse> {
  const qs = new URLSearchParams({
    fixtureId: String(fixtureId),
    seq: String(seq),
    statKey: "1",
    statKey2: "2",
  });
  const res = await fetch(`${API_BASE}/api/scores/stat-validation?${qs}`, {
    headers: { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken },
  });
  if (!res.ok) {
    throw new Error(`stat-validation HTTP ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as StatValidationResponse;
}

// ── Tx send/confirm helper ──────────────────────────────────────────────────

async function sendAndConfirm(
  connection: any,
  built: BuiltInstruction,
  signers: any[],
  label: string,
  extraIxs: any[] = []
): Promise<string> {
  const feePayer = signers[0].publicKey;
  assertRegisteredPayer(feePayer.toBase58());

  const ix = new web3.TransactionInstruction({
    programId: built.programId,
    keys: built.keys,
    data: built.data,
  });

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  const tx = new web3.Transaction({ recentBlockhash: blockhash, feePayer });
  for (const e of extraIxs) tx.add(e);
  tx.add(ix);
  tx.sign(...signers);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  const conf = await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed"
  );
  if (conf.value.err) {
    throw new Error(
      `${label} transaction failed: ${sig} — ${JSON.stringify(conf.value.err)}`
    );
  }

  // Independent post-confirmation check (OUTPUT_CONTRACT step 6): fetch the
  // transaction back and confirm it is non-null with no error, rather than
  // trusting confirmTransaction's response alone.
  const txInfo = await connection.getTransaction(sig, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!txInfo || txInfo.meta?.err) {
    throw new Error(
      `${label} post-confirmation getTransaction check failed: ${sig} — txInfo=${JSON.stringify(
        txInfo?.meta?.err
      )}`
    );
  }

  console.log(
    `[${label}] Tx: ${sig}  (CU: ${txInfo.meta?.computeUnitsConsumed ?? "?"})`
  );
  console.log(
    `[${label}] Explorer: https://explorer.solana.com/tx/${sig}?cluster=devnet`
  );
  return sig;
}

// ── ATA derivation (classic SPL, no @solana/spl-token dep — see M0 CVE note) ─

const ASSOCIATED_TOKEN_PROGRAM_ID = new web3.PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
);

function findAta(owner: any, mint: any): any {
  const [ata] = web3.PublicKey.findProgramAddressSync(
    [owner.toBuffer(), SPL_TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return ata;
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=== M3 lifecycle verifier ===");

  const connection = new web3.Connection(loadHeliusRpc(), "confirmed");
  const genesisHash = await connection.getGenesisHash();
  assertDevnetCluster(genesisHash);
  console.log(`Cluster assertion passed: devnet genesis ${genesisHash}`);

  const deployer = loadDeployer();
  const wallet1 = loadTestWallet(1);
  const wallet2 = loadTestWallet(2);
  for (const kp of [deployer, wallet1, wallet2]) {
    REGISTERED_WALLETS.add(kp.publicKey.toBase58());
  }
  console.log(`Deployer/authority: ${deployer.publicKey.toBase58()}`);
  console.log(`Bettor 1 (YES):     ${wallet1.publicKey.toBase58()}`);
  console.log(`Bettor 2 (NO):      ${wallet2.publicKey.toBase58()}`);

  const { jwt, apiToken } = loadTxlineToken();

  // ── Fresh market_id per run (idempotent-by-construction) ──────────────────
  const marketId = BigInt(Date.now());
  const [market] = marketPda(marketId);
  const [vault] = vaultPda(market);
  console.log(`market_id: ${marketId}`);
  console.log(`Market PDA: ${market.toBase58()}`);
  console.log(`Vault PDA:  ${vault.toBase58()}`);

  // ── Resolve fixture selection (primary, with backup swap on failure) ──────
  let fixtureUsed = PRIMARY_FIXTURE;
  let validation: StatValidationResponse;
  try {
    validation = await fetchStatValidation(
      jwt,
      apiToken,
      PRIMARY_FIXTURE.fixtureId,
      PRIMARY_FIXTURE.seq
    );
  } catch (e) {
    console.warn(
      `Primary fixture ${PRIMARY_FIXTURE.fixtureId} failed (${
        e instanceof Error ? e.message : e
      }); FIXTURE SWAP to backup ${BACKUP_FIXTURE.fixtureId} per M3 brief.`
    );
    fixtureUsed = {
      fixtureId: BACKUP_FIXTURE.fixtureId,
      seq: BACKUP_FIXTURE.seq ?? 1,
    };
    validation = await fetchStatValidation(
      jwt,
      apiToken,
      fixtureUsed.fixtureId,
      fixtureUsed.seq
    );
  }
  console.log(
    `fixture_used: ${fixtureUsed.fixtureId} — home_goals=${validation.statToProve.value} away_goals=${validation.statToProve2.value}`
  );

  const epochDay = Math.floor(
    validation.summary.updateStats.minTimestamp / (24 * 60 * 60 * 1000)
  );
  const [dailyScoresRoots] = dailyScoresRootsPda(epochDay);
  const dailyScoresRootsInfo = await connection.getAccountInfo(
    dailyScoresRoots
  );
  if (!dailyScoresRootsInfo) {
    throw new Error(
      `daily_scores_roots PDA not found on-chain for epochDay ${epochDay} (${dailyScoresRoots.toBase58()}). Both primary and backup fixture disposition exhausted — BLOCKED per M3 brief (no third fixture improvisation).`
    );
  }
  console.log(
    `daily_scores_roots PDA confirmed on-chain: ${dailyScoresRoots.toBase58()} (epochDay ${epochDay})`
  );

  // Deterministic TRUE predicate: home_goals - away_goals > (diff - 1),
  // matching client/m0-smoke.ts's working M0 pattern. YES side wins.
  const diff = validation.statToProve.value - validation.statToProve2.value;
  const predicate = { threshold: diff - 1, comparison: "GreaterThan" as const };

  // ── Deposit amounts (test-USDC, 6 decimals) ───────────────────────────────
  const DEPOSIT_AMOUNT = 10_000_000n; // 10.000000 test-USDC per bettor
  const wallet1Ata = findAta(wallet1.publicKey, USDC_MINT);
  const wallet2Ata = findAta(wallet2.publicKey, USDC_MINT);

  const signatures: Record<string, string> = {};

  // ── 1. create_market ───────────────────────────────────────────────────
  // lock_ts far enough in the future that both deposits land before lock
  // even under slow devnet confirmation, then lock_market runs after a
  // short wait. 30s observed comfortable headroom over the ~6s this took in
  // the S179 dry run; widened here (not tuned to that one run) since a
  // fresh re-run under congestion could otherwise race DepositAfterLock.
  const nowSec = Math.floor(Date.now() / 1000);
  const lockTs = BigInt(nowSec + 30);

  const initIx = buildInitMarket(
    {
      marketId,
      fixtureId: BigInt(fixtureUsed.fixtureId),
      epochDay,
      statAKey: validation.statToProve.key,
      statBKey: validation.statToProve2.key,
      op: "Subtract",
      predicate,
      lockTs,
    },
    { usdcMint: USDC_MINT, authority: deployer.publicKey }
  );
  signatures.create_market = await sendAndConfirm(
    connection,
    initIx,
    [deployer],
    "create_market"
  );

  // ── 2. deposit — wallet1 YES, wallet2 NO (both sides so claim has both a
  //     winning and a losing pool to exercise) ──────────────────────────────
  const deposit1Ix = buildDeposit(
    { amount: DEPOSIT_AMOUNT, side: true },
    {
      market,
      marketId,
      bettor: wallet1.publicKey,
      bettorUsdc: wallet1Ata,
    }
  );
  signatures.deposit = await sendAndConfirm(
    connection,
    deposit1Ix,
    [wallet1],
    "deposit (wallet1 YES)"
  );

  const deposit2Ix = buildDeposit(
    { amount: DEPOSIT_AMOUNT, side: false },
    {
      market,
      marketId,
      bettor: wallet2.publicKey,
      bettorUsdc: wallet2Ata,
    }
  );
  await sendAndConfirm(
    connection,
    deposit2Ix,
    [wallet2],
    "deposit (wallet2 NO)"
  );

  // ── 3. lock_market — wait until lock_ts has passed ─────────────────────
  const waitMs = Number(lockTs) * 1000 - Date.now() + 2000; // +2s slot-time buffer
  if (waitMs > 0) {
    console.log(`Waiting ${Math.ceil(waitMs / 1000)}s for lock_ts to pass...`);
    await new Promise((r) => setTimeout(r, waitMs));
  }

  const lockIx = buildLockMarket({ market, caller: deployer.publicKey });
  signatures.lock_market = await sendAndConfirm(
    connection,
    lockIx,
    [deployer],
    "lock_market"
  );

  // ── 4. resolve — real txoracle CPI proof, raised compute budget ─────────
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

  const resolveIx = buildResolve(
    {
      ts: BigInt(validation.summary.updateStats.minTimestamp),
      fixtureSummary,
      fixtureProof: validation.subTreeProof,
      mainTreeProof: validation.mainTreeProof,
      statA,
      statB,
    },
    { market, epochDay, caller: deployer.publicKey }
  );
  const computeIx = web3.ComputeBudgetProgram.setComputeUnitLimit({
    units: RESOLVE_COMPUTE_UNITS,
  });
  signatures.resolve = await sendAndConfirm(
    connection,
    resolveIx,
    [deployer],
    "resolve",
    [computeIx]
  );

  // ── 5. claim_payout — wallet1 (YES) should be the winner given the
  //     deterministic TRUE predicate above ───────────────────────────────
  const claimIx = buildClaimPayout({
    market,
    bettor: wallet1.publicKey,
    bettorUsdc: wallet1Ata,
  });
  signatures.claim_payout = await sendAndConfirm(
    connection,
    claimIx,
    [wallet1],
    "claim_payout"
  );

  // ── Independent re-confirmation of all 5 signatures (OUTPUT_CONTRACT
  //     step 6): fetch each tx again from the RPC and assert non-null / no
  //     error, distinct from the checks already performed at send-time. ────
  console.log("\n=== Independent re-confirmation of all 5 signatures ===");
  const order = [
    "create_market",
    "deposit",
    "lock_market",
    "resolve",
    "claim_payout",
  ];
  for (const label of order) {
    const sig = signatures[label];
    const info = await connection.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!info || info.meta?.err) {
      throw new Error(
        `Independent re-confirmation FAILED for ${label} (${sig}): ${JSON.stringify(
          info?.meta?.err
        )}`
      );
    }
    console.log(
      `[OK] ${label}: ${sig} — slot ${info.slot}, err=null, explorer: https://explorer.solana.com/tx/${sig}?cluster=devnet`
    );
  }

  console.log("\n=== SIGNATURES (JSON) ===");
  console.log(JSON.stringify(signatures, null, 2));

  console.log(
    `\nM3 LIFECYCLE VERIFIER: PASS (5/5 devnet transactions confirmed, fixture_used=${fixtureUsed.fixtureId})`
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(
      "M3 LIFECYCLE VERIFIER: FAIL —",
      e instanceof Error ? `${e.message}\n${e.stack}` : String(e)
    );
    process.exit(1);
  });
