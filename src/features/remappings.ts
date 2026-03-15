/**
 * Foundry Remappings Parser
 *
 * Parses remappings from foundry.toml and remappings.txt to resolve
 * Solidity imports correctly (e.g. @openzeppelin/=lib/openzeppelin-contracts/).
 */

import * as fs from 'fs';
import * as path from 'path';

export interface Remapping {
  context: string; // optional context prefix
  prefix: string; // import prefix to match
  target: string; // replacement path
}

export class RemappingsResolver {
  private remappings: Remapping[] = [];
  private projectRoot = '';

  /**
   * Load remappings for a project root.
   * Checks: remappings.txt, foundry.toml, hardhat.config
   */
  load(projectRoot: string): void {
    this.projectRoot = projectRoot;
    this.remappings = [];

    // 1. Try remappings.txt (highest priority)
    const remappingsTxt = path.join(projectRoot, 'remappings.txt');
    if (fs.existsSync(remappingsTxt)) {
      const content = fs.readFileSync(remappingsTxt, 'utf-8');
      this.remappings.push(...this.parseRemappingsTxt(content));
    }

    // 2. Try foundry.toml
    const foundryToml = path.join(projectRoot, 'foundry.toml');
    if (fs.existsSync(foundryToml)) {
      const content = fs.readFileSync(foundryToml, 'utf-8');
      const tomlRemappings = this.parseFoundryToml(content);
      // Only add if not already from remappings.txt
      for (const r of tomlRemappings) {
        if (!this.remappings.some((existing) => existing.prefix === r.prefix)) {
          this.remappings.push(r);
        }
      }
    }

    // 3. Auto-detect lib/ folder (common Foundry pattern)
    const libDir = path.join(projectRoot, 'lib');
    if (fs.existsSync(libDir)) {
      try {
        const libs = fs.readdirSync(libDir, { withFileTypes: true });
        for (const lib of libs) {
          if (lib.isDirectory()) {
            // Auto-map lib/name/ -> lib/name/src/ or lib/name/contracts/
            const srcDir = path.join(libDir, lib.name, 'src');
            const contractsDir = path.join(libDir, lib.name, 'contracts');

            const target = fs.existsSync(srcDir)
              ? `lib/${lib.name}/src/`
              : fs.existsSync(contractsDir)
                ? `lib/${lib.name}/contracts/`
                : `lib/${lib.name}/`;

            // Only add if no explicit mapping exists
            const prefix = `${lib.name}/`;
            if (!this.remappings.some((r) => r.prefix === prefix)) {
              this.remappings.push({ context: '', prefix, target });
            }
          }
        }
      } catch {
        // Ignore readdir errors
      }
    }
  }

  /**
   * Parse remappings.txt format: context:prefix=target
   */
  private parseRemappingsTxt(content: string): Remapping[] {
    const remappings: Remapping[] = [];

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
        continue;
      }

      const parsed = this.parseRemappingLine(trimmed);
      if (parsed) {
        remappings.push(parsed);
      }
    }

    return remappings;
  }

  /**
   * Parse a single remapping line: [context:]prefix=target
   */
  private parseRemappingLine(line: string): Remapping | null {
    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) {
      return null;
    }

    const left = line.substring(0, eqIndex);
    const target = line.substring(eqIndex + 1).trim();

    // Check for context prefix
    const colonIndex = left.indexOf(':');
    let context = '';
    let prefix: string;

    if (colonIndex !== -1) {
      context = left.substring(0, colonIndex).trim();
      prefix = left.substring(colonIndex + 1).trim();
    } else {
      prefix = left.trim();
    }

    if (!prefix || !target) {
      return null;
    }

    return { context, prefix, target };
  }

  /**
   * Parse foundry.toml for remappings array
   */
  private parseFoundryToml(content: string): Remapping[] {
    const remappings: Remapping[] = [];

    // Match remappings = [...] in TOML
    const remappingsMatch = content.match(/remappings\s*=\s*\[([\s\S]*?)\]/);
    if (!remappingsMatch) {
      return remappings;
    }

    const arrayContent = remappingsMatch[1];
    // Extract quoted strings
    const stringPattern = /["']([^"']+)["']/g;
    let match;
    while ((match = stringPattern.exec(arrayContent)) !== null) {
      const parsed = this.parseRemappingLine(match[1]);
      if (parsed) {
        remappings.push(parsed);
      }
    }

    return remappings;
  }

  /**
   * Resolve an import path using loaded remappings
   */
  resolve(importPath: string): string | null {
    // Try each remapping (longest prefix match first)
    const sorted = [...this.remappings].sort((a, b) => b.prefix.length - a.prefix.length);

    for (const { prefix, target } of sorted) {
      if (importPath.startsWith(prefix)) {
        const resolved = importPath.replace(prefix, target);
        const fullPath = path.resolve(this.projectRoot, resolved);

        if (fs.existsSync(fullPath)) {
          return fullPath;
        }
      }
    }

    return null;
  }

  /**
   * Resolve an import and return file contents
   */
  resolveContents(importPath: string): { contents: string } | { error: string } {
    const resolved = this.resolve(importPath);
    if (resolved) {
      try {
        return { contents: fs.readFileSync(resolved, 'utf-8') };
      } catch {
        return { error: `Could not read: ${resolved}` };
      }
    }
    return { error: `Import not found: ${importPath}` };
  }

  /**
   * Get all loaded remappings
   */
  getRemappings(): Remapping[] {
    return [...this.remappings];
  }

  /**
   * Check if any remappings are loaded
   */
  hasRemappings(): boolean {
    return this.remappings.length > 0;
  }
}
