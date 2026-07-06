/// Integration tests for pari-market M2a: resolve() + the validate_stat CPI
/// layer.
///
/// Uses litesvm (in-process SVM) -- no local validator, no devnet. Loads TWO
/// programs: pari_market.so (this program, built by `anchor build`) and a
/// dump of the LIVE txoracle program (fixtures/txoracle.so, `solana program
/// dump` against devnet via Helius RPC). The gold-path tests replay a REAL
/// stat-validation proof fetched fresh from the TxLINE API this session
/// (see tests/common/mod.rs header) against the real daily_scores_roots PDA
/// (fixtures/roots.json, dumped from devnet for epoch_day 20636) loaded
/// verbatim into the SVM's account state. This exercises the actual
/// validate_stat CPI logic, not a mock.
mod common;

use anchor_lang::{AnchorDeserialize, InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_clock::Clock;
use solana_instruction::{error::InstructionError, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_sysvar::rent::Rent;
use solana_transaction::{Transaction, TransactionError};

use pari_market::constants::{MARKET_SEED, TXORACLE_PROGRAM_ID, VAULT_SEED};
use pari_market::cpi::txoracle::{ScoresBatchSummary, StatTerm};
use pari_market::market::{BinaryExpression, Comparison, TraderPredicate};
use pari_market::proof::ProofNode;
use pari_market::{self, accounts as acc, instruction as ix};

use anchor_spl::token::spl_token;

const SYSTEM_PROGRAM_ID: Pubkey = Pubkey::from_str_const("11111111111111111111111111111111");

fn program_id() -> Pubkey {
    pari_market::ID
}

fn market_pda(market_id: u64) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[MARKET_SEED, &market_id.to_le_bytes()], &program_id())
}

fn vault_pda(market: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[VAULT_SEED, market.as_ref()], &program_id())
}

fn roots_pda(epoch_day: u16) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"daily_scores_roots", &epoch_day.to_le_bytes()],
        &TXORACLE_PROGRAM_ID,
    )
}

/// Builds an SVM with pari_market.so AND the real dumped txoracle.so loaded,
/// plus the real daily_scores_roots account for common::EPOCH_DAY loaded
/// verbatim from the devnet dump (fixtures/roots.json).
fn svm_with_real_oracle() -> LiteSVM {
    let mut svm = LiteSVM::new();
    let manifest_dir = std::env!("CARGO_MANIFEST_DIR");

    let pari_so = format!("{manifest_dir}/../../target/deploy/pari_market.so");
    svm.add_program_from_file(program_id(), &pari_so)
        .unwrap_or_else(|e| panic!("failed to load {pari_so}: {e}"));

    let oracle_so = format!("{manifest_dir}/fixtures/txoracle.so");
    svm.add_program_from_file(TXORACLE_PROGRAM_ID, &oracle_so)
        .unwrap_or_else(|e| panic!("failed to load {oracle_so}: {e}"));

    // Load the real daily_scores_roots account, dumped from devnet
    // (`solana account <pda> -o fixtures/roots.json --output json`), parsed
    // from the same JSON `solana account` wrote (base64 data field).
    let roots_json_path = format!("{manifest_dir}/fixtures/roots.json");
    let roots_json = std::fs::read_to_string(&roots_json_path)
        .unwrap_or_else(|e| panic!("failed to read {roots_json_path}: {e}"));
    let parsed: serde_json::Value =
        serde_json::from_str(&roots_json).expect("parse fixtures/roots.json");
    let data_b64 = parsed["account"]["data"][0]
        .as_str()
        .expect("account.data[0] (base64 payload)");
    let lamports = parsed["account"]["lamports"]
        .as_u64()
        .expect("account.lamports");
    let data = base64_decode(data_b64);

    let (roots_key, _) = roots_pda(common::EPOCH_DAY);
    svm.set_account(
        roots_key,
        Account {
            lamports,
            data,
            owner: TXORACLE_PROGRAM_ID,
            executable: false,
            rent_epoch: u64::MAX,
        },
    )
    .expect("seed real daily_scores_roots account");

    svm
}

