/**
 * SARIF 2.1.0 serializer for 0xtools audit findings.
 *
 * Produces a valid SARIF log (https://docs.oasis-open.org/sarif/sarif/v2.1.0)
 * consumable by GitHub code-scanning and other CI tooling.
 *
 * This module is intentionally pure: no fs, no vscode, no side effects.
 * It accepts the same `AuditFinding` shape produced by the audit command and
 * returns a JSON-serializable plain object.
 */

/**
 * Uniform finding shape shared with the audit command.
 *
 * Re-declared (rather than imported) so this module stays free of CLI/runtime
 * dependencies and remains trivially testable in isolation.
 */
export interface SarifFinding {
  file: string;
  line: number;
  column?: number;
  code: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  message: string;
}

export interface ToSarifOptions {
  /** Absolute repo root; result URIs are made relative to it. */
  repoRoot?: string;
  /** Tool version string embedded in the driver. */
  toolVersion?: string;
}

const SARIF_SCHEMA =
  'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json';
const INFORMATION_URI = 'https://github.com/0xtools/0xtools';

/**
 * Map an audit severity to a SARIF result `level`.
 *   critical / high -> error
 *   medium          -> warning
 *   low             -> note
 */
export function severityToLevel(severity: SarifFinding['severity']): 'error' | 'warning' | 'note' {
  switch (severity) {
    case 'critical':
    case 'high':
      return 'error';
    case 'medium':
      return 'warning';
    case 'low':
      return 'note';
    default:
      return 'warning';
  }
}

/**
 * Convert a (possibly absolute, possibly windows-style) file path into a
 * forward-slash URI relative to `repoRoot` when provided.
 */
function toUri(file: string, repoRoot?: string): string {
  let rel = file;
  if (repoRoot) {
    const normalizedRoot = repoRoot.replace(/[/\\]+$/, '');
    // Use simple prefix stripping so we never depend on node's `path` here.
    if (file === normalizedRoot) {
      rel = '';
    } else if (file.startsWith(normalizedRoot + '/') || file.startsWith(normalizedRoot + '\\')) {
      rel = file.slice(normalizedRoot.length + 1);
    }
  }
  // Normalize separators and strip any leading "./".
  return rel.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Produce a short, human-friendly rule name from a code such as `tx-origin`.
 */
function ruleName(code: string): string {
  return code
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * Build a SARIF 2.1.0 log object from a list of findings.
 */
export function toSarif(findings: SarifFinding[], opts: ToSarifOptions = {}): object {
  const { repoRoot, toolVersion = '0.1.0' } = opts;

  // De-duplicate rule ids in first-seen order for stable output.
  const seen = new Set<string>();
  const rules: Array<{ id: string; name: string; shortDescription: { text: string } }> = [];
  for (const f of findings) {
    if (seen.has(f.code)) {
      continue;
    }
    seen.add(f.code);
    rules.push({
      id: f.code,
      name: ruleName(f.code),
      shortDescription: { text: ruleName(f.code) },
    });
  }

  const results = findings.map((f) => {
    const region: { startLine: number; startColumn?: number } = {
      startLine: f.line > 0 ? f.line : 1,
    };
    if (typeof f.column === 'number' && f.column > 0) {
      region.startColumn = f.column;
    }

    return {
      ruleId: f.code,
      level: severityToLevel(f.severity),
      message: { text: f.message },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: toUri(f.file, repoRoot) },
            region,
          },
        },
      ],
    };
  });

  return {
    $schema: SARIF_SCHEMA,
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: '0xtools',
            informationUri: INFORMATION_URI,
            version: toolVersion,
            rules,
          },
        },
        results,
      },
    ],
  };
}
