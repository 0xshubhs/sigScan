/**
 * `0xtools audit` — run the security analyzers over a project and emit
 * human / JSON / SARIF output for CI and GitHub code-scanning.
 */

import type { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';

import { ReentrancyDetector } from '../features/reentrancy-detector';
import { UncheckedCallDetector } from '../features/unchecked-calls';
import { EventEmissionChecker } from '../features/event-checker';
import { AccessControlAnalyzer } from '../features/access-control';
import { CustomErrorDetector } from '../features/custom-error-suggestions';
import { NatspecChecker } from '../features/natspec-checker';
import { DangerousPatternDetector } from '../features/dangerous-patterns';
import { DeFiRiskDetector } from '../features/defi-risks';
import { MEVAnalyzer } from '../features/mev-analyzer';

import { parseSuppressions, isSuppressed } from '../features/suppressions';
import { loadBaseline, saveBaseline, isBaselined } from '../features/finding-baseline';

import { toSarif } from '../features/sarif';

/** Uniform finding type emitted by the audit command. */
export interface AuditFinding {
  file: string;
  line: number;
  column?: number;
  code: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  message: string;
}

export type Severity = AuditFinding['severity'];
export type FailOn = 'none' | 'low' | 'medium' | 'high';

export interface RunAuditOptions {
  /** Apply inline suppression comments (default true). */
  suppressions?: boolean;
  /** Filter out findings present in the baseline (default false). */
  baseline?: boolean;
  /** Write current findings as the new baseline, then return them (default false). */
  updateBaseline?: boolean;
}

/** Directories never worth auditing. */
const IGNORE_GLOBS = [
  '**/node_modules/**',
  '**/lib/**',
  '**/out/**',
  '**/cache/**',
  '**/artifacts/**',
  '**/.git/**',
];

/**
 * Shared, stateless analyzer instances.
 *
 * Each detector holds only readonly pattern config set at construction and its
 * `detect`/`analyze` methods are pure functions of the `source` string (no
 * per-file mutable instance state), so a single instance can be reused across
 * every file — matching the extension's singleton pattern and avoiding
 * re-allocating 9 objects (and their regex pattern arrays) per `.sol` file.
 */
const reentrancyDetector = new ReentrancyDetector();
const uncheckedCallDetector = new UncheckedCallDetector();
const eventEmissionChecker = new EventEmissionChecker();
const accessControlAnalyzer = new AccessControlAnalyzer();
const customErrorDetector = new CustomErrorDetector();
const natspecChecker = new NatspecChecker();
const dangerousPatternDetector = new DangerousPatternDetector();
const defiRiskDetector = new DeFiRiskDetector();
const mevAnalyzer = new MEVAnalyzer();

/** Ordered low -> high so we can compare with simple index math. */
const SEVERITY_ORDER: Severity[] = ['low', 'medium', 'high', 'critical'];

function severityRank(sev: Severity): number {
  return SEVERITY_ORDER.indexOf(sev);
}

/**
 * Normalize the looser analyzer severities (e.g. `info`) into our 4-level scale.
 */
function normalizeSeverity(sev: string | undefined): Severity {
  switch (sev) {
    case 'critical':
      return 'critical';
    case 'high':
      return 'high';
    case 'medium':
      return 'medium';
    case 'low':
    case 'info':
    default:
      return 'low';
  }
}

/**
 * Run every analyzer over a single file's source and return findings.
 * Pure (no fs) so it is unit-testable on a raw source string.
 */
export function analyzeSource(file: string, source: string): AuditFinding[] {
  const findings: AuditFinding[] = [];

  const push = (
    line: number,
    code: string,
    severity: string | undefined,
    message: string
  ): void => {
    findings.push({
      file,
      line,
      code,
      severity: normalizeSeverity(severity),
      message,
    });
  };

  // Reentrancy
  for (const w of reentrancyDetector.detect(source)) {
    push(w.line, 'reentrancy', w.severity, `${w.functionName}: ${w.description}`);
  }

  // Unchecked low-level calls
  for (const w of uncheckedCallDetector.detect(source)) {
    push(w.line, 'unchecked-call', 'medium', `${w.functionName}: ${w.description}`);
  }

  // Missing events on state-changing functions
  for (const w of eventEmissionChecker.detect(source)) {
    push(w.line, 'missing-event', 'low', `${w.functionName}: ${w.description}`);
  }

  // Access control
  for (const w of accessControlAnalyzer.detect(source)) {
    push(w.line, 'access-control', w.severity, `${w.functionName}: ${w.description}`);
  }

  // Custom error suggestions
  for (const w of customErrorDetector.detect(source)) {
    push(w.line, 'custom-error', 'low', `${w.functionName}: ${w.description}`);
  }

  // NatSpec completeness
  for (const w of natspecChecker.detect(source)) {
    push(w.line, 'natspec', 'low', `${w.functionName}: ${w.description}`);
  }

  // Dangerous patterns — code is the patternType (e.g. tx-origin)
  for (const w of dangerousPatternDetector.detect(source)) {
    push(w.line, w.patternType, w.severity, `${w.functionName}: ${w.description}`);
  }

  // DeFi risks — code is the riskType
  for (const w of defiRiskDetector.detect(source)) {
    push(w.line, w.riskType, w.severity, `${w.functionName}: ${w.description}`);
  }

  // MEV / front-running
  for (const w of mevAnalyzer.analyze(source)) {
    push(w.line, 'mev', w.severity, `${w.functionName}: ${w.description} (${w.mitigation})`);
  }

  return findings;
}

/**
 * Testable core of the audit command.
 *
 * Globs every `.sol` file under `rootPath` (excluding vendored/build dirs), runs
 * all analyzers, then applies inline suppressions and baseline filtering.
 */
export async function runAudit(
  rootPath: string,
  opts: RunAuditOptions = {}
): Promise<AuditFinding[]> {
  const applySuppressions = opts.suppressions !== false;

  const root = path.resolve(rootPath);
  const files = await glob('**/*.sol', {
    cwd: root,
    ignore: IGNORE_GLOBS,
    absolute: true,
    nodir: true,
  });
  files.sort();

  let findings: AuditFinding[] = [];

  for (const file of files) {
    let source: string;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    let fileFindings = analyzeSource(file, source);

    if (applySuppressions) {
      const scopes = parseSuppressions(source);
      fileFindings = fileFindings.filter((f) => !isSuppressed(f.code, f.line - 1, scopes));
    }

    findings.push(...fileFindings);
  }

  // --update-baseline: persist the (unsuppressed) findings, then return.
  if (opts.updateBaseline) {
    saveBaseline(
      root,
      findings.map((f) => ({ file: f.file, code: f.code, message: f.message, line: f.line }))
    );
    return findings;
  }

  // --baseline: drop anything already recorded in the baseline.
  if (opts.baseline) {
    const baseline = loadBaseline(root);
    findings = findings.filter(
      (f) =>
        !isBaselined({ file: f.file, code: f.code, message: f.message, line: f.line }, baseline)
    );
  }

  return findings;
}

/**
 * Decide the process exit code given a `--fail-on` threshold.
 * Returns 1 if any finding is at-or-above the threshold, else 0.
 * Pure so the decision can be unit-tested without touching process.exit.
 */
export function shouldFail(findings: AuditFinding[], failOn: FailOn): boolean {
  if (failOn === 'none') {
    return false;
  }
  const threshold = severityRank(failOn);
  return findings.some((f) => severityRank(f.severity) >= threshold);
}

/**
 * Render findings as a human-readable table grouped by file, with a summary.
 */
export function formatText(findings: AuditFinding[]): string {
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) {
    counts[f.severity]++;
  }

  if (findings.length === 0) {
    return 'No findings.\n\nSummary: 0 critical, 0 high, 0 medium, 0 low';
  }

  // Group by file, preserving first-seen order.
  const byFile = new Map<string, AuditFinding[]>();
  for (const f of findings) {
    const list = byFile.get(f.file);
    if (list) {
      list.push(f);
    } else {
      byFile.set(f.file, [f]);
    }
  }

  const lines: string[] = [];
  for (const [file, list] of byFile) {
    lines.push(file);
    const sorted = [...list].sort((a, b) => a.line - b.line || a.code.localeCompare(b.code));
    for (const f of sorted) {
      const loc = `${f.line}:${f.column ?? 0}`;
      lines.push(`  ${loc.padEnd(8)} ${f.severity.padEnd(8)} ${f.code.padEnd(20)} ${f.message}`);
    }
    lines.push('');
  }

  lines.push(
    `Summary: ${counts.critical} critical, ${counts.high} high, ${counts.medium} medium, ${counts.low} low`
  );
  return lines.join('\n');
}

