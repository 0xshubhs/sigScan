import { useState } from 'react';
import type { AnvilStatus, HardforkName, NetworkConfig } from '../../../shared/deploy-run-protocol';
import { BUILT_IN_NETWORKS, HARDFORK_NOTES, groupedNetworks } from '../../../shared/deploy-run-protocol';

interface Props {
  network: NetworkConfig;
  anvil: AnvilStatus;
  selectedHardfork: HardforkName;
  hardforks: ReadonlyArray<HardforkName>;
  busy: null | 'starting' | 'stopping' | 'restarting' | 'switching';
  onSelectNetwork: (net: NetworkConfig) => void | Promise<unknown>;
  onStart: (hardfork: HardforkName) => void | Promise<unknown>;
  onStop: () => void | Promise<unknown>;
  onRestart: (hardfork: HardforkName) => void | Promise<unknown>;
}

export function NetworkSection(props: Props): JSX.Element {
  const { network, anvil, selectedHardfork, hardforks, busy } = props;
  const [hardfork, setHardfork] = useState<HardforkName>(selectedHardfork);
  const isAnvil = network.kind === 'anvil';
  const running = anvil.running;
  const hardforkChanged = isAnvil && hardfork !== anvil.hardfork;

  function handleNetworkChange(e: React.ChangeEvent<HTMLSelectElement>): void {
    const next = BUILT_IN_NETWORKS.find((n) => n.kind === e.target.value);
    if (next) void props.onSelectNetwork(next);
  }

  return (
    <section className="section">
      <h3 className="section-title">
        Environment
        <span className="rule" />
      </h3>

      <div className="row">
        <select className="vsc-select" value={network.kind} onChange={handleNetworkChange} disabled={busy !== null}>
          {groupedNetworks().map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.networks.map((n) => (
                <option key={n.kind} value={n.kind}>
                  {n.name}{n.chainId ? ` · ${n.chainId}` : ''}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      {isAnvil && (
        <>
          <div className={`env-pill ${running ? 'on' : 'off'}`}>
            {running ? (
              <>
                <span className="status-dot running" />
                <span className="env-name">Anvil</span>
                <span className="env-meta">:{anvil.port ?? '—'} · chainId {anvil.chainId ?? '—'}</span>
              </>
            ) : (
              <>
                <span className="status-dot idle" />
                <span className="env-name">Anvil</span>
                <span className="env-meta">stopped</span>
              </>
            )}
          </div>

          <div className="row">
            <label className="row-label">Hardfork</label>
            <select
              className="vsc-select"
              value={hardfork}
              onChange={(e) => setHardfork(e.target.value as HardforkName)}
              disabled={busy !== null}
              title={HARDFORK_NOTES[hardfork]}
            >
              {hardforks.map((hf) => (
                <option key={hf} value={hf} title={HARDFORK_NOTES[hf]}>
                  {hf[0].toUpperCase() + hf.slice(1)}
                </option>
              ))}
            </select>
          </div>
          <div className="hint">{HARDFORK_NOTES[hardfork]}</div>

          <div className="button-row">
            {!running && (
              <button
                className="vsc-button primary cta"
                disabled={busy !== null}
                onClick={() => void props.onStart(hardfork)}
              >
                {busy === 'starting' ? 'Starting…' : '▶  Start Anvil'}
              </button>
            )}
            {running && (
              <>
                <button
                  className="vsc-button"
                  disabled={busy !== null || !hardforkChanged}
                  onClick={() => void props.onRestart(hardfork)}
                  title={hardforkChanged ? 'Restart anvil with the new hardfork' : 'Change hardfork to enable'}
                >
                  {busy === 'restarting' ? 'Restarting…' : '↻  Apply hardfork'}
                </button>
                <button className="vsc-button" disabled={busy !== null} onClick={() => void props.onStop()}>
                  {busy === 'stopping' ? 'Stopping…' : '■  Stop'}
                </button>
              </>
            )}
          </div>

          {running && anvil.rpcUrl && <div className="hint">{anvil.rpcUrl}</div>}
        </>
      )}

      {!isAnvil && (
        <>
          <div className="env-pill on">
            <span className="status-dot running" />
            <span className="env-name">{network.name}</span>
            {network.chainId && <span className="env-meta">chainId {network.chainId}</span>}
          </div>
          {network.rpcUrl && <div className="hint">{network.rpcUrl}</div>}
        </>
      )}
    </section>
  );
}
