use alloy_dyn_abi::{DynSolType, DynSolValue};
use alloy_json_abi::{Function, JsonAbi, Param};
use alloy_primitives::{Address, I256, U256};
use eyre::{Result, WrapErr};

/// Encode calldata for a function using zero-value default arguments.
///
/// Returns `selector ++ abi_encoded_params`.
pub fn encode_default_calldata(func: &Function) -> Result<Vec<u8>> {
    let selector = func.selector();

    if func.inputs.is_empty() {
        return Ok(selector.to_vec());
    }

    let values: Vec<DynSolValue> = func
        .inputs
        .iter()
        .map(|p| {
            let ty = param_to_dyn_sol_type(p)?;
            Ok(default_value(&ty))
        })
        .collect::<Result<Vec<_>>>()?;

    let encoded = if values.len() == 1 {
        DynSolValue::Tuple(values).abi_encode_params()
    } else {
        DynSolValue::Tuple(values).abi_encode_params()
    };

    let mut calldata = Vec::with_capacity(4 + encoded.len());
    calldata.extend_from_slice(selector.as_slice());
    calldata.extend_from_slice(&encoded);
    Ok(calldata)
}

/// Encode default constructor arguments (no selector prefix).
///
/// Returns empty bytes if no constructor or no constructor inputs.
pub fn encode_default_constructor_args(abi: &JsonAbi) -> Result<Vec<u8>> {
    let ctor = match &abi.constructor {
        Some(c) => c,
        None => return Ok(Vec::new()),
    };

    if ctor.inputs.is_empty() {
        return Ok(Vec::new());
    }

    let values: Vec<DynSolValue> = ctor
        .inputs
        .iter()
        .map(|p| {
            let ty = param_to_dyn_sol_type(p)?;
            Ok(default_value(&ty))
        })
        .collect::<Result<Vec<_>>>()?;

    Ok(DynSolValue::Tuple(values).abi_encode_params())
}

/// Convert an ABI `Param` to a `DynSolType`.
///
/// Handles tuple types (structs) by recursing into components.
fn param_to_dyn_sol_type(param: &Param) -> Result<DynSolType> {
    let ty_str = &param.ty;

    // Handle tuple types (structs in Solidity ABI)
    if ty_str == "tuple" {
        let inner: Vec<DynSolType> = param
            .components
            .iter()
            .map(|c| param_to_dyn_sol_type(c))
            .collect::<Result<Vec<_>>>()?;
        return Ok(DynSolType::Tuple(inner));
    }

    // Handle tuple arrays: "tuple[]" or "tuple[N]"
    if ty_str.starts_with("tuple[") {
        let inner: Vec<DynSolType> = param
            .components
            .iter()
            .map(|c| param_to_dyn_sol_type(c))
            .collect::<Result<Vec<_>>>()?;
        let tuple_ty = DynSolType::Tuple(inner);

        if ty_str == "tuple[]" {
            return Ok(DynSolType::Array(Box::new(tuple_ty)));
        }

        // Fixed-size tuple array: "tuple[N]"
        let n_str = &ty_str[6..ty_str.len() - 1]; // extract N from "tuple[N]"
        if let Ok(n) = n_str.parse::<usize>() {
            return Ok(DynSolType::FixedArray(Box::new(tuple_ty), n));
        }

        return Ok(DynSolType::Array(Box::new(tuple_ty)));
    }

    // For all other types, parse from the type string
    ty_str
        .parse::<DynSolType>()
        .wrap_err_with(|| format!("failed to parse Solidity type: {ty_str}"))
}

/// Generate a zero-value `DynSolValue` for the given type.
fn default_value(ty: &DynSolType) -> DynSolValue {
    match ty {
        DynSolType::Bool => DynSolValue::Bool(false),
        DynSolType::Uint(bits) => DynSolValue::Uint(U256::ZERO, *bits),
        DynSolType::Int(bits) => DynSolValue::Int(I256::ZERO, *bits),
        DynSolType::Address => DynSolValue::Address(Address::ZERO),
        DynSolType::Bytes => DynSolValue::Bytes(vec![]),
        DynSolType::String => DynSolValue::String(String::new()),
        DynSolType::FixedBytes(n) => {
            DynSolValue::FixedBytes(alloy_primitives::B256::ZERO, *n)
        }
        DynSolType::Array(_inner) => DynSolValue::Array(vec![]),
        DynSolType::FixedArray(inner, n) => {
            let vals = (0..*n).map(|_| default_value(inner)).collect();
            DynSolValue::FixedArray(vals)
        }
        DynSolType::Tuple(types) => {
            let vals = types.iter().map(default_value).collect();
            DynSolValue::Tuple(vals)
        }
        DynSolType::Function => {
            // function type = 24 bytes (address + selector)
            DynSolValue::Function(alloy_primitives::Function::ZERO)
        }
    }
}
