// Enumerates Foundry keystores at ~/.foundry/keystores/ and provides an
// ephemeral password cache that lives in the extension host process only —
// never written to disk, never sent back to the webview.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface KeystoreEntry {
  name: string;       // filename in ~/.foundry/keystores/
  address: string;    // 0x-prefixed checksum-agnostic
  path: string;       // absolute path of the keystore file
}

interface KeystoreV3 {
  version: 3;
  address?: string;
  crypto?: { ciphertext?: string };
}

function isV3(obj: unknown): obj is KeystoreV3 {
  if (!obj || typeof obj !== 'object') return false;
  const o = obj as Record<string, unknown>;
  if (o.version !== 3) return false;
  const crypto = o.crypto as Record<string, unknown> | undefined;
  return !!crypto && typeof crypto.ciphertext === 'string';
}

export function getDefaultKeystoreDir(): string {
  // Allow override for testing / non-standard installs
  return process.env.FOUNDRY_KEYSTORES_DIR ?? path.join(os.homedir(), '.foundry', 'keystores');
}

export function listKeystores(dir: string = getDefaultKeystoreDir()): KeystoreEntry[] {
  if (!fs.existsSync(dir)) return [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: KeystoreEntry[] = [];
  for (const name of entries) {
    const full = path.join(dir, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      continue;
    }
    if (!isV3(parsed)) continue;
    const addr = (parsed as KeystoreV3).address ?? '';
    out.push({
      name,
      // Foundry stores the address without the 0x prefix, lowercase per Web3 spec
      address: addr.startsWith('0x') ? addr : '0x' + addr,
      path: full,
    });
  }
  return out;
}

export function readKeystoreJson(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

// ─── Ephemeral password session ───────────────────────────────────────────
// Held only in this module's closure. Never persisted. Cleared on demand or
// after a configurable idle timeout.

type Cached = { password: string; expiresAt: number };
const cache = new Map<string, Cached>();
const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes

export function storePassword(keystoreName: string, password: string, ttlMs: number = DEFAULT_TTL_MS): void {
  cache.set(keystoreName, { password, expiresAt: Date.now() + ttlMs });
}

export function takePassword(keystoreName: string): string | null {
  const c = cache.get(keystoreName);
  if (!c) return null;
  if (Date.now() > c.expiresAt) {
    cache.delete(keystoreName);
    return null;
  }
  return c.password;
}

export function clearPassword(keystoreName?: string): void {
  if (keystoreName) cache.delete(keystoreName);
  else cache.clear();
}

export function isUnlocked(keystoreName: string): boolean {
  return takePassword(keystoreName) !== null;
}
