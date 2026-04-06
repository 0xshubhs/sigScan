/**
 * Compilation Service - Centralized compiler lifecycle management
 *
 * This is the SINGLE entry point for all compilation operations.
 * Solidity-specific logic is isolated here, UI never triggers compilation directly.
 * Every expensive operation is cached and debounced.
 *
 * Architecture (mirrors Remix):
 * - Compiler + Analysis split
 * - Debounced compilation (250-500ms)
 * - Cache by content hash
 * - Background version downloading
 * - Event-driven UI updates
 */

import { EventEmitter } from 'events';
import {
  SolcManager,
  GasInfo,
  CompilationOutput,
  CompilerSettings,
  compileWithGasAnalysis,
  parsePragmaFromSource,
  resolveSolcVersion,
} from './SolcManager';
import { isForgeAvailable, findFoundryRoot, compileWithForge } from './forge-backend';
import { isRunnerAvailable, compileWithRunner } from './runner-backend';

/**
 * Compilation event types
 */
export interface CompilationEvents {
  'compilation:start': { uri: string; version: string };
  'compilation:success': { uri: string; output: CompilationOutput };
  'compilation:error': { uri: string; errors: string[] };
  'version:downloading': { version: string };
  'version:ready': { version: string };
}

/**
 * Compilation trigger types
 */
export type CompilationTrigger =
  | 'file-save' // Recompile immediately
  | 'file-open' // Recompile immediately
  | 'optimizer-change' // Recompile with new settings
  | 'pragma-change' // Recompile with new solc version
  | 'manual'; // User-triggered

/**
 * Compilation result with metadata
 */
export interface CompilationResult extends CompilationOutput {
  uri: string;
  timestamp: number;
  trigger: CompilationTrigger;
  contentHash: string;
  cached: boolean;
}

/**
 * Cache entry
 */
interface CacheEntry {
  result: CompilationResult;
  timestamp: number;
  pragma: string | null;
}

/**
 * CompilationService - Manages the entire compilation lifecycle
 *
 * Usage:
 * ```ts
 * const service = CompilationService.getInstance();
 * service.on('compilation:success', (event) => {
 *   updateDecorations(event.output.gasInfo);
 * });
 * await service.compile(document.uri.toString(), source, 'file-save');
 * ```
 */
export class CompilationService extends EventEmitter {
  private static instance: CompilationService;

  // Caches
  private compilationCache = new Map<string, CacheEntry>(); // contentHash -> result
  private uriToHashCache = new Map<string, string>(); // uri -> contentHash (for quick lookup)

  // Debouncing
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private pendingDebounceResolvers = new Map<string, Array<(r: CompilationResult) => void>>();
  private activeCompilations = new Map<string, Promise<CompilationResult>>();

  // Settings
  private settings: CompilerSettings = {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'paris',
    viaIR: false,
  };

  // Debounce configuration
  private debounceMs = 300; // 250-500ms recommended

  // Cache limits
  private maxCacheSize = 5;
  private cacheExpiryMs = 60 * 1000;

  private constructor() {
    super();
  }

  /**
   * Get singleton instance
   */
  static getInstance(): CompilationService {
    if (!this.instance) {
      this.instance = new CompilationService();
    }
    return this.instance;
  }

  /**
   * Update compiler settings
   */
  updateSettings(settings: Partial<CompilerSettings>): void {
    this.settings = { ...this.settings, ...settings };
    // Clear cache when settings change (optimizer affects gas estimates)
    this.clearCache();
  }

  /**
   * Get current settings
   */
  getSettings(): CompilerSettings {
    return { ...this.settings };
  }

  /**
   * Set debounce time in milliseconds
   */
  setDebounceMs(ms: number): void {
    this.debounceMs = Math.max(100, Math.min(1000, ms));
  }

  /**
   * Compile source code (debounced)
   *
   * @param uri - Document URI
   * @param source - Source code
   * @param trigger - What triggered this compilation
   * @param importCallback - Optional import resolver
   */
  async compile(
    uri: string,
    source: string,
    trigger: CompilationTrigger,
    importCallback?: (path: string) => { contents: string } | { error: string }
  ): Promise<CompilationResult> {
    const contentHash = this.hashContent(source);

    // Check cache first
    const cached = this.getCached(contentHash);
    if (cached && !this.shouldRecompile(cached, trigger)) {
      return cached;
    }

    // Check if already compiling this exact content
    if (this.activeCompilations.has(contentHash)) {
      const existing = this.activeCompilations.get(contentHash);
      if (existing) {
        return existing;
      }
    }

    // Debounce based on trigger
    if (trigger === 'file-save' || trigger === 'file-open') {
      // Immediate compilation for save/open
      return this.compileNow(uri, source, trigger, contentHash, importCallback);
    }

    // Debounced compilation for other triggers
    return this.compileDebounced(uri, source, trigger, contentHash, importCallback);
  }

