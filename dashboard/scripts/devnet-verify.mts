#!/usr/bin/env -S node --experimental-strip-types
/**
 * Devnet instruction proof for a fresh market lifecycle where the deposit
 * and claim_payout instructions are built by dashboard/src/lib/instructions.ts
 * (buildDepositInstruction / buildClaimPayoutInstruction) -- proving the
 * dashboard's own instruction builders, not just their field-level
 * equivalence to client/pari-client.ts (already covered by
 * instructions.test.ts), actually land on-chain.
 *
 * Copies the scripts/m3-lifecycle-verify.ts pattern (create_market ->
 * deposit -> lock_market -> resolve -> claim_payout, idempotent-by-
 * construction via Date.now()-derived market_id) into dashboard/scripts/
 * `init_market`, `lock_market`, and `resolve` are re-derived
 * locally rather than imported from client/pari-client.ts at runtime,
 * for two reasons: (1) FRONTEND-ONLY scope forbids depending on or editing
 * anything under client/, and (2) client/node_modules doesn't exist in this
 * environment and client/package.json (read-only) doesn't declare
 * @solana/web3.js, so a runtime import would require editing client/ to add
 * it. This matches the self-contained pattern already established in
 * src/lib/pari.ts and src/lib/instructions.ts's own header comments
 * ("re-derives... instead of importing client/pari-client.ts's builders at
 * runtime"). The Borsh encoding below is a faithful line-for-line
 * transcription of client/pari-client.ts's Writer/buildInitMarket/
 * buildLockMarket/buildResolve (read, never edited).
 *
 * Uses ONE existing CLI keypair (~/.config/solana/id.json) for every role --
 * deployer/authority, test-USDC mint authority, AND bettor -- since no
 * pre-funded multi-wallet test fixture (.wallets/test-wallet-*.json) exists
 * in this environment. A fresh disposable test-USDC mint is created and
 * funded to that same wallet's ATA (mint authority = that wallet), since the
 * project's CANONICAL_USDC_MINT has no mint-authority access available here
 * and the wallet holds no ATA for it. This is throwaway devnet
 * infrastructure for this one proof run, not a production mint.
 *
 * Because a single wallet plays every role, only ONE side is exercised
 * (YES) -- Position is seeded [market, bettor] with no side component, so a
 * second deposit from the same wallet on the other side would fail
 * SideMismatch by design. The market resolves YES (deterministic TRUE
 * predicate, matching m3's approach), so this sole depositor is also the
 * sole winner: claim_payout pays back exactly 100% of the deposit (the
 * degenerate single-depositor case), which is still a full, real exercise
 * of both dashboard-authored instruction builders end-to-end on devnet.
 *
 * Run (from dashboard/):
 *   node --experimental-strip-types scripts/devnet-verify.mts
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  buildClaimPayoutInstruction,
  buildDepositInstruction,
  PARI_MARKET_PROGRAM_ID,
} from "../src/lib/instructions.ts";
import { marketSeedBuffer } from "../src/lib/pari.ts";

const HELIUS_KEY_PATH = path.join(os.homedir(), "secrets", "helius-api-key.txt");
const TXLINE_TOKEN_PATH = path.join(os.homedir(), "secrets", "txline-api-token.env");
const API_BASE = "https://txline-dev.txodds.com";

const PRIMARY_FIXTURE = { fixtureId: 18172379, seq: 1053 };
const BACKUP_FIXTURE = { fixtureId: 18179551, seq: undefined as number | undefined };

const RESOLVE_COMPUTE_UNITS = 500_000;
const DEPOSIT_AMOUNT = 10_000_000n; // 10.000000 test-USDC
const MINT_TO_AMOUNT = 100_000_000n; // 100.000000 test-USDC, minted to self

const SPL_TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);
const TXORACLE_PROGRAM_ID = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
const MINT_ACCOUNT_SIZE = 82; // SPL Mint layout, fixed size

// ── Secret / cluster / keypair loaders (point-of-use, never logged) ────────

function loadHeliusRpc(): string {
  const key = fs.readFileSync(HELIUS_KEY_PATH, "utf-8").trim();
  return `https://devnet.helius-rpc.com/?api-key=${key}`;
}

function loadTxlineToken(): { jwt: string; apiToken: string } {
  const content = fs.readFileSync(TXLINE_TOKEN_PATH, "utf-8");
  const jwtMatch = content.match(/^TXLINE_JWT=(.+)$/m);
  const tokenMatch = content.match(/^TXLINE_API_TOKEN=(.+)$/m);
  if (!jwtMatch || !tokenMatch) {
    throw new Error(`Token file at ${TXLINE_TOKEN_PATH} is missing TXLINE_JWT/TXLINE_API_TOKEN`);
  }
  return { jwt: jwtMatch[1].trim(), apiToken: tokenMatch[1].trim() };
}

function loadWallet(): Keypair {
  const raw = JSON.parse(
    fs.readFileSync(path.join(os.homedir(), ".config", "solana", "id.json"), "utf-8"),
  ) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function assertDevnetCluster(genesisHash: string): void {
  const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
  if (genesisHash !== DEVNET_GENESIS) {
    throw new Error(
      `Refusing to proceed: connected cluster genesis ${genesisHash} does not match devnet ${DEVNET_GENESIS}.`,
    );
  }
}

// ── Borsh Writer (faithful transcription of client/pari-client.ts's Writer;
//    read-only source, never imported at runtime -- see header comment) ────

class Writer {
  private chunks: Buffer[] = [];
  u8(v: number): this {
    const b = Buffer.alloc(1);
    b.writeUInt8(v, 0);
    this.chunks.push(b);
    return this;
  }
  bool(v: boolean): this {
    return this.u8(v ? 1 : 0);
  }
  i32(v: number): this {
    const b = Buffer.alloc(4);
    b.writeInt32LE(v, 0);
    this.chunks.push(b);
    return this;
  }
  u32(v: number): this {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v, 0);
    this.chunks.push(b);
    return this;
  }
  u16(v: number): this {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(v, 0);
    this.chunks.push(b);
    return this;
  }
  u64(v: bigint): this {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(v, 0);
    this.chunks.push(b);
    return this;
  }
  i64(v: number | bigint): this {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(BigInt(v), 0);
    this.chunks.push(b);
    return this;
  }
  bytes32(v: number[]): this {
    if (v.length !== 32) throw new Error(`expected 32 bytes, got ${v.length}`);
    this.chunks.push(Buffer.from(v));
    return this;
  }
  raw(b: Buffer): this {
    this.chunks.push(b);
    return this;
  }
  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

function writeOption<T>(w: Writer, v: T | null | undefined, writeItem: (w: Writer, item: T) => void): void {
  if (v !== null && v !== undefined) {
    w.bool(true);
    writeItem(w, v);
  } else {
    w.bool(false);
  }
}
function writeVec<T>(w: Writer, items: T[], writeItem: (w: Writer, item: T) => void): void {
  w.u32(items.length);
  for (const item of items) writeItem(w, item);
}
function writeProofNode(w: Writer, n: { hash: number[]; isRightSibling: boolean }): void {
  w.bytes32(n.hash).bool(n.isRightSibling);
}
function writeScoreStat(w: Writer, s: { key: number; value: number; period: number }): void {
  w.u32(s.key).i32(s.value).i32(s.period);
}
function writeStatTerm(
  w: Writer,
  t: {
    statToProve: { key: number; value: number; period: number };
    eventStatRoot: number[];
    statProof: { hash: number[]; isRightSibling: boolean }[];
  },
): void {
  writeScoreStat(w, t.statToProve);
  w.bytes32(t.eventStatRoot);
  writeVec(w, t.statProof, writeProofNode);
}

const IX_DISCRIMINATOR = {
  init_market: [33, 253, 15, 116, 89, 25, 127, 236],
  lock_market: [107, 8, 184, 91, 223, 13, 180, 38],
  resolve: [246, 150, 236, 206, 108, 63, 58, 10],
};

function dailyScoresRootsPda(epochDay: number): PublicKey {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(epochDay, 0);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("daily_scores_roots"), buf],
    TXORACLE_PROGRAM_ID,
  );
  return pda;
}

function marketPda(marketId: bigint): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(marketSeedBuffer(marketId), PARI_MARKET_PROGRAM_ID);
  return pda;
}

function vaultPdaOf(market: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], PARI_MARKET_PROGRAM_ID);
  return pda;
}

function buildInitMarketIx(
  marketId: bigint,
  fixtureId: bigint,
  epochDay: number,
  statAKey: number,
  statBKey: number,
  op: "Subtract",
  predicate: { threshold: number; comparison: "GreaterThan" },
  lockTs: bigint,
  usdcMint: PublicKey,
  authority: PublicKey,
): TransactionInstruction {
  const market = marketPda(marketId);
  const vault = vaultPdaOf(market);
  const RENT_SYSVAR_ID = new PublicKey("SysvarRent111111111111111111111111111111111");
  const SYSTEM_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");

  const w = new Writer();
  w.raw(Buffer.from(IX_DISCRIMINATOR.init_market));
  w.u64(marketId);
  w.i64(fixtureId);
  w.u16(epochDay);
  w.u32(statAKey);
  writeOption(w, statBKey, (w2, v) => w2.u32(v));
  writeOption(w, op, (w2) => w2.u8(1)); // Subtract == index 1
  w.i32(predicate.threshold).u8(0); // GreaterThan == index 0
  w.i64(lockTs);

  return new TransactionInstruction({
    programId: PARI_MARKET_PROGRAM_ID,
    keys: [
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: usdcMint, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: RENT_SYSVAR_ID, isSigner: false, isWritable: false },
    ],
    data: w.toBuffer(),
  });
}

function buildLockMarketIx(market: PublicKey, caller: PublicKey): TransactionInstruction {
  const w = new Writer();
  w.raw(Buffer.from(IX_DISCRIMINATOR.lock_market));
  return new TransactionInstruction({
    programId: PARI_MARKET_PROGRAM_ID,
    keys: [
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: caller, isSigner: true, isWritable: false },
    ],
    data: w.toBuffer(),
  });
}

function buildResolveIx(
  market: PublicKey,
  epochDay: number,
  caller: PublicKey,
  ts: bigint,
  fixtureSummary: {
    fixtureId: number;
    updateStats: { updateCount: number; minTimestamp: number; maxTimestamp: number };
    eventsSubTreeRoot: number[];
  },
  fixtureProof: { hash: number[]; isRightSibling: boolean }[],
  mainTreeProof: { hash: number[]; isRightSibling: boolean }[],
  statA: {
    statToProve: { key: number; value: number; period: number };
    eventStatRoot: number[];
    statProof: { hash: number[]; isRightSibling: boolean }[];
  },
  statB: typeof statA,
): TransactionInstruction {
  const dailyScoresMerkleRoots = dailyScoresRootsPda(epochDay);

  const w = new Writer();
  w.raw(Buffer.from(IX_DISCRIMINATOR.resolve));
  w.i64(ts);
  w.i64(fixtureSummary.fixtureId);
  w.i32(fixtureSummary.updateStats.updateCount)
    .i64(fixtureSummary.updateStats.minTimestamp)
    .i64(fixtureSummary.updateStats.maxTimestamp);
  w.bytes32(fixtureSummary.eventsSubTreeRoot);
  writeVec(w, fixtureProof, writeProofNode);
  writeVec(w, mainTreeProof, writeProofNode);
  writeStatTerm(w, statA);
  writeOption(w, statB, writeStatTerm);

  return new TransactionInstruction({
    programId: PARI_MARKET_PROGRAM_ID,
    keys: [
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: dailyScoresMerkleRoots, isSigner: false, isWritable: false },
      { pubkey: TXORACLE_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: caller, isSigner: true, isWritable: false },
    ],
    data: w.toBuffer(),
  });
}

// ── SPL token raw instructions (no @solana/spl-token dep -- CVE note in
//    client/pari-client.ts's header applies workspace-wide) ────────────────

function findAta(owner: PublicKey, mint: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), SPL_TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return ata;
}

function initializeMint2Ix(mint: PublicKey, decimals: number, mintAuthority: PublicKey): TransactionInstruction {
  const data = Buffer.alloc(2 + 32 + 1);
  data.writeUInt8(20, 0); // InitializeMint2 tag
  data.writeUInt8(decimals, 1);
  mintAuthority.toBuffer().copy(data, 2);
  data.writeUInt8(0, 34); // no freeze authority
  return new TransactionInstruction({
    programId: SPL_TOKEN_PROGRAM_ID,
    keys: [{ pubkey: mint, isSigner: false, isWritable: true }],
    data,
  });
}

function createAtaIx(payer: PublicKey, owner: PublicKey, mint: PublicKey): TransactionInstruction {
  const ata = findAta(owner, mint);
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: new PublicKey("11111111111111111111111111111111"), isSigner: false, isWritable: false },
      { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.alloc(0),
  });
}

function mintToIx(mint: PublicKey, destination: PublicKey, authority: PublicKey, amount: bigint): TransactionInstruction {
  const data = Buffer.alloc(9);
  data.writeUInt8(7, 0); // MintTo tag
  data.writeBigUInt64LE(amount, 1);
  return new TransactionInstruction({
    programId: SPL_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}

// ── Tx send/confirm helper (mirrors m3-lifecycle-verify.ts) ───────────────

async function sendAndConfirm(
  connection: Connection,
  ixs: TransactionInstruction[],
  signers: Keypair[],
  label: string,
): Promise<string> {
  const feePayer = signers[0].publicKey;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ recentBlockhash: blockhash, feePayer });
  for (const ix of ixs) tx.add(ix);
  tx.sign(...signers);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  const conf = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (conf.value.err) {
    throw new Error(`${label} transaction failed: ${sig} — ${JSON.stringify(conf.value.err)}`);
  }
  const txInfo = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!txInfo || txInfo.meta?.err) {
    throw new Error(`${label} post-confirmation check failed: ${sig} — ${JSON.stringify(txInfo?.meta?.err)}`);
  }
  console.log(`[${label}] Tx: ${sig}`);
  console.log(`[${label}] Explorer: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
  return sig;
}

interface StatValidationResponse {
  statToProve: { key: number; value: number; period: number };
  statToProve2: { key: number; value: number; period: number };
  eventStatRoot: number[];
  summary: {
    fixtureId: number;
    updateStats: { updateCount: number; minTimestamp: number; maxTimestamp: number };
    eventStatsSubTreeRoot: number[];
  };
  statProof: { hash: number[]; isRightSibling: boolean }[];
  statProof2: { hash: number[]; isRightSibling: boolean }[];
  subTreeProof: { hash: number[]; isRightSibling: boolean }[];
  mainTreeProof: { hash: number[]; isRightSibling: boolean }[];
}

async function fetchStatValidation(jwt: string, apiToken: string, fixtureId: number, seq: number): Promise<StatValidationResponse> {
  const qs = new URLSearchParams({ fixtureId: String(fixtureId), seq: String(seq), statKey: "1", statKey2: "2" });
  const res = await fetch(`${API_BASE}/api/scores/stat-validation?${qs}`, {
    headers: { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken },
  });
  if (!res.ok) throw new Error(`stat-validation HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as StatValidationResponse;
}

// ── Main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=== dashboard devnet-verify (T3/T4 instruction proof) ===");

  const connection = new Connection(loadHeliusRpc(), "confirmed");
  const genesisHash = await connection.getGenesisHash();
  assertDevnetCluster(genesisHash);
  console.log(`Cluster assertion passed: devnet genesis ${genesisHash}`);

  const wallet = loadWallet();
  console.log(`Wallet (deployer + mint authority + bettor): ${wallet.publicKey.toBase58()}`);

  const { jwt, apiToken } = loadTxlineToken();

  // ── Fresh disposable test-USDC mint (wallet is mint authority) ─────────
  const mintKeypair = Keypair.generate();
  const mintRent = await connection.getMinimumBalanceForRentExemption(MINT_ACCOUNT_SIZE);
  const createMintIx = SystemProgram.createAccount({
    fromPubkey: wallet.publicKey,
    newAccountPubkey: mintKeypair.publicKey,
    lamports: mintRent,
    space: MINT_ACCOUNT_SIZE,
    programId: SPL_TOKEN_PROGRAM_ID,
  });
  const initMintIx = initializeMint2Ix(mintKeypair.publicKey, 6, wallet.publicKey);
  await sendAndConfirm(connection, [createMintIx, initMintIx], [wallet, mintKeypair], "create_test_mint");
  console.log(`Test-USDC mint: ${mintKeypair.publicKey.toBase58()}`);

  const walletAta = findAta(wallet.publicKey, mintKeypair.publicKey);
  const createAtaAndMintIx = [
    createAtaIx(wallet.publicKey, wallet.publicKey, mintKeypair.publicKey),
    mintToIx(mintKeypair.publicKey, walletAta, wallet.publicKey, MINT_TO_AMOUNT),
  ];
  await sendAndConfirm(connection, createAtaAndMintIx, [wallet], "create_ata_and_mint");
  console.log(`Wallet USDC ATA: ${walletAta.toBase58()} (funded ${MINT_TO_AMOUNT} base units)`);

  // ── Fixture selection (primary, backup swap on failure) ────────────────
  let fixtureUsed = PRIMARY_FIXTURE;
  let validation: StatValidationResponse;
  try {
    validation = await fetchStatValidation(jwt, apiToken, PRIMARY_FIXTURE.fixtureId, PRIMARY_FIXTURE.seq);
  } catch (e) {
    console.warn(`Primary fixture failed (${e instanceof Error ? e.message : e}); swapping to backup.`);
    fixtureUsed = { fixtureId: BACKUP_FIXTURE.fixtureId, seq: BACKUP_FIXTURE.seq ?? 1 };
    validation = await fetchStatValidation(jwt, apiToken, fixtureUsed.fixtureId, fixtureUsed.seq);
  }
  console.log(
    `fixture_used: ${fixtureUsed.fixtureId} — home_goals=${validation.statToProve.value} away_goals=${validation.statToProve2.value}`,
  );

  const epochDay = Math.floor(validation.summary.updateStats.minTimestamp / (24 * 60 * 60 * 1000));
  const dailyScoresRoots = dailyScoresRootsPda(epochDay);
  const dailyScoresRootsInfo = await connection.getAccountInfo(dailyScoresRoots);
  if (!dailyScoresRootsInfo) {
    throw new Error(
      `daily_scores_roots PDA not found on-chain for epochDay ${epochDay} (${dailyScoresRoots.toBase58()}). BLOCKED.`,
    );
  }
  console.log(`daily_scores_roots PDA confirmed: ${dailyScoresRoots.toBase58()}`);

  const diff = validation.statToProve.value - validation.statToProve2.value;
  const predicate = { threshold: diff - 1, comparison: "GreaterThan" as const };

  const marketId = BigInt(Date.now());
  const market = marketPda(marketId);
  console.log(`market_id: ${marketId}`);
  console.log(`Market PDA: ${market.toBase58()}`);

  const signatures: Record<string, string> = {};

  const nowSec = Math.floor(Date.now() / 1000);
  const lockTs = BigInt(nowSec + 30);

  signatures.create_market = await sendAndConfirm(
    connection,
    [
      buildInitMarketIx(
        marketId,
        BigInt(fixtureUsed.fixtureId),
        epochDay,
        validation.statToProve.key,
        validation.statToProve2.key,
        "Subtract",
        predicate,
        lockTs,
        mintKeypair.publicKey,
        wallet.publicKey,
      ),
    ],
    [wallet],
    "create_market",
  );

  // ── deposit -- dashboard/src/lib/instructions.ts's buildDepositInstruction ─
  signatures.deposit = await sendAndConfirm(
    connection,
    [
      buildDepositInstruction({
        market,
        bettor: wallet.publicKey,
        bettorUsdc: walletAta,
        side: true, // YES
        amount: DEPOSIT_AMOUNT,
      }),
    ],
    [wallet],
    "deposit (dashboard builder, YES)",
  );

  const waitMs = Number(lockTs) * 1000 - Date.now() + 2000;
  if (waitMs > 0) {
    console.log(`Waiting ${Math.ceil(waitMs / 1000)}s for lock_ts to pass...`);
    await new Promise((r) => setTimeout(r, waitMs));
  }

  signatures.lock_market = await sendAndConfirm(
    connection,
    [buildLockMarketIx(market, wallet.publicKey)],
    [wallet],
    "lock_market",
  );

  const fixtureSummary = {
    fixtureId: validation.summary.fixtureId,
    updateStats: {
      updateCount: validation.summary.updateStats.updateCount,
      minTimestamp: validation.summary.updateStats.minTimestamp,
      maxTimestamp: validation.summary.updateStats.maxTimestamp,
    },
    eventsSubTreeRoot: validation.summary.eventStatsSubTreeRoot,
  };
  const statA = { statToProve: validation.statToProve, eventStatRoot: validation.eventStatRoot, statProof: validation.statProof };
  const statB = { statToProve: validation.statToProve2, eventStatRoot: validation.eventStatRoot, statProof: validation.statProof2 };

  const computeIx = ComputeBudgetProgram.setComputeUnitLimit({ units: RESOLVE_COMPUTE_UNITS });
  signatures.resolve = await sendAndConfirm(
    connection,
    [
      computeIx,
      buildResolveIx(
        market,
        epochDay,
        wallet.publicKey,
        BigInt(validation.summary.updateStats.minTimestamp),
        fixtureSummary,
        validation.subTreeProof,
        validation.mainTreeProof,
        statA,
        statB,
      ),
    ],
    [wallet],
    "resolve",
  );

  // ── claim_payout -- dashboard/src/lib/instructions.ts's builder ────────
  signatures.claim_payout = await sendAndConfirm(
    connection,
    [buildClaimPayoutInstruction({ market, bettor: wallet.publicKey, bettorUsdc: walletAta })],
    [wallet],
    "claim_payout (dashboard builder)",
  );

  console.log("\n=== Independent re-confirmation of all signatures ===");
  for (const [label, sig] of Object.entries(signatures)) {
    const info = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!info || info.meta?.err) {
      throw new Error(`Independent re-confirmation FAILED for ${label} (${sig}): ${JSON.stringify(info?.meta?.err)}`);
    }
    console.log(`[OK] ${label}: ${sig} — slot ${info.slot}, err=null`);
  }

  console.log("\n=== SIGNATURES (JSON) ===");
  console.log(JSON.stringify(signatures, null, 2));
  console.log(`\nDEVNET-VERIFY: PASS (dashboard deposit + claim_payout builders confirmed on-chain, fixture_used=${fixtureUsed.fixtureId})`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("DEVNET-VERIFY: FAIL —", e instanceof Error ? `${e.message}\n${e.stack}` : String(e));
    process.exit(1);
  });
