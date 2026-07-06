/// M4b: late adversarial pass on resolve() and claim_payout() (the fund-safety
/// core), run against the tree that shipped M2a/M2b/M2.5, now live on devnet.
///
/// Every test here is an attack. A test that asserts a REJECTION is a guard
/// that held under adversarial input (a regression lock, not a "trust the
/// doc comment" pass). A test that would assert an unexpected SUCCESS is a
/// real finding; none were found in this pass (see the M4b report for the
/// full per-hypothesis table and rationale).
///
/// Reuses the resolve.rs harness pattern (real dumped txoracle.so + real
/// devnet-fetched proof fixtures via tests/common) for resolve() attacks, and
/// the claim_payout.rs force_resolve pattern for claim_payout() attacks (no
/// CPI needed there -- M2a/M2.5 already own oracle-CPI correctness).
mod common;

use anchor_lang::{AnchorDeserialize, AnchorSerialize, InstructionData, ToAccountMetas};
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

use pari_market::constants::{MARKET_SEED, POSITION_SEED, TXORACLE_PROGRAM_ID, VAULT_SEED};
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

fn position_pda(market: &Pubkey, bettor: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[POSITION_SEED, market.as_ref(), bettor.as_ref()], &program_id())
}

fn roots_pda(epoch_day: u16) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"daily_scores_roots", &epoch_day.to_le_bytes()], &TXORACLE_PROGRAM_ID)
}

fn custom_err(code: u32) -> TransactionError {
    TransactionError::InstructionError(0, InstructionError::Custom(code))
}

fn send(svm: &mut LiteSVM, payer: &Keypair, signers: &[&Keypair], instruction: Instruction) -> litesvm::types::TransactionResult {
    let bh = svm.latest_blockhash();
    let msg = Message::new(&[instruction], Some(&payer.pubkey()));
    let tx = Transaction::new(signers, msg, bh);
    svm.send_transaction(tx)
}

fn send_many(svm: &mut LiteSVM, payer: &Keypair, signers: &[&Keypair], instructions: &[Instruction]) -> litesvm::types::TransactionResult {
    let bh = svm.latest_blockhash();
    let msg = Message::new(instructions, Some(&payer.pubkey()));
    let tx = Transaction::new(signers, msg, bh);
    svm.send_transaction(tx)
}

// ── Token + mint helpers (identical shape to the sibling test files) ───────

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
        spl_token::instruction::initialize_mint2(&spl_token::ID, &mint_kp.pubkey(), mint_authority, None, decimals).unwrap();
    send_many(svm, payer, &[payer, &mint_kp], &[create_ix, init_ix]).expect("create_mint failed");
    mint_kp.pubkey()
}

fn create_token_account(svm: &mut LiteSVM, payer: &Keypair, mint: &Pubkey, owner: &Pubkey) -> Pubkey {
    let acct_kp = Keypair::new();
    let rent = svm.get_sysvar::<Rent>();
    let lamports = rent.minimum_balance(<spl_token::state::Account as solana_program_pack::Pack>::LEN);
    let create_ix = solana_system_interface::instruction::create_account(
        &payer.pubkey(),
        &acct_kp.pubkey(),
        lamports,
        <spl_token::state::Account as solana_program_pack::Pack>::LEN as u64,
        &spl_token::ID,
    );
    let init_ix = spl_token::instruction::initialize_account3(&spl_token::ID, &acct_kp.pubkey(), mint, owner).unwrap();
    send_many(svm, payer, &[payer, &acct_kp], &[create_ix, init_ix]).expect("create_token_account failed");
    acct_kp.pubkey()
}

fn mint_to(svm: &mut LiteSVM, payer: &Keypair, mint: &Pubkey, dest: &Pubkey, mint_authority: &Keypair, amount: u64) {
    let ix_obj = spl_token::instruction::mint_to(&spl_token::ID, mint, dest, &mint_authority.pubkey(), &[], amount).unwrap();
    send(svm, payer, &[payer, mint_authority], ix_obj).expect("mint_to failed");
}

fn token_balance(svm: &LiteSVM, token_account: &Pubkey) -> u64 {
    let raw = svm.get_account(token_account).expect("token account not found");
    let unpacked = <spl_token::state::Account as solana_program_pack::Pack>::unpack(&raw.data).expect("unpack token account");
    unpacked.amount
}

fn read_market(svm: &LiteSVM, market: &Pubkey) -> pari_market::market::Market {
    let raw = svm.get_account(market).expect("market account not found");
    AnchorDeserialize::deserialize(&mut &raw.data[8..]).expect("deserialize market")
}

fn read_position(svm: &LiteSVM, position: &Pubkey) -> pari_market::position::Position {
    let raw = svm.get_account(position).expect("position account not found");
    AnchorDeserialize::deserialize(&mut &raw.data[8..]).expect("deserialize position")
}

// ═══════════════════════════════════════════════════════════════════════════
// Section A: resolve() attacks -- real dumped txoracle.so + real proof data
// (same harness as tests/resolve.rs).
// ═══════════════════════════════════════════════════════════════════════════

