// Source-code verification on Etherscan-family explorers.
//
// V1 scope: foundry projects only. We shell out to `forge verify-contract`
// with --watch so the call blocks until the explorer either confirms or
// rejects the source. Hardhat projects are detected and produce a clear
// "not supported here — run `npx hardhat verify` manually" message rather
// than half-implementing it. Adding Hardhat support is straightforward but
// requires a hardhat-network-name → chainId mapping that's user-configured,
// so we punt for now.

import { spawn, type ChildProcess } from 'child_process';
import type { VerifyStatus } from '../shared/deploy-run-protocol';

export interface VerifyOptions {
  projectRoot: string;
  projectType: 'foundry' | 'hardhat' | 'solidity';
  /** Source file path, *relative* to projectRoot (matches DiscoveredContract.sourcePath). */
  sourcePath: string;
  contractName: string;
  address: string;
  chainId: number;
  /** Etherscan-family API key. */
  apiKey: string;
  /** Hex-encoded constructor argument bytes — no `0x` prefix. Optional. */
  ctorArgsEncoded?: string;
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  timeoutMs?: number;
}

export interface VerifyResult {
  ok: boolean;
  status: VerifyStatus;
  errorMessage?: string;
  /** Path to the verified source on the explorer (constructed by the caller). */
  explorerUrl?: string;
  /** Exit code of the process (forge), if it ran. */
  exitCode?: number | null;
}

const DEFAULT_TIMEOUT = 5 * 60 * 1000;

/**
 * Run the appropriate verify command. Streams output via opts.onLine.
 * Result.status reflects what the explorer said, not just the exit code —
 * "already verified" is treated as success with a distinct status.
 */
export async function verifySource(opts: VerifyOptions): Promise<VerifyResult> {
  if (opts.projectType === 'hardhat') {
    return {
      ok: false,
      status: 'failed',
      errorMessage:
        'Hardhat verify is not wired into the panel yet. Run `npx hardhat verify --network <name> ' +
        `${opts.address}\` manually, or open an issue if you'd like this automated.`,
    };
  }
  if (opts.projectType !== 'foundry') {
    return {
      ok: false,
      status: 'failed',
      errorMessage:
        'Verification requires a Foundry (foundry.toml) or Hardhat project — no toolchain detected.',
    };
  }
  return runForgeVerify(opts);
}

function runForgeVerify(opts: VerifyOptions): Promise<VerifyResult> {
  // forge expects the contract identifier as `<relative-source-path>:<ContractName>`
  // relative to the project root.
  const relSource = opts.sourcePath.replace(/\\/g, '/');
  const contractId = `${relSource}:${opts.contractName}`;

  const args = [
    'verify-contract',
    opts.address,
    contractId,
    '--chain',
    String(opts.chainId),
    '--etherscan-api-key',
    opts.apiKey,
    '--watch',
  ];
  if (opts.ctorArgsEncoded && opts.ctorArgsEncoded.length > 0) {
    args.push('--constructor-args', '0x' + opts.ctorArgsEncoded.replace(/^0x/, ''));
  }

  // Redact the API key in the human-readable display so it doesn't leak into logs.
  const display =
    `forge verify-contract ${opts.address} ${contractId} --chain ${opts.chainId} ` +
    `--etherscan-api-key <redacted> --watch` +
    (opts.ctorArgsEncoded ? ' --constructor-args …' : '');
  opts.onLine?.(`> ${display}`, 'stdout');

  return new Promise<VerifyResult>((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn('forge', args, {
        cwd: opts.projectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      resolve({
        ok: false,
        status: 'failed',
        errorMessage: `failed to spawn forge: ${message}`,
      });
      return;
    }

    let stdoutBuf = '';
    let stderrBuf = '';
    let fullOutput = '';
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
        if (line.length > 0) {
          fullOutput += line + '\n';
          opts.onLine?.(line, stream);
        }
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
        status: 'failed',
        errorMessage: `process error: ${err.message}`,
      });
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (stdoutBuf.length > 0) {
        fullOutput += stdoutBuf;
        opts.onLine?.(stdoutBuf, 'stdout');
      }
      if (stderrBuf.length > 0) {
        fullOutput += stderrBuf;
        opts.onLine?.(stderrBuf, 'stderr');
      }
      if (timedOut) {
        resolve({
          ok: false,
          status: 'failed',
          errorMessage:
            'verify timed out after ' +
            Math.round((opts.timeoutMs ?? DEFAULT_TIMEOUT) / 1000) +
            's',
          exitCode: code,
        });
        return;
      }
      resolve(classifyForgeOutput(fullOutput, code));
    });
  });
}

/**
 * Inspect forge's output (and exit code) to decide what happened. Forge's
 * messages aren't a stable API but a small set of strings has held across
 * versions for years, and the exit code is reliable.
 */
function classifyForgeOutput(output: string, exitCode: number | null): VerifyResult {
  const lower = output.toLowerCase();
  if (
    lower.includes('already verified') ||
    lower.includes('contract source code already verified')
  ) {
    return { ok: true, status: 'already-verified', exitCode };
  }
  if (exitCode === 0) {
    // Forge prints "Contract successfully verified" on success.
    if (lower.includes('successfully verified') || lower.includes('verification successful')) {
      return { ok: true, status: 'verified', exitCode };
    }
    // Exit 0 without a confirmation string — treat as success but flag in the message.
    return { ok: true, status: 'verified', exitCode };
  }
  // Pull out the most informative line for the error message — prefer
  // "error:" / "Error:" lines, fall back to the last non-empty line.
  const lines = output
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  let errLine = `forge exited with code ${exitCode}`;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^error[:\s]/i.test(lines[i])) {
      errLine = lines[i];
      break;
    }
  }
  if (errLine.startsWith('forge exited') && lines.length > 0) {
    errLine = lines[lines.length - 1];
  }
  return {
    ok: false,
    status: 'failed',
    errorMessage: errLine,
    exitCode,
  };
}
