import * as chokidar from 'chokidar';
import * as path from 'path';
import { EventEmitter } from 'events';
import { ProjectInfo, ContractInfo } from '../types';
import { SolidityParser } from './parser';

export interface WatcherEvents {
  fileChanged: (filePath: string, contractInfo: ContractInfo | null) => void;
  fileAdded: (filePath: string, contractInfo: ContractInfo | null) => void;
  fileRemoved: (filePath: string) => void;
  error: (error: Error) => void;
}

export class FileWatcher extends EventEmitter {
  private watcher: chokidar.FSWatcher | null = null;
  private parser: SolidityParser;
  private isWatching = false;

  constructor() {
    super();
    this.parser = new SolidityParser();
  }

  /**
   * Start watching for file changes
   */
  public startWatching(projectInfo: ProjectInfo): void {
    if (this.isWatching) {
      return;
    }

    const watchPaths = projectInfo.contractDirs.map((dir) =>
      path.join(projectInfo.rootPath, dir, '**/*.sol')
    );

    this.watcher = chokidar.watch(watchPaths, {
      ignored: /node_modules/,
      persistent: true,
      ignoreInitial: true,
    });

    this.watcher
      .on('add', (filePath: string) => {
        const contractInfo = this.parser.parseFile(filePath);
        this.emit('fileAdded', filePath, contractInfo);
      })
      .on('change', (filePath: string) => {
        const contractInfo = this.parser.parseFile(filePath);
        this.emit('fileChanged', filePath, contractInfo);
      })
      .on('unlink', (filePath: string) => {
        this.emit('fileRemoved', filePath);
      })
      .on('error', (error: Error) => {
        this.emit('error', error);
      });

    this.isWatching = true;
  }

  /**
   * Stop watching for file changes
   */
  public stopWatching(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.isWatching = false;
  }

  /**
   * Check if currently watching
   */
  public getWatchingStatus(): boolean {
    return this.isWatching;
  }

  /**
   * Get watched paths
   */
  public getWatchedPaths(): string[] {
    if (!this.watcher) {
      return [];
    }

    const watched = this.watcher.getWatched();
    const paths: string[] = [];

    Object.keys(watched).forEach((dir) => {
      watched[dir].forEach((file) => {
        if (file.endsWith('.sol')) {
          paths.push(path.join(dir, file));
        }
      });
    });

    return paths;
  }
}
