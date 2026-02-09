/**
 * Solc Version Manager - Background lazy compiler downloading with caching
 * Three-phase strategy:
 * 1. Immediate: Use bundled compiler
 * 2. Background: Download matching version if needed
 * 3. Silent upgrade: Re-compile when ready
 */

import * as semver from 'semver';

// Compiler cache
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const compilerCache = new Map<string, any>();
const downloading = new Set<string>();

// Bundled compiler version
const BUNDLED_VERSION = '0.8.28';

// Map of version patterns to actual available solc releases
// These are known stable releases that exist in the solc-bin repository
const VERSION_RELEASES: Record<string, string> = {
  '0.8.28': 'v0.8.28+commit.7893614a',
  '0.8.27': 'v0.8.27+commit.40a35a09',
  '0.8.26': 'v0.8.26+commit.8a97fa7a',
  '0.8.25': 'v0.8.25+commit.b61c2a91',
  '0.8.24': 'v0.8.24+commit.e11b9ed9',
  '0.8.23': 'v0.8.23+commit.f704f362',
  '0.8.22': 'v0.8.22+commit.4fc1097e',
  '0.8.21': 'v0.8.21+commit.d9974bed',
  '0.8.20': 'v0.8.20+commit.a1b79de6',
  '0.8.19': 'v0.8.19+commit.7dd6d404',
  '0.8.18': 'v0.8.18+commit.87f61d96',
  '0.8.17': 'v0.8.17+commit.8df45f5f',
  '0.8.16': 'v0.8.16+commit.07a7930e',
  '0.8.15': 'v0.8.15+commit.e14f2714',
  '0.8.14': 'v0.8.14+commit.80d49f37',
  '0.8.13': 'v0.8.13+commit.abaa5c0e',
  '0.8.12': 'v0.8.12+commit.f00d7308',
  '0.8.11': 'v0.8.11+commit.d7f03943',
  '0.8.10': 'v0.8.10+commit.fc410830',
  '0.8.9': 'v0.8.9+commit.e5eed63a',
  '0.8.8': 'v0.8.8+commit.dddeac2f',
  '0.8.7': 'v0.8.7+commit.e28d00a7',
  '0.8.6': 'v0.8.6+commit.11564f7e',
  '0.8.5': 'v0.8.5+commit.a4f2e591',
  '0.8.4': 'v0.8.4+commit.c7e474f2',
  '0.8.3': 'v0.8.3+commit.8d00100c',
  '0.8.2': 'v0.8.2+commit.661d1103',
  '0.8.1': 'v0.8.1+commit.df193b15',
  '0.8.0': 'v0.8.0+commit.c7dfd78e',
  '0.7.6': 'v0.7.6+commit.7338295f',
  '0.7.5': 'v0.7.5+commit.eb77ed08',
  '0.7.4': 'v0.7.4+commit.3f05b770',
  '0.7.3': 'v0.7.3+commit.9bfce1f6',
  '0.7.2': 'v0.7.2+commit.51b20bc0',
  '0.7.1': 'v0.7.1+commit.f4a555be',
  '0.7.0': 'v0.7.0+commit.9e61f92b',
  '0.6.12': 'v0.6.12+commit.27d51765',
  '0.6.11': 'v0.6.11+commit.5ef660b1',
  '0.6.10': 'v0.6.10+commit.00c0fcaf',
  '0.6.9': 'v0.6.9+commit.3e3065ac',
  '0.6.8': 'v0.6.8+commit.0bbfe453',
  '0.6.7': 'v0.6.7+commit.b8d736ae',
  '0.6.6': 'v0.6.6+commit.6c089d02',
};

export interface PragmaInfo {
  raw: string;
  range?: string;
  version?: string;
  exactVersion?: string; // Extracted exact version if available
}

/**
 * Parse pragma solidity statement from source
 * Extracts version information and handles various pragma formats:
 * - ^0.8.20 -> extracts 0.8.20
 * - >=0.8.0 <0.9.0 -> extracts 0.8.0 (lower bound)
 * - 0.8.20 -> extracts 0.8.20
 */
export function parsePragma(source: string): PragmaInfo | null {
  const pragmaMatch = source.match(/pragma\s+solidity\s+([^;]+);/i);
  if (!pragmaMatch) {
    return null;
  }

  const range = pragmaMatch[1].trim();
  const exactVersion = extractVersionFromPragma(range);

  return {
    raw: pragmaMatch[0],
    range,
    exactVersion,
  };
}