fn svm_with_real_oracle() -> LiteSVM {
    let mut svm = LiteSVM::new();
    let manifest_dir = std::env!("CARGO_MANIFEST_DIR");

    let pari_so = format!("{manifest_dir}/../../target/deploy/pari_market.so");
    svm.add_program_from_file(program_id(), &pari_so).unwrap_or_else(|e| panic!("failed to load {pari_so}: {e}"));

    let oracle_so = format!("{manifest_dir}/fixtures/txoracle.so");
    svm.add_program_from_file(TXORACLE_PROGRAM_ID, &oracle_so).unwrap_or_else(|e| panic!("failed to load {oracle_so}: {e}"));

    let roots_json_path = format!("{manifest_dir}/fixtures/roots.json");
    let roots_json = std::fs::read_to_string(&roots_json_path).unwrap_or_else(|e| panic!("failed to read {roots_json_path}: {e}"));
    let parsed: serde_json::Value = serde_json::from_str(&roots_json).expect("parse fixtures/roots.json");
    let data_b64 = parsed["account"]["data"][0].as_str().expect("account.data[0] (base64 payload)");
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

struct ResolveMarketSetup {
    market: Pubkey,
    authority: Keypair,
}

fn setup_locked_market_for_resolve(
    svm: &mut LiteSVM,
    market_id: u64,
    predicate: TraderPredicate,
    stat_b_key: Option<u32>,
    op: Option<BinaryExpression>,
) -> ResolveMarketSetup {
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
        stat_a_key: 1,
        stat_b_key,
        op,
        predicate,
        lock_ts,
    }
    .data();
    send(svm, &authority, &[&authority], Instruction { program_id: program_id(), accounts, data }).expect("init_market failed");

    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp = lock_ts + 1;
    svm.set_sysvar::<Clock>(&clock);

    let lock_accounts = acc::LockMarket { market, caller: authority.pubkey() }.to_account_metas(None);
    let lock_data = ix::LockMarket {}.data();
    svm.expire_blockhash();
    send(svm, &authority, &[&authority], Instruction { program_id: program_id(), accounts: lock_accounts, data: lock_data })
        .expect("lock_market failed");

    ResolveMarketSetup { market, authority }
}

fn resolve_ix(
    market: Pubkey,
    ts: i64,
    fixture_summary: ScoresBatchSummary,
    fixture_proof: Vec<ProofNode>,
    main_tree_proof: Vec<ProofNode>,
    stat_a: StatTerm,
    stat_b: Option<StatTerm>,
    caller: Pubkey,
) -> Instruction {
    let (roots, _) = roots_pda(common::EPOCH_DAY);
    let accounts = acc::Resolve { market, daily_scores_merkle_roots: roots, txoracle_program: TXORACLE_PROGRAM_ID, caller }.to_account_metas(None);
    let data = ix::Resolve { ts, fixture_summary, fixture_proof, main_tree_proof, stat_a, stat_b }.data();
    Instruction { program_id: program_id(), accounts, data }
}

/// H2: market is a TWO-STAT market (stat_b_key = Some(2)), attacker calls
/// resolve() supplying stat_b = None. The pre-CPI guard
/// (`stat_b.as_ref().ok_or(FixtureMismatch)?`) must reject this before the
/// ~179k CU CPI runs, not silently fall through to a single-stat CPI against
/// the wrong predicate.
#[test]
fn attack_resolve_two_stat_market_missing_stat_b_rejected() {
    let mut svm = svm_with_real_oracle();
    let predicate = TraderPredicate { threshold: 1, comparison: Comparison::GreaterThan };
    let setup = setup_locked_market_for_resolve(&mut svm, 200, predicate, Some(2), Some(BinaryExpression::Subtract));

    let caller = Keypair::new();
    svm.airdrop(&caller.pubkey(), 10_000_000_000).unwrap();

    // Attacker omits stat_b entirely, hoping resolve() falls through to the
    // single-stat CPI path (which would evaluate a DIFFERENT predicate than
    // the one this market was created with).
    let ix_obj = resolve_ix(
        setup.market,
        common::TS,
        common::fixture_summary(),
        common::fixture_proof(),
        common::main_tree_proof(),
        common::stat_a(),
        None,
        caller.pubkey(),
    );

    let err = send(&mut svm, &caller, &[&caller], ix_obj)
        .expect_err("resolve() on a two-stat market with stat_b omitted must be rejected pre-CPI");
    // FixtureMismatch = index 9 -> code 6009.
    assert_eq!(err.err, custom_err(6009), "expected FixtureMismatch (6009) when stat_b is missing on a two-stat market");

    let market = read_market(&svm, &setup.market);
    assert!(!market.resolved, "rejected call must not mark the market resolved");
    let _ = setup.authority;
}

/// H3: market is a TWO-STAT market bound to stat_b_key = 2, attacker calls
/// resolve() supplying a stat_b whose embedded key is WRONG (e.g. re-submits
/// stat_a's own key/proof as stat_b, attempting to evaluate the predicate
/// against a stat this market was never bound to).
#[test]
fn attack_resolve_two_stat_market_wrong_stat_b_key_rejected() {
    let mut svm = svm_with_real_oracle();
    let predicate = TraderPredicate { threshold: 1, comparison: Comparison::GreaterThan };
    let setup = setup_locked_market_for_resolve(&mut svm, 201, predicate, Some(2), Some(BinaryExpression::Subtract));

    let caller = Keypair::new();
    svm.airdrop(&caller.pubkey(), 10_000_000_000).unwrap();

    // Attacker substitutes stat_a's data as stat_b (key=1, not the bound key=2).
    let wrong_stat_b = common::stat_a();

    let ix_obj = resolve_ix(
        setup.market,
        common::TS,
        common::fixture_summary(),
        common::fixture_proof(),
        common::main_tree_proof(),
        common::stat_a(),
        Some(wrong_stat_b),
        caller.pubkey(),
    );

    let err = send(&mut svm, &caller, &[&caller], ix_obj)
        .expect_err("resolve() with a stat_b whose key does not match market.stat_b_key must be rejected pre-CPI");
    assert_eq!(err.err, custom_err(6009), "expected FixtureMismatch (6009) on wrong stat_b key");

    let market = read_market(&svm, &setup.market);
    assert!(!market.resolved, "rejected call must not mark the market resolved");
}

