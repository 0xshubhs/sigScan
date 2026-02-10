use alloy_dyn_abi::{DynSolType, DynSolValue};
use alloy_json_abi::{Function, JsonAbi, Param};
use alloy_primitives::{Address, I256, U256};
use eyre::{Result, WrapErr};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallStrategy {
    SmartDefaults,
    CallerAddress,
    ZeroDefaults,
}

/// Encode `selector ++ abi_encode(strategy_values)` for a function call.
pub fn encode_calldata_with_strategy(
    func: &Function,
    strategy: CallStrategy,
    caller: Address,
) -> Result<Vec<u8>> {
    let selector = func.selector();
    if func.inputs.is_empty() {
        return Ok(selector.to_vec());
    }
    let values: Vec<DynSolValue> = func
        .inputs
        .iter()
        .map(|p| Ok(strategy_value(&param_to_dyn_sol_type(p)?, strategy, caller)))
        .collect::<Result<Vec<_>>>()?;
    let encoded = DynSolValue::Tuple(values).abi_encode_params();
    let mut calldata = Vec::with_capacity(4 + encoded.len());
    calldata.extend_from_slice(selector.as_slice());
    calldata.extend_from_slice(&encoded);
    Ok(calldata)
}

/// Encode constructor arguments (no selector). Empty if no constructor.
pub fn encode_constructor_args_with_strategy(
    abi: &JsonAbi,
    strategy: CallStrategy,
    caller: Address,
) -> Result<Vec<u8>> {
    let ctor = match &abi.constructor {
        Some(c) if !c.inputs.is_empty() => c,
        _ => return Ok(Vec::new()),
    };
    let values: Vec<DynSolValue> = ctor
        .inputs
        .iter()
        .map(|p| Ok(strategy_value(&param_to_dyn_sol_type(p)?, strategy, caller)))
        .collect::<Result<Vec<_>>>()?;
    Ok(DynSolValue::Tuple(values).abi_encode_params())
}

fn param_to_dyn_sol_type(param: &Param) -> Result<DynSolType> {
    let ty_str = &param.ty;
    if ty_str == "tuple" {
        let inner: Vec<DynSolType> = param
            .components
            .iter()
            .map(param_to_dyn_sol_type)
            .collect::<Result<Vec<_>>>()?;
        return Ok(DynSolType::Tuple(inner));
    }
    if ty_str.starts_with("tuple[") {
        let inner: Vec<DynSolType> = param
            .components
            .iter()
            .map(param_to_dyn_sol_type)
            .collect::<Result<Vec<_>>>()?;
        let tuple_ty = DynSolType::Tuple(inner);
        if ty_str == "tuple[]" {
            return Ok(DynSolType::Array(Box::new(tuple_ty)));
        }
        let n_str = &ty_str[6..ty_str.len() - 1];
        if let Ok(n) = n_str.parse::<usize>() {
            return Ok(DynSolType::FixedArray(Box::new(tuple_ty), n));
        }
        return Ok(DynSolType::Array(Box::new(tuple_ty)));
    }
    ty_str
        .parse::<DynSolType>()
        .wrap_err_with(|| format!("failed to parse Solidity type: {ty_str}"))
}

fn strategy_value(ty: &DynSolType, strategy: CallStrategy, caller: Address) -> DynSolValue {
    match strategy {
        CallStrategy::SmartDefaults => smart_value(ty, caller),
        CallStrategy::CallerAddress => caller_value(ty, caller),
        CallStrategy::ZeroDefaults => zero_value(ty),
    }
}

/// Non-zero defaults that pass common require guards.
fn smart_value(ty: &DynSolType, caller: Address) -> DynSolValue {
    match ty {
        DynSolType::Bool => DynSolValue::Bool(true),
        DynSolType::Uint(b) => DynSolValue::Uint(U256::from(1), *b),
        DynSolType::Int(b) => DynSolValue::Int(I256::try_from(1i64).unwrap_or(I256::ZERO), *b),
        DynSolType::Address => DynSolValue::Address(Address::with_last_byte(1)),
        DynSolType::Bytes => DynSolValue::Bytes(vec![0x01]),
        DynSolType::String => DynSolValue::String("a".into()),
        DynSolType::FixedBytes(n) => {
            let mut b = [0u8; 32];
            if *n > 0 { b[n - 1] = 1; }
            DynSolValue::FixedBytes(alloy_primitives::B256::from(b), *n)
        }
        DynSolType::Array(inner) => DynSolValue::Array(vec![smart_value(inner, caller)]),
        DynSolType::FixedArray(inner, n) => {
            DynSolValue::FixedArray((0..*n).map(|_| smart_value(inner, caller)).collect())
        }
        DynSolType::Tuple(types) => {
            DynSolValue::Tuple(types.iter().map(|t| smart_value(t, caller)).collect())
        }
        DynSolType::Function => {
            let mut f = [0u8; 24];
            f[23] = 1;
            DynSolValue::Function(alloy_primitives::Function::from(f))
        }
    }
}

/// Use CALLER for address params, smart defaults for the rest.
fn caller_value(ty: &DynSolType, caller: Address) -> DynSolValue {
    match ty {
        DynSolType::Address => DynSolValue::Address(caller),
        DynSolType::Array(inner) => DynSolValue::Array(vec![caller_value(inner, caller)]),
        DynSolType::FixedArray(inner, n) => {
            DynSolValue::FixedArray((0..*n).map(|_| caller_value(inner, caller)).collect())
        }
        DynSolType::Tuple(types) => {
            DynSolValue::Tuple(types.iter().map(|t| caller_value(t, caller)).collect())
        }
        _ => smart_value(ty, caller),
    }
}

/// Zero-value defaults.
fn zero_value(ty: &DynSolType) -> DynSolValue {
    match ty {
        DynSolType::Bool => DynSolValue::Bool(false),
        DynSolType::Uint(b) => DynSolValue::Uint(U256::ZERO, *b),
        DynSolType::Int(b) => DynSolValue::Int(I256::ZERO, *b),
        DynSolType::Address => DynSolValue::Address(Address::ZERO),
        DynSolType::Bytes => DynSolValue::Bytes(vec![]),
        DynSolType::String => DynSolValue::String(String::new()),
        DynSolType::FixedBytes(n) => DynSolValue::FixedBytes(alloy_primitives::B256::ZERO, *n),
        DynSolType::Array(_) => DynSolValue::Array(vec![]),
        DynSolType::FixedArray(inner, n) => {
            DynSolValue::FixedArray((0..*n).map(|_| zero_value(inner)).collect())
        }
        DynSolType::Tuple(types) => {
            DynSolValue::Tuple(types.iter().map(zero_value).collect())
        }
        DynSolType::Function => DynSolValue::Function(alloy_primitives::Function::ZERO),
    }
}
