import { useEffect, useMemo, useState } from 'react';
import type {
  AbiEntry,
  ContractSummary,
  ProjectGroup,
  ValueUnit,
} from '../../../shared/deploy-run-protocol';
import { valueToWei } from '../../../shared/deploy-run-protocol';
import { ContractGUI } from './ContractGUI';
import { ValueUI } from './ValueUI';
import { GasLimitUI } from './GasLimitUI';
import type { Bus } from '../bus';

interface Props {
  contracts: ContractSummary[];
  projectGroups: ProjectGroup[];
  buildingProjects: string[];
  bus: Bus;
  canDeploy: boolean;
  noDeployReason: string | null;
  onRefresh: () => void;
}

function findConstructor(abi: AbiEntry[]): AbiEntry {
  return (
    abi.find((e) => e.type === 'constructor') ?? {
      type: 'constructor',
      inputs: [],
      stateMutability: 'nonpayable',
    }
  );
}

function basenameOf(p: string): string {
  if (!p) return '/';
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function StateBadge({ state }: { state: ContractSummary['buildState'] }): JSX.Element {
  const labels: Record<ContractSummary['buildState'], { glyph: string; label: string; cls: string }> = {
    'not-built': { glyph: '○', label: 'not built', cls: 'badge-muted' },
    building: { glyph: '⏳', label: 'building', cls: 'badge-info' },
    built: { glyph: '✓', label: 'built', cls: 'badge-ok' },
    failed: { glyph: '✗', label: 'failed', cls: 'badge-err' },
  };
  const b = labels[state];
  return <span className={`build-badge ${b.cls}`} title={b.label}>{b.glyph}</span>;
}

export function ContractsSection(props: Props): JSX.Element {
  const { contracts, projectGroups, buildingProjects, bus, canDeploy, noDeployReason, onRefresh } = props;
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [openProjects, setOpenProjects] = useState<Set<string>>(new Set());
  const [openDirs, setOpenDirs] = useState<Set<string>>(new Set());
  const [value, setValue] = useState('0');
  const [unit, setUnit] = useState<ValueUnit>('wei');
  const [gasLimit, setGasLimit] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [atAddress, setAtAddress] = useState('');

  const builtContracts = useMemo(() => contracts.filter((c) => c.buildState === 'built'), [contracts]);

  useEffect(() => {
    // Default selection: first built contract (if any), else first overall.
    if (!selectedKey || !contracts.find((c) => c.key === selectedKey)) {
      const first = builtContracts[0] ?? contracts[0] ?? null;
      setSelectedKey(first?.key ?? null);
    }
  }, [contracts, builtContracts, selectedKey]);

  useEffect(() => {
    // Auto-open every project group on first render so users see what's there.
    if (openProjects.size === 0 && projectGroups.length > 0) {
      setOpenProjects(new Set(projectGroups.map((g) => g.projectRoot)));
    }
  }, [projectGroups, openProjects.size]);

  const selected = useMemo(
    () => contracts.find((c) => c.key === selectedKey) ?? null,
    [contracts, selectedKey]
  );
  const ctor = selected && selected.abi.length > 0 ? findConstructor(selected.abi) : null;
  const ctorIsPayable = !!ctor && (ctor.stateMutability === 'payable' || !!ctor.payable);

  // Auto-reset Value to 0 when switching contracts so a leftover value from a
  // previous payable deploy doesn't sink a non-payable constructor.
  useEffect(() => {
    setValue('0');
    setUnit('wei');
  }, [selectedKey]);

  async function handleDeploy(rawValues: string[]): Promise<void> {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      // Belt-and-braces: ignore Value field entirely when constructor is non-payable,
      // even if some stale value snuck in.
      const valueWei = ctorIsPayable ? valueToWei(value, unit).toString() : '0';
      const res = await bus.request({
        kind: 'deployContract',
        contractKey: selected.key,
        ctorArgsRaw: rawValues,
        valueWei: valueWei !== '0' ? valueWei : undefined,
        gasLimit: gasLimit ?? undefined,
      });
      if (res.kind === 'error') setError(res.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleAtAddress(): Promise<void> {
    if (!selected || !atAddress.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await bus.request({
        kind: 'loadAtAddress',
        contractKey: selected.key,
        address: atAddress.trim(),
      });
      if (res.kind === 'error') setError(res.message);
      else setAtAddress('');
    } finally {
      setBusy(false);
    }
  }

  function toggleProject(root: string): void {
    setOpenProjects((prev) => {
      const next = new Set(prev);
      if (next.has(root)) next.delete(root);
      else next.add(root);
      return next;
    });
  }

  function toggleDir(key: string): void {
    setOpenDirs((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function buildProject(root: string): void {
    void bus.request({ kind: 'buildProject', projectRoot: root });
  }

  function buildAll(): void {
    void bus.request({ kind: 'buildAll' });
  }

  const totalContracts = contracts.length;
  const totalBuilt = builtContracts.length;
  const anyBuilding = buildingProjects.length > 0;

  return (
    <section className="section">
      <h3 className="section-title">
        Contracts
        {totalContracts > 0 && (
          <span className="count">· {totalBuilt}/{totalContracts}</span>
        )}
        <span className="rule" />
        <span className="right">
          <button className="vsc-button small" onClick={onRefresh} title="Re-scan the workspace">scan</button>
          {totalContracts > 0 && totalBuilt < totalContracts && (
            <button className="vsc-button small primary" onClick={buildAll} disabled={anyBuilding}>
              {anyBuilding ? 'Building…' : 'Build All'}
            </button>
          )}
        </span>
      </h3>

      {totalContracts === 0 && (
        <div className="muted small">
          No <span className="mono">.sol</span> files found in the workspace. Open a folder containing Solidity sources.
        </div>
      )}

      {/* Project / directory tree */}
      {totalContracts > 0 && (
        <div className="contract-tree">
          {projectGroups.map((g) => {
            const projOpen = openProjects.has(g.projectRoot);
            return (
              <div key={g.projectRoot} className="proj-group">
                <div className="proj-header" onClick={() => toggleProject(g.projectRoot)}>
                  <span className="caret">{projOpen ? '▾' : '▸'}</span>
                  <span className="proj-name" title={g.projectRoot}>
                    {basenameOf(g.projectRoot)}
                  </span>
                  <span className="proj-tag">{g.projectType}</span>
                  <span style={{ marginLeft: 'auto' }} />
                  <span className="proj-count">{g.built}/{g.total}</span>
                  <button
                    className="vsc-button small"
                    disabled={g.isBuilding}
                    onClick={(e) => {
                      e.stopPropagation();
                      buildProject(g.projectRoot);
                    }}
                    title={g.projectType === 'foundry' ? 'forge build' : 'npx hardhat compile'}
                  >
                    {g.isBuilding ? '…' : 'build'}
                  </button>
                </div>

                {projOpen && g.byDirectory.map((d) => {
                  const dirKey = `${g.projectRoot}::${d.dir}`;
                  const dirOpen = openDirs.has(dirKey) || g.byDirectory.length <= 2;
                  return (
                    <div key={dirKey} className="dir-group">
                      <div className="dir-header" onClick={() => toggleDir(dirKey)}>
                        <span className="caret">{dirOpen ? '▾' : '▸'}</span>
                        <span>{d.dir || '(root)'}</span>
                        <span className="muted small">· {d.contracts.length}</span>
                      </div>
                      {dirOpen && (
                        <ul className="contract-list">
                          {d.contracts.map((c) => {
                            const isSel = c.key === selectedKey;
                            return (
                              <li
                                key={c.key}
                                className={`contract-row ${isSel ? 'selected' : ''}`}
                                title={c.lastError ?? c.sourcePath}
                                onClick={() => setSelectedKey(c.key)}
                              >
                                <StateBadge state={c.buildState} />
                                <span className="contract-name">{c.name}</span>
                                <span className="file-suffix">{c.file}</span>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}

      {/* Deploy form for the selected contract */}
      {selected && (
        <>
          <div className="selected-chip" title={selected.sourcePath}>
            <span className="selected-name">{selected.name}</span>
            <StateBadge state={selected.buildState} />
            <span className="selected-path">{selected.sourcePath}</span>
          </div>

          {selected.buildState !== 'built' && (
            <div className="muted small">
              {selected.buildState === 'building'
                ? 'Building…'
                : selected.buildState === 'failed'
                  ? `Build failed${selected.lastError ? `: ${selected.lastError}` : ''}`
                  : 'Build this project to enable deploy.'}
            </div>
          )}

          {selected.buildState === 'built' && (
            <>
              <ValueUI
                value={ctorIsPayable ? value : '0'}
                unit={unit}
                onChange={(v, u) => { setValue(v); setUnit(u); }}
                disabled={!ctorIsPayable}
                disabledReason={
                  ctor
                    ? 'constructor is non-payable — cannot send ETH'
                    : 'select a contract'
                }
              />
              <GasLimitUI value={gasLimit} onChange={setGasLimit} />

              {ctor && (
                <ContractGUI
                  funcAbi={ctor}
                  isDeploy
                  busy={busy}
                  buttonLabel="Deploy"
                  onSubmit={handleDeploy}
                />
              )}
              {!canDeploy && noDeployReason && (
                <div className="hint">{noDeployReason}</div>
              )}
            </>
          )}
        </>
      )}

      {/* At Address */}
      {selected && selected.buildState === 'built' && (
        <>
          <h3 className="section-title" style={{ marginTop: 4 }}>
            At Address<span className="rule" />
          </h3>
          <div className="row">
            <input
              type="text"
              className="vsc-input mono"
              placeholder="0x… (existing contract address)"
              value={atAddress}
              onChange={(e) => setAtAddress(e.target.value)}
              style={{ flex: 1 }}
            />
            <button
              className="vsc-button"
              disabled={!selected || !atAddress.trim() || busy}
              onClick={() => void handleAtAddress()}
            >
              Load
            </button>
          </div>
        </>
      )}

      {error && <div className="error-banner">{error}</div>}
    </section>
  );
}
