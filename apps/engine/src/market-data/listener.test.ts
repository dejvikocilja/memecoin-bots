import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Secret } from '@memebots/config';
import type { MarketDiscoveryEvent } from '@memebots/core';
import { afterEach, describe, expect, it } from 'vitest';

import { createDiscoveryBus } from './bus.js';
import { discoveryConfig } from './config.js';
import { PROGRAMS } from './decoder.js';
import { createDiscoveryListener } from './listener.js';
import type { RpcTransaction } from './rpc.js';
import { localPeer } from './test-support/peer.js';

const pump = PROGRAMS.find((program) => program.protocol === 'pump-fun')!.id;
const cpmm = PROGRAMS.find((program) => program.protocol === 'raydium-cpmm')!.id;
const signature = (number: number) => `${number}`.repeat(88);
const close: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const action of close.splice(0).reverse()) await action();
});

function completeLogs() {
  // Official CompleteEvent: discriminator,user,mint,bonding_curve,timestamp,quote_mint.
  const bytes = Buffer.concat([
    Buffer.from([95, 114, 97, 156, 212, 46, 152, 8]),
    Buffer.alloc(32, 1),
    Buffer.alloc(32, 2),
    Buffer.alloc(32, 3),
    Buffer.alloc(8),
    Buffer.alloc(32, 4),
  ]);
  return [
    `Program ${pump} invoke [1]`,
    `Program data: ${bytes.toString('base64')}`,
    `Program ${pump} success`,
  ];
}
const cpmmLogs = [
  `Program ${cpmm} invoke [1]`,
  'Program log: Instruction: Initialize',
  `Program ${cpmm} success`,
];
function encodeBase58(bytes: Buffer): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let number = BigInt(`0x${bytes.toString('hex')}`);
  let encoded = '';
  while (number > 0n) {
    encoded = alphabet[Number(number % 58n)]! + encoded;
    number /= 58n;
  }
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  return '1'.repeat(zeros) + encoded;
}
function transaction() {
  return {
    slot: 42,
    transaction: {
      message: {
        accountKeys: [
          ...Array.from({ length: 20 }, (_, index) => encodeBase58(Buffer.alloc(32, index + 1))),
          cpmm,
        ],
        instructions: [
          {
            programIdIndex: 20,
            accounts: Array.from({ length: 20 }, (_, index) => index),
            data: encodeBase58(
              Buffer.concat([
                createHash('sha256').update('global:initialize').digest().subarray(0, 8),
                Buffer.alloc(24),
              ]),
            ),
          },
        ],
      },
    },
    meta: { err: null, innerInstructions: [], logMessages: cpmmLogs },
  };
}
function send(
  peer: Awaited<ReturnType<typeof localPeer>>,
  connection: number,
  program: string,
  logs: string[],
  number = 2,
) {
  const request = peer.requests.find(
    (entry) =>
      entry.connection === connection && JSON.stringify(entry.message.params).includes(program),
  );
  if (!request) throw new Error('Missing subscription');
  peer.send(connection, {
    jsonrpc: '2.0',
    method: 'logsNotification',
    params: {
      subscription: Number(request.message.id) + 100,
      result: { context: { slot: 42 }, value: { err: null, signature: signature(number), logs } },
    },
  });
}
type Reply = { status?: number; headers?: Record<string, string>; body: unknown };
async function setup(handler: (attempt: number) => Reply | Promise<Reply>) {
  const peer = await localPeer();
  close.push(() => peer.close());
  let attempts = 0;
  const requestsAt: number[] = [];
  const rpc = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    const parsed = JSON.parse(body) as Record<string, unknown>;
    expect(parsed.method).toBe('getTransaction');
    expect(parsed.params).toMatchObject([
      expect.any(String),
      { commitment: 'confirmed', maxSupportedTransactionVersion: 0, encoding: 'json' },
    ]);
    requestsAt.push(Date.now());
    const value = await handler(++attempts);
    response.writeHead(value.status ?? 200, {
      'content-type': 'application/json',
      ...value.headers,
    });
    response.end(JSON.stringify(value.body));
  });
  await new Promise<void>((resolve, reject) =>
    rpc.once('error', reject).listen(0, '127.0.0.1', resolve),
  );
  close.push(() => new Promise<void>((resolve) => rpc.close(() => resolve())));
  const events: MarketDiscoveryEvent[] = [];
  const bus = createDiscoveryBus();
  bus.subscribe((event) => events.push(event));
  const config = {
    ...discoveryConfig(),
    enabled: true,
    wsUrl: new Secret(peer.url),
    rpcUrl: new Secret(`http://127.0.0.1:${(rpc.address() as AddressInfo).port}`),
    reconnectMinMs: 10,
    reconnectMaxMs: 20,
    heartbeatTimeoutMs: 10_000,
    requestsPerSecond: 100,
    rpcTimeoutMs: 100,
  };
  return {
    peer,
    events,
    bus,
    config,
    requestsAt,
    get attempts() {
      return attempts;
    },
  };
}

