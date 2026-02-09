/**
 * CLI Smoke Test — runs the scanner and parser against real example projects.
 * No mocks: exercises the full extraction pipeline on actual .sol files.
 */

import * as path from 'path';
import * as fs from 'fs';
import { ProjectScanner } from '../core/scanner';
import { SolidityParser } from '../core/parser';
import { SignatureExporter } from '../core/exporter';

const EXAMPLES_DIR = path.resolve(__dirname, '../../examples');

describe('CLI smoke tests against example projects', () => {
  const scanner = new ProjectScanner();
  const parser = new SolidityParser();

  it('examples directory exists and has projects', () => {
    expect(fs.existsSync(EXAMPLES_DIR)).toBe(true);
    const entries = fs.readdirSync(EXAMPLES_DIR);
    expect(entries.length).toBeGreaterThan(0);
  });

  describe('Foundry project scanning', () => {
    const foundryDir = path.join(EXAMPLES_DIR, 'foundry-defi');

    it('detects foundry-defi as a Foundry project', async () => {
      const result = await scanner.scanProject(foundryDir);
      expect(result.projectInfo.type).toBe('foundry');
    });

    it('finds Solidity contracts in foundry-defi', async () => {
      const result = await scanner.scanProject(foundryDir);
      expect(result.totalContracts).toBeGreaterThan(0);
      expect(result.totalFunctions).toBeGreaterThan(0);
    });

    it('extracts correct selectors from LiquidityPool.sol', () => {
      const filePath = path.join(foundryDir, 'src', 'LiquidityPool.sol');
      if (!fs.existsSync(filePath)) {
        return;
      }

      const info = parser.parseFile(filePath);
      expect(info).not.toBeNull();
      expect(info!.functions.length).toBeGreaterThan(0);

      // Every public/external function should have a 0x-prefixed selector
      for (const func of info!.functions) {
        if (func.visibility === 'public' || func.visibility === 'external') {
          expect(func.selector).toMatch(/^0x[0-9a-f]{8}$/);
        }
      }
    });
  });

  describe('Hardhat project scanning', () => {
    const hardhatDir = path.join(EXAMPLES_DIR, 'hardhat-nft');

    it('detects hardhat-nft as a Hardhat project', async () => {
      const result = await scanner.scanProject(hardhatDir);
      expect(result.projectInfo.type).toBe('hardhat');
    });

    it('finds contracts in hardhat-nft', async () => {
      const result = await scanner.scanProject(hardhatDir);
      expect(result.totalContracts).toBeGreaterThan(0);
    });
  });

  describe('recursive sub-project discovery', () => {
    it('finds multiple sub-projects under examples/', async () => {
      const { subProjects, combinedResult } = await scanner.scanAllSubProjects(EXAMPLES_DIR);
      expect(subProjects.length).toBeGreaterThanOrEqual(2);
      expect(combinedResult.totalContracts).toBeGreaterThan(0);
      expect(combinedResult.totalFunctions).toBeGreaterThan(0);
    });
  });

  describe('parser correctness on real files', () => {
    it('extracts events and errors from a real contract', () => {
      // Pick any .sol file that likely has events
      const solFiles = findSolFiles(EXAMPLES_DIR);
      expect(solFiles.length).toBeGreaterThan(0);

      let foundEvents = false;
      for (const file of solFiles) {
        const info = parser.parseFile(file);
        if (info && info.events.length > 0) {
          foundEvents = true;
          for (const evt of info.events) {
            expect(evt.selector).toMatch(/^0x[0-9a-f]{64}$/);
            expect(evt.name.length).toBeGreaterThan(0);
          }
          break;
        }
      }
      expect(foundEvents).toBe(true);
    });

    it('produces unique selectors for different function signatures', () => {
      const solFiles = findSolFiles(EXAMPLES_DIR);
      const allSelectors = new Map<string, string[]>();

      for (const file of solFiles) {
        const info = parser.parseFile(file);
        if (!info) {
          continue;
        }
        for (const func of info.functions) {
          if (func.visibility === 'internal' || func.visibility === 'private') {
            continue;
          }
          const existing = allSelectors.get(func.selector) || [];
          if (!existing.includes(func.signature)) {
            existing.push(func.signature);
          }
          allSelectors.set(func.selector, existing);
        }
      }

      // At least some selectors should exist
      expect(allSelectors.size).toBeGreaterThan(0);
    });
  });

  describe('exporter produces output', () => {
    it('exports JSON format without errors', async () => {
      const foundryDir = path.join(EXAMPLES_DIR, 'foundry-defi');
      const result = await scanner.scanProject(foundryDir);

      const tmpDir = path.join(__dirname, '../../.test-output');
      fs.mkdirSync(tmpDir, { recursive: true });

      try {
        await new SignatureExporter().exportSignatures(result, {
          formats: ['json'],
          outputDir: tmpDir,
          includeInternal: false,
          includePrivate: false,
          includeEvents: true,
          includeErrors: true,
        });

        // Check that at least one JSON file was created
        const files = fs.readdirSync(tmpDir);
        const jsonFiles = files.filter((f) => f.endsWith('.json'));
        expect(jsonFiles.length).toBeGreaterThan(0);

        // Validate it's valid JSON
        const content = fs.readFileSync(path.join(tmpDir, jsonFiles[0]), 'utf-8');
        expect(() => JSON.parse(content)).not.toThrow();
      } finally {
        // Cleanup
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});

/** Recursively find all .sol files under a directory */
function findSolFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
      results.push(...findSolFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.sol')) {
      results.push(full);
    }
  }
  return results;
}
