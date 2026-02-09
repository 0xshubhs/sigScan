mod calldata;
mod compile;
mod evm;
mod types;

use clap::Parser;
use std::path::PathBuf;
use types::ContractReport;

#[derive(Parser)]
#[command(
    name = "sigscan-runner",
    about = "Compile Solidity contracts, deploy in-memory, execute functions, report gas."
)]
struct Cli {
    /// Path to the .sol file
    sol_file: PathBuf,
}

fn main() -> eyre::Result<()> {
    color_eyre::install()?;

    let cli = Cli::parse();

    // Validate input
    if !cli.sol_file.exists() {
        eyre::bail!("File not found: {}", cli.sol_file.display());
    }
    if cli.sol_file.extension().and_then(|e| e.to_str()) != Some("sol") {
        eyre::bail!("Expected a .sol file, got: {}", cli.sol_file.display());
    }

    // Step 1: Compile
    let contracts = compile::compile(&cli.sol_file)?;

    if contracts.is_empty() {
        println!("[]");
        return Ok(());
    }

    // Step 2: Execute each contract
    let mut reports = Vec::new();

    for contract in &contracts {
        let functions = match evm::execute_contract(contract) {
            Ok(funcs) => funcs,
            Err(e) => {
                eprintln!("Warning: {} - {e}", contract.name);
                Vec::new()
            }
        };

        reports.push(ContractReport {
            contract: contract.name.clone(),
            functions,
        });
    }

    // Step 3: Output JSON to stdout
    let json = serde_json::to_string_pretty(&reports)?;
    println!("{json}");

    Ok(())
}