interface AuditCliOptions {
  format: 'text' | 'json' | 'sarif';
  output?: string;
  failOn: FailOn;
  suppressions: boolean; // commander sets this false for --no-suppressions
  baseline?: boolean;
  updateBaseline?: boolean;
}

/**
 * Register the `audit` subcommand on a commander program.
 */
export function registerAuditCommand(program: Command): void {
  program
    .command('audit')
    .description('Run security analyzers over a project (human / JSON / SARIF output)')
    .argument('[path]', 'Project path to audit', process.cwd())
    .option('-f, --format <fmt>', 'Output format: text|json|sarif', 'text')
    .option('-o, --output <file>', 'Write output to file instead of stdout')
    .option(
      '--fail-on <severity>',
      'Exit 1 if any finding is at-or-above this severity: none|low|medium|high',
      'none'
    )
    .option('--no-suppressions', 'Ignore inline suppression comments')
    .option('--baseline', 'Filter out findings present in the baseline')
    .option('--update-baseline', 'Write current findings as the new baseline and exit 0')
    .action(async (auditPath: string, options: AuditCliOptions) => {
      try {
        const root = path.resolve(auditPath);

        const findings = await runAudit(root, {
          suppressions: options.suppressions,
          baseline: options.baseline,
          updateBaseline: options.updateBaseline,
        });

        if (options.updateBaseline) {
          const dest = options.output;
          const msg = `Baseline updated with ${findings.length} finding(s).`;
          if (dest) {
            fs.writeFileSync(dest, msg + '\n');
          } else {
            console.log(msg);
          }
          process.exit(0);
        }

        let out: string;
        switch (options.format) {
          case 'json':
            out = JSON.stringify(findings, null, 2);
            break;
          case 'sarif':
            out = JSON.stringify(toSarif(findings, { repoRoot: root }), null, 2);
            break;
          case 'text':
          default:
            out = formatText(findings);
            break;
        }

        if (options.output) {
          fs.writeFileSync(options.output, out + '\n');
        } else {
          console.log(out);
        }

        if (shouldFail(findings, options.failOn)) {
          process.exit(1);
        }
      } catch (error) {
        console.error('Error running audit:', error);
        process.exit(1);
      }
    });
}
