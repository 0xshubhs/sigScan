use crate::calldata::{
    encode_calldata_with_strategy, encode_constructor_args_with_strategy, CallStrategy,
};
use crate::types::{CompiledContract, ExecutionStatus, FunctionReport};
use alloy_primitives::{Address, Bytes, TxKind, U256};
use eyre::{bail, Result};
use revm::context::TxEnv;
use revm::context_interface::result::{ExecutionResult, Output};
use revm::database::CacheDB;
use revm::database_interface::EmptyDB;
use revm::state::AccountInfo;
use revm::{ExecuteCommitEvm, ExecuteEvm, MainBuilder, MainContext};

const GAS_LIMIT: u64 = 30_000_000;
const STRATEGIES: [CallStrategy; 3] = [
    CallStrategy::SmartDefaults,
    CallStrategy::CallerAddress,
    CallStrategy::ZeroDefaults,
];

fn caller() -> Address {
    Address::new([
        0x10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x01,
    ])
}

/// Deploy and execute every public/external function with multi-strategy retry.
pub fn execute_contract(contract: &CompiledContract) -> Result<Vec<FunctionReport>> {
    let caller_addr = caller();
    let (mut db, addr) = deploy_best(contract, caller_addr)?;

    let mut reports = Vec::new();
    for func_list in contract.abi.functions.values() {
        for func in func_list {
            match try_function(&mut db, addr, func, caller_addr) {
                Ok(r) => reports.push(r),
                Err(e) => eprintln!("Warning: skipping {}() — {e}", func.name),
            }
        }
    }
    Ok(reports)
}

/// Try deploying with SmartDefaults, then ZeroDefaults.
fn deploy_best(
    contract: &CompiledContract,
    caller_addr: Address,
) -> Result<(CacheDB<EmptyDB>, Address)> {
    let strategies = [CallStrategy::SmartDefaults, CallStrategy::ZeroDefaults];
    let mut last_err = None;
    for strategy in &strategies {
        let ctor_args =
            match encode_constructor_args_with_strategy(&contract.abi, *strategy, caller_addr) {
                Ok(a) => a,
                Err(e) => { last_err = Some(e); continue; }
            };
        let mut data = contract.bytecode.clone();
        data.extend_from_slice(&ctor_args);
        match deploy(setup_db(), &data) {
            Ok(result) => return Ok(result),
            Err(e) => { last_err = Some(e); continue; }
        }
    }
    Err(last_err.unwrap_or_else(|| eyre::eyre!("deployment failed")))
}

/// Try each strategy, pick best: Success > Revert > Halt. Early-exit on Success.
fn try_function(
    db: &mut CacheDB<EmptyDB>,
    addr: Address,
    func: &alloy_json_abi::Function,
    caller_addr: Address,
) -> Result<FunctionReport> {
    let mut best: Option<(FunctionReport, u8)> = None;
    for strategy in &STRATEGIES {
        let cd = match encode_calldata_with_strategy(func, *strategy, caller_addr) {
            Ok(cd) => cd,
            Err(_) => continue,
        };
        let mut report = match call(db, addr, func, &cd) {
            Ok(r) => r,
            Err(_) => continue,
        };
        report.strategy = Some(strategy_label(*strategy));
        let rank = status_rank(&report.status);
        if rank == 2 { return Ok(report); }
        if best.as_ref().map_or(true, |(_, r)| rank > *r) {
            best = Some((report, rank));
        }
    }
    best.map(|(r, _)| r)
        .ok_or_else(|| eyre::eyre!("all strategies failed for {}()", func.name))
}

fn status_rank(s: &ExecutionStatus) -> u8 {
    match s {
        ExecutionStatus::Success => 2,
        ExecutionStatus::Revert => 1,
        ExecutionStatus::Halt => 0,
    }
}

fn strategy_label(s: CallStrategy) -> String {
    match s {
        CallStrategy::SmartDefaults => "smart_defaults".into(),
        CallStrategy::CallerAddress => "caller_address".into(),
        CallStrategy::ZeroDefaults => "zero_defaults".into(),
    }
}

fn setup_db() -> CacheDB<EmptyDB> {
    let mut db = CacheDB::new(EmptyDB::new());
    let balance = U256::from(10_000u64) * U256::from(10u64).pow(U256::from(18u64));
    db.insert_account_info(caller(), AccountInfo { balance, nonce: 0, ..Default::default() });
    db
}

fn deploy(db: CacheDB<EmptyDB>, data: &[u8]) -> Result<(CacheDB<EmptyDB>, Address)> {
    let mut evm = revm::Context::mainnet().with_db(db).build_mainnet();
    let tx = TxEnv {
        caller: caller(),
        gas_limit: GAS_LIMIT,
        kind: TxKind::Create,
        data: Bytes::copy_from_slice(data),
        ..Default::default()
    };
    let result = evm.transact_commit(tx).map_err(|e| eyre::eyre!("deploy error: {e:?}"))?;
    match result {
        ExecutionResult::Success { output, .. } => match output {
            Output::Create(_, Some(addr)) => Ok((evm.ctx.journaled_state.database, addr)),
            Output::Create(_, None) => bail!("CREATE succeeded but no address returned"),
            Output::Call(_) => bail!("expected CREATE output, got CALL"),
        },
        ExecutionResult::Revert { output, .. } => bail!("deploy reverted: 0x{}", hex::encode(&output)),
        ExecutionResult::Halt { reason, .. } => bail!("deploy halted: {reason:?}"),
    }
}

fn call(
    db: &mut CacheDB<EmptyDB>,
    addr: Address,
    func: &alloy_json_abi::Function,
    calldata: &[u8],
) -> Result<FunctionReport> {
    let mut evm = revm::Context::mainnet().with_db(&mut *db).build_mainnet();
    let tx = TxEnv {
        caller: caller(),
        gas_limit: GAS_LIMIT,
        kind: TxKind::Call(addr),
        data: Bytes::copy_from_slice(calldata),
        nonce: 1,
        ..Default::default()
    };
    let result = evm.transact(tx).map_err(|e| eyre::eyre!("call error: {e:?}"))?;
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
        strategy: None,
    })
}