  /**
   * Compile immediately (no debounce)
   */
  async compileNow(
    uri: string,
    source: string,
    trigger: CompilationTrigger,
    contentHash?: string,
    importCallback?: (path: string) => { contents: string } | { error: string }
  ): Promise<CompilationResult> {
    const hash = contentHash || this.hashContent(source);

    // Check cache
    const cached = this.getCached(hash);
    if (cached && !this.shouldRecompile(cached, trigger)) {
      return cached;
    }

    // Check if already compiling
    if (this.activeCompilations.has(hash)) {
      const existing = this.activeCompilations.get(hash);
      if (existing) {
        return existing;
      }
    }

    // Start compilation
    const compilationPromise = this.doCompile(uri, source, trigger, hash, importCallback);
    this.activeCompilations.set(hash, compilationPromise);

    try {
      const result = await compilationPromise;
      return result;
    } finally {
      this.activeCompilations.delete(hash);
    }
  }

  /**
   * Compile with debounce
   */
  private compileDebounced(
    uri: string,
    source: string,
    trigger: CompilationTrigger,
    contentHash: string,
    importCallback?: (path: string) => { contents: string } | { error: string }
  ): Promise<CompilationResult> {
    return new Promise((resolve) => {
      // Clear existing timer
      const existingTimer = this.debounceTimers.get(uri);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      // Track this resolver so it can be resolved when the winning timer fires
      if (!this.pendingDebounceResolvers.has(uri)) {
        this.pendingDebounceResolvers.set(uri, []);
      }
      this.pendingDebounceResolvers.get(uri)!.push(resolve);

      // Set new timer — when it fires, resolve ALL pending promises for this URI
      const timer = setTimeout(async () => {
        this.debounceTimers.delete(uri);
        const resolvers = this.pendingDebounceResolvers.get(uri) || [];
        this.pendingDebounceResolvers.delete(uri);

        try {
          const result = await this.compileNow(uri, source, trigger, contentHash, importCallback);
          for (const r of resolvers) {
            r(result);
          }
        } catch {
          // On error, resolve all with a minimal fallback so callers don't hang
          const fallback: CompilationResult = {
            success: false,
            version: 'none',
            gasInfo: [],
            errors: ['Compilation failed'],
            warnings: [],
            uri,
            timestamp: Date.now(),
            trigger,
            contentHash,
            cached: false,
          };
          for (const r of resolvers) {
            r(fallback);
          }
        }
      }, this.debounceMs);

      this.debounceTimers.set(uri, timer);
    });
  }

