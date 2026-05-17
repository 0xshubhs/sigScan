import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { discoverContracts, discoverWorkspace } from '../contract-discovery';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sigscan-discovery-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeFoundryArtifact(srcName: string, contractName: string, opts: { abi: unknown[]; bytecode?: string; deployedBytecode?: string }): void {
  const dir = path.join(tmpRoot, 'out', srcName);
  fs.mkdirSync(dir, { recursive: true });
  const artifact = {
    abi: opts.abi,
    bytecode: { object: opts.bytecode ?? '6080604052' },
    deployedBytecode: opts.deployedBytecode ? { object: opts.deployedBytecode } : undefined,
    metadata: {
      settings: {
        compilationTarget: { [`src/${srcName}`]: contractName },
      },
    },
  };
  fs.writeFileSync(path.join(dir, `${contractName}.json`), JSON.stringify(artifact));
}

function writeHardhatArtifact(srcRelPath: string, contractName: string, opts: { abi: unknown[]; bytecode?: string }): void {
  const dir = path.join(tmpRoot, 'artifacts', 'contracts', path.dirname(srcRelPath), `${path.basename(srcRelPath)}`);
  fs.mkdirSync(dir, { recursive: true });
  const artifact = {
    sourceName: `contracts/${srcRelPath}`,
    contractName,
    abi: opts.abi,
    bytecode: opts.bytecode ?? '0x6080604052',
  };
  fs.writeFileSync(path.join(dir, `${contractName}.json`), JSON.stringify(artifact));
}

describe('discoverContracts', () => {
  it('returns [] when no out/ or artifacts/', () => {
    expect(discoverContracts(tmpRoot)).toEqual([]);
  });

  it('finds a foundry artifact', () => {
    writeFoundryArtifact('Counter.sol', 'Counter', {
      abi: [
        { type: 'function', name: 'increment', inputs: [], outputs: [], stateMutability: 'nonpayable' },
      ],
    });
    const found = discoverContracts(tmpRoot);
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe('Counter');
    expect(found[0].sourcePath).toBe('src/Counter.sol');
    expect(found[0].bytecode?.startsWith('0x')).toBe(true);
  });

  it('skips artifacts with no functional ABI entries (only constructor/fallback)', () => {
    writeFoundryArtifact('Empty.sol', 'Empty', {
      abi: [{ type: 'constructor', inputs: [] }, { type: 'fallback' }],
    });
    expect(discoverContracts(tmpRoot)).toEqual([]);
  });

  it('finds a hardhat artifact', () => {
    writeHardhatArtifact('Token.sol', 'Token', {
      abi: [
        { type: 'function', name: 'transfer', inputs: [{ name: 'to', type: 'address' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
        { type: 'event', name: 'Transfer', inputs: [] },
      ],
    });
    const found = discoverContracts(tmpRoot);
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe('Token');
    expect(found[0].sourcePath).toBe('contracts/Token.sol');
  });

  it('foundry takes precedence over hardhat for the same key', () => {
    writeFoundryArtifact('Dup.sol', 'Dup', {
      abi: [{ type: 'function', name: 'foo', inputs: [], outputs: [], stateMutability: 'view' }],
    });
    writeHardhatArtifact('Dup.sol', 'Dup', {
      abi: [{ type: 'function', name: 'foo', inputs: [], outputs: [], stateMutability: 'view' }],
    });
    const found = discoverContracts(tmpRoot);
    // foundry path uses "src/Dup.sol", hardhat uses "contracts/Dup.sol" — different keys, so both appear
    expect(found.map((c) => c.sourcePath).sort()).toEqual(['contracts/Dup.sol', 'src/Dup.sol']);
  });

  it('skips noisy directories (node_modules, .git, build-info)', () => {
    writeFoundryArtifact('Real.sol', 'Real', {
      abi: [{ type: 'function', name: 'f', inputs: [], outputs: [], stateMutability: 'view' }],
    });
    fs.mkdirSync(path.join(tmpRoot, 'out', 'build-info'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'out', 'build-info', 'huge.json'), JSON.stringify({ huge: 'data' }));
    const found = discoverContracts(tmpRoot);
    expect(found.map((c) => c.name)).toEqual(['Real']);
  });
});

function writeFoundryArtifactAt(absolutePath: string, contractName: string, abi: unknown[], sourcePath: string): void {
  const dir = path.dirname(absolutePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    absolutePath,
    JSON.stringify({
      abi,
      bytecode: { object: '6080604052' },
      metadata: { settings: { compilationTarget: { [sourcePath]: contractName } } },
    })
  );
}

describe('discoverWorkspace · filters out dependencies', () => {
  it('excludes lib/forge-std artifacts for a foundry project', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'foundry.toml'), '');
    // user contract
    fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, 'src', 'Counter.sol'),
      'pragma solidity ^0.8.0;\ncontract Counter { function incr() external {} }'
    );
    // built artifact for user contract
    writeFoundryArtifactAt(
      path.join(tmpRoot, 'out', 'Counter.sol', 'Counter.json'),
      'Counter',
      [{ type: 'function', name: 'incr', inputs: [], outputs: [], stateMutability: 'nonpayable' }],
      'src/Counter.sol'
    );
    // built artifact for a forge-std lib (should be hidden because sourcePath is under lib/)
    writeFoundryArtifactAt(
      path.join(tmpRoot, 'out', 'Test.sol', 'Test.json'),
      'Test',
      [{ type: 'function', name: 'assertEq', inputs: [], outputs: [], stateMutability: 'view' }],
      'lib/forge-std/src/Test.sol'
    );
    // also a lib source on disk (should be hidden)
    fs.mkdirSync(path.join(tmpRoot, 'lib', 'forge-std', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, 'lib', 'forge-std', 'src', 'Test.sol'),
      'pragma solidity ^0.8.0;\ncontract Test {}'
    );

    const found = await discoverWorkspace(tmpRoot);
    const names = found.map((c) => c.name).sort();
    expect(names).toEqual(['Counter']);
  });

  it('only walks contracts/ for hardhat projects', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'hardhat.config.js'), 'module.exports = {};');
    fs.mkdirSync(path.join(tmpRoot, 'contracts'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, 'contracts', 'Token.sol'),
      'pragma solidity ^0.8.0;\ncontract Token {}'
    );
    // a stray .sol outside contracts/ should be ignored
    fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, 'src', 'ShouldNotAppear.sol'),
      'pragma solidity ^0.8.0;\ncontract ShouldNotAppear {}'
    );

    const found = await discoverWorkspace(tmpRoot);
    expect(found.map((c) => c.name).sort()).toEqual(['Token']);
  });
});