// ponytail: no base64 crate in dev-deps; the account dump only needs decode,
// hand-rolled here rather than adding a dependency for one call site.
fn base64_decode(s: &str) -> Vec<u8> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut rev = [255u8; 256];
    for (i, &c) in TABLE.iter().enumerate() {
        rev[c as usize] = i as u8;
    }
    let clean: Vec<u8> = s.bytes().filter(|&b| b != b'\n' && b != b'=').collect();
    let mut out = Vec::with_capacity(clean.len() * 3 / 4);
    for chunk in clean.chunks(4) {
        let mut buf = [0u8; 4];
        for (i, &b) in chunk.iter().enumerate() {
            buf[i] = rev[b as usize];
        }
        out.push((buf[0] << 2) | (buf[1] >> 4));
        if chunk.len() > 2 {
            out.push((buf[1] << 4) | (buf[2] >> 2));
        }
        if chunk.len() > 3 {
            out.push((buf[2] << 6) | buf[3]);
        }
    }
    out
}

fn send(
    svm: &mut LiteSVM,
    payer: &Keypair,
    signers: &[&Keypair],
    instruction: Instruction,
) -> litesvm::types::TransactionResult {
    let bh = svm.latest_blockhash();
    let msg = Message::new(&[instruction], Some(&payer.pubkey()));
    let tx = Transaction::new(signers, msg, bh);
    svm.send_transaction(tx)
}

fn custom_err(code: u32) -> TransactionError {
    TransactionError::InstructionError(0, InstructionError::Custom(code))
}

fn create_mint(svm: &mut LiteSVM, payer: &Keypair, mint_authority: &Pubkey, decimals: u8) -> Pubkey {
    let mint_kp = Keypair::new();
    let rent = svm.get_sysvar::<Rent>();
    let lamports = rent.minimum_balance(<spl_token::state::Mint as solana_program_pack::Pack>::LEN);
    let create_ix = solana_system_interface::instruction::create_account(
        &payer.pubkey(),
        &mint_kp.pubkey(),
        lamports,
        <spl_token::state::Mint as solana_program_pack::Pack>::LEN as u64,
        &spl_token::ID,
    );
    let init_ix =
        spl_token::instruction::initialize_mint2(&spl_token::ID, &mint_kp.pubkey(), mint_authority, None, decimals)
            .unwrap();
    let bh = svm.latest_blockhash();
    let msg = Message::new(&[create_ix, init_ix], Some(&payer.pubkey()));
    let tx = Transaction::new(&[payer, &mint_kp], msg, bh);
    svm.send_transaction(tx).expect("create_mint failed");
    mint_kp.pubkey()
}

/// Sets up a market bound to common::FIXTURE_ID / common::EPOCH_DAY / a
/// 2-stat (home_goals - away_goals) predicate matching the real fixture data,
/// already locked (resolve() requires market.locked).
struct MarketSetup {
    market: Pubkey,
    authority: Keypair,
}

fn setup_locked_market(svm: &mut LiteSVM, market_id: u64, predicate: TraderPredicate) -> MarketSetup {
    let authority = Keypair::new();
    svm.airdrop(&authority.pubkey(), 10_000_000_000).unwrap();

    let mint = create_mint(svm, &authority, &authority.pubkey(), 6);
    let (market, _) = market_pda(market_id);
    let (vault, _) = vault_pda(&market);

    let now = svm.get_sysvar::<Clock>().unix_timestamp;
    let lock_ts = now + 1; // lock immediately after init

    let accounts = acc::InitMarket {
        market,
        usdc_mint: mint,
        vault,
        authority: authority.pubkey(),
        token_program: spl_token::ID,
        system_program: SYSTEM_PROGRAM_ID,
        rent: solana_sysvar::rent::ID,
    }
    .to_account_metas(None);
    let data = ix::InitMarket {
        market_id,
        fixture_id: common::FIXTURE_ID,
        epoch_day: common::EPOCH_DAY,
        stat_a_key: 1,
        stat_b_key: Some(2),
        op: Some(BinaryExpression::Subtract),
        predicate,
        lock_ts,
    }
    .data();
    send(
        svm,
        &authority,
        &[&authority],
        Instruction { program_id: program_id(), accounts, data },
    )
    .expect("init_market failed");

    // Warp clock past lock_ts and lock.
    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp = lock_ts + 1;
    svm.set_sysvar::<Clock>(&clock);

    let lock_accounts = acc::LockMarket { market, caller: authority.pubkey() }.to_account_metas(None);
    let lock_data = ix::LockMarket {}.data();
    svm.expire_blockhash();
    send(
        svm,
        &authority,
        &[&authority],
        Instruction { program_id: program_id(), accounts: lock_accounts, data: lock_data },
    )
    .expect("lock_market failed");

    MarketSetup { market, authority }
}

