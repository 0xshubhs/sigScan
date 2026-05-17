import { useMemo, useState } from 'react';
import type { ScriptSummary } from '../../../shared/deploy-run-protocol';
import type { Bus } from '../bus';

interface Props {
  scripts: ScriptSummary[];
  bus: Bus;
  canRun: boolean;
  noRunReason: string | null;
}

function basenameOf(p: string): string {
  if (!p) return '/';
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function statusGlyph(s: ScriptSummary['runState']): { glyph: string; cls: string; title: string } {
  switch (s) {
    case 'idle':    return { glyph: '○', cls: 'badge-muted', title: 'Ready to run' };
    case 'running': return { glyph: '⏳', cls: 'badge-info',  title: 'Running…' };
    case 'success': return { glyph: '✓', cls: 'badge-ok',    title: 'Last run succeeded' };
    case 'error':   return { glyph: '✗', cls: 'badge-err',   title: 'Last run failed' };
  }
}

function fmtMs(ms: number | undefined): string {
  if (!ms) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
}

export function ScriptsSection({ scripts, bus, canRun, noRunReason }: Props): JSX.Element {
  const [openProjects, setOpenProjects] = useState<Set<string>>(new Set());

  const grouped = useMemo(() => {
    const m = new Map<string, ScriptSummary[]>();
    for (const s of scripts) {
      const list = m.get(s.projectRoot) ?? [];
      list.push(s);
      m.set(s.projectRoot, list);
    }
    return Array.from(m.entries())
      .map(([root, arr]) => ({ root, arr: arr.sort((a, b) => a.relPath.localeCompare(b.relPath)) }))
      .sort((a, b) => a.root.localeCompare(b.root));
  }, [scripts]);

  // Auto-open every project on first render
  if (openProjects.size === 0 && grouped.length > 0) {
    setOpenProjects(new Set(grouped.map((g) => g.root)));
  }

  if (scripts.length === 0) {
    return (
      <section className="section">
        <h3 className="section-title">Scripts</h3>
        <div className="muted small">
          No deploy scripts found. Foundry: add a <span className="mono">*.s.sol</span> file under{' '}
          <span className="mono">script/</span>. Hardhat: drop a file under <span className="mono">scripts/</span>{' '}
          or <span className="mono">deploy/</span>.
        </div>
      </section>
    );
  }

  function toggleProject(root: string): void {
    setOpenProjects((prev) => {
      const next = new Set(prev);
      if (next.has(root)) next.delete(root);
      else next.add(root);
      return next;
    });
  }

  function run(scriptKey: string): void {
    void bus.request({ kind: 'runScript', scriptKey });
  }

  const anyRunning = scripts.some((s) => s.runState === 'running');

  return (
    <section className="section">
      <h3 className="section-title">
        Scripts
        <span className="count">· {scripts.length}</span>
        <span className="right">
          <button
            className="vsc-button small"
            onClick={() => void bus.request({ kind: 'refreshScripts' })}
            disabled={anyRunning}
          >
            rescan
          </button>
        </span>
      </h3>

      <div className="scripts-tree">
        {grouped.map((g) => {
          const open = openProjects.has(g.root);
          return (
            <div key={g.root} className="proj-group">
              <div className="proj-header" onClick={() => toggleProject(g.root)}>
                <span className="caret">{open ? '▾' : '▸'}</span>
                <span className="proj-name" title={g.root}>{basenameOf(g.root)}</span>
                <span className="proj-tag">{g.arr[0].projectType}</span>
                <span className="proj-count" style={{ marginLeft: 'auto' }}>{g.arr.length}</span>
              </div>
              {open && (
                <ul className="script-list">
                  {g.arr.map((s) => {
                    const status = statusGlyph(s.runState);
                    const kindLabel =
                      s.kind === 'foundry' ? 'sol' : s.kind === 'hardhat-ts' ? 'ts' : 'js';
                    return (
                      <li key={s.key} className="script-row" title={s.relPath}>
                        <span className={`build-badge ${status.cls}`} title={status.title}>
                          {status.glyph}
                        </span>
                        <span className="script-name">{s.name}</span>
                        <span className="script-kind">{kindLabel}</span>
                        {s.lastDurationMs !== undefined && s.runState !== 'running' && (
                          <span className="script-duration">{fmtMs(s.lastDurationMs)}</span>
                        )}
                        <span style={{ marginLeft: 'auto' }} />
                        <button
                          className="vsc-button small primary"
                          disabled={s.runState === 'running' || !canRun}
                          title={!canRun && noRunReason ? noRunReason : 'Run this script on the active network'}
                          onClick={() => run(s.key)}
                        >
                          {s.runState === 'running' ? '…' : 'run'}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      {!canRun && noRunReason && (
        <div className="hint">{noRunReason}</div>
      )}
    </section>
  );
}
