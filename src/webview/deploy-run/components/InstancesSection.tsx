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

  return (
    <section className="section">
      <h3 className="section-title">
        Deployed Contracts
        {onNetwork.length > 0 && <span className="count">· {onNetwork.length}</span>}
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
