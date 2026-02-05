use crate::calldata::{encode_default_calldata, encode_default_constructor_args};
use crate::types::{CompiledContract, ExecutionStatus, FunctionReport};
use alloy_primitives::{Address, Bytes, TxKind, U256};
use eyre::{bail, Result, WrapErr};
use revm::context::TxEnv;
use revm::context_interface::result::{ExecutionResult, Output};
use revm::database::CacheDB;
use revm::database_interface::EmptyDB;
use revm::state::AccountInfo;
use revm::{ExecuteCommitEvm, ExecuteEvm, MainBuilder, MainContext};

const GAS_LIMIT: u64 = 30_000_000;

/// Fixed caller address, funded with ETH.
fn caller() -> Address {
    Address::new([
        0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x01,
    ])
}

/// Deploy the contract and execute every public/external function.
///
/// Returns a vector of function reports with gas usage.
pub fn execute_contract(contract: &CompiledContract) -> Result<Vec<FunctionReport>> {
    let db = setup_db();

    // Build constructor args and deployment data
    let ctor_args = encode_default_constructor_args(&contract.abi)
        .wrap_err("failed to encode constructor args")?;

    let mut deploy_data = contract.bytecode.clone();
    deploy_data.extend_from_slice(&ctor_args);

    // Deploy
    let (mut db, contract_addr) = deploy_contract(db, &deploy_data)?;

    // Execute each function
    let mut reports = Vec::new();

    for func_list in contract.abi.functions.values() {
        for func in func_list {
            let calldata = match encode_default_calldata(func) {
                Ok(cd) => cd,
                Err(e) => {
                    eprintln!(
                        "Warning: skipping {}() - calldata encoding failed: {e}",
                        func.name
                    );
                    continue;
                }
            };

            let report = execute_function(&mut db, contract_addr, func, &calldata)?;
            reports.push(report);
        }
    }

    Ok(reports)
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn setup_db() -> CacheDB<EmptyDB> {
    let mut db = CacheDB::new(EmptyDB::new());

    // Fund the caller with 10,000 ETH
    let balance = U256::from(10_000u64) * U256::from(10u64).pow(U256::from(18u64));
    db.insert_account_info(
        caller(),
        AccountInfo {
            balance,
            nonce: 0,
            ..Default::default()
        },
    );

    db
}

fn deploy_contract(
    db: CacheDB<EmptyDB>,
    deploy_data: &[u8],
) -> Result<(CacheDB<EmptyDB>, Address)> {
    let ctx = revm::Context::mainnet().with_db(db);
    let mut evm = ctx.build_mainnet();

    let tx = TxEnv {
        caller: caller(),
        gas_limit: GAS_LIMIT,
        gas_price: 0,
        kind: TxKind::Create,
        value: U256::ZERO,
        data: Bytes::copy_from_slice(deploy_data),
        nonce: 0,
        ..Default::default()
    };

    let result = evm
        .transact_commit(tx)
        .map_err(|e| eyre::eyre!("EVM deploy error: {e:?}"))?;

    match result {
        ExecutionResult::Success { output, .. } => match output {
            Output::Create(_, Some(addr)) => {
                // Extract the DB back from the EVM
                let db = evm.ctx.journaled_state.database;
                Ok((db, addr))
            }
            Output::Create(_, None) => {
                bail!("CREATE succeeded but no address returned");
            }
            Output::Call(_) => {
                bail!("Expected CREATE output, got CALL output");
            }
        },
        ExecutionResult::Revert { output, .. } => {
            bail!("Deployment reverted: 0x{}", hex::encode(&output));
        }
        ExecutionResult::Halt { reason, .. } => {
            bail!("Deployment halted: {reason:?}");
        }
    }
}

fn execute_function(
    db: &mut CacheDB<EmptyDB>,
    contract_addr: Address,
    func: &alloy_json_abi::Function,
    calldata: &[u8],
) -> Result<FunctionReport> {
    // Use transact (non-committing) so each call sees clean post-deploy state
    let ctx = revm::Context::mainnet().with_db(&mut *db);
    let mut evm = ctx.build_mainnet();

    let tx = TxEnv {
        caller: caller(),
        gas_limit: GAS_LIMIT,
        gas_price: 0,
        kind: TxKind::Call(contract_addr),
        value: U256::ZERO,
        data: Bytes::copy_from_slice(calldata),
        nonce: 1, // after deployment
        ..Default::default()
    };

    let result = evm
        .transact(tx)
        .map_err(|e| eyre::eyre!("EVM call error: {e:?}"))?;

    let (gas, status) = match &result.result {
        ExecutionResult::Success { gas_used, .. } => (*gas_used, ExecutionStatus::Success),
        ExecutionResult::Revert { gas_used, .. } => (*gas_used, ExecutionStatus::Revert),
        ExecutionResult::Halt { gas_used, .. } => (*gas_used, ExecutionStatus::Halt),
    };

    Ok(FunctionReport {
        name: func.name.clone(),
        selector: format!("0x{}", hex::encode(func.selector().as_slice())),
        signature: func.signature(),
        gas,
        status,
    })
}
