/**
 * C12 subscribe — send ONE fresh devnet subscribe tx to TxODDS oracle program.
 *
 * Replicates the exact instruction structure from confirmed tx:
 * 2TteFqS5SRRsGnQiZRphjg6k4co1pktnuKcZ1UpVRiTQ4aMMB1PdKCeVkm1z5mtdUEfcWicDX1FXiAT7VkrLzDuN
 *
 * DEVNET ONLY. No token/activate call. No mainnet.
 *
 * Usage:
 *   npx ts-node --project tsconfig.json subscribe-fresh.ts
 *
 * Writes result to ~/.arcana/c12-subscribe.json
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const web3 = require("../node_modules/@solana/web3.js");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bs58 = require("../node_modules/bs58");

// ---- Constants (devnet, confirmed) ----------------------------------------

const DEVNET_RPC = "https://api.devnet.solana.com";

const PROGRAM_ID = new web3.PublicKey(
  "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J"
);
const PRICING_MATRIX_PDA = new web3.PublicKey(
  "B4hHn1FpD1YPPrcM4yUrQhBPF18zFWgijHLTsumGzeKi"
);
const TOKEN_MINT = new web3.PublicKey(
  "4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG"
);
// Token treasury PDA (seed: "token_treasury_v2")
const TOKEN_TREASURY_PDA = new web3.PublicKey(
  "Eqqd7rZQGzn2HA9L11NwBMhknxArM3L4KETyUuujK3LB"
);
// Treasury token account (ATA of TOKEN_TREASURY_PDA for TOKEN_MINT)
const TREASURY_TOKEN_ACCOUNT = new web3.PublicKey(
  "dc6rQSPk8GJAeyyAtC1F62JoigmgEuLnW4k9zmgAeuM"
);
// Token-2022 program
const TOKEN_2022_PROGRAM = new web3.PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
);
// Associated Token Program
const ASSOCIATED_TOKEN_PROGRAM = new web3.PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
);
// System program
const SYSTEM_PROGRAM = new web3.PublicKey("11111111111111111111111111111111");

// Subscriber wallet pubkey
const SUBSCRIBER_PUBKEY = new web3.PublicKey(
  "8gbaJEfM5VDs9BpFLgwMTq7s2FkVpEri8ZnPbxn4HPqY"
);
// Subscriber ATA for TOKEN_MINT (already exists from prior subscribe)
const SUBSCRIBER_TOKEN_ACCOUNT = new web3.PublicKey(
  "Ai8vGeUTwY5GrjkSf4U5xnpW1kZnSiJ9D8uAP9yVWWtg"
);

// Subscribe instruction data from confirmed tx (discriminator + SL=1 + trailing args)
// [254, 28, 191, 138, 156, 179, 183, 53, 1, 0, 4]
// Bytes 0-7: discriminator 0xfe1cbf8a9cb3b735
// Byte 8: SL = 1
// Bytes 9-10: 0x00 0x04 (additional serialised args — replicate exactly)
const SUBSCRIBE_IX_DATA = Buffer.from([
  0xfe,
  0x1c,
  0xbf,
  0x8a,
  0x9c,
  0xb3,
  0xb7,
  0x35, // discriminator
  0x01, // service_level = 1
  0x00,
  0x04, // additional args (replicated verbatim from confirmed tx)
]);

// ---- Credential loading (read at point-of-use, never log value) -----------

function loadPrivKey(): Uint8Array {
  const walletPath = path.join(
    os.homedir(),
    "secrets",
    "solana-worldcup-devnet-wallet.md"
  );
  const content = fs.readFileSync(walletPath, "utf-8");
  const keyMatch = content.match(/private key\s*=\s*(\S+)/i);
  if (!keyMatch)
    throw new Error("Could not parse private key from wallet file");
  // decode base58 → Uint8Array (never log)
  return bs58.decode(keyMatch[1]) as Uint8Array;
}

// ---- Main -----------------------------------------------------------------

async function main(): Promise<void> {
  console.log("C12 subscribe: building fresh devnet subscribe tx...");

  // Load key at point-of-use
  const privKey = loadPrivKey();
  const signer = web3.Keypair.fromSecretKey(privKey);

  // Sanity check pubkey matches expected
  if (signer.publicKey.toBase58() !== SUBSCRIBER_PUBKEY.toBase58()) {
    throw new Error(
      `Wallet pubkey mismatch: got ${signer.publicKey.toBase58()}`
    );
  }
  console.log(`Signer confirmed: ${signer.publicKey.toBase58()}`);

  const connection = new web3.Connection(DEVNET_RPC, "confirmed");

  // Build subscribe instruction — replicating exact account order from confirmed tx
  // Instruction 0 accounts (in order as they appeared):
  // 0: subscriber (signer, writable)
  // 1: pricingMatrix PDA (read)
  // 2: tokenMint (read)
  // 3: subscriberTokenAccount (writable) — ATA of subscriber for mint
  // 4: treasuryTokenAccount (writable)  — ATA of treasury PDA for mint
  // 5: tokenTreasuryPda (read)
  // 6: Token-2022 program (read)
  // 7: System program (read)
  // 8: Associated Token program (read)
  const subscribeIx = new web3.TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: signer.publicKey, isSigner: true, isWritable: true }, // 0: subscriber
      { pubkey: PRICING_MATRIX_PDA, isSigner: false, isWritable: false }, // 1: pricingMatrix
      { pubkey: TOKEN_MINT, isSigner: false, isWritable: false }, // 2: tokenMint
      { pubkey: SUBSCRIBER_TOKEN_ACCOUNT, isSigner: false, isWritable: true }, // 3: subscriber ATA
      { pubkey: TREASURY_TOKEN_ACCOUNT, isSigner: false, isWritable: true }, // 4: treasury token account
      { pubkey: TOKEN_TREASURY_PDA, isSigner: false, isWritable: false }, // 5: tokenTreasuryPda
      { pubkey: TOKEN_2022_PROGRAM, isSigner: false, isWritable: false }, // 6: Token-2022
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false }, // 7: System
      { pubkey: ASSOCIATED_TOKEN_PROGRAM, isSigner: false, isWritable: false }, // 8: AToken
    ],
    data: SUBSCRIBE_IX_DATA,
  });

  // ComputeBudget instruction from confirmed tx: [2, 128, 26, 6, 0]
  // = SetComputeUnitLimit(400_000) encoded: opcode=2, value=0x0006_1a80=400000 LE
  const computeIx = new web3.TransactionInstruction({
    programId: new web3.PublicKey(
      "ComputeBudget111111111111111111111111111111"
    ),
    keys: [],
    data: Buffer.from([0x02, 0x80, 0x1a, 0x06, 0x00]),
  });

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");

  const tx = new web3.Transaction({
    recentBlockhash: blockhash,
    feePayer: signer.publicKey,
  });
  tx.add(subscribeIx);
  tx.add(computeIx);

  tx.sign(signer);

  console.log("Sending subscribe transaction to devnet...");
  const txSig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  console.log(`Tx sent: ${txSig}`);

  // Wait for confirmation
  console.log("Waiting for confirmation...");
  const confirmation = await connection.confirmTransaction(
    { signature: txSig, blockhash, lastValidBlockHeight },
    "confirmed"
  );

  if (confirmation.value.err) {
    throw new Error(
      `Transaction failed: ${JSON.stringify(confirmation.value.err)}`
    );
  }

  // Fetch slot
  const txInfo = await connection.getTransaction(txSig, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  const slot = txInfo?.slot ?? 0;

  console.log(`Confirmed in slot ${slot}`);

  // Write artifact
  const artifact = {
    txSig,
    slot,
    sl: 1,
    sentAt: new Date().toISOString(),
    wallet: SUBSCRIBER_PUBKEY.toBase58(),
  };

  const outPath = path.join(os.homedir(), ".arcana", "c12-subscribe.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2), "utf-8");
  console.log(`\nArtifact written to ${outPath}`);
  console.log(JSON.stringify(artifact, null, 2));
}

main().catch((err) => {
  console.error(
    "subscribe-fresh failed:",
    err instanceof Error ? `${err.message}\n${err.stack}` : String(err)
  );
  process.exit(1);
});
