// Triggers a project build for Foundry / Hardhat. Streams stdout/stderr lines
// to a callback so the Deploy & Run panel can show progress. Resolves with the
// final exit code so the caller can refresh artifact discovery on success.

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export type ProjectKind = 'foundry' | 'hardhat' | 'solidity';

export interface BuildOptions {
  projectRoot: string;
  kind: ProjectKind;
  /** Called for each stdout/stderr line. */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  /** Hard wall-clock cap; defaults to 10 minutes. */
  timeoutMs?: number;
}

export interface BuildResult {
  ok: boolean;
  exitCode: number | null;
  command: string;
  durationMs: number;
  errorMessage?: string;
}

const DEFAULT_TIMEOUT = 10 * 60 * 1000;

function detectKind(projectRoot: string): ProjectKind {
  if (fs.existsSync(path.join(projectRoot, 'foundry.toml'))) return 'foundry';
  if (
    fs.existsSync(path.join(projectRoot, 'hardhat.config.js')) ||
    fs.existsSync(path.join(projectRoot, 'hardhat.config.ts'))
  ) {
    return 'hardhat';
  }
  return 'solidity';
}

function commandFor(kind: ProjectKind): { cmd: string; args: string[] } | null {
  if (kind === 'foundry') return { cmd: 'forge', args: ['build'] };
  if (kind === 'hardhat') return { cmd: 'npx', args: ['hardhat', 'compile'] };
  return null;
}

export function detectProjectKind(projectRoot: string): ProjectKind {
  return detectKind(projectRoot);
}

export async function runBuild(opts: BuildOptions): Promise<BuildResult> {
  const cmdSpec = commandFor(opts.kind);
  if (!cmdSpec) {
    return {
      ok: false,
      exitCode: null,
      command: '(no build tool)',
      durationMs: 0,
      errorMessage:
        'no foundry.toml or hardhat.config.{js,ts} found — cannot determine build command',
    };
  }

  const started = Date.now();
  const display = `${cmdSpec.cmd} ${cmdSpec.args.join(' ')}`;

  return new Promise<BuildResult>((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn(cmdSpec.cmd, cmdSpec.args, {
        cwd: opts.projectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      resolve({
        ok: false,
        exitCode: null,
        command: display,
        durationMs: Date.now() - started,
        errorMessage: `failed to spawn "${display}": ${message}`,
      });
      return;
    }

    let stdoutBuf = '';
    let stderrBuf = '';
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, 5000);
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT);

    function emitLines(buf: string, stream: 'stdout' | 'stderr'): string {
      const lines = buf.split('\n');
      const remainder = lines.pop() ?? '';
      for (const line of lines) {
        if (line.length > 0) opts.onLine?.(line, stream);
      }
      return remainder;
    }

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      stdoutBuf = emitLines(stdoutBuf, 'stdout');
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      stderrBuf = emitLines(stderrBuf, 'stderr');
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      resolve({
        ok: false,
        exitCode: null,
        command: display,
        durationMs: Date.now() - started,
        errorMessage: `process error: ${err.message}`,
      });
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (stdoutBuf.length > 0) opts.onLine?.(stdoutBuf, 'stdout');
      if (stderrBuf.length > 0) opts.onLine?.(stderrBuf, 'stderr');

      if (timedOut) {
        resolve({
          ok: false,
          exitCode: code,
          command: display,
          durationMs: Date.now() - started,
          errorMessage: 'build timed out',
        });
        return;
      }
      resolve({
        ok: code === 0,
        exitCode: code,
        command: display,
        durationMs: Date.now() - started,
        errorMessage:
          code === 0
            ? undefined
            : `${display} exited with code ${code}`,
      });
    });
  });
}
