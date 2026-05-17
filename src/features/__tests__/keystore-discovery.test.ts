import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  clearPassword,
  isUnlocked,
  listKeystores,
  storePassword,
  takePassword,
} from '../keystore-discovery';

let tmpDir: string;
const ORIGINAL_ENV = process.env.FOUNDRY_KEYSTORES_DIR;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigscan-keystore-'));
  process.env.FOUNDRY_KEYSTORES_DIR = tmpDir;
  clearPassword();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (ORIGINAL_ENV === undefined) delete process.env.FOUNDRY_KEYSTORES_DIR;
  else process.env.FOUNDRY_KEYSTORES_DIR = ORIGINAL_ENV;
  clearPassword();
});

function writeKeystoreV3(name: string, address: string): void {
  const ks = {
    version: 3,
    address,
    crypto: { ciphertext: 'a'.repeat(64), cipher: 'aes-128-ctr' },
  };
  fs.writeFileSync(path.join(tmpDir, name), JSON.stringify(ks));
}

function writeNonKeystore(name: string, content: string): void {
  fs.writeFileSync(path.join(tmpDir, name), content);
}

describe('listKeystores', () => {
  it('returns [] when directory is missing', () => {
    fs.rmSync(tmpDir, { recursive: true });
    expect(listKeystores()).toEqual([]);
  });

  it('lists valid v3 keystores and normalizes addresses with 0x prefix', () => {
    writeKeystoreV3('alice', 'f39fd6e51aad88f6f4ce6ab8827279cfffb92266');
    writeKeystoreV3('bob', '0x70997970c51812dc3a010c7d01b50e0d17dc79c8');
    const list = listKeystores();
    expect(list.map((k) => k.name).sort()).toEqual(['alice', 'bob']);
    for (const k of list) {
      expect(k.address.startsWith('0x')).toBe(true);
    }
  });

  it('skips non-JSON files', () => {
    writeKeystoreV3('valid', '0xabc');
    writeNonKeystore('readme.txt', 'just a readme');
    expect(listKeystores().map((k) => k.name)).toEqual(['valid']);
  });

  it('skips invalid keystores (wrong version, no ciphertext)', () => {
    writeKeystoreV3('valid', '0xabc');
    writeNonKeystore('v1.json', JSON.stringify({ version: 1, address: 'x' }));
    writeNonKeystore('no-crypto.json', JSON.stringify({ version: 3, address: 'x' }));
    expect(listKeystores().map((k) => k.name)).toEqual(['valid']);
  });
});

describe('ephemeral password session', () => {
  it('store + take roundtrips', () => {
    storePassword('alice', 'secret-pw');
    expect(takePassword('alice')).toBe('secret-pw');
    expect(isUnlocked('alice')).toBe(true);
  });

  it('takePassword returns null for unknown name', () => {
    expect(takePassword('ghost')).toBeNull();
    expect(isUnlocked('ghost')).toBe(false);
  });

  it('expires after the TTL window', () => {
    storePassword('alice', 'pw', 50); // 50ms
    expect(takePassword('alice')).toBe('pw');
    // wait synchronously past expiry
    const start = Date.now();
    while (Date.now() - start < 80) {
      /* spin */
    }
    expect(takePassword('alice')).toBeNull();
  });

  it('clearPassword removes one entry', () => {
    storePassword('alice', 'a');
    storePassword('bob', 'b');
    clearPassword('alice');
    expect(takePassword('alice')).toBeNull();
    expect(takePassword('bob')).toBe('b');
  });

  it('clearPassword() with no arg clears all', () => {
    storePassword('alice', 'a');
    storePassword('bob', 'b');
    clearPassword();
    expect(takePassword('alice')).toBeNull();
    expect(takePassword('bob')).toBeNull();
  });
});
