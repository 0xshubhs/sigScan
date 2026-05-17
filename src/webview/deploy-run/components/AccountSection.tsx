import { useState } from 'react';
import type {
  AccountSelection,
  AnvilStatus,
  KeystoreInfo,
  NetworkConfig,
} from '../../../shared/deploy-run-protocol';
import type { Bus } from '../bus';

interface Props {
  network: NetworkConfig;
  anvil: AnvilStatus;
  keystores: KeystoreInfo[];
  selection: AccountSelection;
  bus: Bus;
}

function shorten(addr: string): string {
  return addr.length < 14 ? addr : `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function AccountSection({ network, anvil, keystores, selection, bus }: Props): JSX.Element {
  const [pwd, setPwd] = useState('');
  const [pwdFor, setPwdFor] = useState<string | null>(null);
  const [pwdBusy, setPwdBusy] = useState(false);
  const [pwdError, setPwdError] = useState<string | null>(null);

  const isAnvilMode = network.kind === 'anvil';

  async function selectAnvilAccount(index: number, address: string): Promise<void> {
    await bus.request({ kind: 'selectAccount', selection: { kind: 'anvil', index, address } });
  }

  async function selectKeystoreAccount(name: string, address: string): Promise<void> {
    await bus.request({ kind: 'selectAccount', selection: { kind: 'keystore', name, address } });
  }

  async function submitPassword(): Promise<void> {
    if (!pwdFor) return;
    setPwdBusy(true);
    setPwdError(null);
    try {
      const res = await bus.request({ kind: 'unlockKeystore', name: pwdFor, password: pwd });
      if (res.kind === 'error') {
        setPwdError(res.message);
        return;
      }
      const ks = keystores.find((k) => k.name === pwdFor);
      if (ks) await selectKeystoreAccount(ks.name, ks.address);
      setPwd('');
      setPwdFor(null);
    } finally {
      setPwdBusy(false);
    }
  }

  function refreshKeystores(): void {
    void bus.request({ kind: 'refreshKeystores' });
  }

  return (
    <section className="section">
      <h3 className="section-title">
        Account
        <span className="rule" />
        {!isAnvilMode && (
          <span className="right">
            <button className="vsc-button small" onClick={refreshKeystores}>↻ keystores</button>
          </span>
        )}
      </h3>

      {isAnvilMode && (
        <>
          {!anvil.running && <div className="muted small">Start Anvil to populate accounts.</div>}
          {anvil.running && anvil.accounts.length === 0 && (
            <div className="muted small">No accounts parsed from anvil output.</div>
          )}
          {anvil.running && anvil.accounts.length > 0 && (
            <select
              className="vsc-select mono"
              value={selection.kind === 'anvil' ? selection.index : 0}
              onChange={(e) => {
                const idx = Number(e.target.value);
                const acc = anvil.accounts[idx];
                if (acc) void selectAnvilAccount(idx, acc.address);
              }}
              title="Anvil pre-funded accounts"
            >
              {anvil.accounts.map((acc, idx) => (
                <option key={acc.address} value={idx}>
                  {`#${idx} · ${shorten(acc.address)} · ${acc.balance}`}
                </option>
              ))}
            </select>
          )}
        </>
      )}

      {!isAnvilMode && (
        <>
          {keystores.length === 0 && (
            <div className="muted small">
              No keystores in <span className="mono">~/.foundry/keystores/</span>. Create one with{' '}
              <span className="mono">cast wallet import &lt;name&gt; --interactive</span>.
            </div>
          )}
          {keystores.length > 0 && (
            <ul className="accounts-list">
              {keystores.map((ks) => {
                const isSel = selection.kind === 'keystore' && selection.name === ks.name;
                const balanceText = ks.balance?.formatted;
                const isFetching = ks.balanceStatus === 'fetching';
                const isError = ks.balanceStatus === 'error';
                return (
                  <li
                    key={ks.name}
                    className={`account-row ${isSel ? 'selected' : ''}`}
                    onClick={() => {
                      if (ks.unlocked) void selectKeystoreAccount(ks.name, ks.address);
                      else setPwdFor(ks.name);
                    }}
                  >
                    <span style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
                      <span title={ks.unlocked ? 'unlocked' : 'locked'} style={{ flexShrink: 0 }}>
                        {ks.unlocked ? '🔓' : '🔐'}
                      </span>
                      <code className="address" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {ks.name}
                      </code>
                      <span className="muted small" style={{ flexShrink: 0 }}>
                        {shorten(ks.address)}
                      </span>
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                      {balanceText && !isFetching && (
                        <span
                          className="balance-chip"
                          title={ks.balance ? `${ks.balance.wei} wei on chain ${ks.balance.chainId}` : undefined}
                        >
                          {balanceText}
                        </span>
                      )}
                      {isFetching && <span className="balance-chip fetching">···</span>}
                      {isError && (
                        <span
                          className="balance-chip error"
                          title={ks.balanceError ?? 'failed to fetch balance'}
                        >
                          !
                        </span>
                      )}
                      {isSel && (
                        <button
                          className="icon-btn"
                          title="Refresh balance"
                          onClick={(e) => {
                            e.stopPropagation();
                            void bus.request({ kind: 'refreshBalance' });
                          }}
                        >
                          ↻
                        </button>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {selection.kind === 'keystore' && (
            <div className="hint">
              Balance refreshes when you switch accounts or networks · click ↻ to force-refresh
            </div>
          )}
        </>
      )}

      {pwdFor && (
        <div className="modal-backdrop" onClick={() => !pwdBusy && setPwdFor(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h4>Unlock keystore: {pwdFor}</h4>
            <input
              type="password"
              className="vsc-input mono"
              placeholder="password"
              value={pwd}
              onChange={(e) => setPwd(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitPassword();
              }}
              autoFocus
              disabled={pwdBusy}
            />
            <div className="muted small">
              Password is kept in extension-host memory only — never written to disk, never sent back to the webview.
            </div>
            {pwdError && <div className="error-banner">⚠ {pwdError}</div>}
            <div className="button-row" style={{ justifyContent: 'flex-end' }}>
              <button className="vsc-button" disabled={pwdBusy} onClick={() => setPwdFor(null)}>
                Cancel
              </button>
              <button className="vsc-button primary" disabled={pwdBusy || !pwd} onClick={() => void submitPassword()}>
                {pwdBusy ? 'Unlocking…' : 'Unlock'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
