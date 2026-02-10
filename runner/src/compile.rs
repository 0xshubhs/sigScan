use crate::types::CompiledContract;
use alloy_json_abi::JsonAbi;
use eyre::{bail, Result, WrapErr};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::fs;

/// Compile a `.sol` file and return all contracts found.
///
/// Strategy:
/// 1. If the file lives inside a Foundry project → use `forge build` in-place
/// 2. Otherwise → create a temp Foundry project, copy the file, compile there
///
/// This means the runner works with **any** `.sol` file — no project structure required.
pub fn compile(sol_path: &Path) -> Result<Vec<CompiledContract>> {
    let sol_path = fs::canonicalize(sol_path)
        .wrap_err_with(|| format!("cannot resolve path: {}", sol_path.display()))?;

    if let Some(root) = find_foundry_root(&sol_path) {
        compile_in_project(&sol_path, &root)
    } else {
        compile_standalone(&sol_path)
    }
}

// ---------------------------------------------------------------------------
// Foundry project detection
// ---------------------------------------------------------------------------

fn find_foundry_root(sol_path: &Path) -> Option<PathBuf> {
    let mut dir = sol_path.parent()?;
    loop {
        if dir.join("foundry.toml").exists() {
            return Some(dir.to_path_buf());
        }
        match dir.parent() {
            Some(parent) if parent != dir => dir = parent,
            _ => return None,
        }
    }
}

// ---------------------------------------------------------------------------
// Path 1: compile inside an existing Foundry project
// ---------------------------------------------------------------------------

fn compile_in_project(sol_path: &Path, foundry_root: &Path) -> Result<Vec<CompiledContract>> {
    forge_build(foundry_root)?;

    let out_dir = parse_forge_out_dir(foundry_root);
    read_artifacts(&out_dir, sol_path)
}

// ---------------------------------------------------------------------------
// Path 2: standalone .sol file — create a temp Foundry project
// ---------------------------------------------------------------------------

fn compile_standalone(sol_path: &Path) -> Result<Vec<CompiledContract>> {
    let tmp = tempfile::tempdir().wrap_err("failed to create temp directory")?;
    let root = tmp.path();

    // Minimal foundry.toml
    fs::write(
        root.join("foundry.toml"),
        "[profile.default]\nsrc = \"src\"\nout = \"out\"\n",
    )?;

    // Create src/ and copy the .sol file into it
    let src_dir = root.join("src");
    fs::create_dir_all(&src_dir)?;
    fs::copy(sol_path, src_dir.join(sol_path.file_name().unwrap()))?;

    forge_build(root)?;

    let out_dir = root.join("out");
    read_artifacts(&out_dir, sol_path)

    // tmp is dropped here, cleaning up the temp directory
}

// ---------------------------------------------------------------------------
// Shared: run forge build
// ---------------------------------------------------------------------------

fn forge_build(foundry_root: &Path) -> Result<()> {
    let output = Command::new("forge")
        .args([
            "build",
            "--force",
            "--skip",
            "*/test/*",
            "--skip",
            "*/script/*",
            "--extra-output",
            "abi",
            "evm.bytecode.object",
        ])
        .current_dir(foundry_root)
        .output()
        .wrap_err("failed to run `forge build` — is forge installed?")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("forge build failed:\n{stderr}");
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Shared: read forge artifacts from out/ directory
// ---------------------------------------------------------------------------

fn read_artifacts(out_dir: &Path, sol_path: &Path) -> Result<Vec<CompiledContract>> {
    let file_stem = sol_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Contract");
    let file_name = sol_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("Contract.sol");

    // Forge outputs artifacts under out/<FileName>.sol/<ContractName>.json
    let artifact_dir = out_dir.join(file_name);
    let alt_artifact_dir = out_dir.join(format!("{file_stem}.sol"));

    let search_dir = if artifact_dir.is_dir() {
        artifact_dir
    } else if alt_artifact_dir.is_dir() {
        alt_artifact_dir
    } else {
        bail!(
            "No forge artifacts found at {} or {}",
            artifact_dir.display(),
            alt_artifact_dir.display()
        );
    };

    let mut contracts = Vec::new();

    for entry in fs::read_dir(&search_dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }

        let contract_name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Unknown")
            .to_string();

        let raw: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path)?).wrap_err_with(|| {
                format!("failed to parse artifact {}", path.display())
            })?;

        // Parse ABI
        let abi_value = raw
            .get("abi")
            .cloned()
            .unwrap_or(serde_json::Value::Array(vec![]));
        let abi: JsonAbi = serde_json::from_value(abi_value)
            .wrap_err("failed to parse ABI from forge artifact")?;

        // Parse bytecode — forge puts it at /bytecode/object, solc at /evm/bytecode/object
        let bytecode_hex = raw
            .pointer("/bytecode/object")
            .or_else(|| raw.pointer("/evm/bytecode/object"))
            .and_then(|v| v.as_str())
            .unwrap_or("");

        // Replace unlinked library placeholders (__$...$__) with a zero address.
        // These appear when a contract uses external libraries. Each placeholder is
        // 40 hex chars (20 bytes = an address slot). Replacing with zeros lets us
        // deploy and measure gas — library calls will revert but non-library
        // functions still produce accurate gas.
        let cleaned_hex = replace_library_placeholders(bytecode_hex.trim_start_matches("0x"));
        let bytecode = hex::decode(&cleaned_hex).unwrap_or_default();

        // Skip artifacts with no bytecode (interfaces, abstract contracts)
        if bytecode.is_empty() {
            continue;
        }

        contracts.push(CompiledContract {
            name: contract_name,
            abi,
            bytecode,
        });
    }

    Ok(contracts)
}

/// Replace unlinked library placeholders (`__$<hash>$__`) with zero addresses.
///
/// Forge emits 40-char placeholders like `__$1f06ac8d622ce42796cee98ba1044ce165$__`
/// for contracts that use external libraries. Each placeholder occupies exactly
/// 40 hex characters (20 bytes = one EVM address slot).
fn replace_library_placeholders(hex_str: &str) -> String {
    let mut result = String::with_capacity(hex_str.len());
    let bytes = hex_str.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        if i + 1 < bytes.len() && bytes[i] == b'_' && bytes[i + 1] == b'_' {
            // Find the closing `$__`
            if let Some(end) = hex_str[i..].find("$__") {
                let placeholder_end = i + end + 3; // past the closing `$__`
                let placeholder_len = placeholder_end - i;
                // Each placeholder should be 40 chars; pad with zeros
                for _ in 0..placeholder_len {
                    result.push('0');
                }
                i = placeholder_end;
                continue;
            }
        }
        result.push(bytes[i] as char);
        i += 1;
    }

    result
}

fn parse_forge_out_dir(foundry_root: &Path) -> PathBuf {
    let toml_path = foundry_root.join("foundry.toml");
    if let Ok(contents) = fs::read_to_string(&toml_path) {
        if let Ok(value) = contents.parse::<toml::Value>() {
            if let Some(out) = value
                .get("profile")
                .and_then(|p| p.get("default"))
                .and_then(|d| d.get("out"))
                .and_then(|o| o.as_str())
            {
                return foundry_root.join(out);
            }
        }
    }
    foundry_root.join("out")
}