/// H1-extended: attacker resubmits the CORRECT fixture proof data but flips
/// the CPI args order intent by swapping which StatTerm is passed as stat_a
/// vs stat_b (stat_a arg = the real stat_b payload, and vice versa) while
/// leaving fixture_id untouched. Since market.stat_a_key (1) != the swapped
/// stat_to_prove.key (2), this must be rejected on the stat_a check, proving
/// the guard checks stat_a specifically and does not just check "some stat
/// matches somewhere."
#[test]
fn attack_resolve_stat_a_stat_b_swapped_rejected() {
    let mut svm = svm_with_real_oracle();
    let predicate = TraderPredicate { threshold: 1, comparison: Comparison::GreaterThan };
    let setup = setup_locked_market_for_resolve(&mut svm, 202, predicate, Some(2), Some(BinaryExpression::Subtract));

    let caller = Keypair::new();
    svm.airdrop(&caller.pubkey(), 10_000_000_000).unwrap();

    // stat_a slot gets stat_b's payload (key=2), stat_b slot gets stat_a's payload (key=1).
    // market.stat_a_key == 1, so stat_a.stat_to_prove.key (now 2) must fail the check.
    let ix_obj = resolve_ix(
        setup.market,
        common::TS,
        common::fixture_summary(),
        common::fixture_proof(),
        common::main_tree_proof(),
        common::stat_b(), // swapped into the stat_a slot
        Some(common::stat_a()), // swapped into the stat_b slot
        caller.pubkey(),
    );

    let err = send(&mut svm, &caller, &[&caller], ix_obj)
        .expect_err("swapped stat_a/stat_b payloads must be rejected on the stat_a_key check");
    assert_eq!(err.err, custom_err(6009), "expected FixtureMismatch (6009) on swapped stat_a/stat_b");

    let market = read_market(&svm, &setup.market);
    assert!(!market.resolved);
}

/// H1-single-stat-market variant: a SINGLE-stat market (stat_b_key = None)
/// receives an attacker-supplied stat_b = Some(...). Confirms the extra,
/// unrequested stat_b payload is inert (never silently promotes the call to
/// a two-stat evaluation against a predicate this market was never bound
/// to) -- the call must still resolve using ONLY stat_a, matching
/// market.op == None.
#[test]
fn attack_resolve_single_stat_market_extra_stat_b_ignored_safely() {
    let mut svm = svm_with_real_oracle();
    // Single-stat market: stat_a_key defaults to 1 in setup_locked_market_for_resolve's
    // init_market call; predicate threshold=1 GreaterThan against stat_a alone
    // (home_goals=2 per the real fixture) should resolve true (2 > 1).
    let predicate = TraderPredicate { threshold: 1, comparison: Comparison::GreaterThan };
    let setup = setup_locked_market_for_resolve(&mut svm, 203, predicate, None, None);

    let caller = Keypair::new();
    svm.airdrop(&caller.pubkey(), 10_000_000_000).unwrap();

    // Attacker attaches a stat_b even though this market never asked for one.
    let ix_obj = resolve_ix(
        setup.market,
        common::TS,
        common::fixture_summary(),
        common::fixture_proof(),
        common::main_tree_proof(),
        common::stat_a(),
        Some(common::stat_b()),
        caller.pubkey(),
    );

    // Must succeed (extra stat_b is inert on a single-stat market) and the
    // outcome must reflect ONLY stat_a's real value (home_goals=2 > threshold=1
    // => true), not some artifact of the unrequested two-stat data.
    send(&mut svm, &caller, &[&caller], ix_obj)
        .expect("single-stat market resolve must succeed even with an unrequested stat_b attached");

    let market = read_market(&svm, &setup.market);
    assert!(market.resolved, "market must resolve");
    assert_eq!(market.outcome, Some(true), "outcome must reflect stat_a alone (2 > 1), unaffected by the injected stat_b");
}

// ═══════════════════════════════════════════════════════════════════════════
// Section B: claim_payout() attacks -- force-resolve pattern (no CPI needed;
// M2a/M2.5 own oracle-CPI correctness, out of scope here).
// ═══════════════════════════════════════════════════════════════════════════

fn svm_no_oracle() -> LiteSVM {
    let mut svm = LiteSVM::new();
    let manifest_dir = std::env!("CARGO_MANIFEST_DIR");
    let so = format!("{manifest_dir}/../../target/deploy/pari_market.so");
    svm.add_program_from_file(program_id(), &so).unwrap_or_else(|e| panic!("failed to load {so}: {e}"));
    svm
}

fn default_predicate() -> TraderPredicate {
    TraderPredicate { threshold: 0, comparison: Comparison::GreaterThan }
}

