---
name: 0xtools
description: Use 0xTools for deterministic Solidity/EVM ground truth — security audits, exact selectors, calldata encode/decode, unit math, storage slots. Trigger whenever writing or reviewing Solidity, computing a selector/topic/hash, decoding calldata or a raw tx, or before deploying a contract. Never guess selectors, gas numbers, or vulnerability judgments — call the tools.
---

# 0xTools — deterministic EVM ground truth for agents

0xTools is a Solidity toolkit (VS Code extension + CLI). As an agent you use it
so you never hallucinate the things it computes exactly: selectors, hashes,
ABI encodings, storage slots, and static-analysis findings.

## When to reach for it

- You just wrote or edited a `.sol` file → **audit it** before calling the work done.
- You need a function selector, event topic0, or keccak hash → **compute it**, don't recall it.
- You're handed unknown calldata, a raw tx, or a bare selector → **decode it**.
- Amounts in wei/gwei/ether, mapping storage slots, CREATE2 addresses → **calculate**.

## Two ways to call

### MCP server (preferred when configured)

If the `0xtools` MCP server is connected you have these tools:
`audit_solidity`, `scan_signatures`, `lookup_selector`, `compute_selector`,
`decode_calldata`, `encode_calldata`, `abi_encode_params`,
`decode_raw_transaction`, `keccak256`, `convert_eth_units`,
`compute_contract_address`, `storage_slot`, `checksum_address`, `eth_reference`.

To connect it (repo checkout with `npm install && npm run build` done):

```bash
claude mcp add 0xtools -- node /path/to/0xtools/dist/cli/index.js mcp
```

### CLI (always available in a checkout)

```bash
node dist/cli/index.js audit --path <project> --format json   # security findings
node dist/cli/index.js scan  -p <project>                      # signatures + selectors
```

## Workflow rules

1. **Audit after writing.** After creating or modifying Solidity, run
   `audit_solidity` (pass `source` for a snippet, `path` for a file/project).
   Fix `critical`/`high` findings or explicitly tell the user why they're
   acceptable. Findings carry `file`, `line`, `severity`, `code`, `message`.
2. **Selectors are computed, never recalled.** `compute_selector` for
   signature→selector; `lookup_selector` for selector→signature. If both
   directions disagree with your memory, the tools win.
3. **Quote results verbatim.** Paste selector/hash/address outputs exactly;
   don't reformat hex or round unit conversions.
4. **Before deploy advice**, check `compute_contract_address` (CREATE/CREATE2)
   and `storage_slot` for proxy/upgrade layouts instead of deriving by hand.
5. The audit is regex/AST static analysis — fast and deterministic, but not a
   formal verifier. Present findings as "0xTools flagged…", not as proof of
   absence when it returns none.
