use alloy_json_abi::JsonAbi;
use serde::Serialize;

/// Top-level output for one contract.
#[derive(Debug, Serialize)]
pub struct ContractReport {
    pub contract: String,
    pub functions: Vec<FunctionReport>,
}

/// Per-function gas execution report.
#[derive(Debug, Serialize)]
pub struct FunctionReport {
    pub name: String,
    pub selector: String,
    pub signature: String,
    pub gas: u64,
    pub status: ExecutionStatus,
}

/// Whether the function call succeeded or reverted.
#[derive(Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ExecutionStatus {
    Success,
    Revert,
    Halt,
}

/// Intermediate representation of a compiled contract.
#[derive(Debug)]
pub struct CompiledContract {
    pub name: String,
    pub abi: JsonAbi,
    pub bytecode: Vec<u8>,
}