struct ClaimMarketSetup {
    market: Pubkey,
    mint: Pubkey,
    vault: Pubkey,
    authority: Keypair,
}

fn setup_market_for_claim(svm: &mut LiteSVM, market_id: u64) -> ClaimMarketSetup {
    let authority = Keypair::new();
    svm.airdrop(&authority.pubkey(), 10_000_000_000).unwrap();
    let mint = create_mint(svm, &authority, &authority.pubkey(), 6);
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
        fixture_id: 18172379,
        epoch_day: 20632,
        stat_a_key: 1,
        stat_b_key: None,
        op: None,
        predicate: default_predicate(),
        lock_ts: now + 3600,
    }
    .data();
    send(svm, &authority, &[&authority], Instruction { program_id: program_id(), accounts, data }).expect("init_market failed");

    ClaimMarketSetup { market, mint, vault, authority }
}

fn deposit(svm: &mut LiteSVM, setup: &ClaimMarketSetup, bettor: &Keypair, bettor_usdc: Pubkey, amount: u64, side: bool) {
    let (position, _) = position_pda(&setup.market, &bettor.pubkey());
    let accounts = acc::Deposit {
        market: setup.market,
        position,
        vault: setup.vault,
        bettor_usdc,
        bettor: bettor.pubkey(),
        token_program: spl_token::ID,
        system_program: SYSTEM_PROGRAM_ID,
    }
    .to_account_metas(None);
    let data = ix::Deposit { amount, side }.data();
    svm.expire_blockhash();
    send(svm, bettor, &[bettor], Instruction { program_id: program_id(), accounts, data }).expect("deposit failed");
}

fn force_resolve(svm: &mut LiteSVM, market: &Pubkey, outcome: bool) {
    let raw = svm.get_account(market).unwrap();
    let owner = raw.owner;
    let mut market_state: pari_market::market::Market = AnchorDeserialize::deserialize(&mut &raw.data[8..]).unwrap();
    market_state.locked = true;
    market_state.resolved = true;
    market_state.outcome = Some(outcome);

    let mut data = raw.data[..8].to_vec();
    AnchorSerialize::serialize(&market_state, &mut data).unwrap();

    svm.set_account(*market, Account { lamports: raw.lamports, data, owner, executable: false, rent_epoch: raw.rent_epoch }).unwrap();
}

/// Raw claim instruction builder that lets a test pass ARBITRARY accounts,
/// including mismatched ones, to probe whether Anchor's declarative
/// constraints (has_one, token::mint, token::authority) actually hold under
/// adversarial account substitution rather than trusting the annotation.
fn claim_ix_raw(market: Pubkey, position: Pubkey, vault: Pubkey, bettor_usdc: Pubkey, bettor: Pubkey) -> Instruction {
    let accounts = acc::ClaimPayout { market, position, vault, bettor_usdc, bettor, token_program: spl_token::ID }.to_account_metas(None);
    let data = ix::ClaimPayout {}.data();
    Instruction { program_id: program_id(), accounts, data }
}

/// H4: attacker (bettor_b, deposited nothing or deposited separately) signs
/// a claim_payout transaction but passes the VICTIM's Position PDA (bettor_a's),
/// hoping `has_one = bettor` either isn't enforced or can be satisfied by
/// passing attacker's own pubkey as the `bettor` account while the position's
/// stored `bettor` field still points at the victim. Anchor's has_one
/// constraint compares `position.bettor == accounts.bettor.key()`, so this
/// must be rejected before any payout math runs.
#[test]
fn attack_claim_payout_steal_via_victim_position_pda() {
    let mut svm = svm_no_oracle();
    let setup = setup_market_for_claim(&mut svm, 300);

    let victim = Keypair::new();
    let attacker = Keypair::new();
    svm.airdrop(&victim.pubkey(), 10_000_000_000).unwrap();
    svm.airdrop(&attacker.pubkey(), 10_000_000_000).unwrap();
    let victim_usdc = create_token_account(&mut svm, &victim, &setup.mint, &victim.pubkey());
    let attacker_usdc = create_token_account(&mut svm, &attacker, &setup.mint, &attacker.pubkey());
    mint_to(&mut svm, &setup.authority, &setup.mint, &victim_usdc, &setup.authority, 1_000_000);

    deposit(&mut svm, &setup, &victim, victim_usdc, 500_000, true);
    force_resolve(&mut svm, &setup.market, true); // YES wins, victim is the legitimate winner

    let (victim_position, _) = position_pda(&setup.market, &victim.pubkey());

    // Attacker signs as `bettor`, but passes victim's Position PDA and their
    // OWN token account as the payout destination -- attempting to redirect
    // the victim's winnings to the attacker's wallet.
    let steal_ix = claim_ix_raw(setup.market, victim_position, setup.vault, attacker_usdc, attacker.pubkey());

    let err = send(&mut svm, &attacker, &[&attacker], steal_ix)
        .expect_err("attacker claiming victim's position while signing as a different bettor must be rejected");
    match err.err {
        TransactionError::InstructionError(0, InstructionError::Custom(_)) => {}
        other => panic!("expected an InstructionError::Custom (Anchor has_one=bettor constraint violation), got {other:?}"),
    }

    // Confirm the victim's position is untouched and unclaimed.
    let pos = read_position(&svm, &victim_position);
    assert!(!pos.claimed, "victim's position must remain unclaimed after the rejected steal attempt");
    assert_eq!(token_balance(&svm, &attacker_usdc), 0, "attacker must receive nothing");
    assert_eq!(token_balance(&svm, &setup.vault), 500_000, "vault must remain untouched");
}