  /**
   * Do the actual compilation
   */
  private async doCompile(
    uri: string,
    source: string,
    trigger: CompilationTrigger,
    contentHash: string,
    importCallback?: (path: string) => { contents: string } | { error: string }
  ): Promise<CompilationResult> {
    const pragma = parsePragmaFromSource(source);
    const fileName = this.getFileName(uri);

    try {
      let output: CompilationOutput | null = null;

      const filePath = this.uriToFilePath(uri);
      const foundryRoot = filePath ? findFoundryRoot(filePath) : null;

      // Helper: check if output has real gas data (not just fallback selectors with gas: 0)
      const hasRealGas = (o: CompilationOutput | null): boolean =>
        !!o && o.success && o.gasInfo.length > 0 && o.gasInfo.some((g) => g.gas !== 0);

      // Check user preference for runner backend
      let preferRunner = true;
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const vscode = require('vscode');
        preferRunner = vscode.workspace.getConfiguration('sigscan').get('preferRunner', true);
      } catch {
        // CLI context — default to true
      }

      // --- Priority 1: Runner backend (EVM-executed gas, fastest) ---
      if (preferRunner && filePath && (await isRunnerAvailable())) {
        this.emit('compilation:start', { uri, version: 'runner' });
        try {
          const runnerOutput = await compileWithRunner(filePath, source);
          if (hasRealGas(runnerOutput)) {
            output = runnerOutput;
          } else {
            console.warn('[0xtools] Runner returned no real gas data:', runnerOutput?.errors);
          }
        } catch (e) {
          console.warn('[0xtools] Runner backend failed:', e instanceof Error ? e.message : e);
        }
      } else {
        console.warn(
          `[0xtools] Runner skipped: preferRunner=${preferRunner}, filePath=${!!filePath}, available=${await isRunnerAvailable()}`
        );
      }

      // --- Priority 2: Forge backend (Foundry projects) ---
      if (!hasRealGas(output) && foundryRoot && (await isForgeAvailable())) {
        this.emit('compilation:start', { uri, version: 'forge' });
        try {
          const forgeOutput = await compileWithForge(filePath!, foundryRoot);
          if (hasRealGas(forgeOutput)) {
            output = forgeOutput;
          } else if (forgeOutput && forgeOutput.success && forgeOutput.gasInfo.length > 0) {
            // Forge compiled successfully with selectors but no gas estimates
            // (common for test contracts). Accept this over solc-js which can't resolve imports.
            output = forgeOutput;
            console.warn('[0xtools] Forge compiled OK but no gas estimates (test contract?)');
          } else {
            console.warn('[0xtools] Forge returned no real gas data:', forgeOutput?.errors);
          }
        } catch (e) {
          console.warn('[0xtools] Forge backend failed:', e instanceof Error ? e.message : e);
        }
      } else if (!hasRealGas(output)) {
        console.warn(
          `[0xtools] Forge skipped: foundryRoot=${foundryRoot}, available=${await isForgeAvailable()}`
        );
      }

      // --- Priority 3: Solc-js (WASM, universal fallback) ---
      // Skip solc-js if forge already gave us valid selectors (e.g. test contracts).
      // Solc-js can't resolve forge imports and its regex fallback is worse than forge's ABI.
      const forgeHasSelectors = output && output.success && output.gasInfo.length > 0;
      if (!hasRealGas(output) && !forgeHasSelectors) {
        this.emit('compilation:start', { uri, version: pragma || 'bundled' });

        if (pragma) {
          const availableVersions = await SolcManager.getAvailableVersions();
          try {
            const targetVersion = resolveSolcVersion(pragma, availableVersions);
            if (!SolcManager.isCached(targetVersion)) {
              this.emit('version:downloading', { version: targetVersion });
              await SolcManager.load(targetVersion);
              this.emit('version:ready', { version: targetVersion });
            }
          } catch {
            // Will fall back to bundled
          }
        }

        output = await compileWithGasAnalysis(source, fileName, this.settings, importCallback);
        if (!hasRealGas(output)) {
          console.warn('[0xtools] Solc-js returned no real gas data:', output?.errors);
        }
      }

      // If all backends produced output but none had real gas, prefer the one with most gasInfo entries
      // (the regex fallback from runner/forge still has valid selectors and line locations)
      if (!output) {
        // This shouldn't happen since compileWithGasAnalysis always returns, but guard anyway
        output = {
          success: false,
          version: 'none',
          gasInfo: [],
          errors: ['All compilation backends failed'],
          warnings: [],
        };
      }

      const result: CompilationResult = {
        ...output,
        uri,
        timestamp: Date.now(),
        trigger,
        contentHash,
        cached: false,
      };

      // Cache the result
      this.cacheResult(contentHash, result, pragma);
      this.uriToHashCache.set(uri, contentHash);

      // Emit events - even on error, we may have fallback gasInfo
      if (result.success) {
        this.emit('compilation:success', { uri, output: result });
      } else {
        // Emit error event but also include the output (which may have fallback gasInfo)
        this.emit('compilation:error', { uri, errors: result.errors, output: result });
      }

      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      const result: CompilationResult = {
        success: false,
        version: 'unknown',
        gasInfo: [],
        errors: [errorMsg],
        warnings: [],
        uri,
        timestamp: Date.now(),
        trigger,
        contentHash,
        cached: false,
      };

      this.emit('compilation:error', { uri, errors: result.errors });
      return result;
    }
  }

  /**
   * Try to convert a URI string to a local file path.
   * Returns null for non-file URIs.
   */
  private uriToFilePath(uri: string): string | null {
    if (uri.startsWith('file://')) {
      return decodeURIComponent(uri.replace('file://', ''));
    }
    // Already a path (no scheme)
    if (uri.startsWith('/') || /^[a-zA-Z]:/.test(uri)) {
      return uri;
    }
    return null;
  }

  /**
   * Get cached result
   */
  getCached(contentHash: string): CompilationResult | null {
    const entry = this.compilationCache.get(contentHash);
    if (!entry) {
      return null;
    }

    // Check expiry
    if (Date.now() - entry.timestamp > this.cacheExpiryMs) {
      this.compilationCache.delete(contentHash);
      return null;
    }

    // Return cached result with cached flag
    return { ...entry.result, cached: true };
  }

  /**
   * Get cached result by URI
   */
  getCachedByUri(uri: string): CompilationResult | null {
    const hash = this.uriToHashCache.get(uri);
    if (!hash) {
      return null;
    }
    const result = this.getCached(hash);
    if (!result) {
      // Hash was evicted or expired — clean up the URI mapping
      this.uriToHashCache.delete(uri);
    }
    return result;
  }

  /**
   * Get gas info for a URI (from cache)
   */
  getGasInfo(uri: string): GasInfo[] {
    const result = this.getCachedByUri(uri);
    return result?.gasInfo || [];
  }

  /**
   * Check if we should recompile
   */
  private shouldRecompile(cached: CompilationResult, trigger: CompilationTrigger): boolean {
    // Always recompile on optimizer or pragma change
    if (trigger === 'optimizer-change' || trigger === 'pragma-change') {
      return true;
    }

    // Check if cache is still valid
    if (Date.now() - cached.timestamp > this.cacheExpiryMs) {
      return true;
    }

    return false;
  }

  /**
   * Cache a compilation result
   */
  private cacheResult(contentHash: string, result: CompilationResult, pragma: string | null): void {
    // Enforce cache size limit
    if (this.compilationCache.size >= this.maxCacheSize) {
      this.evictOldest();
    }

    this.compilationCache.set(contentHash, {
      result,
      timestamp: Date.now(),
      pragma,
    });
  }

  /**
   * Evict oldest cache entries and clean up uriToHashCache
   */
  private evictOldest(): void {
    const now = Date.now();
    const entries = Array.from(this.compilationCache.entries());

    // First pass: remove expired entries
    const removedHashes = new Set<string>();
    for (const [hash, entry] of entries) {
      if (now - entry.timestamp > this.cacheExpiryMs) {
        this.compilationCache.delete(hash);
        removedHashes.add(hash);
      }
    }

    // If still over limit, remove oldest 20%
    if (this.compilationCache.size >= this.maxCacheSize) {
      const remaining = Array.from(this.compilationCache.entries());
      remaining.sort((a, b) => a[1].timestamp - b[1].timestamp);
      const toRemove = Math.ceil(remaining.length * 0.2);
      for (let i = 0; i < toRemove; i++) {
        this.compilationCache.delete(remaining[i][0]);
        removedHashes.add(remaining[i][0]);
      }
    }

    // Clean up uriToHashCache: remove entries pointing to evicted hashes
    if (removedHashes.size > 0) {
      for (const [uri, hash] of this.uriToHashCache) {
        if (removedHashes.has(hash)) {
          this.uriToHashCache.delete(uri);
        }
      }
    }
  }

  /**
   * Clear all caches
   */
  clearCache(): void {
    this.compilationCache.clear();
    this.uriToHashCache.clear();
    console.log('🗑️  Compilation cache cleared');
  }

  /**
   * Cancel pending compilation for a URI
   */
  cancelPending(uri: string): void {
    const timer = this.debounceTimers.get(uri);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(uri);
    }
    // Resolve any pending promises with empty result so they don't hang
    const resolvers = this.pendingDebounceResolvers.get(uri);
    if (resolvers) {
      const empty: CompilationResult = {
        success: false,
        version: 'none',
        gasInfo: [],
        errors: ['Cancelled'],
        warnings: [],
        uri,
        timestamp: Date.now(),
        trigger: 'manual',
        contentHash: '',
        cached: false,
      };
      for (const r of resolvers) {
        r(empty);
      }
      this.pendingDebounceResolvers.delete(uri);
    }
  }

  /**
   * Cancel all pending compilations
   */
  cancelAll(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    // Resolve all pending promises so callers don't hang
    for (const [uri, resolvers] of this.pendingDebounceResolvers) {
      const empty: CompilationResult = {
        success: false,
        version: 'none',
        gasInfo: [],
        errors: ['Cancelled'],
        warnings: [],
        uri,
        timestamp: Date.now(),
        trigger: 'manual',
        contentHash: '',
        cached: false,
      };
      for (const r of resolvers) {
        r(empty);
      }
    }
    this.pendingDebounceResolvers.clear();
  }

  /**
   * Hash content for caching
   */
  private hashContent(content: string): string {
    let hash = 5381;
    for (let i = 0; i < content.length; i++) {
      hash = ((hash << 5) + hash + content.charCodeAt(i)) & 0xffffffff;
    }
    return (hash >>> 0).toString(16);
  }

  /**
   * Extract filename from URI
   */
  private getFileName(uri: string): string {
    const parts = uri.split('/');
    return parts[parts.length - 1] || 'Contract.sol';
  }

  /**
   * Get compilation statistics
   */
  getStats(): {
    cacheSize: number;
    cachedVersions: string[];
    pendingCompilations: number;
    settings: CompilerSettings;
  } {
    return {
      cacheSize: this.compilationCache.size,
      cachedVersions: SolcManager.getCachedVersions(),
      pendingCompilations: this.debounceTimers.size,
      settings: this.getSettings(),
    };
  }

  /**
   * Dispose the service
   */
  dispose(): void {
    this.cancelAll();
    this.clearCache();
    SolcManager.clearCache();
    this.removeAllListeners();
  }
}

/**
 * Global compilation service instance
 */
export const compilationService = CompilationService.getInstance();
