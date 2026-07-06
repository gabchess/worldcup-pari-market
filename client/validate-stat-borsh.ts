/**
 * Manual Borsh encoder for the txoracle `validate_stat` instruction.
 *
 * No @coral-xyz/anchor dependency: socket flagged transitive CVEs
 * (bigint-buffer high, uuid moderate) on `@coral-xyz/anchor` + `@solana/spl-token`
 * for this one-shot M0 smoke test. All validate_stat arg types are simple
 * (structs, Vec<struct>, Option<struct>, 2-3-variant enums) so hand-rolled
 * Borsh encoding is a smaller, safer diff than pulling in the SDK.
 *
 * Layout rules (Anchor/Borsh):
 *   - struct: fields concatenated in declaration order
 *   - Vec<T>: u32 LE length prefix + elements
 *   - Option<T>: 1 byte tag (0=None, 1=Some) + value if Some
 *   - enum: u8 variant index (fieldless variants only, this program's enums)
 *   - fixed [u8;32]: raw 32 bytes
 *   - i64/u64: 8 bytes LE (BigInt)
 *   - i32/u32: 4 bytes LE
 */

export interface ProofNode {
  hash: number[]; // 32 bytes
  isRightSibling: boolean;
}

export interface ScoreStat {
  key: number; // u32
  value: number; // i32
  period: number; // i32
}

export interface StatTerm {
  statToProve: ScoreStat;
  eventStatRoot: number[]; // 32 bytes
  statProof: ProofNode[];
}

export interface ScoresUpdateStats {
  updateCount: number; // i32
  minTimestamp: number; // i64
  maxTimestamp: number; // i64
}

export interface ScoresBatchSummary {
  fixtureId: number; // i64
  updateStats: ScoresUpdateStats;
  eventsSubTreeRoot: number[]; // 32 bytes
}

export type Comparison = "GreaterThan" | "LessThan" | "EqualTo";
const COMPARISON_INDEX: Record<Comparison, number> = {
  GreaterThan: 0,
  LessThan: 1,
  EqualTo: 2,
};

export interface TraderPredicate {
  threshold: number; // i32
  comparison: Comparison;
}

export type BinaryExpression = "Add" | "Subtract";
const BINARY_EXPR_INDEX: Record<BinaryExpression, number> = {
  Add: 0,
  Subtract: 1,
};

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

function writeProofNode(w: Writer, n: ProofNode): void {
  w.bytes32(n.hash).bool(n.isRightSibling);
}

function writeVec<T>(
  w: Writer,
  items: T[],
  writeItem: (w: Writer, item: T) => void
): void {
  w.u32(items.length);
  for (const item of items) writeItem(w, item);
}

function writeScoreStat(w: Writer, s: ScoreStat): void {
  w.u32(s.key).i32(s.value).i32(s.period);
}

function writeStatTerm(w: Writer, t: StatTerm): void {
  writeScoreStat(w, t.statToProve);
  w.bytes32(t.eventStatRoot);
  writeVec(w, t.statProof, writeProofNode);
}

function writeScoresBatchSummary(w: Writer, s: ScoresBatchSummary): void {
  w.i64(s.fixtureId);
  w.i32(s.updateStats.updateCount)
    .i64(s.updateStats.minTimestamp)
    .i64(s.updateStats.maxTimestamp);
  w.bytes32(s.eventsSubTreeRoot);
}

function writeTraderPredicate(w: Writer, p: TraderPredicate): void {
  w.i32(p.threshold).u8(COMPARISON_INDEX[p.comparison]);
}

/**
 * Build the full instruction data buffer for validate_stat.
 * Signature: validate_stat(ts, fixture_summary, fixture_proof, main_tree_proof,
 *                           predicate, stat_a, stat_b: Option<StatTerm>, op: Option<BinaryExpression>)
 */
export function encodeValidateStatArgs(args: {
  discriminator: number[]; // 8 bytes
  ts: number; // i64 (unix ms)
  fixtureSummary: ScoresBatchSummary;
  fixtureProof: ProofNode[];
  mainTreeProof: ProofNode[];
  predicate: TraderPredicate;
  statA: StatTerm;
  statB?: StatTerm | null;
  op?: BinaryExpression | null;
}): Buffer {
  const w = new Writer();
  w.raw(Buffer.from(args.discriminator));
  w.i64(args.ts);
  writeScoresBatchSummary(w, args.fixtureSummary);
  writeVec(w, args.fixtureProof, writeProofNode);
  writeVec(w, args.mainTreeProof, writeProofNode);
  writeTraderPredicate(w, args.predicate);
  writeStatTerm(w, args.statA);

  // stat_b: Option<StatTerm>
  if (args.statB) {
    w.bool(true);
    writeStatTerm(w, args.statB);
  } else {
    w.bool(false);
  }

  // op: Option<BinaryExpression>
  if (args.op) {
    w.bool(true);
    w.u8(BINARY_EXPR_INDEX[args.op]);
  } else {
    w.bool(false);
  }

  return w.toBuffer();
}