/// H5: cross-market position substitution. Attacker has a legitimate,
/// claimable winning position on market A, and tries to reuse that SAME
/// Position PDA (which only exists relative to market A's key in its seeds)
/// against market B's vault, hoping to drain market B's pool using a
/// position that was never funded there. Anchor's seeds re-derivation on the
/// ClaimPayout Accounts struct (`seeds = [POSITION_SEED, market.key(),
/// bettor.key()]`) means passing market B's pubkey as `market` while passing
/// market A's Position PDA produces a seed mismatch (the PDA at that address
/// was derived under market A's key, not market B's), which must be rejected.
#[test]
fn attack_claim_payout_cross_market_position_substitution_rejected() {
    let mut svm = svm_no_oracle();
    let setup_a = setup_market_for_claim(&mut svm, 301);
    let setup_b = setup_market_for_claim(&mut svm, 302);

    let bettor = Keypair::new();
    svm.airdrop(&bettor.pubkey(), 10_000_000_000).unwrap();
    let bettor_usdc = create_token_account(&mut svm, &bettor, &setup_a.mint, &bettor.pubkey());
    mint_to(&mut svm, &setup_a.authority, &setup_a.mint, &bettor_usdc, &setup_a.authority, 1_000_000);

    // Bettor deposits and wins on market A ONLY. Market B has its own vault,
    // funded independently by a different depositor, and is force-resolved too.
    deposit(&mut svm, &setup_a, &bettor, bettor_usdc, 200_000, true);
    force_resolve(&mut svm, &setup_a.market, true);

    let other_bettor = Keypair::new();
    svm.airdrop(&other_bettor.pubkey(), 10_000_000_000).unwrap();
    let other_usdc = create_token_account(&mut svm, &other_bettor, &setup_b.mint, &other_bettor.pubkey());
    mint_to(&mut svm, &setup_b.authority, &setup_b.mint, &other_usdc, &setup_b.authority, 1_000_000);
    deposit(&mut svm, &setup_b, &other_bettor, other_usdc, 400_000, true);
    force_resolve(&mut svm, &setup_b.market, true);

    let (position_a, _) = position_pda(&setup_a.market, &bettor.pubkey());

    // Attacker tries: sign as the SAME bettor who legitimately won on market
    // A, but point `market` and `vault` at market B, while still passing
    // market A's Position PDA (their real, winning position) -- attempting
    // to drain market B's vault using a position that only exists relative
    // to market A.
    let cross_market_ix = claim_ix_raw(setup_b.market, position_a, setup_b.vault, bettor_usdc, bettor.pubkey());

    let err = send(&mut svm, &bettor, &[&bettor], cross_market_ix)
        .expect_err("cross-market position substitution must be rejected by the seeds re-derivation on ClaimPayout");
    match err.err {
        TransactionError::InstructionError(0, InstructionError::Custom(_)) => {}
        other => panic!("expected an InstructionError::Custom (Anchor ConstraintSeeds / has_one=market), got {other:?}"),
    }

    // Confirm market B's vault is untouched, and market A's legitimate
    // position is still claimable (the attack attempt must not have
    // consumed the claim).
    assert_eq!(token_balance(&svm, &setup_b.vault), 400_000, "market B's vault must be untouched by the cross-market attempt");
    let pos_a = read_position(&svm, &position_a);
    assert!(!pos_a.claimed, "market A's legitimate position must remain unclaimed after the rejected cross-market attempt");
}

