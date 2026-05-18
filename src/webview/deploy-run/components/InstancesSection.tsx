import { useState } from 'react';
import type { DeployedInstance, NetworkKind } from '../../../shared/deploy-run-protocol';
import type { Bus } from '../bus';
import { InstanceCard } from './InstanceCard';

interface Props {
  instances: DeployedInstance[];
  currentNetwork: NetworkKind;
  bus: Bus;
}

export function InstancesSection({ instances, currentNetwork, bus }: Props): JSX.Element {
  const [showOthers, setShowOthers] = useState(false);
  const onNetwork = instances.filter((i) => i.network === currentNetwork);
  const onOtherNetworks = instances.filter((i) => i.network !== currentNetwork);

  function handleRemoveAll(): void {
    // Plain confirm rather than a modal — destructive but reversible-enough
    // (re-deploy or re-add via At Address) that a one-click prompt is fine.
    if (instances.length === 0) return;
    const ok = window.confirm(
      `Remove all ${instances.length} stored instance(s)? This wipes them from this workspace.`
    );
    if (!ok) return;
    void bus.request({ kind: 'clearAllInstances' });
  }

  return (
    <section className="section">
      <h3 className="section-title">
        Deployed Contracts
        {onNetwork.length > 0 && <span className="count">· {onNetwork.length}</span>}
        {instances.length > 0 && (
          <span className="right">
            <button
              className="vsc-button small"
              onClick={handleRemoveAll}
              title="Remove every stored instance (across all networks)"
            >
              remove all
            </button>
          </span>
        )}
      </h3>

      {instances.length === 0 && <div className="muted small">No deployed contracts yet.</div>}
      {instances.length > 0 && onNetwork.length === 0 && !showOthers && (
        <div className="muted small">
          No contracts deployed on this network. Switch networks to see {onOtherNetworks.length} from
          other networks.
        </div>
      )}

      {onNetwork.map((inst) => (
        <InstanceCard
          key={inst.id}
          instance={inst}
          bus={bus}
          onRemove={() => void bus.request({ kind: 'removeInstance', instanceId: inst.id })}
        />
      ))}

      {onOtherNetworks.length > 0 && (
        <div className="other-networks">
          <button
            className="vsc-button small"
            onClick={() => setShowOthers((v) => !v)}
            title="Contracts you deployed on a different network — switch network to use them"
          >
            {showOthers ? 'hide' : 'show'} · {onOtherNetworks.length} on other networks
          </button>
          {showOthers &&
            onOtherNetworks.map((inst) => (
              <InstanceCard
                key={inst.id}
                instance={inst}
                bus={bus}
                onRemove={() => void bus.request({ kind: 'removeInstance', instanceId: inst.id })}
              />
            ))}
        </div>
      )}
    </section>
  );
}