describe('discovery service over real WebSocket and HTTP', () => {
  it('publishes direct and enriched observations promptly, retries null, deduplicates across reconnect, and stops', async () => {
    const context = await setup((attempt) => ({
      body: { jsonrpc: '2.0', id: 1, result: attempt === 1 ? null : transaction() },
    }));
    const listener = createDiscoveryListener({ ...context, log: () => {}, random: () => 0 });
    close.push(() => listener.stop());
    listener.start();
    await expect.poll(() => listener.status().connection).toBe('ready');
    const started = Date.now();
    send(context.peer, 0, pump, completeLogs());
    send(context.peer, 0, cpmm, cpmmLogs, 3);
    send(context.peer, 0, cpmm, cpmmLogs, 3);
    await expect.poll(() => context.events.length).toBe(2);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(context.events.map((event) => event.kind)).toEqual([
      'bonding-curve-completed',
      'pool-created',
    ]);
    expect(context.attempts).toBe(2);
    context.peer.sockets[0]!.destroy();
    await expect.poll(() => context.peer.sockets.length).toBe(2);
    await expect.poll(() => listener.status().connection).toBe('ready');
    send(context.peer, 1, pump, completeLogs());
    send(context.peer, 1, cpmm, cpmmLogs, 3);
    await expect.poll(() => listener.status().duplicates).toBeGreaterThan(1);
    expect(context.events).toHaveLength(2);
    expect(listener.status()).toMatchObject({
      gapDetected: true,
      degraded: true,
      dropped: 0,
      exhausted: 0,
      unrecognized: 0,
      decodeFailures: 0,
    });
    listener.stop();
    expect(listener.status()).toMatchObject({ connection: 'stopped', inFlight: 0, queueDepth: 0 });
  });

  it('applies provider Retry-After globally to other queued signatures', async () => {
    const context = await setup((attempt) =>
      attempt === 1
        ? { status: 429, headers: { 'retry-after': '1' }, body: {} }
        : { body: { result: transaction() } },
    );
    const listener = createDiscoveryListener({
      ...context,
      config: { ...context.config, concurrency: 1 },
      log: () => {},
      random: () => 0,
    });
    close.push(() => listener.stop());
    listener.start();
    await expect.poll(() => listener.status().connection).toBe('ready');
    send(context.peer, 0, cpmm, cpmmLogs, 3);
    send(context.peer, 0, cpmm, cpmmLogs, 4);
    await expect.poll(() => context.attempts, { timeout: 3_000 }).toBeGreaterThanOrEqual(2);
    expect(context.requestsAt[1]! - context.requestsAt[0]!).toBeGreaterThanOrEqual(980);
    await expect.poll(() => context.events.length).toBe(2);
  });

  it('aborts in-flight work and suppresses old-generation results after restart', async () => {
    const context = await setup(() => ({ body: { result: transaction() } }));
    let oldSignal: AbortSignal | undefined;
    let resolveOld: ((value: RpcTransaction) => void) | undefined;
    let reads = 0;
    const listener = createDiscoveryListener({
      ...context,
      log: () => {},
      readTransaction: async (_url, _signature, signal) => {
        reads++;
        if (reads > 1) return transaction();
        oldSignal = signal;
        return new Promise<RpcTransaction>((resolve) => {
          resolveOld = resolve;
        });
      },
    });
    close.push(() => listener.stop());
    listener.start();
    await expect.poll(() => listener.status().connection).toBe('ready');
    send(context.peer, 0, cpmm, cpmmLogs, 3);
    await expect.poll(() => reads).toBe(1);
    listener.stop();
    expect(oldSignal?.aborted).toBe(true);
    listener.start();
    await expect.poll(() => context.peer.sockets.length).toBe(2);
    await expect.poll(() => listener.status().connection).toBe('ready');
    send(context.peer, 1, cpmm, cpmmLogs, 4);
    await expect.poll(() => context.events.length).toBe(1);
    resolveOld!(transaction());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(context.events).toHaveLength(1);
    expect(context.events[0]?.signature).toBe(signature(4));
    expect(listener.status()).toMatchObject({ inFlight: 0, queueDepth: 0, exhausted: 0 });
  });

  it('times out slow HTTP enrichment and aborts in-flight requests on stop', async () => {
    const context = await setup(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { body: { result: transaction() } };
    });
    const listener = createDiscoveryListener({
      ...context,
      config: { ...context.config, rpcTimeoutMs: 30, retryLimit: 0 },
      log: () => {},
    });
    close.push(() => listener.stop());
    listener.start();
    await expect.poll(() => listener.status().connection).toBe('ready');
    send(context.peer, 0, cpmm, cpmmLogs, 3);
    await expect.poll(() => listener.status().exhausted).toBe(1);
    expect(context.events).toHaveLength(0);
    send(context.peer, 0, cpmm, cpmmLogs, 4);
    await expect.poll(() => context.attempts).toBe(2);
    listener.stop();
    await new Promise((resolve) => setTimeout(resolve, 170));
    expect(context.events).toHaveLength(0);
    expect(listener.status()).toMatchObject({ connection: 'stopped', inFlight: 0, queueDepth: 0 });
  });

  it('surfaces overflow and retry exhaustion and cancels pending work on shutdown', async () => {
    const context = await setup(() => ({ body: { result: null } }));
    const listener = createDiscoveryListener({
      ...context,
      config: { ...context.config, queueLimit: 1, retryLimit: 0 },
      log: () => {},
    });
    close.push(() => listener.stop());
    listener.start();
    await expect.poll(() => listener.status().connection).toBe('ready');
    send(context.peer, 0, cpmm, cpmmLogs, 3);
    send(context.peer, 0, cpmm, cpmmLogs, 4);
    await expect.poll(() => listener.status().exhausted).toBe(1);
    expect(listener.status()).toMatchObject({ dropped: 1, degraded: true });
    listener.stop();
    const attempts = context.attempts;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(context.attempts).toBe(attempts);
  });
});
