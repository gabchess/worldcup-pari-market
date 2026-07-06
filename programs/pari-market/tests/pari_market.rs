/// Integration tests for pari-market M1 instructions (init_market, deposit,
/// lock_market).
///
/// Uses litesvm (in-process SVM) -- no local validator, no devnet. The
/// compiled .so is loaded from target/deploy/pari_market.so. Follows the
/// same pattern as programs/worldcup-settlement/tests/settlement.rs.
///
/// M2a/M2b (resolve, claim_payout) are out of scope -- not tested here.
use anchor_lang::{InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use solana_clock::Clock;
use solana_instruction::{error::InstructionError, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_sysvar::rent::Rent;
use solana_transaction::{Transaction, TransactionError};

use pari_market::constants::{MARKET_SEED, POSITION_SEED, VAULT_SEED};
use pari_market::market::{BinaryExpression, Comparison, TraderPredicate};
use pari_market::{self, accounts as acc, instruction as ix};

// spl_token re-exported through anchor_spl -- classic Token program, already
// bundled as a litesvm builtin (LiteSVM::new() -> with_default_programs()).
use anchor_spl::token::spl_token;

const SYSTEM_PROGRAM_ID: Pubkey = Pubkey::from_str_const("11111111111111111111111111111111");

// ── PDA derivation helpers ──────────────────────────────────────────────────

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
    Pubkey::find_program_address(
        &[POSITION_SEED, market.as_ref(), bettor.as_ref()],
        &program_id(),
    )
}

// ── SVM + token setup helpers ───────────────────────────────────────────────

/// Build an SVM with the pari-market program loaded. The .so is produced by
/// `anchor build`.
fn svm() -> LiteSVM {
    let mut svm = LiteSVM::new();
    // CARGO_MANIFEST_DIR = programs/pari-market/; workspace root is two levels up.
    let manifest_dir = std::env!("CARGO_MANIFEST_DIR");
    let so = format!("{manifest_dir}/../../target/deploy/pari_market.so");
    svm.add_program_from_file(program_id(), &so)
        .unwrap_or_else(|e| panic!("failed to load {so}: {e}"));
    svm
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

fn send_many(
    svm: &mut LiteSVM,
    payer: &Keypair,
    signers: &[&Keypair],
    instructions: &[Instruction],
) -> litesvm::types::TransactionResult {
    let bh = svm.latest_blockhash();
    let msg = Message::new(instructions, Some(&payer.pubkey()));
    let tx = Transaction::new(signers, msg, bh);
    svm.send_transaction(tx)
}

/// Creates a fresh classic-SPL-Token mint, minted by `mint_authority` (the
/// program payer/authority for these tests -- no CPI relationship implied).
/// Returns the mint pubkey.
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

    send_many(svm, payer, &[payer, &mint_kp], &[create_ix, init_ix])
        .expect("create_mint failed");

    mint_kp.pubkey()
}

/// Creates a fresh classic-SPL-Token account for `owner`, holding `mint`,
/// optionally pre-funded with `initial_amount` (minted in by `mint_authority`,
/// which must equal the mint's actual mint_authority).
fn create_token_account(
    svm: &mut LiteSVM,
    payer: &Keypair,
    mint: &Pubkey,
    owner: &Pubkey,
) -> Pubkey {
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
    let init_ix =
        spl_token::instruction::initialize_account3(&spl_token::ID, &acct_kp.pubkey(), mint, owner).unwrap();

    send_many(svm, payer, &[payer, &acct_kp], &[create_ix, init_ix])
        .expect("create_token_account failed");

    acct_kp.pubkey()
}

fn mint_to(
    svm: &mut LiteSVM,
    payer: &Keypair,
    mint: &Pubkey,
    dest: &Pubkey,
    mint_authority: &Keypair,
    amount: u64,
) {
    let ix = spl_token::instruction::mint_to(
        &spl_token::ID,
        mint,
        dest,
        &mint_authority.pubkey(),
        &[],
        amount,
    )
    .unwrap();
    send(svm, payer, &[payer, mint_authority], ix).expect("mint_to failed");
}

fn token_balance(svm: &LiteSVM, token_account: &Pubkey) -> u64 {
    let raw = svm.get_account(token_account).expect("token account not found");
    let unpacked = <spl_token::state::Account as solana_program_pack::Pack>::unpack(&raw.data)
        .expect("unpack token account");
    unpacked.amount
}

fn set_clock_timestamp(svm: &mut LiteSVM, unix_timestamp: i64) {
    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp = unix_timestamp;
    svm.set_sysvar::<Clock>(&clock);
}

fn default_predicate() -> TraderPredicate {
    TraderPredicate {
        threshold: 0,
        comparison: Comparison::GreaterThan,
    }
}

/// Full market setup: creates mint, market PDA (init_market), vault PDA.
/// Returns (market, mint, vault, authority, lock_ts).
struct MarketSetup {
    market: Pubkey,
    mint: Pubkey,
    vault: Pubkey,
    authority: Keypair,
    lock_ts: i64,
}

fn setup_market(svm: &mut LiteSVM, market_id: u64, lock_offset_secs: i64) -> MarketSetup {
    let authority = Keypair::new();
    svm.airdrop(&authority.pubkey(), 10_000_000_000).unwrap();

    let mint = create_mint(svm, &authority, &authority.pubkey(), 6);
    let (market, _) = market_pda(market_id);
    let (vault, _) = vault_pda(&market);

    let now = svm.get_sysvar::<Clock>().unix_timestamp;
    let lock_ts = now + lock_offset_secs;

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
        op: None::<BinaryExpression>,
        predicate: default_predicate(),
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

    MarketSetup { market, mint, vault, authority, lock_ts }
}

fn deposit_ix(market: Pubkey, position: Pubkey, vault: Pubkey, bettor_usdc: Pubkey, bettor: Pubkey, amount: u64, side: bool) -> Instruction {
    let accounts = acc::Deposit {
        market,
        position,
        vault,
        bettor_usdc,
        bettor,
        token_program: spl_token::ID,
        system_program: SYSTEM_PROGRAM_ID,
    }
    .to_account_metas(None);
    let data = ix::Deposit { amount, side }.data();
    Instruction { program_id: program_id(), accounts, data }
}

fn custom_err(code: u32) -> TransactionError {
    TransactionError::InstructionError(0, InstructionError::Custom(code))
}

// ── Test 1: happy path -- create, deposit both sides, pools update, lock closes deposits ──

#[test]
fn test_create_deposit_both_sides_lock_happy_path() {
    let mut svm = svm();
    let setup = setup_market(&mut svm, 1, 3600);

    let yes_bettor = Keypair::new();
    let no_bettor = Keypair::new();
    svm.airdrop(&yes_bettor.pubkey(), 10_000_000_000).unwrap();
    svm.airdrop(&no_bettor.pubkey(), 10_000_000_000).unwrap();

    let yes_usdc = create_token_account(&mut svm, &yes_bettor, &setup.mint, &yes_bettor.pubkey());
    let no_usdc = create_token_account(&mut svm, &no_bettor, &setup.mint, &no_bettor.pubkey());
    mint_to(&mut svm, &setup.authority, &setup.mint, &yes_usdc, &setup.authority, 1_000_000);
    mint_to(&mut svm, &setup.authority, &setup.mint, &no_usdc, &setup.authority, 500_000);

    let (yes_position, _) = position_pda(&setup.market, &yes_bettor.pubkey());
    let (no_position, _) = position_pda(&setup.market, &no_bettor.pubkey());

    // YES deposit: 300_000.
    send(
        &mut svm,
        &yes_bettor,
        &[&yes_bettor],
        deposit_ix(setup.market, yes_position, setup.vault, yes_usdc, yes_bettor.pubkey(), 300_000, true),
    )
    .expect("yes deposit failed");

    // NO deposit: 200_000.
    send(
        &mut svm,
        &no_bettor,
        &[&no_bettor],
        deposit_ix(setup.market, no_position, setup.vault, no_usdc, no_bettor.pubkey(), 200_000, false),
    )
    .expect("no deposit failed");

    // Verify pools + balances.
    let market_data = svm.get_account(&setup.market).unwrap();
    let market: pari_market::market::Market =
        anchor_lang::AnchorDeserialize::deserialize(&mut &market_data.data[8..]).unwrap();
    assert_eq!(market.yes_pool, 300_000, "yes_pool mismatch");
    assert_eq!(market.no_pool, 200_000, "no_pool mismatch");
    assert!(!market.locked, "market should not be locked yet");

    assert_eq!(token_balance(&svm, &yes_usdc), 700_000, "yes bettor balance should decrease by 300_000");
    assert_eq!(token_balance(&svm, &no_usdc), 300_000, "no bettor balance should decrease by 200_000");
    assert_eq!(token_balance(&svm, &setup.vault), 500_000, "vault should hold sum of both deposits");

    let yes_pos_data = svm.get_account(&yes_position).unwrap();
    let yes_pos: pari_market::position::Position =
        anchor_lang::AnchorDeserialize::deserialize(&mut &yes_pos_data.data[8..]).unwrap();
    assert_eq!(yes_pos.amount, 300_000);
    assert!(yes_pos.side);
    assert!(!yes_pos.claimed);

    // Warp clock past lock_ts, then lock_market (permissionless -- any signer).
    set_clock_timestamp(&mut svm, setup.lock_ts + 1);
    let lock_accounts = acc::LockMarket { market: setup.market, caller: no_bettor.pubkey() }.to_account_metas(None);
    let lock_data = ix::LockMarket {}.data();
    send(
        &mut svm,
        &no_bettor,
        &[&no_bettor],
        Instruction { program_id: program_id(), accounts: lock_accounts, data: lock_data },
    )
    .expect("lock_market failed");

    let market_data = svm.get_account(&setup.market).unwrap();
    let market: pari_market::market::Market =
        anchor_lang::AnchorDeserialize::deserialize(&mut &market_data.data[8..]).unwrap();
    assert!(market.locked, "market should be locked");

    // Deposit after lock must be rejected (MarketLocked = index 1 -> code 6001).
    svm.expire_blockhash();
    let err = send(
        &mut svm,
        &yes_bettor,
        &[&yes_bettor],
        deposit_ix(setup.market, yes_position, setup.vault, yes_usdc, yes_bettor.pubkey(), 1, true),
    )
    .expect_err("deposit after lock should be rejected");
    assert_eq!(err.err, custom_err(6001), "expected MarketLocked (6001)");
}

// ── Test 2: same-slot lock-race -- deposit at/after lock_ts (before lock_market runs) is rejected ──

#[test]
fn test_deposit_after_lock_ts_rejected_before_lock_market_called() {
    let mut svm = svm();
    let setup = setup_market(&mut svm, 2, 3600);

    let bettor = Keypair::new();
    svm.airdrop(&bettor.pubkey(), 10_000_000_000).unwrap();
    let bettor_usdc = create_token_account(&mut svm, &bettor, &setup.mint, &bettor.pubkey());
    mint_to(&mut svm, &setup.authority, &setup.mint, &bettor_usdc, &setup.authority, 1_000_000);

    let (position, _) = position_pda(&setup.market, &bettor.pubkey());

    // Warp the clock to exactly lock_ts + 1 (past the deadline) WITHOUT ever
    // calling lock_market(). This is the same-slot lock-race case: a deposit
    // landing at/after lock_ts must fail even though market.locked is still
    // false at the account-constraint layer.
    set_clock_timestamp(&mut svm, setup.lock_ts + 1);

    let err = send(
        &mut svm,
        &bettor,
        &[&bettor],
        deposit_ix(setup.market, position, setup.vault, bettor_usdc, bettor.pubkey(), 100_000, true),
    )
    .expect_err("deposit at/after lock_ts (pre-lock_market) must be rejected");

    // DepositAfterLock = index 2 -> code 6002.
    assert_eq!(err.err, custom_err(6002), "expected DepositAfterLock (6002)");

    // Confirm the deposit truly did not land: position PDA was never created,
    // pools untouched.
    assert!(svm.get_account(&position).is_none(), "position must not have been created");
    let market_data = svm.get_account(&setup.market).unwrap();
    let market: pari_market::market::Market =
        anchor_lang::AnchorDeserialize::deserialize(&mut &market_data.data[8..]).unwrap();
    assert_eq!(market.yes_pool, 0);
    assert_eq!(market.no_pool, 0);

    // Also confirm the exact boundary: deposit at exactly lock_ts (== , not >)
    // is still allowed per the scaffold's doc comment (rejected once
    // unix_timestamp > lock_ts). Warp back to exactly lock_ts and retry.
    set_clock_timestamp(&mut svm, setup.lock_ts);
    svm.expire_blockhash();
    send(
        &mut svm,
        &bettor,
        &[&bettor],
        deposit_ix(setup.market, position, setup.vault, bettor_usdc, bettor.pubkey(), 100_000, true),
    )
    .expect("deposit at exactly lock_ts should still succeed (boundary is exclusive on the lock side)");
}

// ── Test 3: deposit-zero-amount rejected ────────────────────────────────────

#[test]
fn test_deposit_zero_amount_rejected() {
    let mut svm = svm();
    let setup = setup_market(&mut svm, 3, 3600);

    let bettor = Keypair::new();
    svm.airdrop(&bettor.pubkey(), 10_000_000_000).unwrap();
    let bettor_usdc = create_token_account(&mut svm, &bettor, &setup.mint, &bettor.pubkey());
    mint_to(&mut svm, &setup.authority, &setup.mint, &bettor_usdc, &setup.authority, 1_000_000);

    let (position, _) = position_pda(&setup.market, &bettor.pubkey());

    let err = send(
        &mut svm,
        &bettor,
        &[&bettor],
        deposit_ix(setup.market, position, setup.vault, bettor_usdc, bettor.pubkey(), 0, true),
    )
    .expect_err("zero-amount deposit should be rejected");

    // ZeroAmount = index 7 -> code 6007.
    assert_eq!(err.err, custom_err(6007), "expected ZeroAmount (6007)");
}

// ── Test 4: deposit after resolved rejected (state guard even though resolve is stubbed) ──

#[test]
fn test_deposit_after_resolved_rejected() {
    let mut svm = svm();
    let setup = setup_market(&mut svm, 4, 3600);

    let bettor = Keypair::new();
    svm.airdrop(&bettor.pubkey(), 10_000_000_000).unwrap();
    let bettor_usdc = create_token_account(&mut svm, &bettor, &setup.mint, &bettor.pubkey());
    mint_to(&mut svm, &setup.authority, &setup.mint, &bettor_usdc, &setup.authority, 1_000_000);

    let (position, _) = position_pda(&setup.market, &bettor.pubkey());

    // resolve() is out of M1 scope and still todo!()'s; simulate the
    // post-resolve state directly (market.resolved implies market.locked in
    // the real flow, since Resolve's Accounts struct requires
    // `constraint = market.locked` before resolve() can even be called).
    // Deserialize -> mutate struct fields -> re-serialize, rather than a raw
    // byte-offset poke: Borsh's Option<T> only emits the value when Some, so
    // a hand-computed fixed offset for `locked`/`resolved` is fragile against
    // this market's None stat_b_key/op (confirmed by a first-pass offset
    // poke that undershot by 5 bytes). Field-level mutation is layout-proof.
    {
        let raw = svm.get_account(&setup.market).unwrap();
        let owner = raw.owner;
        let mut market: pari_market::market::Market =
            anchor_lang::AnchorDeserialize::deserialize(&mut &raw.data[8..]).unwrap();
        market.locked = true;
        market.resolved = true;

        let mut data = raw.data[..8].to_vec(); // keep the 8-byte discriminator
        anchor_lang::AnchorSerialize::serialize(&market, &mut data).unwrap();

        svm.set_account(
            setup.market,
            solana_account::Account {
                lamports: raw.lamports,
                data,
                owner,
                executable: false,
                rent_epoch: raw.rent_epoch,
            },
        )
        .unwrap();

        // Self-check: deserialize and confirm the mutation landed.
        let updated = svm.get_account(&setup.market).unwrap();
        let market: pari_market::market::Market =
            anchor_lang::AnchorDeserialize::deserialize(&mut &updated.data[8..]).unwrap();
        assert!(market.locked, "market.locked must be true after the simulated post-resolve write");
        assert!(market.resolved, "market.resolved must be true after the simulated post-resolve write");
    }

    let err = send(
        &mut svm,
        &bettor,
        &[&bettor],
        deposit_ix(setup.market, position, setup.vault, bettor_usdc, bettor.pubkey(), 100_000, true),
    )
    .expect_err("deposit on a resolved (and therefore locked) market must be rejected");

    // MarketLocked = index 1 -> code 6001 (resolved implies locked; deposit's
    // only account-level guard is !market.locked, which already covers this).
    assert_eq!(err.err, custom_err(6001), "expected MarketLocked (6001)");
}

// ── Test 5: wrong-mint deposit rejected by token constraints ───────────────

#[test]
fn test_deposit_wrong_mint_rejected() {
    let mut svm = svm();
    let setup = setup_market(&mut svm, 5, 3600);

    let bettor = Keypair::new();
    svm.airdrop(&bettor.pubkey(), 10_000_000_000).unwrap();

    // A different mint than the market's usdc_mint.
    let wrong_mint = create_mint(&mut svm, &setup.authority, &setup.authority.pubkey(), 6);
    let wrong_mint_usdc = create_token_account(&mut svm, &bettor, &wrong_mint, &bettor.pubkey());
    mint_to(&mut svm, &setup.authority, &wrong_mint, &wrong_mint_usdc, &setup.authority, 1_000_000);

    let (position, _) = position_pda(&setup.market, &bettor.pubkey());

    let result = send(
        &mut svm,
        &bettor,
        &[&bettor],
        deposit_ix(setup.market, position, setup.vault, wrong_mint_usdc, bettor.pubkey(), 100_000, true),
    );

    assert!(result.is_err(), "deposit with wrong-mint token account should be rejected by Anchor's token::mint constraint");
}

// ── Test 6: side-mismatch on repeat deposit rejected (Dayo M4a P1 finding) ──

#[test]
fn test_deposit_side_mismatch_on_repeat_rejected() {
    let mut svm = svm();
    let setup = setup_market(&mut svm, 6, 3600);

    let bettor = Keypair::new();
    svm.airdrop(&bettor.pubkey(), 10_000_000_000).unwrap();
    let bettor_usdc = create_token_account(&mut svm, &bettor, &setup.mint, &bettor.pubkey());
    mint_to(&mut svm, &setup.authority, &setup.mint, &bettor_usdc, &setup.authority, 1_000_000);

    let (position, _) = position_pda(&setup.market, &bettor.pubkey());

    // First deposit: YES side.
    send(
        &mut svm,
        &bettor,
        &[&bettor],
        deposit_ix(setup.market, position, setup.vault, bettor_usdc, bettor.pubkey(), 100_000, true),
    )
    .expect("first (YES) deposit should succeed");

    // Second deposit, same side (YES): must accumulate.
    svm.expire_blockhash();
    send(
        &mut svm,
        &bettor,
        &[&bettor],
        deposit_ix(setup.market, position, setup.vault, bettor_usdc, bettor.pubkey(), 50_000, true),
    )
    .expect("second same-side (YES) deposit should accumulate");

    let pos_data = svm.get_account(&position).unwrap();
    let pos: pari_market::position::Position =
        anchor_lang::AnchorDeserialize::deserialize(&mut &pos_data.data[8..]).unwrap();
    assert_eq!(pos.amount, 150_000, "same-side repeat deposit must accumulate, not reset");
    assert!(pos.side, "side must remain YES");

    // Third deposit, opposite side (NO): must be rejected with SideMismatch.
    svm.expire_blockhash();
    let err = send(
        &mut svm,
        &bettor,
        &[&bettor],
        deposit_ix(setup.market, position, setup.vault, bettor_usdc, bettor.pubkey(), 10_000, false),
    )
    .expect_err("opposite-side repeat deposit must be rejected");

    // SideMismatch = index 6 -> code 6006.
    assert_eq!(err.err, custom_err(6006), "expected SideMismatch (6006)");

    // Confirm the rejected call did not mutate state (amount unchanged, side unchanged).
    let pos_data = svm.get_account(&position).unwrap();
    let pos: pari_market::position::Position =
        anchor_lang::AnchorDeserialize::deserialize(&mut &pos_data.data[8..]).unwrap();
    assert_eq!(pos.amount, 150_000, "rejected side-mismatch deposit must not mutate amount");
    assert!(pos.side, "rejected side-mismatch deposit must not mutate side");
}

// ── Test 7: lock_market before lock_ts rejected ─────────────────────────────

#[test]
fn test_lock_market_before_lock_ts_rejected() {
    let mut svm = svm();
    let setup = setup_market(&mut svm, 7, 3600);

    let caller = Keypair::new();
    svm.airdrop(&caller.pubkey(), 10_000_000_000).unwrap();

    let accounts = acc::LockMarket { market: setup.market, caller: caller.pubkey() }.to_account_metas(None);
    let data = ix::LockMarket {}.data();

    let err = send(
        &mut svm,
        &caller,
        &[&caller],
        Instruction { program_id: program_id(), accounts, data },
    )
    .expect_err("lock_market before lock_ts should be rejected");

    // LockNotYetDue = index 8 -> code 6008.
    assert_eq!(err.err, custom_err(6008), "expected LockNotYetDue (6008)");
}

// ── Test 8: double-lock rejected (idempotent-call rejection) ───────────────

#[test]
fn test_lock_market_double_lock_rejected() {
    let mut svm = svm();
    let setup = setup_market(&mut svm, 8, 3600);

    let caller = Keypair::new();
    svm.airdrop(&caller.pubkey(), 10_000_000_000).unwrap();

    set_clock_timestamp(&mut svm, setup.lock_ts + 1);

    let make_lock_ix = || {
        let accounts = acc::LockMarket { market: setup.market, caller: caller.pubkey() }.to_account_metas(None);
        let data = ix::LockMarket {}.data();
        Instruction { program_id: program_id(), accounts, data }
    };

    send(&mut svm, &caller, &[&caller], make_lock_ix()).expect("first lock_market should succeed");

    svm.expire_blockhash();
    let err = send(&mut svm, &caller, &[&caller], make_lock_ix())
        .expect_err("second lock_market on an already-locked market must be rejected, not a no-op");

    // MarketLocked = index 1 -> code 6001.
    assert_eq!(err.err, custom_err(6001), "expected MarketLocked (6001) on double-lock");
}
