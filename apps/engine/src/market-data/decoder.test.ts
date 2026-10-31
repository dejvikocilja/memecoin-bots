import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { decodeLogs, decodeTransaction, needsTransaction, PROGRAMS } from './decoder.js';
import meteora from './fixtures/meteora-v2-mainnet.json' with { type: 'json' };
import pump from './fixtures/pump-mainnet.json' with { type: 'json' };
import type { RpcInstruction, RpcTransaction } from './rpc.js';
import type { LogNotification } from './transport.js';

const signature = '2'.repeat(88);
const keyBytes = (number: number) => Buffer.alloc(32, number);
const key = (number: number) => base58(keyBytes(number));
const uint = (size: number, value = 0n) => {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i++) {
    bytes[i] = Number(value & 255n);
    value >>= 8n;
  }
  return bytes;
};
const string = (value: string) =>
  Buffer.concat([uint(4, BigInt(Buffer.byteLength(value))), Buffer.from(value)]);
const disc = (name: string) => createHash('sha256').update(name).digest().subarray(0, 8);
const event = (name: string, ...parts: Buffer[]) =>
  Buffer.concat([disc(`event:${name}`), ...parts]);
const program = (protocol: string) =>
  PROGRAMS.find((candidate) => candidate.protocol === protocol)!.id;
const notify = (protocol: string, data: Buffer): LogNotification => ({
  signature,
  slot: 123,
  logs: [
    `Program ${program(protocol)} invoke [1]`,
    `Program data: ${data.toString('base64')}`,
    `Program ${program(protocol)} success`,
  ],
});

// These fixtures are encoded independently from field order in the pinned upstream
// IDLs/Rust, rather than serializing the production decoder's schema table.
const create = () =>
  event(
    'CreateEvent',
    string('coin 🦀'),
    string('NON-SOL'),
    string('https://example.invalid/metadata'),
    keyBytes(1),
    keyBytes(2),
    keyBytes(3),
    keyBytes(4),
    uint(8, 1_793_472_713n),
    ...Array.from({ length: 4 }, () => uint(8, 2n ** 63n + 17n)),
    keyBytes(5),
    uint(1),
    uint(1, 1n),
    keyBytes(7),
    uint(8),
    uint(8),
    uint(1),
    uint(1),
  );
const complete = () =>
  event('CompleteEvent', keyBytes(3), keyBytes(1), keyBytes(2), uint(8), keyBytes(7));
const swapPool = () =>
  event(
    'CreatePoolEvent',
    uint(8),
    uint(2),
    keyBytes(4),
    keyBytes(1),
    keyBytes(7),
    uint(1, 9n),
    uint(1, 6n),
    ...Array.from({ length: 7 }, () => uint(8, 2n ** 60n)),
    uint(1),
    keyBytes(2),
    keyBytes(5),
    keyBytes(6),
    keyBytes(8),
    keyBytes(9),
    uint(1),
    uint(8),
    uint(1),
    uint(1),
  );
const clmmPool = () =>
  event(
    'PoolCreatedEvent',
    keyBytes(1),
    keyBytes(7),
    uint(2, 64n),
    keyBytes(2),
    uint(16, 2n ** 80n),
    uint(4),
    keyBytes(5),
    keyBytes(6),
  );
const dlmmPool = () => event('LbPairCreate', keyBytes(2), uint(2, 80n), keyBytes(1), keyBytes(7));
const dammV1Pool = (poolType = 1) =>
  event(
    'PoolCreated',
    keyBytes(5),
    keyBytes(1),
    keyBytes(7),
    uint(1, BigInt(poolType)),
    keyBytes(2),
  );