/// H6: standard losing-side rejection, but under a HARDER adversarial
/// condition than the existing sibling test (claim_payout.rs's
/// test_claim_payout_losing_position_rejected uses a 2-depositor market).
/// Here: THREE depositors, mixed sides, winning pool has substantial funds
/// (not near-empty), and the losing-side claimant additionally has the
/// LARGEST individual deposit in the whole market -- confirming the
/// winner-only constraint is not somehow bypassable by deposit size, only by
/// `position.side == market.outcome`.
#[test]
fn attack_claim_payout_largest_depositor_on_losing_side_still_rejected() {
    let mut svm = svm_no_oracle();
    let setup = setup_market_for_claim(&mut svm, 303);

    let whale_loser = Keypair::new();
    let small_winner_a = Keypair::new();
    let small_winner_b = Keypair::new();
    for kp in [&whale_loser, &small_winner_a, &small_winner_b] {
        svm.airdrop(&kp.pubkey(), 10_000_000_000).unwrap();
    }
    let whale_usdc = create_token_account(&mut svm, &whale_loser, &setup.mint, &whale_loser.pubkey());
    let a_usdc = create_token_account(&mut svm, &small_winner_a, &setup.mint, &small_winner_a.pubkey());
    let b_usdc = create_token_account(&mut svm, &small_winner_b, &setup.mint, &small_winner_b.pubkey());
    mint_to(&mut svm, &setup.authority, &setup.mint, &whale_usdc, &setup.authority, 10_000_000);
    mint_to(&mut svm, &setup.authority, &setup.mint, &a_usdc, &setup.authority, 1_000_000);
    mint_to(&mut svm, &setup.authority, &setup.mint, &b_usdc, &setup.authority, 1_000_000);

    deposit(&mut svm, &setup, &whale_loser, whale_usdc, 9_000_000, false); // NO, huge, will lose
    deposit(&mut svm, &setup, &small_winner_a, a_usdc, 50_000, true); // YES, small, will win
    deposit(&mut svm, &setup, &small_winner_b, b_usdc, 25_000, true); // YES, small, will win

    force_resolve(&mut svm, &setup.market, true); // YES wins; whale's 9_000_000 NO deposit loses entirely

    let err = send(&mut svm, &whale_loser, &[&whale_loser], claim_ix_raw(setup.market, position_pda(&setup.market, &whale_loser.pubkey()).0, setup.vault, whale_usdc, whale_loser.pubkey()))
        .expect_err("the largest depositor in the market, on the losing side, must still be rejected");
    assert_eq!(err.err, custom_err(6012), "expected LosingPosition (6012) regardless of deposit size");

    // Confirm the winners can still claim their exact proportional share
    // after the whale's rejected attempt (no state corruption from the
    // failed transaction).
    let before_a = token_balance(&svm, &a_usdc);
    send(&mut svm, &small_winner_a, &[&small_winner_a], claim_ix_raw(setup.market, position_pda(&setup.market, &small_winner_a.pubkey()).0, setup.vault, a_usdc, small_winner_a.pubkey()))
        .expect("legitimate winner must still be able to claim after the whale's rejected attempt");
    let after_a = token_balance(&svm, &a_usdc);
    // total_pool = 9_000_000 + 75_000 = 9_075_000; winning_pool = 75_000.
    // payout_a = 50_000 * 9_075_000 / 75_000 = 6_050_000.
    assert_eq!(after_a - before_a, 6_050_000, "winner's payout must be unaffected by the whale's rejected steal attempt");
}

/// H8-hardened: empty-winning-pool refund with MULTIPLE losing-side
/// depositors of DIFFERENT amounts. Each must get back EXACTLY their own
/// deposit (a refund), never a share of the pool and never another
/// depositor's funds -- the accounts-struct OR'd constraint routes them to
/// the refund branch, but this proves the BODY computes the refund
/// correctly per-position, not as some pooled/averaged amount.
#[test]
fn attack_claim_payout_empty_winning_pool_refund_multiple_depositors_exact_amounts() {
    let mut svm = svm_no_oracle();
    let setup = setup_market_for_claim(&mut svm, 304);

    let d1 = Keypair::new();
    let d2 = Keypair::new();
    let d3 = Keypair::new();
    for kp in [&d1, &d2, &d3] {
        svm.airdrop(&kp.pubkey(), 10_000_000_000).unwrap();
    }
    let d1_usdc = create_token_account(&mut svm, &d1, &setup.mint, &d1.pubkey());
    let d2_usdc = create_token_account(&mut svm, &d2, &setup.mint, &d2.pubkey());
    let d3_usdc = create_token_account(&mut svm, &d3, &setup.mint, &d3.pubkey());
    mint_to(&mut svm, &setup.authority, &setup.mint, &d1_usdc, &setup.authority, 1_000_000);
    mint_to(&mut svm, &setup.authority, &setup.mint, &d2_usdc, &setup.authority, 1_000_000);
    mint_to(&mut svm, &setup.authority, &setup.mint, &d3_usdc, &setup.authority, 1_000_000);

    // All three deposit on the NO side, with deliberately unequal, non-round amounts.
    deposit(&mut svm, &setup, &d1, d1_usdc, 123_456, false);
    deposit(&mut svm, &setup, &d2, d2_usdc, 7_777, false);
    deposit(&mut svm, &setup, &d3, d3_usdc, 999_999, false);

    let market = read_market(&svm, &setup.market);
    assert_eq!(market.yes_pool, 0, "sanity: yes_pool must be 0");

    force_resolve(&mut svm, &setup.market, true); // YES wins, but yes_pool == 0 -> refund path for all three

    for (d, usdc, expected_amount) in [(&d1, d1_usdc, 123_456u64), (&d2, d2_usdc, 7_777u64), (&d3, d3_usdc, 999_999u64)] {
        let before = token_balance(&svm, &usdc);
        let (position, _) = position_pda(&setup.market, &d.pubkey());
        svm.expire_blockhash();
        send(&mut svm, d, &[d], claim_ix_raw(setup.market, position, setup.vault, usdc, d.pubkey()))
            .unwrap_or_else(|e| panic!("refund claim failed for depositor with amount {expected_amount}: {e:?}"));
        let after = token_balance(&svm, &usdc);
        assert_eq!(after - before, expected_amount, "refund must equal exactly this depositor's own deposit, not a pooled share");
    }

    assert_eq!(token_balance(&svm, &setup.vault), 0, "vault must be fully drained after all three exact refunds (123_456 + 7_777 + 999_999 divides evenly since it IS the whole pool)");
}

