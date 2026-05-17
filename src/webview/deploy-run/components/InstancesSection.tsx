import type { DeployedInstance } from '../../../shared/deploy-run-protocol';
import type { Bus } from '../bus';
import { InstanceCard } from './InstanceCard';

interface Props {
  instances: DeployedInstance[];
  bus: Bus;
}

export function InstancesSection({ instances, bus }: Props): JSX.Element {
  return (
    <section className="section">
      <h3 className="section-title">Deployed Contracts ({instances.length})</h3>
      {instances.length === 0 && (
        <div className="muted small">No deployed contracts yet.</div>
      )}
      {instances.map((inst) => (
        <InstanceCard
          key={inst.id}
          instance={inst}
          bus={bus}
          onRemove={() => void bus.request({ kind: 'removeInstance', instanceId: inst.id })}
        />
      ))}
    </section>
  );
}
