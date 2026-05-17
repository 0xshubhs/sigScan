import { EventsDecoder, type ReceiptLike } from '../events-decoder';
import type { CompiledContractsMap } from '../tx-helper';
import { AbiCoder, id } from 'ethers';

// Standard ERC-20 ABI subset (Transfer + Approval events)
const erc20Abi = [
  {
    type: 'event',
    name: 'Transfer',
    anonymous: false,
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Approval',
    anonymous: false,
    inputs: [
      { name: 'owner', type: 'address', indexed: true },
      { name: 'spender', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
];

const contracts: CompiledContractsMap = {
  'Token.sol': { Token: { abi: erc20Abi as never } },
};

const TRANSFER_TOPIC = id('Transfer(address,address,uint256)');
const APPROVAL_TOPIC = id('Approval(address,address,uint256)');

const FROM = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const TO = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

const padAddress = (a: string) => '0x' + a.replace('0x', '').padStart(64, '0').toLowerCase();
const encodeValue = (v: bigint) => new AbiCoder().encode(['uint256'], [v]);

function makeTransferLog(value: bigint): { address: string; topics: string[]; data: string } {
  return {
    address: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    topics: [TRANSFER_TOPIC, padAddress(FROM), padAddress(TO)],
    data: encodeValue(value),
  };
}

function makeReceipt(logs: Array<{ address: string; topics: string[]; data: string }>): ReceiptLike {
  return { logs };
}

describe('EventsDecoder · parseLogs', () => {
  it('skips when tx is a call (no state change → no logs)', (done) => {
    const decoder = new EventsDecoder({
      resolveReceipt: () => done.fail('should not resolve receipt for isCall'),
    });
    decoder.parseLogs({ isCall: true }, 'Token', contracts, (err, result) => {
      expect(err).toBeNull();
      expect(result).toEqual({ decoded: [], raw: [] });
      done();
    });
  });

  it('decodes a single Transfer log with indexed + non-indexed args', (done) => {
    const log = makeTransferLog(1234n);
    const decoder = new EventsDecoder({
      resolveReceipt: (_tx, cb) => cb(null, makeReceipt([log])),
    });
    decoder.parseLogs({}, 'Token', contracts, (err, result) => {
      expect(err).toBeNull();
      expect(result!.decoded).toHaveLength(1);
      const ev = result!.decoded[0];
      expect(ev.event).toBe('Transfer');
      expect(ev.from).toBe(log.address);
      expect(ev.args!.from).toBe(FROM);
      expect(ev.args!.to).toBe(TO);
      expect(ev.args!.value).toBe('1234');
      done();
    });
  });

  it('decodes multiple logs in order', (done) => {
    const logs = [makeTransferLog(1n), makeTransferLog(2n), makeTransferLog(3n)];
    const decoder = new EventsDecoder({
      resolveReceipt: (_tx, cb) => cb(null, makeReceipt(logs)),
    });
    decoder.parseLogs({}, 'Token', contracts, (err, result) => {
      expect(err).toBeNull();
      expect(result!.decoded.map((e) => e.args!.value)).toEqual(['1', '2', '3']);
      done();
    });
  });

  it('falls through raw when topic does not match any known event', (done) => {
    const log = {
      address: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
      topics: ['0x' + 'ab'.repeat(32)],
      data: '0x',
    };
    const decoder = new EventsDecoder({
      resolveReceipt: (_tx, cb) => cb(null, makeReceipt([log])),
    });
    decoder.parseLogs({}, 'Token', contracts, (err, result) => {
      expect(err).toBeNull();
      expect(result!.decoded).toHaveLength(1);
      const ev = result!.decoded[0];
      expect(ev.event).toBeUndefined();
      expect(ev.topics).toEqual(log.topics);
      expect(ev.data).toBe('0x');
      done();
    });
  });

  it('decodes a mix of Transfer and Approval', (done) => {
    const transferLog = makeTransferLog(10n);
    const approvalLog = {
      address: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
      topics: [APPROVAL_TOPIC, padAddress(FROM), padAddress(TO)],
      data: encodeValue(99n),
    };
    const decoder = new EventsDecoder({
      resolveReceipt: (_tx, cb) => cb(null, makeReceipt([transferLog, approvalLog])),
    });
    decoder.parseLogs({}, 'Token', contracts, (err, result) => {
      expect(err).toBeNull();
      expect(result!.decoded.map((e) => e.event)).toEqual(['Transfer', 'Approval']);
      expect(result!.decoded[1].args!.value).toBe('99');
      done();
    });
  });

  it('returns empty decoded when receipt has no logs', (done) => {
    const decoder = new EventsDecoder({
      resolveReceipt: (_tx, cb) => cb(null, {}),
    });
    decoder.parseLogs({}, 'Token', contracts, (err, result) => {
      expect(err).toBeNull();
      expect(result).toEqual({ decoded: [], raw: [] });
      done();
    });
  });

  it('propagates errors from resolveReceipt', (done) => {
    const decoder = new EventsDecoder({
      resolveReceipt: (_tx, cb) => cb('boom'),
    });
    decoder.parseLogs({}, 'Token', contracts, (err) => {
      expect(err).toBe('boom');
      done();
    });
  });
});
