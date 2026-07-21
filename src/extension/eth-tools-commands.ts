/**
 * EVM Toolbox — VS Code command wiring for src/features/eth-tools.
 *
 * Design rules:
 *  - Only `vscode` is imported eagerly. The toolbox logic (which pulls in
 *    ethers) is `require()`d inside command callbacks, keeping activation
 *    cost at zero until a tool is actually used.
 *  - Small results use QuickPicks (Enter copies, button inserts at cursor);
 *    rich results (decodes) open a read-only markdown report.
 */

import * as vscode from 'vscode';
import type { ScanResult } from '../types';
import type { DecodedValue, WorkspaceEvent } from '../features/eth-tools/decoder';
import type { FourByteLookup } from '../features/four-byte-lookup';

type EthTools = typeof import('../features/eth-tools');

/** Lazy-load the toolbox logic (and, transitively, ethers) on first use. */
function tools(): EthTools {
  return require('../features/eth-tools');
}

export interface EthToolsDeps {
  /** Latest workspace signature scan, if one has run. */
  getScanResult: () => ScanResult | null;
}

// ---------------------------------------------------------------------------
// Workspace + directory signature lookups
// ---------------------------------------------------------------------------

let _fourByte: FourByteLookup | null = null;
function fourByte(): FourByteLookup {
  if (!_fourByte) {
    const { FourByteLookup: Lookup } = require('../features/four-byte-lookup');
    _fourByte = new Lookup() as FourByteLookup;
  }
  return _fourByte;
}

interface WorkspaceIndex {
  /** 4-byte selector → function/error signatures (both decode as calldata). */
  bySelector: Map<string, string[]>;
  /** 32-byte topic0 → events with exact indexed flags. */
  byTopic: Map<string, WorkspaceEvent[]>;
  functionList: Array<{ signature: string; contractName: string }>;
}

function buildWorkspaceIndex(scan: ScanResult | null): WorkspaceIndex {
  const bySelector = new Map<string, string[]>();
  const byTopic = new Map<string, WorkspaceEvent[]>();
  const functionList: Array<{ signature: string; contractName: string }> = [];
  const seenFunctions = new Set<string>();

  for (const contract of scan?.projectInfo.contracts.values() ?? []) {
    for (const fn of [...contract.functions, ...contract.errors]) {
      const selector = fn.selector?.toLowerCase();
      if (!selector?.startsWith('0x') || selector.length !== 10) {
        continue;
      }
      const existing = bySelector.get(selector) ?? [];
      if (!existing.includes(fn.signature)) {
        existing.push(fn.signature);
      }
      bySelector.set(selector, existing);
    }
    for (const fn of contract.functions) {
      if (
        !seenFunctions.has(fn.signature) &&
        (fn.visibility === 'public' || fn.visibility === 'external')
      ) {
        seenFunctions.add(fn.signature);
        functionList.push({ signature: fn.signature, contractName: contract.name });
      }
    }
    for (const event of contract.events) {
      const topic = event.selector?.toLowerCase();
      if (!topic?.startsWith('0x') || topic.length !== 66) {
        continue;
      }
      const existing = byTopic.get(topic) ?? [];
      existing.push({ signature: event.signature, inputs: event.inputs });
      byTopic.set(topic, existing);
    }
  }
  return { bySelector, byTopic, functionList };
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

interface CopyItem extends vscode.QuickPickItem {
  /** Value copied on Enter / inserted via the pencil button. */
  value?: string;
}

const INSERT_BUTTON: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('insert'),
  tooltip: 'Insert at cursor',
};

async function insertAtCursor(text: string): Promise<boolean> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return false;
  }
  await editor.edit((edit) => edit.replace(editor.selection, text));
  return true;
}

async function copyValue(value: string, what = 'Value'): Promise<void> {
  await vscode.env.clipboard.writeText(value);
  vscode.window.setStatusBarMessage(
    `$(check) ${what} copied: ${value.length > 48 ? `${value.slice(0, 45)}…` : value}`,
    3000
  );
}

