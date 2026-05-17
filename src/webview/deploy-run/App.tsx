import { useEffect, useMemo, useState } from 'react';
import type {
  DeployRunResponse,
  DeployRunStatus,
  HardforkName,
  NetworkConfig,
} from '../../shared/deploy-run-protocol';
import { ALL_HARDFORKS } from '../../shared/deploy-run-protocol';
import type { Bus } from './bus';
import { NetworkSection } from './components/NetworkSection';
import { AccountSection } from './components/AccountSection';
import { ContractsSection } from './components/ContractsSection';
import { InstancesSection } from './components/InstancesSection';
import { ScriptsSection } from './components/ScriptsSection';
import { TxLogPanel } from './components/TxLogPanel';
import { StatusDot } from './components/StatusDot';

interface AppProps {
  bus: Bus;
}

function isStatus(r: DeployRunResponse): r is { kind: 'status'; payload: DeployRunStatus } {
  return r.kind === 'status';
}

type BusyKind = null | 'starting' | 'stopping' | 'restarting' | 'switching';

export function App({ bus }: AppProps): JSX.Element {
  const [status, setStatus] = useState<DeployRunStatus | null>(null);
  const [busy, setBusy] = useState<BusyKind>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    void bus.request({ kind: 'getStatus' }).then((res) => {
      if (isStatus(res)) setStatus(res.payload);
    });
    const off = bus.on((evt) => {
      if (evt.kind === 'statusChanged') setStatus(evt.payload);
      // txAppended is reflected via statusChanged after a tx; we don't need a separate handler
    });
    return () => {
      off();
    };
  }, [bus]);

  async function withBusy<T>(label: NonNullable<BusyKind>, fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(label);
    setErrorMsg(null);
    try {
      return await fn();
    } finally {
      setBusy(null);
    }
  }

  const handleStart = (hardfork: HardforkName) =>
    withBusy('starting', async () => {
      const res = await bus.request({ kind: 'startAnvil', hardfork });
      if (res.kind === 'error') setErrorMsg(res.message);
    });

  const handleStop = () =>
    withBusy('stopping', async () => {
      const res = await bus.request({ kind: 'stopAnvil' });
      if (res.kind === 'error') setErrorMsg(res.message);
    });

  const handleRestart = (hardfork: HardforkName) =>
    withBusy('restarting', async () => {
      const res = await bus.request({ kind: 'restartAnvil', hardfork });
      if (res.kind === 'error') setErrorMsg(res.message);
    });

  const handleSelectNetwork = (net: NetworkConfig) =>
    withBusy('switching', async () => {
      const res = await bus.request({ kind: 'selectNetwork', network: net });
      if (res.kind === 'error') setErrorMsg(res.message);
    });

  const handleRefreshContracts = () =>
    void bus.request({ kind: 'refreshContracts' });

  const canDeploy = useMemo<{ ok: boolean; reason: string | null }>(() => {
    if (!status) return { ok: false, reason: null };
    if (status.network.kind === 'anvil' && !status.anvil.running) {
      return { ok: false, reason: 'Start Anvil to enable deploy.' };
    }
    if (status.account.kind === 'none') {
      if (status.network.kind === 'anvil') return { ok: false, reason: 'No anvil account selected.' };
      return { ok: false, reason: 'Select and unlock a keystore to deploy on this network.' };
    }
    return { ok: true, reason: null };
  }, [status]);

  if (!status) {
    return (
      <div className="skel-stack" aria-busy="true">
        <div className="skel-bar t" />
        <div className="skel-bar s" />
        <div className="skel-bar b" />
        <div className="skel-bar t" />
        <div className="skel-bar s" />
        <div className="skel-bar b" />
        <div className="skel-bar xs" />
      </div>
    );
  }

  return (
    <div className="panel">
      <header className="panel-header">
        <span className="header-dot">
          <StatusDot running={status.network.kind === 'anvil' ? status.anvil.running : true} />
        </span>
        <span className="title">0xTOOLS</span>
        <span className="title title-accent">// Deploy &amp; Run</span>
      </header>

      <NetworkSection
        network={status.network}
        anvil={status.anvil}
        selectedHardfork={status.selectedHardfork}
        hardforks={ALL_HARDFORKS}
        busy={busy}
        onSelectNetwork={handleSelectNetwork}
        onStart={handleStart}
        onStop={handleStop}
        onRestart={handleRestart}
      />

      <AccountSection
        network={status.network}
        anvil={status.anvil}
        keystores={status.keystores}
        selection={status.account}
        bus={bus}
      />

      <ContractsSection
        contracts={status.contracts}
        projectGroups={status.projectGroups}
        buildingProjects={status.buildingProjects}
        bus={bus}
        canDeploy={canDeploy.ok}
        noDeployReason={canDeploy.reason}
        onRefresh={handleRefreshContracts}
      />

      <InstancesSection
        instances={status.instances}
        currentNetwork={status.network.kind}
        bus={bus}
      />

      <ScriptsSection
        scripts={status.scripts}
        bus={bus}
        canRun={canDeploy.ok}
        noRunReason={canDeploy.reason}
      />

      <TxLogPanel entries={status.txLog} bus={bus} />

      {errorMsg && <div className="error-banner">⚠ {errorMsg}</div>}

      <footer className="panel-footer">
        <span className="muted">
          {status.network.kind === 'anvil' && status.anvil.running ? `Connected · ${status.anvil.rpcUrl}` : status.network.name}
        </span>
      </footer>
    </div>
  );
}