fn resolve_ix(market: Pubkey, ts: i64, fixture_summary: ScoresBatchSummary, fixture_proof: Vec<ProofNode>, main_tree_proof: Vec<ProofNode>, stat_a: StatTerm, stat_b: Option<StatTerm>, caller: Pubkey) -> Instruction {
    let (roots, _) = roots_pda(common::EPOCH_DAY);
    let accounts = acc::Resolve {
        market,
        daily_scores_merkle_roots: roots,
        txoracle_program: TXORACLE_PROGRAM_ID,
        caller,
    }
    .to_account_metas(None);
    let data = ix::Resolve {
        ts,
        fixture_summary,
        fixture_proof,
        main_tree_proof,
        stat_a,
        stat_b,
    }
    .data();
    Instruction { program_id: program_id(), accounts, data }
}

fn read_market(svm: &LiteSVM, market: &Pubkey) -> pari_market::market::Market {
    let raw = svm.get_account(market).expect("market account not found");
    AnchorDeserialize::deserialize(&mut &raw.data[8..]).expect("deserialize market")
}

// ── Test (a): true-predicate resolves Some(true) ────────────────────────────
// home_goals(2) - away_goals(0) = 2. Predicate: diff > 1 => TRUE.

#[test]
fn test_resolve_true_predicate_real_cpi() {
    let mut svm = svm_with_real_oracle();
    let predicate = TraderPredicate { threshold: 1, comparison: Comparison::GreaterThan };
    let setup = setup_locked_market(&mut svm, 100, predicate);

    let caller = Keypair::new();
    svm.airdrop(&caller.pubkey(), 10_000_000_000).unwrap();

    let ix = resolve_ix(
        setup.market,
        common::TS,
        common::fixture_summary(),
        common::fixture_proof(),
        common::main_tree_proof(),
        common::stat_a(),
        Some(common::stat_b()),
        caller.pubkey(),
    );

    let result = send(&mut svm, &caller, &[&caller], ix);
    // (g) compute: record actual CU consumed for this call. litesvm's default
    // per-tx compute budget (ComputeBudget::new_with_defaults) is well above
    // Solana's 200k mainnet default, so this call succeeds without an explicit
    // ComputeBudgetProgram::set_compute_unit_limit pre-instruction here.
    //
    // MEASURED (this session, real CPI against the dumped txoracle.so + real
    // proof data, 2-stat path): 197_528 CU total for the whole resolve()
    // instruction (pari-market's own account loads/writes + the validate_stat
    // CPI leg combined). M0 measured ~179_000-179_190 CU for a STANDALONE
    // validate_stat call (depth-1, no wrapping instruction); the ~18k delta
    // here is resolve()'s own pre-CPI guard checks (FixtureMismatch checks)
    // plus account-loading/writing overhead on top of the CPI floor.
    // Comfortably inside RESOLVE_RECOMMENDED_COMPUTE_UNITS = 500_000, and the
    // assertion below pins that budget as a regression guard.
    let meta = result.expect("resolve (true-predicate, real CPI) should succeed");
    eprintln!("CU consumed (true-predicate resolve, real CPI): {}", meta.compute_units_consumed);
    assert!(
        meta.compute_units_consumed < 500_000,
        "resolve() must fit within RESOLVE_RECOMMENDED_COMPUTE_UNITS (500_000); consumed {}",
        meta.compute_units_consumed
    );

    let market = read_market(&svm, &setup.market);
    assert!(market.resolved, "market.resolved must be true");
    assert_eq!(market.outcome, Some(true), "outcome must be Some(true)");

    let _ = setup.authority; // keep authority alive for lifetime clarity
}

// ── Test (b): false-predicate resolves Some(false) ──────────────────────────
// Same real proof, diff = 2. Predicate: diff > 100 => FALSE (Ok-with-bool,
// not a revert -- this is the M0 no-revert-on-false contract under real test).

