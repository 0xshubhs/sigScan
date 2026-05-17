interface Props {
  running: boolean;
}

export function StatusDot({ running }: Props): JSX.Element {
  return (
    <span
      className={`status-dot ${running ? 'running' : 'idle'}`}
      aria-label={running ? 'Anvil running' : 'Anvil stopped'}
      title={running ? 'Anvil running' : 'Anvil stopped'}
    />
  );
}
