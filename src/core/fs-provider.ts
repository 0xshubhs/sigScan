/**
 * File System Provider Abstraction
 *
 * Allows the core engine to work with either VS Code APIs or Node.js fs APIs.
 * Extension context uses VsCodeFsProvider (no glob/chokidar dependency).
 * CLI context uses NodeFsProvider (uses glob/chokidar).
 */

import * as fs from 'fs';
import { FSProvider, FSWatcher } from '../types';

/**
 * Node.js FS provider — uses glob and chokidar directly.
 * Used by the CLI entry point.
 */
export class NodeFsProvider implements FSProvider {
  async findFiles(pattern: string, exclude?: string): Promise<string[]> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { glob } = require('glob');
    const options: Record<string, unknown> = {};
    if (exclude) {
      options.ignore = exclude;
    }
    return glob(pattern, options);
  }

  async readFile(filePath: string): Promise<string> {
    return fs.readFileSync(filePath, 'utf-8');
  }

  async exists(filePath: string): Promise<boolean> {
    return fs.existsSync(filePath);
  }

  createWatcher(patterns: string[]): FSWatcher {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const chokidar = require('chokidar');
    const watcher = chokidar.watch(patterns, {
      ignored: /node_modules/,
      persistent: true,
      ignoreInitial: true,
    });

    const callbacks: {
      change: Array<(path: string) => void>;
      create: Array<(path: string) => void>;
      delete: Array<(path: string) => void>;
    } = { change: [], create: [], delete: [] };

    watcher.on('change', (p: string) => callbacks.change.forEach((cb) => cb(p)));
    watcher.on('add', (p: string) => callbacks.create.forEach((cb) => cb(p)));
    watcher.on('unlink', (p: string) => callbacks.delete.forEach((cb) => cb(p)));

    return {
      onDidChange(cb: (path: string) => void) {
        callbacks.change.push(cb);
      },
      onDidCreate(cb: (path: string) => void) {
        callbacks.create.push(cb);
      },
      onDidDelete(cb: (path: string) => void) {
        callbacks.delete.push(cb);
      },
      dispose() {
        watcher.close();
      },
    };
  }
}

/**
 * Default FS provider instance for backward compatibility.
 * Scanner and watcher can use this if no provider is injected.
 */
export const defaultFsProvider = new NodeFsProvider();
