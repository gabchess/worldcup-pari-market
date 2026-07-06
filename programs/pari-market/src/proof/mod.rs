use anchor_lang::prelude::*;

/// A single node in a portable Merkle proof path.
///
/// S171/M0 reuse: mirrors the txoracle IDL `ProofNode` struct byte-for-byte
/// (see client/validate-stat-borsh.ts ProofNode, confirmed working in M0's
/// live validate_stat calls). Reused here as the client-side Merkle-verify
/// fallback type (see docs/pm-research.md Part 5 "Mechanism (fallback)") --
/// this file intentionally carries NO accounting/settlement logic, only the
/// proof-path data shape. Verify logic lives in cpi::txoracle / a future
/// proof::verify module once the fallback path is built.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ProofNode {
    /// SHA-256 hash of the sibling node.
    pub hash: [u8; 32],
    /// If true, this node is the right sibling (leaf goes left in the hash pair).
    pub is_right_sibling: bool,
}
