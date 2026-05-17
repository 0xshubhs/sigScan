// Typed message bus for the webview side. Wraps acquireVsCodeApi().
import type {
  DeployRunEvent,
  DeployRunRequest,
  DeployRunResponse,
  Envelope,
} from '../../shared/deploy-run-protocol';
import { isEvent, isResponse } from '../../shared/deploy-run-protocol';

declare global {
  interface Window {
    acquireVsCodeApi?: () => {
      postMessage: (msg: unknown) => void;
      getState: <T = unknown>() => T;
      setState: <T = unknown>(state: T) => void;
    };
  }
}

type Pending = (res: DeployRunResponse) => void;
type Listener = (evt: DeployRunEvent) => void;

export interface Bus {
  request<R extends DeployRunRequest>(req: R): Promise<DeployRunResponse>;
  on(listener: Listener): () => void;
}

function makeId(): string {
  // Webview-only IDs — collision safety is the only requirement.
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function createBus(): Bus {
  const vscode = window.acquireVsCodeApi?.();
  const pending = new Map<string, Pending>();
  const listeners = new Set<Listener>();

  window.addEventListener('message', (e: MessageEvent<Envelope>) => {
    const env = e.data;
    if (!env || typeof env !== 'object') return;
    if (isResponse(env)) {
      const cb = pending.get(env.id);
      if (cb) {
        pending.delete(env.id);
        cb(env.res);
      }
    } else if (isEvent(env)) {
      for (const l of listeners) l(env.evt);
    }
  });

  return {
    request<R extends DeployRunRequest>(req: R): Promise<DeployRunResponse> {
      return new Promise<DeployRunResponse>((resolve) => {
        const id = makeId();
        pending.set(id, resolve);
        vscode?.postMessage({ type: 'req', id, req } satisfies Envelope);
      });
    },
    on(listener: Listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