const dammV2Pool = (dynamic = false) =>
  event(
    'EvtInitializePool',
    keyBytes(2),
    keyBytes(1),
    keyBytes(7),
    keyBytes(4),
    keyBytes(5),
    keyBytes(6),
    Buffer.alloc(27),
    uint(2),
    uint(1),
    uint(1, dynamic ? 1n : 0n),
    ...(dynamic ? [uint(2), uint(16), uint(2), uint(2), uint(2), uint(4), uint(4)] : []),
    uint(16),
    uint(16),
    uint(1),
    uint(1),
    uint(16),
    uint(16),
    uint(8),
    uint(1),
    uint(1),
    uint(8),
    uint(8),
    uint(8),
    uint(8),
    uint(1),
  );

function transaction(
  protocol: string,
  data: Buffer,
  accountCount = 0,
  withCpi = false,
): { transaction: RpcTransaction; notification: LogNotification } {
  const id = program(protocol);
  const accountKeys = Array.from({ length: Math.max(accountCount, 10) }, (_, index) =>
    key(index + 1),
  );
  accountKeys.push(id);
  const instruction: RpcInstruction = {
    programIdIndex: accountKeys.length - 1,
    accounts: Array.from({ length: accountCount }, (_, index) => index),
    data: base58(data),
    stackHeight: 1,
  };
  const logs = [
    `Program ${id} invoke [1]`,
    `Program log: Instruction: ${protocol === 'raydium-cpmm' ? 'Initialize' : 'InitializeLbPair'}`,
  ];
  let innerInstructions: RpcTransaction['meta']['innerInstructions'];
  if (withCpi) {
    const encoded = Buffer.concat([Buffer.from('e445a52e51cb9a1d', 'hex'), data]);
    innerInstructions = [
      {
        index: 0,
        instructions: [{ ...instruction, data: base58(encoded), accounts: [0], stackHeight: 2 }],
      },
    ];
    logs.push(`Program ${id} invoke [2]`, `Program ${id} success`);
  }
  logs.push(`Program ${id} success`);
  const notification = { signature, slot: 123, logs };
  return {
    transaction: {
      slot: 123,
      transaction: {
        message: {
          accountKeys,
          instructions: [
            { ...instruction, data: withCpi ? base58(Buffer.alloc(8, 1)) : instruction.data },
          ],
        },
      },
      meta: { err: null, logMessages: logs, ...(innerInstructions ? { innerInstructions } : {}) },
    },
    notification,
  };
}