/** Static result picker: Enter copies, the pencil button inserts at the cursor. */
async function showCopyPick(title: string, items: CopyItem[], placeholder?: string): Promise<void> {
  const pick = vscode.window.createQuickPick<CopyItem>();
  pick.title = title;
  pick.placeholder = placeholder ?? 'Enter to copy · pencil icon to insert into the editor';
  pick.matchOnDescription = true;
  pick.matchOnDetail = true;
  pick.items = items.map((item) =>
    item.value === undefined ? item : { ...item, buttons: [INSERT_BUTTON] }
  );
  pick.onDidTriggerItemButton(async (event) => {
    if (event.item.value !== undefined && (await insertAtCursor(event.item.value))) {
      pick.hide();
    }
  });
  pick.onDidAccept(async () => {
    const selected = pick.selectedItems[0];
    if (selected?.value !== undefined) {
      await copyValue(selected.value, selected.label.replace(/\$\([^)]*\)\s*/g, ''));
      pick.hide();
    }
  });
  pick.onDidHide(() => pick.dispose());
  pick.show();
}

/** Live picker: recompute rows as the user types (converter/hash/epoch UX). */
function showLivePick(
  title: string,
  placeholder: string,
  compute: (input: string) => CopyItem[]
): void {
  const pick = vscode.window.createQuickPick<CopyItem>();
  pick.title = title;
  pick.placeholder = placeholder;
  const refresh = (value: string) => {
    pick.items = compute(value).map((item) =>
      item.value === undefined ? item : { ...item, buttons: [INSERT_BUTTON] }
    );
  };
  refresh('');
  pick.onDidChangeValue(refresh);
  pick.onDidTriggerItemButton(async (event) => {
    if (event.item.value !== undefined && (await insertAtCursor(event.item.value))) {
      pick.hide();
    }
  });
  pick.onDidAccept(async () => {
    const selected = pick.selectedItems[0];
    if (selected?.value !== undefined) {
      await copyValue(selected.value, selected.label.replace(/\$\([^)]*\)\s*/g, ''));
      pick.hide();
    }
  });
  pick.onDidHide(() => pick.dispose());
  pick.show();
}

const separator = (label: string): CopyItem => ({
  label,
  kind: vscode.QuickPickItemKind.Separator,
});

async function showReport(title: string, markdown: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: `# ${title}\n\n${markdown}`,
  });
  await vscode.window.showTextDocument(doc, { preview: true });
}

