import * as crypto from 'crypto';

interface SignatureData {
  functions: unknown[];
  events: unknown[];
  errors: unknown[];
}

interface CacheMetadata {
  size: number;
  complexity: number;
  gasEstimate?: number;
}

/**
 * Cache entry for parsed file
 */
interface CacheEntry {
  hash: string;
  lastModified: number;
  signatures: SignatureData;
  metadata?: CacheMetadata;
}

/**
 * Signature cache for performance optimization
 */
export class SignatureCache {
  private cache: Map<string, CacheEntry> = new Map();
  private maxSize = 1000;

  /**
   * Get cached signatures for a file
   */
  public get(filePath: string, fileContent: string): CacheEntry | null {
    const entry = this.cache.get(filePath);
    if (!entry) {
      return null;
    }

    const currentHash = this.calculateHash(fileContent);
    if (entry.hash !== currentHash) {
      // File changed, invalidate cache
      this.cache.delete(filePath);
      return null;
    }

    // Move to end for LRU behavior (Map preserves insertion order)
    this.cache.delete(filePath);
    this.cache.set(filePath, entry);

    return entry;
  }

  /**
   * Store signatures in cache
   */
  public set(
    filePath: string,
    fileContent: string,
    signatures: SignatureData,
    metadata?: CacheMetadata
  ): void {
    if (this.cache.size >= this.maxSize) {
      // Remove oldest entry (LRU)
      const firstKey = this.cache.keys().next().value as string | undefined;
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }

    const entry: CacheEntry = {
      hash: this.calculateHash(fileContent),
      lastModified: Date.now(),
      signatures,
      metadata,
    };

    this.cache.set(filePath, entry);
  }

  /**
   * Invalidate cache for a file
   */
  public invalidate(filePath: string): void {
    this.cache.delete(filePath);
  }

  /**
   * Clear entire cache
   */
  public clear(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  public getStats(): { size: number; maxSize: number; hitRate: number } {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hitRate: 0, // Would need to track hits/misses
    };
  }

  /**
   * Calculate SHA-256 hash of content
   */
  private calculateHash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }
}

// Singleton instance
export const signatureCache = new SignatureCache();