/// H9: attacker attempts to redirect a legitimate claim's payout through a
/// token account of the WRONG mint (e.g. a token account the bettor controls
/// but denominated in a different SPL mint than market.usdc_mint), hoping to
/// either steal via a mint confusion or crash the instruction into an
/// unexpected state. Anchor's `token::mint = market.usdc_mint` constraint on
/// `bettor_usdc` must reject this at the account-validation layer.
#[test]
fn attack_claim_payout_wrong_mint_destination_rejected() {
    let mut svm = svm_no_oracle();
    let setup = setup_market_for_claim(&mut svm, 305);

    let bettor = Keypair::new();
    svm.airdrop(&bettor.pubkey(), 10_000_000_000).unwrap();
    let correct_usdc = create_token_account(&mut svm, &bettor, &setup.mint, &bettor.pubkey());
    mint_to(&mut svm, &setup.authority, &setup.mint, &correct_usdc, &setup.authority, 1_000_000);

    deposit(&mut svm, &setup, &bettor, correct_usdc, 300_000, true);
    force_resolve(&mut svm, &setup.market, true);

    // A different mint, same bettor as authority -- NOT market.usdc_mint.
    let wrong_mint = create_mint(&mut svm, &setup.authority, &setup.authority.pubkey(), 6);
    let wrong_mint_usdc = create_token_account(&mut svm, &bettor, &wrong_mint, &bettor.pubkey());

    let (position, _) = position_pda(&setup.market, &bettor.pubkey());
    let result = send(&mut svm, &bettor, &[&bettor], claim_ix_raw(setup.market, position, setup.vault, wrong_mint_usdc, bettor.pubkey()));

    assert!(result.is_err(), "claim_payout with a wrong-mint destination token account must be rejected by Anchor's token::mint constraint");

    // Confirm the legitimate position is still claimable via the correct account.
    let before = token_balance(&svm, &correct_usdc);
    send(&mut svm, &bettor, &[&bettor], claim_ix_raw(setup.market, position, setup.vault, correct_usdc, bettor.pubkey()))
        .expect("legitimate claim via the correct-mint account must still succeed after the rejected wrong-mint attempt");
    let after = token_balance(&svm, &correct_usdc);
    assert_eq!(after - before, 300_000, "sole winner must receive the full pool via the correct-mint account");
}

/// H10: claim_payout attempted on a market that was NEVER resolved (no
/// resolve() call, no force_resolve simulation). The Accounts-struct-level
/// `constraint = market.resolved` must reject this before the body ever
/// reads `market.outcome` (which would be None) -- proving the
/// `market.outcome.ok_or(MarketNotResolved)?` line in the body is truly
/// unreachable dead code under the current Accounts struct, not a latent
/// path an attacker can reach by some other account arrangement.
#[test]
fn attack_claim_payout_before_resolve_rejected_at_account_validation_layer() {
    let mut svm = svm_no_oracle();
    let setup = setup_market_for_claim(&mut svm, 306);

    let bettor = Keypair::new();
    svm.airdrop(&bettor.pubkey(), 10_000_000_000).unwrap();
    let bettor_usdc = create_token_account(&mut svm, &bettor, &setup.mint, &bettor.pubkey());
    mint_to(&mut svm, &setup.authority, &setup.mint, &bettor_usdc, &setup.authority, 1_000_000);

    deposit(&mut svm, &setup, &bettor, bettor_usdc, 100_000, true);
    // Deliberately do NOT force_resolve. market.resolved is still false,
    // market.outcome is still None.

    let (position, _) = position_pda(&setup.market, &bettor.pubkey());
    let err = send(&mut svm, &bettor, &[&bettor], claim_ix_raw(setup.market, position, setup.vault, bettor_usdc, bettor.pubkey()))
        .expect_err("claim_payout on an unresolved market must be rejected");
    // MarketNotResolved = index 13 -> code 6013 (the ClaimPayout Accounts
    // struct's `constraint = market.resolved @ MarketNotResolved` fires here;
    // the rejection happens before the body runs, and the error now names the
    // actual "not yet resolved" condition rather than the backwards
    // AlreadyResolved -- Dayo M4b cosmetic fix, S179).
    assert_eq!(err.err, custom_err(6013), "expected MarketNotResolved (6013) as the account-validation-layer guard for an unresolved market");

    assert_eq!(token_balance(&svm, &setup.vault), 100_000, "vault must be untouched; the deposit must remain locked, not claimable pre-resolve");
}

// ═══════════════════════════════════════════════════════════════════════════
// Section C: hardened conservation fuzz -- extends claim_payout.rs's fuzz
// (5 cases, max 7 depositors) with more depositors and harsher adversarial
// amount distributions, still deterministic (no wall-clock randomness).
// ═══════════════════════════════════════════════════════════════════════════

struct FuzzDeposit {
    side: bool,
    amount: u64,
}

struct FuzzCase {
    name: &'static str,
    deposits: Vec<FuzzDeposit>,
    outcome: bool,
}

