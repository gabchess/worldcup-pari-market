/// Integration tests for pari-market M2.5: the parametric (2-stat) market --
/// the track differentiator. Same litesvm setup as tests/resolve.rs (real
/// txoracle.so + real proof data for fixture 18172379), narrowed to the
/// specific compound-predicate story: home_goals - away_goals > threshold.
///
/// Fixture 18172379 (USA 2-0 Bosnia & Herzegovina): stat_a (key=1, home
/// goals) = 2, stat_b (key=2, away goals) = 0. Spread = 2 - 0 = 2.
///
/// M2a's resolve.rs tests already exercise this exact 2-stat path (their
/// setup_locked_market() helper builds markets with stat_b_key=Some(2),
/// op=Some(Subtract)) -- which is itself the confirmation that init_market
/// accepts and stores op + stat_b_key correctly (M1 scaffold behavior;
/// resolve() would have nothing to CPI against otherwise). This file adds
/// the differentiator-framed true/false pair the M2.5 brief asks for,
/// naming the spread predicate explicitly rather than leaving it implicit
/// inside resolve.rs's generic setup helper.
mod common;

use anchor_lang::{AnchorDeserialize, InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_clock::Clock;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_sysvar::rent::Rent;
use solana_transaction::Transaction;

use pari_market::constants::{MARKET_SEED, TXORACLE_PROGRAM_ID, VAULT_SEED};
use pari_market::market::{BinaryExpression, Comparison, TraderPredicate};
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

fn svm_with_real_oracle() -> LiteSVM {
    let mut svm = LiteSVM::new();
    let manifest_dir = std::env!("CARGO_MANIFEST_DIR");

    let pari_so = format!("{manifest_dir}/../../target/deploy/pari_market.so");
    svm.add_program_from_file(program_id(), &pari_so)
        .unwrap_or_else(|e| panic!("failed to load {pari_so}: {e}"));

    let oracle_so = format!("{manifest_dir}/fixtures/txoracle.so");
    svm.add_program_from_file(TXORACLE_PROGRAM_ID, &oracle_so)
        .unwrap_or_else(|e| panic!("failed to load {oracle_so}: {e}"));

    let roots_json_path = format!("{manifest_dir}/fixtures/roots.json");
    let roots_json = std::fs::read_to_string(&roots_json_path)
        .unwrap_or_else(|e| panic!("failed to read {roots_json_path}: {e}"));
    let parsed: serde_json::Value =
        serde_json::from_str(&roots_json).expect("parse fixtures/roots.json");
    let data_b64 = parsed["account"]["data"][0]
        .as_str()
        .expect("account.data[0] (base64 payload)");
    let lamports = parsed["account"]["lamports"].as_u64().expect("account.lamports");
    let data = base64_decode(data_b64);

    let (roots_key, _) = roots_pda(common::EPOCH_DAY);
    svm.set_account(
        roots_key,
        Account { lamports, data, owner: TXORACLE_PROGRAM_ID, executable: false, rent_epoch: u64::MAX },
    )
    .expect("seed real daily_scores_roots account");

    svm
}

// ponytail: no base64 crate in dev-deps; matches tests/resolve.rs's decoder
// exactly (one call site each, not worth extracting into a shared helper
// module for two 30-line test files).
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

fn send(svm: &mut LiteSVM, payer: &Keypair, signers: &[&Keypair], instruction: Instruction) -> litesvm::types::TransactionResult {
    let bh = svm.latest_blockhash();
    let msg = Message::new(&[instruction], Some(&payer.pubkey()));
    let tx = Transaction::new(signers, msg, bh);
    svm.send_transaction(tx)
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

/// Sets up a locked parametric (2-stat, Subtract) market bound to fixture
/// 18172379 (common::FIXTURE_ID / common::EPOCH_DAY) with the given predicate.
fn setup_locked_parametric_market(svm: &mut LiteSVM, market_id: u64, predicate: TraderPredicate) -> Pubkey {
    let authority = Keypair::new();
    svm.airdrop(&authority.pubkey(), 10_000_000_000).unwrap();
    let mint = create_mint(svm, &authority, &authority.pubkey(), 6);
    let (market, _) = market_pda(market_id);
    let (vault, _) = vault_pda(&market);

    let now = svm.get_sysvar::<Clock>().unix_timestamp;
    let lock_ts = now + 1;

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
        stat_a_key: 1, // home goals
        stat_b_key: Some(2), // away goals -- the parametric/compound differentiator
        op: Some(BinaryExpression::Subtract), // home_goals - away_goals
        predicate,
        lock_ts,
    }
    .data();
    send(svm, &authority, &[&authority], Instruction { program_id: program_id(), accounts, data })
        .expect("init_market (parametric) failed");

    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp = lock_ts + 1;
    svm.set_sysvar::<Clock>(&clock);

    let lock_accounts = acc::LockMarket { market, caller: authority.pubkey() }.to_account_metas(None);
    let lock_data = ix::LockMarket {}.data();
    svm.expire_blockhash();
    send(svm, &authority, &[&authority], Instruction { program_id: program_id(), accounts: lock_accounts, data: lock_data })
        .expect("lock_market (parametric) failed");

    market
}

fn resolve_parametric_ix(market: Pubkey, caller: Pubkey) -> Instruction {
    let (roots, _) = roots_pda(common::EPOCH_DAY);
    let accounts = acc::Resolve {
        market,
        daily_scores_merkle_roots: roots,
        txoracle_program: TXORACLE_PROGRAM_ID,
        caller,
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
    Instruction { program_id: program_id(), accounts, data }
}

fn read_market(svm: &LiteSVM, market: &Pubkey) -> pari_market::market::Market {
    let raw = svm.get_account(market).expect("market account not found");
    AnchorDeserialize::deserialize(&mut &raw.data[8..]).expect("deserialize market")
}

// ── Test: spread > 1 resolves Some(true) ────────────────────────────────────
// USA 2-0 BIH: home_goals(2) - away_goals(0) = 2. Predicate: spread > 1 => TRUE.

#[test]
fn test_parametric_spread_predicate_resolves_true() {
    let mut svm = svm_with_real_oracle();
    let predicate = TraderPredicate { threshold: 1, comparison: Comparison::GreaterThan };
    let market = setup_locked_parametric_market(&mut svm, 200, predicate);

    let caller = Keypair::new();
    svm.airdrop(&caller.pubkey(), 10_000_000_000).unwrap();

    send(&mut svm, &caller, &[&caller], resolve_parametric_ix(market, caller.pubkey()))
        .expect("parametric resolve (spread > 1, true) should succeed");

    let market_state = read_market(&svm, &market);
    assert!(market_state.resolved);
    assert_eq!(market_state.outcome, Some(true), "spread 2 > threshold 1 must resolve true");
}

// ── Test: mirrored false case -- spread > 2 resolves Some(false) ───────────
// Same real proof (spread still = 2). Predicate: spread > 2 => FALSE.

#[test]
fn test_parametric_spread_predicate_resolves_false() {
    let mut svm = svm_with_real_oracle();
    let predicate = TraderPredicate { threshold: 2, comparison: Comparison::GreaterThan };
    let market = setup_locked_parametric_market(&mut svm, 201, predicate);

    let caller = Keypair::new();
    svm.airdrop(&caller.pubkey(), 10_000_000_000).unwrap();

    send(&mut svm, &caller, &[&caller], resolve_parametric_ix(market, caller.pubkey()))
        .expect("parametric resolve (spread > 2, false) should succeed -- Ok-with-bool");

    let market_state = read_market(&svm, &market);
    assert!(market_state.resolved, "false is a valid resolution, market must still be marked resolved");
    assert_eq!(market_state.outcome, Some(false), "spread 2 is not > threshold 2, must resolve false");
}

// ── Test: init_market stores op + stat_b_key correctly (the differentiator's
// on-chain footprint) ───────────────────────────────────────────────────────
// Direct read-back, independent of resolve() succeeding -- confirms the M1
// scaffold's Option<u32>/Option<BinaryExpression> storage is exactly what a
// parametric market needs, not inferred from resolve() working.

#[test]
fn test_init_market_stores_parametric_config() {
    let mut svm = svm_with_real_oracle();
    let predicate = TraderPredicate { threshold: 1, comparison: Comparison::GreaterThan };
    let market = setup_locked_parametric_market(&mut svm, 202, predicate);

    let market_state = read_market(&svm, &market);
    assert_eq!(market_state.stat_a_key, 1, "stat_a_key must be stored");
    assert_eq!(market_state.stat_b_key, Some(2), "stat_b_key must be stored as Some(2) for a parametric market");
    assert_eq!(market_state.op, Some(BinaryExpression::Subtract), "op must be stored as Some(Subtract)");
    assert_eq!(market_state.predicate, predicate, "predicate must round-trip exactly");
}
