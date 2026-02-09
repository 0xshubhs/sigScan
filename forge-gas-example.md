# Forge Gas Report Format

Forge's gas reporter shows gas usage in a different format from raw solc output.

## Example Forge Gas Report Output

```
Running 1 test for test/SimpleStorage.t.sol:SimpleStorageTest
[PASS] testSetValue() (gas: 28673)
Test result: ok. 1 passed; 0 failed; finished in 1.23ms

| Contract       | Function     | min  | avg   | median | max   | # calls |
|----------------|--------------|------|-------|--------|-------|---------|
| SimpleStorage  | setValue     | 22375| 22375 | 22375  | 22375 | 1       |
| SimpleStorage  | getValue     | 2245 | 2245  | 2245   | 2245  | 1       |
| SimpleStorage  | deposit      | 24576| 24576 | 24576  | 24576 | 1       |
| SimpleStorage  | withdraw     | 5432 | 8921  | 8921   | 12410 | 2       |
```

## Key Differences

### Solc Output
- Returns **estimated** gas costs based on static analysis
- Format: `{ "external": { "function(args)": "gasValue" } }`
- Values can be:
  - String numbers: `"22375"`
  - String "infinite" for unbounded: `"infinite"`
  - Object format (older versions): `{ "min": "100", "max": "200" }`

### Forge Output
- Returns **actual** gas usage from test execution
- Includes min/avg/median/max from multiple calls
- Shows deployment costs separately
- More detailed statistics

## Current Solc 0.8.33 Format

```json
{
  "creation": {
    "codeDepositCost": "129600",
    "executionCost": "175",
    "totalCost": "129775"
  },
  "external": {
    "balances(address)": "2469",
    "deposit()": "24576",
    "getValue()": "2245",
    "setValue(uint256)": "22375",
    "value()": "2325",
    "withdraw(uint256)": "infinite"
  }
}
```

All values are **strings**, including "infinite" for unbounded gas.

## Older Solc Versions (< 0.6.x) Format

Some older versions returned object format:

```json
{
  "external": {
    "setValue(uint256)": {
      "min": "22375",
      "max": "22375"
    },
    "conditionalTransfer(address,uint256,bool)": {
      "min": "5432",
      "max": "12410"
    }
  }
}
```

This is why the fix handles both formats!
