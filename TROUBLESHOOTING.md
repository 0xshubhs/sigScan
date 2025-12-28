# SigScan Extension Troubleshooting Guide

## Problem: Extension not generating gas estimates or signatures

### Root Cause

The extension was missing a critical configuration setting in `package.json`:
- **`sigscan.realtimeAnalysis`** - This setting controls whether real-time gas analysis is enabled

### What Was Fixed

Added the missing configuration to [package.json](package.json):

```json
"sigscan.realtimeAnalysis": {
  "type": "boolean",
  "default": true,
  "description": "Enable real-time gas analysis and inline annotations as you type"
}
```

### How to Test the Fix

#### 1. Reload the Extension

After building:
```bash
npm run build
```

In VS Code:
1. Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac)
2. Run: `Developer: Reload Window`

#### 2. Open a Solidity File

Open any `.sol` file in your workspace, such as:
- `examples/SimpleStorage.sol`
- Any contract in `examples/foundry-dao/src/`

#### 3. Check for Gas Annotations

You should see inline gas annotations appearing after function declarations:
```solidity
function setValue(uint256 newValue) public { // ⛽ 45,234 gas | 0x12345678
    value = newValue;
    emit ValueSet(newValue);
}
```

#### 4. Check Developer Console (Optional)

To see detailed logs:
1. Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac)
2. Run: `Developer: Toggle Developer Tools`
3. Go to the Console tab
4. Look for messages like:
   - `📊 Compiling SimpleStorage with solc...`
   - `✅ [1/5] setValue: 45234 gas`
   - `✨ Completed gas analysis for SimpleStorage (5 functions)`

#### 5. Run Command: Scan Project

1. Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac)
2. Run: `SigScan: Scan Project for Signatures`
3. Check the `signatures/` folder in your workspace for generated signature files

### Settings to Check

Open VS Code Settings (`Ctrl+,` or `Cmd+,`) and search for "sigscan":

1. **Real-time Analysis** (`sigscan.realtimeAnalysis`)
   - Should be: ✓ Enabled (checked)
   - Controls: Inline gas annotations and live analysis

2. **Auto Scan** (`sigscan.autoScan`)
   - Should be: ✓ Enabled (checked)
   - Controls: Automatic project scanning on startup

3. **Solc Idle Time** (`sigscan.realtime.solcIdleMs`)
   - Default: 10000 (10 seconds)
   - Controls: How long to wait after you stop typing before running full compilation

### Common Issues

#### Issue: No gas estimates showing

**Solutions:**
1. Check that `sigscan.realtimeAnalysis` is enabled in settings
2. Ensure you're editing a `.sol` file (Solidity language)
3. Check that the contract has valid Solidity syntax
4. Try toggling: Run command `SigScan: Toggle Real-time Gas Analysis`

#### Issue: Gas estimates are "0 gas" or missing

**Possible causes:**
1. Solc compiler failed to compile the contract
   - Check for syntax errors in your Solidity code
   - Look for red squiggly lines (compilation errors)
2. Compiler version mismatch
   - The extension will download the correct compiler version automatically
   - Wait a few seconds and the estimates should update

#### Issue: Signatures not generated in `signatures/` folder

**Solutions:**
1. Manually run: `SigScan: Scan Project for Signatures`
2. Check that your workspace contains:
   - `foundry.toml`, or
   - `hardhat.config.js`, or
   - `.sol` files in `src/` or `contracts/` directories
3. Check the Output panel for error messages:
   - View → Output → Select "SigScan" from dropdown

### Verify Installation

Check that solc is available:
```bash
# Check if solcjs is in PATH
which solcjs

# Check if solc package is installed
npm list solc
```

Expected output:
```
/path/to/node_modules/.bin/solcjs
sigscan@0.0.2 /path/to/sigScan
└── solc@0.8.33
```

### Status Bar Indicator

Look for the flame icon (🔥) in the status bar:
- **Visible**: Real-time analysis is active
- **Hidden**: Real-time analysis is disabled

Click the icon to toggle real-time analysis on/off.

### Advanced Debugging

If the extension still doesn't work:

1. **Check Extension Logs:**
   ```
   View → Output → Select "SigScan" from dropdown
   ```

2. **Check Developer Console:**
   ```
   Help → Toggle Developer Tools → Console tab
   ```

3. **Verify Extension is Loaded:**
   ```bash
   # In terminal, run:
   code --list-extensions | grep sigscan
   ```

4. **Reinstall Extension:**
   ```bash
   npm run build
   # In VS Code: Reload Window (Ctrl+Shift+P → "Developer: Reload Window")
   ```

### Contact Support

If you still encounter issues:
1. Open an issue at: https://github.com/0xshubhs/sigScan/issues
2. Include:
   - VS Code version
   - Extension version
   - Error messages from Output/Console
   - Sample `.sol` file that doesn't work

## Quick Test Checklist

- [ ] Extension built successfully (`npm run build`)
- [ ] VS Code window reloaded
- [ ] Opened a `.sol` file
- [ ] `sigscan.realtimeAnalysis` is enabled in settings
- [ ] Status bar shows flame icon (🔥)
- [ ] Gas annotations appear after functions
- [ ] Hover over functions shows gas estimate tooltip
- [ ] `SigScan: Scan Project` command works
- [ ] `signatures/` folder contains generated files
