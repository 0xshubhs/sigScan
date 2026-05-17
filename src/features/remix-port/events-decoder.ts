// Ported from Remix: libs/remix-lib/src/execution/eventsDecoder.ts
// Modernized for ethers v6 — replaces v5 `_isBigNumber`/`_ethersType` checks with native bigint detection.

import { Interface, type EventFragment, type LogDescription } from 'ethers';
import { visitContracts, type CompiledContract, type CompiledContractsMap } from './tx-helper';

export interface RawLog {
  address: string;
  topics: string[];
  data: string;
}

export interface TxLike {
  isCall?: boolean;
}

export interface ReceiptLike {
  logs?: RawLog[];
}

export type ResolveReceipt = (
  tx: TxLike,
  cb: (err: Error | string | null, receipt?: ReceiptLike) => void
) => void;

export interface DecodedEvent {
  from: string;
  topic?: string;
  event?: string;
  args?: Record<string, unknown>;
  data?: string;
  topics?: string[];
}

export interface DecodedLogs {
  decoded: DecodedEvent[];
  raw: RawLog[];
}

interface EventAbiEntry {
  event: string;
  inputs: ReadonlyArray<{ name: string; type: string; [k: string]: unknown }>;
  fragment: EventFragment;
  iface: Interface;
}

type EventAbiMap = Record<string, EventAbiEntry>;
type EventsAbiMap = Record<string, EventAbiMap>;

export class EventsDecoder {
  private resolveReceipt: ResolveReceipt;

  constructor({ resolveReceipt }: { resolveReceipt: ResolveReceipt }) {
    this.resolveReceipt = resolveReceipt;
  }

  parseLogs(
    tx: TxLike,
    contractName: string,
    compiledContracts: CompiledContractsMap,
    cb: (err: Error | string | null, result?: DecodedLogs) => void
  ): void {
    if (tx.isCall) return cb(null, { decoded: [], raw: [] });
    this.resolveReceipt(tx, (error, receipt) => {
      if (error) return cb(error);
      this._decodeLogs(tx, receipt!, contractName, compiledContracts, cb);
    });
  }

  private _decodeLogs(
    tx: TxLike,
    receipt: ReceiptLike,
    contract: string,
    contracts: CompiledContractsMap,
    cb: (err: string | null, result?: DecodedLogs) => void
  ): void {
    if (!contract || !receipt) {
      return cb('cannot decode logs - contract or receipt not resolved ');
    }
    if (!receipt.logs) {
      return cb(null, { decoded: [], raw: [] });
    }
    this._decodeEvents(tx, receipt.logs, contract, contracts, cb);
  }

  private _eventABI(contract: CompiledContract): EventAbiMap {
    const eventABI: EventAbiMap = {};
    const iface = new Interface(contract.abi as never);
    const eventFragments = iface.fragments.filter((f) => f.type === 'event') as EventFragment[];
    for (const e of eventFragments) {
      const event = iface.getEvent(e.name);
      if (!event) continue;
      eventABI[e.topicHash.replace('0x', '')] = {
        event: event.name,
        inputs: event.inputs as never,
        fragment: event,
        iface,
      };
    }
    return eventABI;
  }

  private _eventsABI(compiledContracts: CompiledContractsMap): EventsAbiMap {
    const eventsABI: EventsAbiMap = {};
    visitContracts(compiledContracts, (contract) => {
      eventsABI[contract.name] = this._eventABI(contract.object);
    });
    return eventsABI;
  }

  private _event(hash: string, eventsABI: EventsAbiMap): EventAbiEntry[] {
    const matched: EventAbiEntry[] = [];
    for (const k in eventsABI) {
      if (eventsABI[k][hash]) {
        const entry = eventsABI[k][hash];
        // Remix quirk: 'function' type is encoded as a 24-byte selector — re-tag for decoding
        for (const input of entry.inputs) {
          if ((input as { type: string }).type === 'function') {
            (input as { type: string }).type = 'bytes24';
            (input as { baseType?: string }).baseType = 'bytes24';
          }
        }
        matched.push(entry);
      }
    }
    return matched;
  }

  private _stringifyValue(value: unknown): unknown {
    if (value === null || value === undefined) return ' - ';
    if (typeof value === 'bigint') return value.toString();
    if (Array.isArray(value)) return value.map((item) => this._stringifyValue(item));
    return value;
  }

  private _decodeEvents(
    _tx: TxLike,
    logs: RawLog[],
    _contractName: string,
    compiledContracts: CompiledContractsMap,
    cb: (err: string | null, result: DecodedLogs) => void
  ): void {
    const eventsABI = this._eventsABI(compiledContracts);
    const events: DecodedEvent[] = [];
    for (const log of logs) {
      const topicId = log.topics[0];
      if (!topicId) {
        events.push({ from: log.address, data: log.data, topics: log.topics });
        continue;
      }
      const matched = this._event(topicId.replace('0x', ''), eventsABI);
      let decoded = false;
      for (const eventAbi of matched) {
        try {
          const parsed: LogDescription | null = eventAbi.iface.parseLog(log);
          if (!parsed) continue;
          const args: Record<string, unknown> = {};
          for (let i = 0; i < eventAbi.inputs.length; i++) {
            const name = eventAbi.inputs[i].name || i.toString();
            args[name] = this._stringifyValue(parsed.args[i]);
          }
          events.push({ from: log.address, topic: topicId, event: eventAbi.event, args });
          decoded = true;
          break;
        } catch {
          continue;
        }
      }
      if (!decoded) {
        events.push({ from: log.address, data: log.data, topics: log.topics });
      }
    }
    cb(null, { decoded: events, raw: logs });
  }
}