/**
 * Extract a concrete version number from pragma range
 */
function extractVersionFromPragma(range: string): string | undefined {
  // Remove whitespace for easier parsing
  const cleaned = range.replace(/\s+/g, '');

  // Match patterns like ^0.8.20, ~0.8.20, 0.8.20
  const simpleMatch = cleaned.match(/[\^~]?(\d+\.\d+\.\d+)/);
  if (simpleMatch) {
    return simpleMatch[1];
  }

  // Match ranges like >=0.8.0<0.9.0, use the lower bound
  const rangeMatch = cleaned.match(/>=?(\d+\.\d+\.\d+)/);
  if (rangeMatch) {
    return rangeMatch[1];
  }

  return undefined;
}

/**
 * Check if bundled compiler satisfies pragma
 */
export function bundledCompilerSatisfies(pragma: PragmaInfo | null): boolean {
  if (!pragma || !pragma.range) {
    return true;
  } // No pragma = assume compatible

  try {
    return semver.satisfies(BUNDLED_VERSION, pragma.range);
  } catch {
    // Invalid semver range, assume compatible
    return true;
  }
}

/**
 * Resolve best version for pragma
 * Returns version in format 'v0.8.20+commit.xyz' for solc-js loader
 * Maps to actual available releases in the solc-bin repository
 */
export function resolveBestVersion(pragma: PragmaInfo | null): string | null {
  if (!pragma || !pragma.range) {
    return null;
  }

  try {
    // Priority 1: Use extracted exact version from pragma
    if (pragma.exactVersion) {
      const release = VERSION_RELEASES[pragma.exactVersion];
      if (release) {
        return release;
      }
      // If exact version not in map, try to find closest
      console.log(`⚠️  Exact version ${pragma.exactVersion} not in release map, using bundled`);
      return null;
    }

    // Priority 2: Try to extract from range directly
    const cleaned = pragma.range.replace(/\s+/g, '');

    // Match ^0.8.20, ~0.8.20, or 0.8.20
    const simpleMatch = cleaned.match(/[\^~]?(\d+\.\d+\.\d+)/);
    if (simpleMatch) {
      const version = simpleMatch[1];
      const release = VERSION_RELEASES[version];
      if (release) {
        return release;
      }
      console.log(`⚠️  Version ${version} not in release map`);
    }

    // Match range >=0.8.0 <0.9.0 - use lower bound
    const rangeMatch = cleaned.match(/>=?(\d+\.\d+\.\d+)/);
    if (rangeMatch) {
      const version = rangeMatch[1];
      const release = VERSION_RELEASES[version];
      if (release) {
        return release;
      }
    }

    // Priority 3: For complex ranges without explicit version, use latest stable of major version
    const rangeToVersion: Record<string, string> = {
      '^0.8': VERSION_RELEASES['0.8.28'],
      '^0.7': VERSION_RELEASES['0.7.6'],
      '^0.6': VERSION_RELEASES['0.6.12'],
      '>=0.8.0<0.9.0': VERSION_RELEASES['0.8.28'],
      '>=0.7.0<0.8.0': VERSION_RELEASES['0.7.6'],
    };

    for (const [pattern, version] of Object.entries(rangeToVersion)) {
      if (cleaned.includes(pattern.replace(/[\^><=\s]/g, ''))) {
        console.log(`📌 Resolved complex pragma "${pragma.range}" to ${version}`);
        return version;
      }
    }
  } catch (error) {
    console.warn('⚠️  Error resolving version from pragma:', error);
    return null;
  }

  return null;
}

/**
 * Check if compiler is cached (disk or memory)
 */
export function isCompilerCached(version: string): boolean {
  return compilerCache.has(version);
}

/**
 * Get cached compiler
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getCachedCompiler(version: string): any | null {
  return compilerCache.get(version) || null;
}

/**
 * Cache compiler in memory
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function cacheCompiler(version: string, compiler: any): void {
  compilerCache.set(version, compiler);
  console.log(`✅ Cached solc ${version} in memory`);
}

/**
 * Track download callbacks for deduplication
 */
const downloadCallbacks = new Map<string, Array<(version: string, compiler: any) => void>>();

