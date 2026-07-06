/// Integration tests for pari-market M2b: claim_payout() -- proportional
/// payout math, the winner-only declarative constraint (Dayo M4a P1), the
/// empty-winning-pool refund edge case, the vault-PDA-signed transfer-out
/// authority path (first runtime exercise), and the conservation fuzz test
/// (the M2b verifier).
///
/// Uses litesvm (in-process SVM), pari_market.so only -- claim_payout does
/// not CPI into the oracle, so markets are force-resolved directly (same
/// deserialize -> mutate -> re-serialize pattern M1's
/// test_deposit_after_resolved_rejected established, layout-proof against
/// Borsh's Option<T> None-is-1-byte quirk).
use anchor_lang::{AnchorDeserialize, AnchorSerialize, InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_instruction::{error::InstructionError, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_sysvar::rent::Rent;
use solana_transaction::{Transaction, TransactionError};

use pari_market::constants::{MARKET_SEED, POSITION_SEED, VAULT_SEED};
use pari_market::market::{Comparison, TraderPredicate};
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

fn svm() -> LiteSVM {
    let mut svm = LiteSVM::new();
    let manifest_dir = std::env!("CARGO_MANIFEST_DIR");
    let so = format!("{manifest_dir}/../../target/deploy/pari_market.so");
    svm.add_program_from_file(program_id(), &so)
        .unwrap_or_else(|e| panic!("failed to load {so}: {e}"));
    svm
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
    let init_ix = spl_token::instruction::initialize_mint2(&spl_token::ID, &mint_kp.pubkey(), mint_authority, None, decimals).unwrap();
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

fn default_predicate() -> TraderPredicate {
    TraderPredicate { threshold: 0, comparison: Comparison::GreaterThan }
}

struct MarketSetup {
    market: Pubkey,
    mint: Pubkey,
    vault: Pubkey,
    authority: Keypair,
}

fn setup_market(svm: &mut LiteSVM, market_id: u64) -> MarketSetup {
    let authority = Keypair::new();
    svm.airdrop(&authority.pubkey(), 10_000_000_000).unwrap();
    let mint = create_mint(svm, &authority, &authority.pubkey(), 6);
    let (market, _) = market_pda(market_id);
    let (vault, _) = vault_pda(&market);

    let now = svm.get_sysvar::<solana_clock::Clock>().unix_timestamp;
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

    MarketSetup { market, mint, vault, authority }
}

fn deposit(svm: &mut LiteSVM, setup: &MarketSetup, bettor: &Keypair, bettor_usdc: Pubkey, amount: u64, side: bool) {
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

/// Force-resolves a market: deserialize -> mutate locked/resolved/outcome ->
/// re-serialize. No real CPI needed for claim_payout tests (resolve()'s own
/// CPI correctness is M2a/M2.5's job); this is deliberately layout-proof
/// (field-level mutation, not a byte-offset poke -- see M1's
/// test_deposit_after_resolved_rejected for why offset pokes are fragile
/// against Borsh's Option<T> None-is-1-byte encoding).
fn force_resolve(svm: &mut LiteSVM, market: &Pubkey, outcome: bool) {
    let raw = svm.get_account(market).unwrap();
    let owner = raw.owner;
    let mut market_state: pari_market::market::Market =
        AnchorDeserialize::deserialize(&mut &raw.data[8..]).unwrap();
    market_state.locked = true;
    market_state.resolved = true;
    market_state.outcome = Some(outcome);

    let mut data = raw.data[..8].to_vec();
    AnchorSerialize::serialize(&market_state, &mut data).unwrap();

    svm.set_account(
        *market,
        Account { lamports: raw.lamports, data, owner, executable: false, rent_epoch: raw.rent_epoch },
    )
    .unwrap();
}

fn read_market(svm: &LiteSVM, market: &Pubkey) -> pari_market::market::Market {
    let raw = svm.get_account(market).expect("market account not found");
    AnchorDeserialize::deserialize(&mut &raw.data[8..]).expect("deserialize market")
}

fn read_position(svm: &LiteSVM, position: &Pubkey) -> pari_market::position::Position {
    let raw = svm.get_account(position).expect("position account not found");
    AnchorDeserialize::deserialize(&mut &raw.data[8..]).expect("deserialize position")
}

fn claim_ix(setup: &MarketSetup, bettor: &Keypair, bettor_usdc: Pubkey) -> Instruction {
    let (position, _) = position_pda(&setup.market, &bettor.pubkey());
    let accounts = acc::ClaimPayout {
        market: setup.market,
        position,
        vault: setup.vault,
        bettor_usdc,
        bettor: bettor.pubkey(),
        token_program: spl_token::ID,
    }
    .to_account_metas(None);
    let data = ix::ClaimPayout {}.data();
    Instruction { program_id: program_id(), accounts, data }
}

fn custom_err(code: u32) -> TransactionError {
    TransactionError::InstructionError(0, InstructionError::Custom(code))
}

// ── Test 1: proportional payout happy path ──────────────────────────────────
// YES pool: 300_000 (bettor A). NO pool: 100_000 (bettor B). Outcome: YES wins.
// total_pool = 400_000, winning_pool = 300_000. A's payout = 300_000 * 400_000 / 300_000 = 400_000.

#[test]
fn test_claim_payout_proportional_happy_path() {
    let mut svm = svm();
    let setup = setup_market(&mut svm, 1);

    let bettor_a = Keypair::new();
    let bettor_b = Keypair::new();
    svm.airdrop(&bettor_a.pubkey(), 10_000_000_000).unwrap();
    svm.airdrop(&bettor_b.pubkey(), 10_000_000_000).unwrap();
    let a_usdc = create_token_account(&mut svm, &bettor_a, &setup.mint, &bettor_a.pubkey());
    let b_usdc = create_token_account(&mut svm, &bettor_b, &setup.mint, &bettor_b.pubkey());
    mint_to(&mut svm, &setup.authority, &setup.mint, &a_usdc, &setup.authority, 1_000_000);
    mint_to(&mut svm, &setup.authority, &setup.mint, &b_usdc, &setup.authority, 1_000_000);

    deposit(&mut svm, &setup, &bettor_a, a_usdc, 300_000, true);
    deposit(&mut svm, &setup, &bettor_b, b_usdc, 100_000, false);

    force_resolve(&mut svm, &setup.market, true); // YES wins

    let before = token_balance(&svm, &a_usdc);
    send(&mut svm, &bettor_a, &[&bettor_a], claim_ix(&setup, &bettor_a, a_usdc)).expect("winner claim should succeed");
    let after = token_balance(&svm, &a_usdc);

    assert_eq!(after - before, 400_000, "winner's payout must be exactly total_pool (sole winner takes all)");

    let (position_a, _) = position_pda(&setup.market, &bettor_a.pubkey());
    let pos = read_position(&svm, &position_a);
    assert!(pos.claimed, "position.claimed must be true after claim");

    assert_eq!(token_balance(&svm, &setup.vault), 0, "vault must be drained to 0 (sole winner, no dust)");
}

// ── Test 2: losing position rejected (winner-only constraint) ──────────────

#[test]
fn test_claim_payout_losing_position_rejected() {
    let mut svm = svm();
    let setup = setup_market(&mut svm, 2);

    let bettor_a = Keypair::new();
    let bettor_b = Keypair::new();
    svm.airdrop(&bettor_a.pubkey(), 10_000_000_000).unwrap();
    svm.airdrop(&bettor_b.pubkey(), 10_000_000_000).unwrap();
    let a_usdc = create_token_account(&mut svm, &bettor_a, &setup.mint, &bettor_a.pubkey());
    let b_usdc = create_token_account(&mut svm, &bettor_b, &setup.mint, &bettor_b.pubkey());
    mint_to(&mut svm, &setup.authority, &setup.mint, &a_usdc, &setup.authority, 1_000_000);
    mint_to(&mut svm, &setup.authority, &setup.mint, &b_usdc, &setup.authority, 1_000_000);

    deposit(&mut svm, &setup, &bettor_a, a_usdc, 300_000, true);
    deposit(&mut svm, &setup, &bettor_b, b_usdc, 100_000, false);

    force_resolve(&mut svm, &setup.market, true); // YES wins, B (NO) loses

    let err = send(&mut svm, &bettor_b, &[&bettor_b], claim_ix(&setup, &bettor_b, b_usdc))
        .expect_err("losing-side claim (winning pool non-empty) must be rejected");
    // LosingPosition = index 12 -> code 6012.
    assert_eq!(err.err, custom_err(6012), "expected LosingPosition (6012)");
}

// ── Test 3: double-claim rejected ───────────────────────────────────────────

#[test]
fn test_claim_payout_double_claim_rejected() {
    let mut svm = svm();
    let setup = setup_market(&mut svm, 3);

    let bettor_a = Keypair::new();
    svm.airdrop(&bettor_a.pubkey(), 10_000_000_000).unwrap();
    let a_usdc = create_token_account(&mut svm, &bettor_a, &setup.mint, &bettor_a.pubkey());
    mint_to(&mut svm, &setup.authority, &setup.mint, &a_usdc, &setup.authority, 1_000_000);

    deposit(&mut svm, &setup, &bettor_a, a_usdc, 100_000, true);
    force_resolve(&mut svm, &setup.market, true);

    send(&mut svm, &bettor_a, &[&bettor_a], claim_ix(&setup, &bettor_a, a_usdc)).expect("first claim should succeed");

    svm.expire_blockhash();
    let err = send(&mut svm, &bettor_a, &[&bettor_a], claim_ix(&setup, &bettor_a, a_usdc))
        .expect_err("second claim on the same position must be rejected");
    // AlreadyClaimed = index 4 -> code 6004.
    assert_eq!(err.err, custom_err(6004), "expected AlreadyClaimed (6004)");
}

// ── Test 4: empty-winning-pool refund ───────────────────────────────────────
// Only NO-side deposits exist. Outcome resolves YES (winning_pool = yes_pool = 0).
// The NO-side depositor must be refunded exactly their deposit, not stuck.

#[test]
fn test_claim_payout_empty_winning_pool_refund() {
    let mut svm = svm();
    let setup = setup_market(&mut svm, 4);

    let bettor_a = Keypair::new();
    svm.airdrop(&bettor_a.pubkey(), 10_000_000_000).unwrap();
    let a_usdc = create_token_account(&mut svm, &bettor_a, &setup.mint, &bettor_a.pubkey());
    mint_to(&mut svm, &setup.authority, &setup.mint, &a_usdc, &setup.authority, 1_000_000);

    deposit(&mut svm, &setup, &bettor_a, a_usdc, 250_000, false); // NO side only

    let market = read_market(&svm, &setup.market);
    assert_eq!(market.yes_pool, 0, "sanity: yes_pool must be 0 (nobody bet YES)");

    force_resolve(&mut svm, &setup.market, true); // YES wins, but yes_pool == 0

    let before = token_balance(&svm, &a_usdc);
    send(&mut svm, &bettor_a, &[&bettor_a], claim_ix(&setup, &bettor_a, a_usdc))
        .expect("empty-winning-pool refund must succeed for the NO-side depositor");
    let after = token_balance(&svm, &a_usdc);

    assert_eq!(after - before, 250_000, "refund must equal exactly the original deposit, not a proportional share");
    assert_eq!(token_balance(&svm, &setup.vault), 0, "vault must be fully drained after the sole refund");
}

// ── Test 5: vault-PDA-signed transfer-out authority path ───────────────────
// Explicit assertion this is the FIRST runtime exercise of the market-PDA-
// signs-outbound-transfers authority model (deposit only ever transfers IN,
// bettor-signed; claim_payout is the first outbound leg).

#[test]
fn test_claim_payout_vault_authority_signs_outbound_transfer() {
    let mut svm = svm();
    let setup = setup_market(&mut svm, 5);

    let bettor_a = Keypair::new();
    svm.airdrop(&bettor_a.pubkey(), 10_000_000_000).unwrap();
    let a_usdc = create_token_account(&mut svm, &bettor_a, &setup.mint, &bettor_a.pubkey());
    mint_to(&mut svm, &setup.authority, &setup.mint, &a_usdc, &setup.authority, 1_000_000);

    deposit(&mut svm, &setup, &bettor_a, a_usdc, 100_000, true);

    // Confirm the vault's token::authority really is the Market PDA (not a
    // separate keypair) before claiming -- this is the precondition the
    // signer-seeds path in claim_payout's body relies on.
    let vault_raw = svm.get_account(&setup.vault).unwrap();
    let vault_unpacked = <spl_token::state::Account as solana_program_pack::Pack>::unpack(&vault_raw.data).unwrap();
    assert_eq!(vault_unpacked.owner, setup.market, "vault's SPL token authority must be the Market PDA");

    force_resolve(&mut svm, &setup.market, true);

    // If the CpiContext::new_with_signer seeds were wrong, this CPI would
    // fail with a Solana-level signature/authority error (the vault's
    // authority would reject the transfer instruction). Success here is the
    // runtime proof the [MARKET_SEED, market_id.LE, bump] signer seeds are
    // correct.
    send(&mut svm, &bettor_a, &[&bettor_a], claim_ix(&setup, &bettor_a, a_usdc))
        .expect("claim_payout's market-PDA-signed transfer-out must succeed");

    assert_eq!(token_balance(&svm, &a_usdc), 1_000_000 - 100_000 + 100_000, "full round-trip balance check");
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 6: CONSERVATION FUZZ (the M2b verifier, non-negotiable)
// ═══════════════════════════════════════════════════════════════════════════
//
// Property-style test over adversarial deposit sets. Deterministic seeding
// (no wall-clock randomness) -- every case is a hardcoded list, reproducible
// on every run. For each case: build the market, apply all deposits, force-
// resolve, claim every position in sequence, then assert:
//   (a) sum(all payouts) <= total_deposited
//   (b) vault balance == total_deposited - sum(payouts)  (no phantom lamports)
//   (c) every winner's payout >= their proportional floor
//       (position.amount * total_pool) / winning_pool, computed the same way
//       the on-chain math does, so this is a redundant cross-check of the
//       CONTRACT (must be >=), not a re-implementation the test blindly trusts.

struct FuzzDeposit {
    side: bool,
    amount: u64,
}

struct FuzzCase {
    name: &'static str,
    deposits: Vec<FuzzDeposit>,
    outcome: bool, // true = YES wins
}

fn fuzz_cases() -> Vec<FuzzCase> {
    vec![
        FuzzCase {
            name: "1-unit deposits, many claimers",
            deposits: vec![
                FuzzDeposit { side: true, amount: 1 },
                FuzzDeposit { side: true, amount: 1 },
                FuzzDeposit { side: false, amount: 1 },
                FuzzDeposit { side: false, amount: 1 },
                FuzzDeposit { side: true, amount: 1 },
            ],
            outcome: true,
        },
        FuzzCase {
            name: "heavily lopsided: 1 vs a large NO pool",
            deposits: vec![
                FuzzDeposit { side: true, amount: 1 },
                FuzzDeposit { side: false, amount: 5_000_000_000_000 }, // large, not near u64::MAX (avoid airdrop/mint overflow in test setup)
            ],
            outcome: true, // the 1-unit YES depositor takes the whole pool
        },
        FuzzCase {
            name: "dust-generating: amounts that do not divide evenly",
            deposits: vec![
                FuzzDeposit { side: true, amount: 7 },
                FuzzDeposit { side: true, amount: 11 },
                FuzzDeposit { side: true, amount: 13 },
                FuzzDeposit { side: false, amount: 17 },
                FuzzDeposit { side: false, amount: 19 },
            ],
            outcome: true,
        },
        FuzzCase {
            name: "many claimers in sequence, mixed amounts",
            deposits: vec![
                FuzzDeposit { side: true, amount: 100_000 },
                FuzzDeposit { side: true, amount: 250_000 },
                FuzzDeposit { side: true, amount: 333_333 },
                FuzzDeposit { side: false, amount: 400_000 },
                FuzzDeposit { side: false, amount: 150_000 },
                FuzzDeposit { side: false, amount: 999_999 },
                FuzzDeposit { side: true, amount: 1 },
            ],
            outcome: false,
        },
        FuzzCase {
            name: "empty-winning-pool refund case (fuzz-covered)",
            deposits: vec![
                FuzzDeposit { side: false, amount: 50_000 },
                FuzzDeposit { side: false, amount: 75_000 },
                FuzzDeposit { side: false, amount: 1 },
            ],
            outcome: true, // YES wins but yes_pool == 0 -> every NO position refunds
        },
    ]
}

#[test]
fn test_claim_payout_conservation_fuzz() {
    for (case_idx, case) in fuzz_cases().into_iter().enumerate() {
        let mut svm = svm();
        // Deterministic market_id per case: 1000 + case_idx (offset clear of
        // the other tests' market_ids 1-5 in this file).
        let market_id = 1000 + case_idx as u64;
        let setup = setup_market(&mut svm, market_id);

        // Deterministic bettor keypairs per case (seeded from a fixed byte
        // pattern derived from case_idx + deposit index -- no wall-clock
        // randomness, fully reproducible).
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
            seed[2] = 0xAB; // distinguish from other fixed-seed keypairs in the suite
            let bettor = Keypair::new_from_array(seed);
            svm.airdrop(&bettor.pubkey(), 20_000_000_000_000).unwrap(); // enough for the lopsided case's large amount + rent
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
            if !eligible {
                // Ordinary loser, winning pool non-empty: must be rejected,
                // never silently zero-paid.
                svm.expire_blockhash();
                let err = send(&mut svm, &d.keypair, &[&d.keypair], claim_ix(&setup, &d.keypair, d.usdc))
                    .expect_err(&format!("[{}] losing position must be rejected, not silently paid", case.name));
                assert_eq!(err.err, custom_err(6012), "[{}] expected LosingPosition (6012)", case.name);
                continue;
            }

            let before = token_balance(&svm, &d.usdc);
            svm.expire_blockhash();
            send(&mut svm, &d.keypair, &[&d.keypair], claim_ix(&setup, &d.keypair, d.usdc))
                .unwrap_or_else(|e| panic!("[{}] eligible claim failed: {e:?}", case.name));
            let after = token_balance(&svm, &d.usdc);
            let payout = after - before;

            // Contract cross-check: the payout must be >= the proportional
            // floor this test computes independently (same formula the
            // program uses, but this is verifying the CONTRACT held, not
            // trusting the program's internal math blindly -- a genuine
            // math bug in the program would show up as a mismatch here).
            let expected_floor: u128 = if winning_pool == 0 {
                d.amount as u128 // refund case: exact deposit back, not "floor" in the proportional sense
            } else {
                (d.amount as u128 * total_pool as u128) / (winning_pool as u128)
            };
            assert!(
                (payout as u128) >= expected_floor,
                "[{}] payout {} below proportional floor {} for depositor amount {}",
                case.name, payout, expected_floor, d.amount
            );
            // And must not exceed it (floor division means it should be
            // exactly equal in this single-instruction, no-rounding-drift
            // design -- assert equality, tighter than the brief's ">="
            // minimum, since our own math is exact floor division).
            assert_eq!(
                payout as u128, expected_floor,
                "[{}] payout must equal the exact floor-divided share (no over/under-payment)", case.name
            );

            sum_payouts += payout as u128;
        }

        // (a) conservation: never pay out more than was deposited.
        assert!(
            sum_payouts <= total_deposited,
            "[{}] CONSERVATION VIOLATION: sum_payouts {} > total_deposited {}",
            case.name, sum_payouts, total_deposited
        );

        // (b) no phantom lamports: vault balance must equal exactly what's left.
        let vault_balance = token_balance(&svm, &setup.vault) as u128;
        assert_eq!(
            vault_balance, total_deposited - sum_payouts,
            "[{}] vault balance {} != total_deposited {} - sum_payouts {} (phantom lamports or a leak)",
            case.name, vault_balance, total_deposited, sum_payouts
        );
    }
}