/** Selection → clipboard → empty, whichever first looks like hex. */
async function hexSeedValue(): Promise<string> {
  const { looksLikeHex } = tools();
  const editor = vscode.window.activeTextEditor;
  const selection = editor?.document.getText(editor.selection).trim() ?? '';
  if (selection && looksLikeHex(selection.replace(/["'`\s]/g, ''))) {
    return selection.replace(/["'`\s]/g, '');
  }
  const clip = (await vscode.env.clipboard.readText()).trim();
  if (clip && clip.length < 200_000 && looksLikeHex(clip.replace(/["'`\s]/g, ''))) {
    return clip.replace(/["'`\s]/g, '');
  }
  return '';
}

function renderTree(params: DecodedValue[], indent = 0): string {
  const lines: string[] = [];
  for (const p of params) {
    const pad = '  '.repeat(indent);
    const hint = p.hint ? `  _(${p.hint})_` : '';
    const decodedAs = p.decodedAs ? `  → decoded as \`${p.decodedAs}\`` : '';
    lines.push(`${pad}- \`${p.type}\` **${p.name ?? ''}** = \`${p.value}\`${hint}${decodedAs}`);
    if (p.children) {
      lines.push(renderTree(p.children, indent + 1));
    }
  }
  return lines.join('\n');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0] : String(error);
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

async function decodeCalldataCommand(deps: EthToolsDeps): Promise<void> {
  const input = await vscode.window.showInputBox({
    title: 'Decode Calldata',
    prompt:
      'Paste calldata (or revert data) — signatures resolve from your workspace, 4byte.directory, and type-guessing',
    value: await hexSeedValue(),
    ignoreFocusOut: true,
  });
  if (!input) {
    return;
  }

  const { decodeCalldata } = tools();
  const index = buildWorkspaceIndex(deps.getScanResult());
  try {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Decoding calldata…' },
      () =>
        decodeCalldata(input, {
          workspace: (selector) => index.bySelector.get(selector) ?? [],
          online: (selector) => fourByte().lookup(selector),
        })
    );

    const sections: string[] = [
      `**Selector** \`${result.selector}\` · **args** ${result.argBytes} bytes${result.note ? `\n\n> ⚠ ${result.note}` : ''}`,
    ];
    if (result.candidates.length === 0) {
      sections.push(
        '_No matching signature found — not in the workspace or 4byte.directory, and the shape defeated type-guessing._'
      );
    }
    for (const candidate of result.candidates) {
      const badge = candidate.ok ? '' : ' — ⚠ args do not decode';
      sections.push(
        `## \`${candidate.signature}\`\n_${candidate.source}${badge}_\n\n${candidate.ok ? renderTree(candidate.params) : (candidate.error ?? '')}`
      );
    }
    sections.push(`---\n\n\`\`\`\n${result.raw}\n\`\`\``);
    await showReport('Calldata decode', sections.join('\n\n'));
  } catch (error) {
    vscode.window.showErrorMessage(`Decode failed: ${errorMessage(error)}`);
  }
}

async function encodeCalldataCommand(deps: EthToolsDeps): Promise<void> {
  const { encodeFunctionCallData, parseHumanSignature } = tools();
  const index = buildWorkspaceIndex(deps.getScanResult());

  const typeItem: CopyItem = { label: '$(edit) Type a signature…', alwaysShow: true };
  const workspaceItems: CopyItem[] = index.functionList.map((fn) => ({
    label: `$(symbol-method) ${fn.signature}`,
    description: fn.contractName,
    value: fn.signature,
  }));
  const picked = await vscode.window.showQuickPick<CopyItem>(
    [typeItem, separator('Workspace functions'), ...workspaceItems],
    { title: 'Encode Calldata', placeHolder: 'Pick a workspace function or type any signature' }
  );
  if (!picked) {
    return;
  }

  let signature = picked.value;
  if (!signature) {
    signature = await vscode.window.showInputBox({
      title: 'Encode Calldata — signature',
      prompt: 'e.g. transfer(address to, uint256 amount)',
      validateInput: (value) => {
        if (!value.trim()) {
          return undefined;
        }
        try {
          parseHumanSignature(value);
          return undefined;
        } catch (error) {
          return errorMessage(error);
        }
      },
      ignoreFocusOut: true,
    });
  }
  if (!signature) {
    return;
  }

  const parsed = parseHumanSignature(signature);
  let encoded: ReturnType<typeof encodeFunctionCallData> | null = null;
  if (parsed.fragment.inputs.length > 0) {
    const argsRaw = await vscode.window.showInputBox({
      title: `Arguments for ${parsed.canonical}`,
      prompt: `Comma-separated: ${parsed.fragment.inputs.map((p) => p.format()).join(', ')} — uints accept "1.5 ether"`,
      validateInput: (value) => {
        try {
          encodeFunctionCallData(signature!, value);
          return undefined;
        } catch (error) {
          return errorMessage(error);
        }
      },
      ignoreFocusOut: true,
    });
    if (argsRaw === undefined) {
      return;
    }
    encoded = encodeFunctionCallData(signature, argsRaw);
  } else {
    encoded = encodeFunctionCallData(signature, '');
  }

  await showCopyPick(`Encoded ${encoded.canonical}`, [
    {
      label: '$(file-binary) Calldata',
      detail: encoded.calldata,
      description: `${encoded.byteLength} bytes`,
      value: encoded.calldata,
    },
    { label: '$(symbol-key) Selector', description: encoded.selector, value: encoded.selector },
    {
      label: '$(symbol-text) Canonical signature',
      description: encoded.canonical,
      value: encoded.canonical,
    },
  ]);
}

async function abiEncodeCommand(): Promise<void> {
  const { abiEncodeParams, encodePackedParams } = tools();
  const typeList = await vscode.window.showInputBox({
    title: 'ABI Encode — types',
    prompt: 'Comma-separated types, e.g. address, uint256, (address,bytes)[]',
    ignoreFocusOut: true,
  });
  if (!typeList) {
    return;
  }
  const argsRaw = await vscode.window.showInputBox({
    title: 'ABI Encode — values',
    prompt: 'Comma-separated values matching the types',
    validateInput: (value) => {
      try {
        abiEncodeParams(typeList, value);
        return undefined;
      } catch (error) {
        return errorMessage(error);
      }
    },
    ignoreFocusOut: true,
  });
  if (argsRaw === undefined) {
    return;
  }

  const items: CopyItem[] = [];
  try {
    const standard = abiEncodeParams(typeList, argsRaw);
    items.push({
      label: '$(file-binary) abi.encode',
      detail: standard,
      description: `${(standard.length - 2) / 2} bytes`,
      value: standard,
    });
  } catch (error) {
    vscode.window.showErrorMessage(`abi.encode failed: ${errorMessage(error)}`);
    return;
  }
  try {
    const packed = encodePackedParams(typeList, argsRaw);
    items.push({
      label: '$(file-binary) abi.encodePacked',
      detail: packed,
      description: `${(packed.length - 2) / 2} bytes`,
      value: packed,
    });
  } catch {
    /* encodePacked legitimately rejects some type combinations */
  }
  await showCopyPick('ABI encoded', items);
}

async function abiDecodeCommand(deps: EthToolsDeps): Promise<void> {
  const data = await vscode.window.showInputBox({
    title: 'ABI Decode — data',
    prompt: 'Raw ABI blob (no selector). Leave types empty on the next step to guess them.',
    value: await hexSeedValue(),
    ignoreFocusOut: true,
  });
  if (!data) {
    return;
  }
  const typeList = await vscode.window.showInputBox({
    title: 'ABI Decode — types (optional)',
    prompt: 'Comma-separated types, or empty to guess with abi-guesser',
    ignoreFocusOut: true,
  });
  if (typeList === undefined) {
    return;
  }

  const { decodeAbiBlob, splitTopLevelTypes } = tools();
  const index = buildWorkspaceIndex(deps.getScanResult());
  try {
    const result = await decodeAbiBlob(
      data,
      typeList.trim() === '' ? undefined : splitTopLevelTypes(typeList),
      {
        workspace: (selector) => index.bySelector.get(selector) ?? [],
        online: (selector) => fourByte().lookup(selector),
      }
    );
    const heading = result.guessed
      ? `**Guessed types**: \`${result.types.join(', ')}\``
      : `**Types**: \`${result.types.join(', ')}\``;
    await showReport('ABI decode', `${heading}\n\n${renderTree(result.params)}`);
  } catch (error) {
    vscode.window.showErrorMessage(`ABI decode failed: ${errorMessage(error)}`);
  }
}

function convertUnitsCommand(): void {
  showLivePick('Convert Units', 'Type a value: 1.5 · 2000 gwei · 0xde0b6b3a7640000', (input) => {
    const { buildConversions } = tools();
    if (input.trim() === '') {
      return [
        {
          label: 'Type a number (wei/gwei/ether interpretations appear live)',
          description: 'e.g. 1.5 or 0x38d7ea4c68000',
        },
      ];
    }
    const rows = buildConversions(input);
    if (rows.length === 0) {
      return [
        { label: 'Not a number or hex quantity', description: 'try 1.5, 2000 gwei, or 0x1234' },
      ];
    }
    const items: CopyItem[] = [];
    for (const row of rows) {
      items.push(separator(`as ${row.interpretation}`));
      for (const value of row.values) {
        items.push({
          label: `$(arrow-right) ${value.unit}`,
          description: value.value,
          value: value.value,
        });
      }
    }
    return items;
  });
}

function keccakCommand(): void {
  showLivePick(
    'Keccak-256 / Selector / Checksum',
    'Text, hex bytes, signature like transfer(address,uint256), or an address',
    (input) => {
      const value = input.trim();
      if (value === '') {
        return [
          {
            label: 'Type text, 0x-hex, a function/event signature, or an address',
            description: 'hashes update live',
          },
        ];
      }
      const {
        isHexString,
        keccakHex,
        keccakUtf8,
        hexToUtf8,
        utf8ToHex,
        toChecksumAddress,
        parseHumanSignature,
      } = tools();
      const items: CopyItem[] = [];

      if (/^[A-Za-z_$][\w$]*\(.*\)$/.test(value)) {
        try {
          const { canonical, selector } = parseHumanSignature(value);
          const topic = keccakUtf8(canonical);
          items.push(separator(`signature ${canonical}`));
          items.push({
            label: '$(symbol-key) 4-byte selector',
            description: selector,
            value: selector,
          });
          items.push({ label: '$(symbol-event) event topic0', description: topic, value: topic });
        } catch {
          /* fall through to plain hashing */
        }
      }
      if (isHexString(value, 20)) {
        const checksummed = toChecksumAddress(value);
        items.push(separator('address'));
        items.push({
          label: '$(verified) EIP-55 checksum',
          description: checksummed,
          value: checksummed,
        });
      }
      if (isHexString(value)) {
        items.push(separator('as hex bytes'));
        items.push({
          label: '$(key) keccak256(bytes)',
          description: keccakHex(value),
          value: keccakHex(value),
        });
        const utf8 = hexToUtf8(value);
        if (utf8) {
          items.push({ label: '$(symbol-text) UTF-8 text', description: utf8, value: utf8 });
        }
      }
      items.push(separator('as UTF-8 text'));
      items.push({
        label: '$(key) keccak256(utf8)',
        description: keccakUtf8(value),
        value: keccakUtf8(value),
      });
      items.push({
        label: '$(symbol-numeric) hex encoding',
        description: utf8ToHex(value),
        value: utf8ToHex(value),
      });
      return items;
    }
  );
}

async function contractAddressCommand(): Promise<void> {
  const kind = await vscode.window.showQuickPick(
    [
      { label: '$(rocket) CREATE', description: 'deployer + nonce', id: 'create' },
      {
        label: '$(target) CREATE2',
        description: 'deployer + salt + init code (or its hash)',
        id: 'create2',
      },
    ],
    { title: 'Determine Contract Address', placeHolder: 'Which opcode computes the address?' }
  );
  if (!kind) {
    return;
  }

  const {
    computeCreateAddress,
    computeCreate2Address,
    computeCreate2AddressFromInitCode,
    isHexString,
    keccakHex,
  } = tools();
  const deployer = await vscode.window.showInputBox({
    title: `${kind.id === 'create' ? 'CREATE' : 'CREATE2'} — deployer address`,
    validateInput: (v) => (isHexString(v.trim(), 20) ? undefined : 'Enter a 20-byte address'),
    ignoreFocusOut: true,
  });
  if (!deployer) {
    return;
  }

  try {
    if (kind.id === 'create') {
      const nonce = await vscode.window.showInputBox({
        title: 'CREATE — deployer nonce',
        prompt: 'The account nonce at deployment (decimal)',
        validateInput: (v) => (/^\d+$/.test(v.trim()) ? undefined : 'Enter a non-negative integer'),
        ignoreFocusOut: true,
      });
      if (nonce === undefined) {
        return;
      }
      const address = computeCreateAddress(deployer.trim(), BigInt(nonce.trim()));
      await showCopyPick('CREATE address', [
        { label: '$(location) Contract address', description: address, value: address },
      ]);
    } else {
      const salt = await vscode.window.showInputBox({
        title: 'CREATE2 — salt',
        prompt: 'Hex salt (left-padded to 32 bytes)',
        validateInput: (v) => (isHexString(v.trim()) ? undefined : 'Enter hex, e.g. 0x1234'),
        ignoreFocusOut: true,
      });
      if (!salt) {
        return;
      }
      const initCode = await vscode.window.showInputBox({
        title: 'CREATE2 — init code (or its 32-byte keccak hash)',
        prompt: '32-byte input is treated as the init-code hash; anything longer is hashed for you',
        validateInput: (v) =>
          isHexString(v.trim()) ? undefined : 'Enter the init code (or its hash) as hex',
        ignoreFocusOut: true,
      });
      if (!initCode) {
        return;
      }
      const isHash = isHexString(initCode.trim(), 32);
      const address = isHash
        ? computeCreate2Address(deployer.trim(), salt.trim(), initCode.trim())
        : computeCreate2AddressFromInitCode(deployer.trim(), salt.trim(), initCode.trim());
      await showCopyPick('CREATE2 address', [
        { label: '$(location) Contract address', description: address, value: address },
        ...(isHash
          ? []
          : [
              {
                label: '$(key) init code hash',
                description: keccakHex(initCode.trim()),
                value: keccakHex(initCode.trim()),
              },
            ]),
      ]);
    }
  } catch (error) {
    vscode.window.showErrorMessage(`Address computation failed: ${errorMessage(error)}`);
  }
}

async function constantsCommand(): Promise<void> {
  const { ethConstants } = tools();
  const items: CopyItem[] = [];
  let lastGroup = '';
  for (const constant of ethConstants()) {
    if (constant.group !== lastGroup) {
      items.push(separator(constant.group));
      lastGroup = constant.group;
    }
    items.push({
      label: constant.name,
      description: constant.value,
      detail: constant.note,
      value: constant.value,
    });
  }
  await showCopyPick(
    'Ethereum Constants',
    items,
    'Enter to copy · pencil to insert · type to filter'
  );
}

async function storageSlotCommand(): Promise<void> {
  const kind = await vscode.window.showQuickPick(
    [
      {
        label: '$(symbol-namespace) Mapping entry slot',
        description: 'keccak256(key ++ slot)',
        id: 'mapping',
      },
      {
        label: '$(list-ordered) Dynamic array slot',
        description: 'keccak256(slot) + index',
        id: 'array',
      },
      {
        label: '$(bookmark) Well-known slots',
        description: 'EIP-1967, EIP-1822, OZ Initializable',
        id: 'known',
      },
      {
        label: '$(symbol-structure) ERC-7201 namespace',
        description: 'namespaced storage root',
        id: 'erc7201',
      },
    ],
    { title: 'Storage Slot Calculator', placeHolder: 'What do you need the slot of?' }
  );
  if (!kind) {
    return;
  }

  const {
    mappingEntrySlot,
    dynamicArrayDataSlot,
    dynamicArrayElementSlot,
    wellKnownSlots,
    erc7201Slot,
  } = tools();
  const parseSlot = (v: string): bigint =>
    v.trim().startsWith('0x') ? BigInt(v.trim()) : BigInt(v.trim());
  const slotValidate = (v: string) => {
    try {
      parseSlot(v);
      return undefined;
    } catch {
      return 'Enter the base slot as decimal or 0x-hex';
    }
  };

  try {
    if (kind.id === 'known') {
      await showCopyPick(
        'Well-known storage slots',
        wellKnownSlots().map((s) => ({
          label: s.name,
          description: s.slot,
          detail: s.formula,
          value: s.slot,
        }))
      );
    } else if (kind.id === 'erc7201') {
      const ns = await vscode.window.showInputBox({
        title: 'ERC-7201 namespace id',
        prompt: 'e.g. openzeppelin.storage.ERC20',
        ignoreFocusOut: true,
      });
      if (!ns) {
        return;
      }
      const slot = erc7201Slot(ns.trim());
      await showCopyPick(`erc7201("${ns.trim()}")`, [
        { label: '$(location) Storage root', description: slot, value: slot },
      ]);
    } else if (kind.id === 'mapping') {
      const keyType = await vscode.window.showQuickPick(
        ['address', 'uint256', 'int256', 'bytes32', 'bool', 'string', 'bytes'],
        {
          title: 'Mapping key type',
        }
      );
      if (!keyType) {
        return;
      }
      const key = await vscode.window.showInputBox({
        title: `Mapping key (${keyType})`,
        ignoreFocusOut: true,
      });
      if (key === undefined) {
        return;
      }
      const slot = await vscode.window.showInputBox({
        title: 'Mapping base slot',
        prompt: 'Declaration slot of the mapping (decimal or hex)',
        validateInput: slotValidate,
        ignoreFocusOut: true,
      });
      if (slot === undefined) {
        return;
      }
      const result = mappingEntrySlot(
        keyType as Parameters<typeof mappingEntrySlot>[0],
        key,
        parseSlot(slot)
      );
      await showCopyPick(`mapping slot for [${key}]`, [
        { label: '$(location) Entry slot', description: result, value: result },
      ]);
    } else {
      const slot = await vscode.window.showInputBox({
        title: 'Array base slot',
        prompt: 'Declaration slot of the dynamic array (decimal or hex)',
        validateInput: slotValidate,
        ignoreFocusOut: true,
      });
      if (slot === undefined) {
        return;
      }
      const index = await vscode.window.showInputBox({
        title: 'Element index (optional)',
        prompt: 'Empty = first data slot',
        validateInput: (v) =>
          v.trim() === '' || /^\d+$/.test(v.trim()) ? undefined : 'Enter a non-negative integer',
        ignoreFocusOut: true,
      });
      if (index === undefined) {
        return;
      }
      const base = parseSlot(slot);
      const result =
        index.trim() === ''
          ? dynamicArrayDataSlot(base)
          : dynamicArrayElementSlot(base, BigInt(index.trim()));
      await showCopyPick('Dynamic array slot', [
        {
          label: `$(location) ${index.trim() === '' ? 'Data start slot' : `Element ${index.trim()} slot`}`,
          description: result,
          value: result,
        },
      ]);
    }
  } catch (error) {
    vscode.window.showErrorMessage(`Slot computation failed: ${errorMessage(error)}`);
  }
}

function epochCommand(): void {
  showLivePick('Epoch Converter', 'Unix seconds/ms, 0x-hex, ISO date, or "now"', (input) => {
    const { parseEpochInput, describeEpoch, durationConstants } = tools();
    const now = Date.now();
    const info = parseEpochInput(input.trim() === '' ? 'now' : input, now);
    if (!info) {
      return [{ label: 'Not a timestamp', description: 'try 1700000000, 2024-01-01, or now' }];
    }
    const items: CopyItem[] = [separator(`${info.interpretedAs}`)];
    for (const row of describeEpoch(info, now)) {
      items.push({ label: `$(clock) ${row.label}`, description: row.value, value: row.value });
    }
    items.push(separator('Solidity durations'));
    for (const duration of durationConstants()) {
      items.push({
        label: `$(watch) ${duration.name}`,
        description: `${duration.seconds} seconds`,
        value: String(duration.seconds),
      });
    }
    return items;
  });
}

async function decodeEventCommand(deps: EthToolsDeps): Promise<void> {
  const input = await vscode.window.showInputBox({
    title: 'Decode Event Log',
    prompt:
      'Paste a log as JSON: {"topics": ["0x…"], "data": "0x…"} (explorer / cast / receipt format)',
    ignoreFocusOut: true,
  });
  if (!input) {
    return;
  }

  let topics: string[];
  let data: string;
  try {
    let parsed = JSON.parse(input) as unknown;
    if (Array.isArray(parsed)) {
      parsed = parsed[0];
    }
    const log = parsed as { topics?: string[]; data?: string };
    if (!log?.topics || !Array.isArray(log.topics) || log.topics.length === 0) {
      throw new Error('JSON must contain a non-empty "topics" array');
    }
    topics = log.topics;
    data = typeof log.data === 'string' ? log.data : '0x';
  } catch (error) {
    vscode.window.showErrorMessage(`Could not parse the log: ${errorMessage(error)}`);
    return;
  }

  const { decodeEventLog } = tools();
  const index = buildWorkspaceIndex(deps.getScanResult());
  try {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Decoding event…' },
      () =>
        decodeEventLog(topics, data, {
          workspace: (topic0) => index.byTopic.get(topic0) ?? [],
          online: (topic0) => fourByte().lookupEvent(topic0),
        })
    );
    const header = result.signature
      ? `**Event** \`${result.signature}\` _(${result.source})_${result.assumption ? `\n\n> ⚠ ${result.assumption}` : ''}`
      : '_No matching event signature found — showing raw topics/data._';
    await showReport(
      'Event decode',
      `**topic0** \`${result.topic0}\`\n\n${header}\n\n${renderTree(result.params)}`
    );
  } catch (error) {
    vscode.window.showErrorMessage(`Event decode failed: ${errorMessage(error)}`);
  }
}

async function decodeRawTxCommand(deps: EthToolsDeps): Promise<void> {
  const input = await vscode.window.showInputBox({
    title: 'Decode Raw Transaction',
    prompt: 'Paste an RLP-encoded transaction (signed or unsigned)',
    value: await hexSeedValue(),
    ignoreFocusOut: true,
  });
  if (!input) {
    return;
  }

  const { decodeRawTransaction, decodeCalldata } = tools();
  const index = buildWorkspaceIndex(deps.getScanResult());
  try {
    const decoded = decodeRawTransaction(input);
    const fieldLines = decoded.fields
      .map((f) => `| ${f.label} | \`${f.value}\`${f.hint ? ` _(${f.hint})_` : ''} |`)
      .join('\n');
    let calldataSection = '';
    if (decoded.calldata) {
      const inner = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Decoding calldata…' },
        () =>
          decodeCalldata(decoded.calldata!, {
            workspace: (selector) => index.bySelector.get(selector) ?? [],
            online: (selector) => fourByte().lookup(selector),
          })
      );
      const best = inner.candidates.find((c) => c.ok);
      calldataSection = best
        ? `\n\n## Calldata — \`${best.signature}\` _(${best.source})_\n\n${renderTree(best.params)}`
        : `\n\n## Calldata\n\n_Selector \`${inner.selector}\` did not resolve to a signature._`;
    }
    await showReport(
      'Raw transaction decode',
      `| field | value |\n|---|---|\n${fieldLines}${calldataSection}`
    );
  } catch (error) {
    vscode.window.showErrorMessage(`Transaction decode failed: ${errorMessage(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

interface ToolEntry {
  command: string;
  label: string;
  description: string;
  handler: () => void | Promise<void>;
}

export function registerEthToolsCommands(
  context: vscode.ExtensionContext,
  deps: EthToolsDeps
): vscode.Disposable[] {
  const toolList: ToolEntry[] = [
    {
      command: 'sigscan.decodeCalldata',
      label: '$(inspect) Decode Calldata',
      description: 'selector + args → readable call, no ABI needed',
      handler: () => decodeCalldataCommand(deps),
    },
    {
      command: 'sigscan.encodeCalldata',
      label: '$(file-binary) Encode Calldata',
      description: 'signature + args → calldata',
      handler: () => encodeCalldataCommand(deps),
    },
    {
      command: 'sigscan.abiDecode',
      label: '$(unfold) ABI Decode',
      description: 'raw ABI blob → values (types optional)',
      handler: () => abiDecodeCommand(deps),
    },
    {
      command: 'sigscan.abiEncode',
      label: '$(fold) ABI Encode',
      description: 'types + values → abi.encode / encodePacked',
      handler: () => abiEncodeCommand(),
    },
    {
      command: 'sigscan.decodeEventLog',
      label: '$(symbol-event) Decode Event Log',
      description: 'topics + data → named event values',
      handler: () => decodeEventCommand(deps),
    },
    {
      command: 'sigscan.decodeRawTx',
      label: '$(package) Decode Raw Transaction',
      description: 'RLP tx → fields + decoded calldata',
      handler: () => decodeRawTxCommand(deps),
    },
    {
      command: 'sigscan.convertUnits',
      label: '$(arrow-swap) Convert Units',
      description: 'wei ⇄ gwei ⇄ ether ⇄ hex, live',
      handler: () => convertUnitsCommand(),
    },
    {
      command: 'sigscan.keccakHash',
      label: '$(key) Keccak / Selector / Checksum',
      description: 'hash text or bytes, selectors, EIP-55',
      handler: () => keccakCommand(),
    },
    {
      command: 'sigscan.computeContractAddress',
      label: '$(location) Determine Contract Address',
      description: 'CREATE and CREATE2 address math',
      handler: () => contractAddressCommand(),
    },
    {
      command: 'sigscan.storageSlotCalc',
      label: '$(database) Storage Slot Calculator',
      description: 'mapping/array slots, EIP-1967, ERC-7201',
      handler: () => storageSlotCommand(),
    },
    {
      command: 'sigscan.ethConstants',
      label: '$(symbol-constant) Ethereum Constants',
      description: 'addresses, max uints, gas costs, selectors',
      handler: () => constantsCommand(),
    },
    {
      command: 'sigscan.epochConvert',
      label: '$(clock) Epoch Converter',
      description: 'timestamps ⇄ dates, Solidity durations',
      handler: () => epochCommand(),
    },
  ];

  const disposables: vscode.Disposable[] = toolList.map((tool) =>
    vscode.commands.registerCommand(tool.command, async () => {
      try {
        await tool.handler();
      } catch (error) {
        vscode.window.showErrorMessage(
          `${tool.label.replace(/\$\([^)]*\)\s*/g, '')}: ${errorMessage(error)}`
        );
      }
    })
  );

  disposables.push(
    vscode.commands.registerCommand('sigscan.evmToolbox', async () => {
      const picked = await vscode.window.showQuickPick(
        toolList.map((tool) => ({
          label: tool.label,
          description: tool.description,
          command: tool.command,
        })),
        { title: 'EVM Toolbox', placeHolder: 'Decode, encode, convert, hash…' }
      );
      if (picked) {
        await vscode.commands.executeCommand(picked.command);
      }
    })
  );

  context.subscriptions.push(...disposables);
  return disposables;
}