describe('pinned discovery protocol decoders', () => {
  it('replays two genuine confirmed Pump launches and ignores a fee-share transaction', () => {
    const decoded = pump.notifications.map((notification) => decodeLogs(notification));
    expect(decoded.map((events) => events.length)).toEqual([1, 0, 1]);
    expect(decoded[0]?.[0]).toMatchObject({
      kind: 'token-launched',
      mint: 'F8k81N5aNG23JVrJB4EU5pz1e2GNRbpCkxnJ6zBUpump',
      creator: '99tiwS2q7Rcyi7mT9ock1LjBsbBXTqRmu61f6zhQULvG',
      quoteMint: '11111111111111111111111111111111',
    });
    expect(decoded[2]?.[0]).toMatchObject({ mint: '27PBERdqRyMWxoYQ1H3WZmvJN5myczRzX964hWbJpump' });
    expect(pump.notifications.map((notification) => needsTransaction(notification.logs))).toEqual([
      false,
      false,
      false,
    ]);
  });

  it('replays genuine Meteora DAMM v2 event-CPI requiring transaction enrichment', () => {
    expect(decodeLogs(meteora.notification)).toEqual([]);
    expect(needsTransaction(meteora.notification.logs)).toBe(true);
    expect(decodeTransaction(meteora.transaction, meteora.notification)).toMatchObject([
      {
        kind: 'pool-created',
        source: 'EvtInitializePool',
        pool: 'APh4oF4TA2UG7bZtev5dyoyEGKPadrUijnffCBrtPnez',
        mintA: 'So11111111111111111111111111111111111111112',
        mintB: 'CwNJsae9hcq6f5tw7DkANmL8Jp6P2x7EacFhYR4JHyLi',
      },
    ]);
  });

  it('decodes variable-length Pump metadata, distinct creator, u64 reserves and non-SOL quote', () => {
    expect(decodeLogs(notify('pump-fun', create()))).toMatchObject([
      {
        kind: 'token-launched',
        source: 'CreateEvent',
        mint: key(1),
        bondingCurve: key(2),
        creator: key(4),
        quoteMint: key(7),
      },
    ]);
    expect(decodeLogs(notify('pump-fun', complete()))).toMatchObject([
      { kind: 'bonding-curve-completed', mint: key(1), bondingCurve: key(2), quoteMint: key(7) },
    ]);
  });

  it.each([
    ['pump-swap', swapPool],
    ['raydium-clmm', clmmPool],
    ['meteora-dlmm', dlmmPool],
    ['meteora-damm-v1', dammV1Pool],
    ['meteora-damm-v2', dammV2Pool],
  ] as const)('decodes the complete current %s pool event', (protocol, makeEvent) => {
    expect(decodeLogs(notify(protocol, makeEvent()))).toMatchObject([
      {
        kind: 'pool-created',
        protocol,
        pool: key(2),
        mintA: key(1),
        mintB: key(7),
        chain: 'solana',
        commitment: 'confirmed',
      },
    ]);
  });

  it('decodes both DAMM v2 dynamic-fee options and both DAMM v1 enum variants', () => {
    expect(decodeLogs(notify('meteora-damm-v2', dammV2Pool(true)))).toHaveLength(1);
    expect(decodeLogs(notify('meteora-damm-v1', dammV1Pool(0)))).toHaveLength(1);
    expect(decodeLogs(notify('meteora-damm-v1', dammV1Pool(2)))).toEqual([]);
  });

  it('decodes event-CPI for DLMM, including v0 loaded-address program and event authority', () => {
    const fixture = transaction('meteora-dlmm', dlmmPool(), 1, true);
    expect(decodeTransaction(fixture.transaction, fixture.notification)).toMatchObject([
      { pool: key(2), mintA: key(1), mintB: key(7) },
    ]);
    const keys = fixture.transaction.transaction.message.accountKeys;
    const v0 = {
      ...fixture.transaction,
      transaction: {
        message: { ...fixture.transaction.transaction.message, accountKeys: keys.slice(0, -1) },
      },
      meta: {
        ...fixture.transaction.meta,
        loadedAddresses: { writable: [], readonly: [program('meteora-dlmm')] },
      },
    };
    expect(decodeTransaction(v0, fixture.notification)).toHaveLength(1);
  });

  it('decodes both exact CPMM initializer layouts and the legacy AMM v4 Initialize2', () => {
    const cpmm = transaction(
      'raydium-cpmm',
      Buffer.concat([disc('global:initialize'), uint(8), uint(8), uint(8)]),
      20,
    );
    expect(decodeTransaction(cpmm.transaction, cpmm.notification)).toMatchObject([
      { source: 'initialize', pool: key(4), mintA: key(5), mintB: key(6) },
    ]);
    const permission = transaction(
      'raydium-cpmm',
      Buffer.concat([
        disc('global:initialize_with_permission'),
        uint(8),
        uint(8),
        uint(8),
        uint(1, 2n),
      ]),
      21,
    );
    expect(decodeTransaction(permission.transaction, permission.notification)).toMatchObject([
      { source: 'initialize_with_permission', pool: key(5), mintA: key(6), mintB: key(7) },
    ]);
    const legacy = transaction(
      'raydium-amm-v4',
      Buffer.concat([uint(1, 1n), uint(1, 254n), uint(8), uint(8), uint(8)]),
      21,
    );
    expect(decodeTransaction(legacy.transaction, legacy.notification)).toMatchObject([
      { source: 'Initialize2', pool: key(5), mintA: key(9), mintB: key(10) },
    ]);
  });

  it('requires valid full event/instruction bytes and account indexes', () => {
    for (const data of [
      create().subarray(0, -1),
      Buffer.concat([create(), uint(1)]),
      Buffer.alloc(8),
      Buffer.from([255]),
    ])
      expect(decodeLogs(notify('pump-fun', data))).toEqual([]);
    const fixture = transaction(
      'raydium-cpmm',
      Buffer.concat([disc('global:initialize'), uint(8), uint(8), uint(8)]),
      20,
    );
    const instruction = fixture.transaction.transaction.message.instructions[0]!;
    const invalid = {
      ...fixture.transaction,
      transaction: {
        message: {
          ...fixture.transaction.transaction.message,
          instructions: [{ ...instruction, accounts: [999, ...instruction.accounts.slice(1)] }],
        },
      },
    };
    expect(decodeTransaction(invalid, fixture.notification)).toEqual([]);
    const short = transaction(
      'raydium-cpmm',
      Buffer.concat([disc('global:initialize'), uint(8), uint(8), uint(8)]),
      19,
    );
    expect(decodeTransaction(short.transaction, short.notification)).toEqual([]);
    const badEnum = transaction(
      'raydium-cpmm',
      Buffer.concat([
        disc('global:initialize_with_permission'),
        uint(8),
        uint(8),
        uint(8),
        uint(1, 3n),
      ]),
      21,
    );
    expect(decodeTransaction(badEnum.transaction, badEnum.notification)).toEqual([]);
  });

  it('rejects foreign-program spoofed payloads/hints, truncated frames, and caught failed CPI', () => {
    const id = program('pump-fun');
    const foreign = key(19);
    const notification = notify('pump-fun', create());
    expect(
      decodeLogs({
        ...notification,
        logs: [
          `Program ${id} invoke [1]`,
          `Program ${foreign} invoke [2]`,
          `Program log: Instruction: CreateV2`,
          `Program data: ${create().toString('base64')}`,
          `Program ${foreign} success`,
          `Program ${id} success`,
        ],
      }),
    ).toEqual([]);
    expect(
      needsTransaction([
        `Program ${foreign} invoke [1]`,
        'Program log: Instruction: InitializeLbPair',
        `Program ${foreign} success`,
      ]),
    ).toBe(false);
    expect(decodeLogs({ ...notification, logs: notification.logs.slice(0, -1) })).toEqual([]);
    expect(
      decodeLogs({
        ...notification,
        logs: [
          `Program ${foreign} invoke [1]`,
          ...notification.logs.map((line) => line.replace('invoke [1]', 'invoke [2]')).slice(0, -1),
          `Program ${id} failed: custom program error: 0x1`,
          `Program ${foreign} success`,
        ],
      }),
    ).toEqual([]);
    const fixture = transaction('meteora-dlmm', dlmmPool(), 1, true);
    const failedLogs = [
      `Program ${foreign} invoke [1]`,
      ...fixture.notification.logs
        .map((line) => line.replace('invoke [2]', 'invoke [3]').replace('invoke [1]', 'invoke [2]'))
        .slice(0, -1),
      `Program ${program('meteora-dlmm')} failed: custom program error: 0x1`,
      `Program ${foreign} success`,
    ];
    expect(
      decodeTransaction(
        { ...fixture.transaction, meta: { ...fixture.transaction.meta, logMessages: failedLogs } },
        { ...fixture.notification, logs: failedLogs },
      ),
    ).toEqual([]);
    expect(
      decodeTransaction(
        {
          ...fixture.transaction,
          meta: { ...fixture.transaction.meta, err: { InstructionError: [0, 'Custom'] } },
        },
        fixture.notification,
      ),
    ).toEqual([]);
  });

  it('keeps event-CPI only when every invocation ancestor commits, even if the wrapper catches failure', () => {
    const fixture = transaction('meteora-dlmm', dlmmPool(), 1, true);
    const target = program('meteora-dlmm');
    const wrapper = key(29);
    const keys = [...fixture.transaction.transaction.message.accountKeys, wrapper];
    const createInstruction = {
      ...fixture.transaction.transaction.message.instructions[0]!,
      stackHeight: 2,
    };
    const emitInstruction = {
      ...fixture.transaction.meta.innerInstructions![0]!.instructions[0]!,
      stackHeight: 3,
    };
    const wrapperInstruction = {
      programIdIndex: keys.length - 1,
      accounts: [],
      data: '1',
      stackHeight: 1,
    };
    const logs = [
      `Program ${wrapper} invoke [1]`,
      `Program ${target} invoke [2]`,
      'Program log: Instruction: InitializeLbPair',
      `Program ${target} invoke [3]`,
      `Program ${target} success`,
      `Program ${target} success`,
      `Program ${wrapper} success`,
    ];
    const nested: RpcTransaction = {
      ...fixture.transaction,
      transaction: { message: { accountKeys: keys, instructions: [wrapperInstruction] } },
      meta: {
        err: null,
        logMessages: logs,
        innerInstructions: [{ index: 0, instructions: [createInstruction, emitInstruction] }],
      },
    };
    expect(decodeTransaction(nested, fixture.notification)).toHaveLength(1);
    const failed = [...logs];
    failed[5] = `Program ${target} failed: custom program error: 0x1`;
    expect(
      decodeTransaction(
        { ...nested, meta: { ...nested.meta, logMessages: failed } },
        fixture.notification,
      ),
    ).toEqual([]);
  });

  it('surfaces known event schema drift without treating unknown swap events as malformed', () => {
    let malformed = 0;
    expect(decodeLogs(notify('pump-fun', complete().subarray(0, -1)), () => malformed++)).toEqual(
      [],
    );
    expect(malformed).toBe(1);
    expect(decodeLogs(notify('pump-fun', event('TradeEvent', uint(8))), () => malformed++)).toEqual(
      [],
    );
    expect(malformed).toBe(1);
  });

  it('coalesces repeated log payloads and preserves separate pools within one signature', () => {
    const first = notify('meteora-dlmm', dlmmPool());
    const secondData = event(
      'LbPairCreate',
      keyBytes(9),
      uint(2),
      keyBytes(1),
      keyBytes(7),
    ).toString('base64');
    const logs = [
      first.logs[0]!,
      first.logs[1]!,
      first.logs[1]!,
      `Program data: ${secondData}`,
      first.logs[2]!,
    ];
    const decoded = decodeLogs({ ...first, logs });
    expect(decoded).toHaveLength(2);
    expect(decoded[0]?.id).not.toBe(decoded[1]?.id);
  });

  it('only requests transaction data for supported successful initialization variants', () => {
    for (const definition of PROGRAMS)
      for (const hint of definition.initializationHints) {
        const logs = [
          `Program ${definition.id} invoke [1]`,
          `Program log: Instruction: ${hint}`,
          `Program ${definition.id} success`,
        ];
        expect(needsTransaction(logs)).toBe(true);
        expect(
          needsTransaction(logs.map((line) => line.replace(' success', ' failed: invalid'))),
        ).toBe(false);
      }
    expect(
      needsTransaction([
        `Program ${program('raydium-amm-v4')} invoke [1]`,
        'Program log: initialize2: InitializeInstruction2 { nonce: 254 }',
        `Program ${program('raydium-amm-v4')} success`,
      ]),
    ).toBe(true);
    expect(
      needsTransaction([
        `Program ${program('meteora-dlmm')} invoke [1]`,
        'Program log: Instruction: Swap',
        `Program ${program('meteora-dlmm')} success`,
      ]),
    ).toBe(false);
  });
});

// Independent fixture-only base58 encoder, using the standard integer representation.
function base58(bytes: Buffer): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = bytes.reduce((total, byte) => total * 256n + BigInt(byte), 0n);
  const digits: string[] = [];
  while (value) {
    digits.push(alphabet[Number(value % 58n)]!);
    value /= 58n;
  }
  let leading = 0;
  for (const byte of bytes) {
    if (byte !== 0) break;
    leading++;
  }
  return '1'.repeat(leading) + digits.reverse().join('');
}