fn hardened_fuzz_cases() -> Vec<FuzzCase> {
    vec![
        FuzzCase {
            name: "12 depositors, prime-heavy amounts, many winners claiming in sequence",
            deposits: vec![
                FuzzDeposit { side: true, amount: 2 },
                FuzzDeposit { side: true, amount: 3 },
                FuzzDeposit { side: true, amount: 5 },
                FuzzDeposit { side: true, amount: 7 },
                FuzzDeposit { side: true, amount: 11 },
                FuzzDeposit { side: true, amount: 13 },
                FuzzDeposit { side: false, amount: 17 },
                FuzzDeposit { side: false, amount: 19 },
                FuzzDeposit { side: false, amount: 23 },
                FuzzDeposit { side: false, amount: 29 },
                FuzzDeposit { side: false, amount: 31 },
                FuzzDeposit { side: true, amount: 1 },
            ],
            outcome: true,
        },
        FuzzCase {
            name: "one dominant winner among 10 tiny winners (rounding pressure on the small side)",
            deposits: vec![
                FuzzDeposit { side: true, amount: 50_000_000 },
                FuzzDeposit { side: true, amount: 1 },
                FuzzDeposit { side: true, amount: 1 },
                FuzzDeposit { side: true, amount: 1 },
                FuzzDeposit { side: true, amount: 1 },
                FuzzDeposit { side: true, amount: 1 },
                FuzzDeposit { side: true, amount: 1 },
                FuzzDeposit { side: true, amount: 1 },
                FuzzDeposit { side: true, amount: 1 },
                FuzzDeposit { side: true, amount: 1 },
                FuzzDeposit { side: false, amount: 999_999_999 },
            ],
            outcome: true,
        },
        FuzzCase {
            name: "near-equal pools, odd totals that never divide evenly",
            deposits: vec![
                FuzzDeposit { side: true, amount: 333_333 },
                FuzzDeposit { side: true, amount: 333_333 },
                FuzzDeposit { side: true, amount: 333_335 },
                FuzzDeposit { side: false, amount: 500_001 },
                FuzzDeposit { side: false, amount: 499_999 },
            ],
            outcome: false,
        },
    ]
}

#[test]
fn attack_conservation_fuzz_hardened() {
    for (case_idx, case) in hardened_fuzz_cases().into_iter().enumerate() {
        let mut svm = svm_no_oracle();
        let market_id = 2000 + case_idx as u64;
        let setup = setup_market_for_claim(&mut svm, market_id);

        struct Depositor {
            keypair: Keypair,
            usdc: Pubkey,
            amount: u64,
            side: bool,
        }

        let mut depositors: Vec<Depositor> = Vec::new();
        let mut total_deposited: u128 = 0;

        for (dep_idx, dep) in case.deposits.iter().enumerate() {
            let mut seed = [0u8; 32];
            seed[0] = case_idx as u8;
            seed[1] = dep_idx as u8;
            seed[2] = 0xCD; // distinguish from claim_payout.rs's 0xAB-seeded fuzz keypairs
            let bettor = Keypair::new_from_array(seed);
            svm.airdrop(&bettor.pubkey(), 20_000_000_000_000).unwrap();
            let usdc = create_token_account(&mut svm, &bettor, &setup.mint, &bettor.pubkey());
            mint_to(&mut svm, &setup.authority, &setup.mint, &usdc, &setup.authority, dep.amount);

            deposit(&mut svm, &setup, &bettor, usdc, dep.amount, dep.side);
            total_deposited += dep.amount as u128;

            depositors.push(Depositor { keypair: bettor, usdc, amount: dep.amount, side: dep.side });
        }

        force_resolve(&mut svm, &setup.market, case.outcome);

        let market_before_claims = read_market(&svm, &setup.market);
        let winning_pool: u64 = if case.outcome { market_before_claims.yes_pool } else { market_before_claims.no_pool };
        let total_pool: u64 = market_before_claims.yes_pool + market_before_claims.no_pool;

        let mut sum_payouts: u128 = 0;

        for d in &depositors {
            let is_winner_side = d.side == case.outcome;
            let eligible = is_winner_side || winning_pool == 0;
            let (position, _) = position_pda(&setup.market, &d.keypair.pubkey());
            if !eligible {
                svm.expire_blockhash();
                let err = send(&mut svm, &d.keypair, &[&d.keypair], claim_ix_raw(setup.market, position, setup.vault, d.usdc, d.keypair.pubkey()))
                    .expect_err(&format!("[{}] losing position must be rejected, never silently paid, even under this harsher fuzz set", case.name));
                assert_eq!(err.err, custom_err(6012), "[{}] expected LosingPosition (6012)", case.name);
                continue;
            }

            let before = token_balance(&svm, &d.usdc);
            svm.expire_blockhash();
            send(&mut svm, &d.keypair, &[&d.keypair], claim_ix_raw(setup.market, position, setup.vault, d.usdc, d.keypair.pubkey()))
                .unwrap_or_else(|e| panic!("[{}] eligible claim failed (possible insufficient-vault-balance under the harsher many-claimer sequence): {e:?}", case.name));
            let after = token_balance(&svm, &d.usdc);
            let payout = after - before;

            let expected_floor: u128 = if winning_pool == 0 {
                d.amount as u128
            } else {
                (d.amount as u128 * total_pool as u128) / (winning_pool as u128)
            };
            assert_eq!(payout as u128, expected_floor, "[{}] payout must equal the exact floor-divided share even under this harsher fuzz set", case.name);

            sum_payouts += payout as u128;
        }

        assert!(sum_payouts <= total_deposited, "[{}] CONSERVATION VIOLATION: sum_payouts {} > total_deposited {}", case.name, sum_payouts, total_deposited);

        let vault_balance = token_balance(&svm, &setup.vault) as u128;
        assert_eq!(vault_balance, total_deposited - sum_payouts, "[{}] vault balance {} != total_deposited {} - sum_payouts {} (phantom lamports or a leak)", case.name, vault_balance, total_deposited, sum_payouts);
    }
}