#[test]
fn test_resolve_false_predicate_real_cpi() {
    let mut svm = svm_with_real_oracle();
    let predicate = TraderPredicate { threshold: 100, comparison: Comparison::GreaterThan };
    let setup = setup_locked_market(&mut svm, 101, predicate);

    let caller = Keypair::new();
    svm.airdrop(&caller.pubkey(), 10_000_000_000).unwrap();

    let ix = resolve_ix(
        setup.market,
        common::TS,
        common::fixture_summary(),
        common::fixture_proof(),
        common::main_tree_proof(),
        common::stat_a(),
        Some(common::stat_b()),
        caller.pubkey(),
    );

    send(&mut svm, &caller, &[&caller], ix).expect("resolve (false-predicate, real CPI) should succeed (Ok-with-bool)");

    let market = read_market(&svm, &setup.market);
    assert!(market.resolved, "market.resolved must be true even on a false outcome");
    assert_eq!(market.outcome, Some(false), "outcome must be Some(false) -- a VALID resolution, not an error");
}

// ── Test (c): wrong-root rejected by the seeds constraint ──────────────────
// Pass a daily_scores_merkle_roots account for a DIFFERENT epoch_day than
// market.epoch_day. Anchor's seeds re-derivation on the Resolve Accounts
// struct must reject the account substitution before the instruction body runs.

#[test]
fn test_resolve_wrong_root_rejected() {
    let mut svm = svm_with_real_oracle();
    let predicate = TraderPredicate { threshold: 1, comparison: Comparison::GreaterThan };
    let setup = setup_locked_market(&mut svm, 102, predicate);

    let caller = Keypair::new();
    svm.airdrop(&caller.pubkey(), 10_000_000_000).unwrap();

    // Build the instruction manually with a wrong-epoch_day roots account
    // (market.epoch_day is common::EPOCH_DAY; substitute a different one).
    let (wrong_roots, _) = roots_pda(common::EPOCH_DAY - 1);
    let accounts = acc::Resolve {
        market: setup.market,
        daily_scores_merkle_roots: wrong_roots,
        txoracle_program: TXORACLE_PROGRAM_ID,
        caller: caller.pubkey(),
    }
    .to_account_metas(None);
    let data = ix::Resolve {
        ts: common::TS,
        fixture_summary: common::fixture_summary(),
        fixture_proof: common::fixture_proof(),
        main_tree_proof: common::main_tree_proof(),
        stat_a: common::stat_a(),
        stat_b: Some(common::stat_b()),
    }
    .data();
    let ix_obj = Instruction { program_id: program_id(), accounts, data };

    let err = send(&mut svm, &caller, &[&caller], ix_obj)
        .expect_err("wrong-epoch_day daily_scores_roots account must be rejected by the seeds constraint");
    // Anchor's seeds-constraint failure is ConstraintSeeds (generic Anchor
    // error, not a PariMarketError custom code) -- assert it's an
    // InstructionError, not a specific custom code, since the exact Anchor
    // internal error code is a framework detail, not part of our contract.
    match err.err {
        TransactionError::InstructionError(0, InstructionError::Custom(_)) => {}
        other => panic!("expected an InstructionError::Custom (Anchor ConstraintSeeds), got {other:?}"),
    }
}

// ── Test (d): double-resolve rejected ───────────────────────────────────────

#[test]
fn test_resolve_double_resolve_rejected() {
    let mut svm = svm_with_real_oracle();
    let predicate = TraderPredicate { threshold: 1, comparison: Comparison::GreaterThan };
    let setup = setup_locked_market(&mut svm, 103, predicate);

    let caller = Keypair::new();
    svm.airdrop(&caller.pubkey(), 10_000_000_000).unwrap();

    let make_ix = || {
        resolve_ix(
            setup.market,
            common::TS,
            common::fixture_summary(),
            common::fixture_proof(),
            common::main_tree_proof(),
            common::stat_a(),
            Some(common::stat_b()),
            caller.pubkey(),
        )
    };

    send(&mut svm, &caller, &[&caller], make_ix()).expect("first resolve must succeed");

    svm.expire_blockhash();
    let err = send(&mut svm, &caller, &[&caller], make_ix())
        .expect_err("second resolve on an already-resolved market must be rejected");
    // AlreadyResolved = index 3 -> code 6003.
    assert_eq!(err.err, custom_err(6003), "expected AlreadyResolved (6003)");
}

