import * as fs from 'fs';
import * as path from 'path';

/**
 * Signature Database - Library of common contract signatures
 */

export interface SignatureEntry {
  signature: string;
  selector: string;
  category: string;
  description: string;
  example?: string;
  tags: string[];
}

export class SignatureDatabase {
  private signatures: Map<string, SignatureEntry> = new Map();
  private databasePath: string;

  constructor(databasePath?: string) {
    this.databasePath = databasePath || path.join(__dirname, '../../data/signatures.json');
    this.loadDatabase();
  }

  /**
   * Load signature database from file
   */
  private loadDatabase(): void {
    try {
      if (fs.existsSync(this.databasePath)) {
        const data = fs.readFileSync(this.databasePath, 'utf-8');
        const entries: SignatureEntry[] = JSON.parse(data);
        entries.forEach((entry) => {
          this.signatures.set(entry.selector, entry);
        });
      } else {
        this.initializeDatabase();
      }
    } catch (error) {
      console.error('Failed to load signature database:', error);
      this.initializeDatabase();
    }
  }

  /**
   * Initialize database with common signatures
   */
  private initializeDatabase(): void {
    const commonSignatures: SignatureEntry[] = [
      // ERC20
      {
        signature: 'transfer(address,uint256)',
        selector: '0xa9059cbb',
        category: 'ERC20',
        description: 'Transfer tokens to address',
        tags: ['token', 'transfer', 'erc20'],
      },
      {
        signature: 'approve(address,uint256)',
        selector: '0x095ea7b3',
        category: 'ERC20',
        description: 'Approve spender to spend tokens',
        tags: ['token', 'approve', 'erc20'],
      },
      {
        signature: 'transferFrom(address,address,uint256)',
        selector: '0x23b872dd',
        category: 'ERC20',
        description: 'Transfer tokens from address',
        tags: ['token', 'transfer', 'erc20'],
      },
      // ERC721
      {
        signature: 'safeTransferFrom(address,address,uint256)',
        selector: '0x42842e0e',
        category: 'ERC721',
        description: 'Safely transfer NFT',
        tags: ['nft', 'transfer', 'erc721'],
      },
      {
        signature: 'mint(address,uint256)',
        selector: '0x40c10f19',
        category: 'Minting',
        description: 'Mint new tokens',
        tags: ['mint', 'token', 'nft'],
      },
      // Common patterns
      {
        signature: 'initialize()',
        selector: '0x8129fc1c',
        category: 'Proxy',
        description: 'Initialize upgradeable contract',
        tags: ['proxy', 'upgrade', 'initialize'],
      },
      {
        signature: 'pause()',
        selector: '0x8456cb59',
        category: 'Access Control',
        description: 'Pause contract operations',
        tags: ['pause', 'emergency', 'access-control'],
      },
      {
        signature: 'unpause()',
        selector: '0x3f4ba83a',
        category: 'Access Control',
        description: 'Unpause contract operations',
        tags: ['unpause', 'emergency', 'access-control'],
      },
    ];

    commonSignatures.forEach((sig) => {
      this.signatures.set(sig.selector, sig);
    });

    this.saveDatabase();
  }

  /**
   * Save database to file
   */
  private saveDatabase(): void {
    try {
      const dir = path.dirname(this.databasePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const data = JSON.stringify(Array.from(this.signatures.values()), null, 2);
      fs.writeFileSync(this.databasePath, data, 'utf-8');
    } catch (error) {
      console.error('Failed to save signature database:', error);
    }
  }

  /**
   * Add signature to database
   */
  public addSignature(entry: SignatureEntry): void {
    this.signatures.set(entry.selector, entry);
    this.saveDatabase();
  }

  /**
   * Search signatures by keyword
   */
  public search(keyword: string): SignatureEntry[] {
    const lowerKeyword = keyword.toLowerCase();
    return Array.from(this.signatures.values()).filter(
      (entry) =>
        entry.signature.toLowerCase().includes(lowerKeyword) ||
        entry.description.toLowerCase().includes(lowerKeyword) ||
        entry.tags.some((tag) => tag.toLowerCase().includes(lowerKeyword))
    );
  }

  /**
   * Get signature by selector
   */
  public getBySelector(selector: string): SignatureEntry | undefined {
    return this.signatures.get(selector);
  }

  /**
   * Get signatures by category
   */
  public getByCategory(category: string): SignatureEntry[] {
    return Array.from(this.signatures.values()).filter((entry) => entry.category === category);
  }

  /**
   * Get all categories
   */
  public getCategories(): string[] {
    const categories = new Set<string>();
    this.signatures.forEach((entry) => categories.add(entry.category));
    return Array.from(categories).sort();
  }

  /**
   * Identify unknown signatures
   */
  public identifySignatures(localSignatures: string[]): {
    known: Map<string, SignatureEntry>;
    unknown: string[];
  } {
    const known = new Map<string, SignatureEntry>();
    const unknown: string[] = [];

    localSignatures.forEach((sig) => {
      const entry = this.signatures.get(sig);
      if (entry) {
        known.set(sig, entry);
      } else {
        unknown.push(sig);
      }
    });

    return { known, unknown };
  }

  /**
   * Generate signature library documentation
   */
  public generateLibraryDocs(): string {
    let docs = '# Signature Library\n\n';

    const categories = this.getCategories();

    categories.forEach((category) => {
      docs += `## ${category}\n\n`;
      const sigs = this.getByCategory(category);

      docs += '| Signature | Selector | Description | Tags |\n';
      docs += '|-----------|----------|-------------|------|\n';

      sigs.forEach((sig) => {
        docs += `| \`${sig.signature}\` | \`${sig.selector}\` | ${sig.description} | ${sig.tags.join(', ')} |\n`;
      });

      docs += '\n';
    });

    return docs;
  }

  /**
   * Export signatures for a specific category
   */
  public exportCategory(category: string, format: 'json' | 'text'): string {
    const sigs = this.getByCategory(category);

    if (format === 'json') {
      return JSON.stringify(sigs, null, 2);
    } else {
      return sigs.map((sig) => `${sig.selector} ${sig.signature}`).join('\n');
    }
  }

  /**
   * Import signatures from external source
   */
  public importSignatures(signatures: SignatureEntry[]): void {
    signatures.forEach((sig) => {
      this.addSignature(sig);
    });
    this.saveDatabase();
  }

  /**
   * Get signature statistics
   */
  public getStatistics(): {
    total: number;
    byCategory: Map<string, number>;
    topTags: { tag: string; count: number }[];
  } {
    const byCategory = new Map<string, number>();
    const tagCounts = new Map<string, number>();

    this.signatures.forEach((entry) => {
      // Count by category
      const count = byCategory.get(entry.category) || 0;
      byCategory.set(entry.category, count + 1);

      // Count tags
      entry.tags.forEach((tag) => {
        const tagCount = tagCounts.get(tag) || 0;
        tagCounts.set(tag, tagCount + 1);
      });
    });

    // Get top tags
    const topTags = Array.from(tagCounts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      total: this.signatures.size,
      byCategory,
      topTags,
    };
  }
}