/**
 * Ensure compiler is downloaded (non-blocking, background)
 * Returns immediately, downloads asynchronously
 * Multiple calls for same version will be deduplicated
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function ensureCompilerDownloaded(
  pragma: PragmaInfo | null,
  onReady?: (version: string, compiler: any) => void
): void {
  // Check if bundled compiler is sufficient
  if (bundledCompilerSatisfies(pragma)) {
    return; // No download needed
  }

  const version = resolveBestVersion(pragma);
  if (!version) {
    console.log('⚠️  Could not resolve version for pragma:', pragma?.range);
    return;
  }

  // Check if already cached
  if (isCompilerCached(version)) {
    console.log(`📦 Solc ${version} already cached`);
    if (onReady) {
      const compiler = getCachedCompiler(version);
      if (compiler) {
        onReady(version, compiler);
      }
    }
    return;
  }

  // Register callback for this download
  if (onReady) {
    if (!downloadCallbacks.has(version)) {
      downloadCallbacks.set(version, []);
    }
    const callbacks = downloadCallbacks.get(version);
    if (callbacks) {
      callbacks.push(onReady);
    }
  }

  // Check if already downloading
  if (downloading.has(version)) {
    console.log(`⏳ Solc ${version} already downloading... (registered callback)`);
    return;
  }

  // Start background download
  console.log(`⬇️  Background downloading solc ${version}...`);
  downloading.add(version);

  // Use solc-js to load remote version
  // Dynamic import is needed here as we're loading different compiler versions
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const solc = require('solc');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    solc.loadRemoteVersion(version, (err: Error | null, solcSpecific: any) => {
      downloading.delete(version);

      if (err) {
        console.error(`❌ Failed to download solc ${version}:`, err.message);
        downloadCallbacks.delete(version);
        return;
      }

      console.log(`✅ Downloaded solc ${version}`);
      cacheCompiler(version, solcSpecific);

      // Notify all registered callbacks
      const callbacks = downloadCallbacks.get(version) || [];
      callbacks.forEach((cb) => {
        try {
          cb(version, solcSpecific);
        } catch (error) {
          console.error('Error in download callback:', error);
        }
      });
      downloadCallbacks.delete(version);
    });
  } catch (error) {
    downloading.delete(version);
    downloadCallbacks.delete(version);
    console.error('❌ solc.loadRemoteVersion not available:', error);
  }
}

/**
 * Get compiler for source (immediate, non-blocking)
 * Returns cached exact version if available, otherwise bundled, triggers background download if needed
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getCompilerForSource(
  source: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onUpgrade?: (version: string, compiler: any) => void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): { compiler: any; version: string; isExact: boolean } {
  const pragma = parsePragma(source);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let solc: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    solc = require('solc');
  } catch (error) {
    console.error('❌ Failed to load solc module:', error);
    throw new Error('Solc module not available. Please install solc package.');
  }

  // PHASE 3: Check if we have exact cached version (from completed download)
  if (pragma) {
    const version = resolveBestVersion(pragma);
    if (version) {
      const cached = getCachedCompiler(version);
      if (cached) {
        console.log(`🎯 Using cached exact solc ${version}`);
        return { compiler: cached, version, isExact: true };
      }
    }
  }

  // PHASE 1: If bundled satisfies pragma, use it and skip download
  if (bundledCompilerSatisfies(pragma)) {
    console.log(`✅ Bundled solc ${BUNDLED_VERSION} satisfies pragma ${pragma?.range || 'any'}`);
    return { compiler: solc, version: BUNDLED_VERSION, isExact: true };
  }

  // PHASE 2: Bundled doesn't satisfy - trigger background download and return bundled for now
  console.log(
    `⚠️  Bundled solc ${BUNDLED_VERSION} doesn't satisfy ${pragma?.range}, triggering download...`
  );
  ensureCompilerDownloaded(pragma, onUpgrade);

  // Return bundled as fallback until download completes
  return { compiler: solc, version: BUNDLED_VERSION, isExact: false };
}

/**
 * Get status of compiler downloads and cache
 */
export function getCompilerStatus(): {
  cached: string[];
  downloading: string[];
  bundled: string;
} {
  return {
    cached: Array.from(compilerCache.keys()),
    downloading: Array.from(downloading),
    bundled: BUNDLED_VERSION,
  };
}

/**
 * Clear compiler cache (useful for testing or memory management)
 */
export function clearCompilerCache(): void {
  compilerCache.clear();
  console.log('🗑️  Compiler cache cleared');
}

/**
 * Check if a specific version is currently downloading
 */
export function isDownloading(version: string): boolean {
  return downloading.has(version);
}