// ── Test (e): resolve on unlocked market rejected ───────────────────────────

#[test]
fn test_resolve_on_unlocked_market_rejected() {
    let mut svm = svm_with_real_oracle();
    let authority = Keypair::new();
    svm.airdrop(&authority.pubkey(), 10_000_000_000).unwrap();
    let mint = create_mint(&mut svm, &authority, &authority.pubkey(), 6);
    let market_id: u64 = 104;
    let (market, _) = market_pda(market_id);
    let (vault, _) = vault_pda(&market);

    let now = svm.get_sysvar::<Clock>().unix_timestamp;
    let accounts = acc::InitMarket {
        market,
        usdc_mint: mint,
        vault,
        authority: authority.pubkey(),
        token_program: spl_token::ID,
        system_program: SYSTEM_PROGRAM_ID,
        rent: solana_sysvar::rent::ID,
    }
    .to_account_metas(None);
    let data = ix::InitMarket {
        market_id,
        fixture_id: common::FIXTURE_ID,
        epoch_day: common::EPOCH_DAY,
        stat_a_key: 1,
        stat_b_key: Some(2),
        op: Some(BinaryExpression::Subtract),
        predicate: TraderPredicate { threshold: 1, comparison: Comparison::GreaterThan },
        lock_ts: now + 3600,
    }
    .data();
    send(&mut svm, &authority, &[&authority], Instruction { program_id: program_id(), accounts, data })
        .expect("init_market failed");
    // Deliberately do NOT call lock_market().

    let caller = Keypair::new();
    svm.airdrop(&caller.pubkey(), 10_000_000_000).unwrap();

    let ix = resolve_ix(
        market,
        common::TS,
        common::fixture_summary(),
        common::fixture_proof(),
        common::main_tree_proof(),
        common::stat_a(),
        Some(common::stat_b()),
        caller.pubkey(),
    );
    let err = send(&mut svm, &caller, &[&caller], ix)
        .expect_err("resolve on an unlocked market must be rejected");
    // MarketLocked = index 1 -> code 6001 (Resolve's constraint is `market.locked`,
    // so a still-unlocked market fails the same guard).
    assert_eq!(err.err, custom_err(6001), "expected MarketLocked (6001) on an unlocked market");
}

// ── Test (f): FixtureMismatch -- summary for a different fixture_id rejected pre-CPI ──

#[test]
fn test_resolve_fixture_mismatch_rejected_pre_cpi() {
    let mut svm = svm_with_real_oracle();
    let predicate = TraderPredicate { threshold: 1, comparison: Comparison::GreaterThan };
    let setup = setup_locked_market(&mut svm, 105, predicate);

    let caller = Keypair::new();
    svm.airdrop(&caller.pubkey(), 10_000_000_000).unwrap();

    // Same proof data, but fixture_summary.fixture_id altered to a different
    // fixture than market.fixture_id (common::FIXTURE_ID). Must be rejected
    // BEFORE the CPI (structural fix, Dayo P0 #1) -- no CU spent on the CPI.
    let mut wrong_summary = common::fixture_summary();
    wrong_summary.fixture_id = common::FIXTURE_ID + 1;

    let ix = resolve_ix(
        setup.market,
        common::TS,
        wrong_summary,
        common::fixture_proof(),
        common::main_tree_proof(),
        common::stat_a(),
        Some(common::stat_b()),
        caller.pubkey(),
    );

    let err = send(&mut svm, &caller, &[&caller], ix)
        .expect_err("fixture_summary for a different fixture_id must be rejected pre-CPI");
    // FixtureMismatch = index 9 -> code 6009.
    assert_eq!(err.err, custom_err(6009), "expected FixtureMismatch (6009)");

    // Confirm the rejected call did not mutate market state.
    let market = read_market(&svm, &setup.market);
    assert!(!market.resolved, "rejected pre-CPI call must not mark the market resolved");
    assert!(market.outcome.is_none(), "rejected pre-CPI call must not set an outcome");
}
