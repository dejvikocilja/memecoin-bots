import { afterEach, describe, expect, it } from 'vitest';

import { localPeer } from './test-support/peer.js';
import { discoveryConfig } from './config.js';
import { DiscoveryTransport } from './transport.js';
import type { LogNotification, TransportState } from './transport.js';

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PROGRAM2 = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const signature = '2'.repeat(88);

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function notification(subscription: number, overrides: Record<string, unknown> = {}) {
  return {
    jsonrpc: '2.0',
    method: 'logsNotification',
    params: {
      subscription,
      result: {
        context: { slot: 42 },
        value: { signature, err: null, logs: ['valid fixture'], ...overrides },
      },
    },
  };
}

const config = () => ({
  ...discoveryConfig(),
  enabled: true,
  reconnectMinMs: 20,
  reconnectMaxMs: 30,
  ackTimeoutMs: 100,
  heartbeatTimeoutMs: 500,
});

describe('real WebSocket discovery transport', () => {
  it('ACKs by id, filters failed/malformed/foreign notifications, and restores all subscriptions after a drop', async () => {
    const peer = await localPeer();
    cleanup.push(() => peer.close());
    const states: TransportState[] = [];
    const logs: LogNotification[] = [];
    const transport = new DiscoveryTransport(
      { ...config(), wsUrl: peer.url },
      [PUMP, PROGRAM2],
      (value) => logs.push(value),
      (state) => states.push(state),
      undefined,
      () => 0,
    );
    cleanup.push(() => transport.stop());
    transport.start();
    await expect.poll(() => states.at(-1)).toBe('ready');
    expect(peer.requests.map(({ message }) => message.method)).toEqual([
      'logsSubscribe',
      'logsSubscribe',
      'slotSubscribe',
    ]);
    expect(peer.requests[0]?.message.params).toEqual([
      { mentions: [PUMP] },
      { commitment: 'confirmed' },
    ]);
    peer.send(0, '{broken');
    peer.send(0, notification(101, { err: { InstructionError: [0, 'error'] } }));
    peer.send(0, notification(101, { signature: 'invalid' }));
    peer.send(0, notification(999));
    peer.send(0, notification(101));
    await expect.poll(() => logs.length).toBe(1);
    expect(logs[0]).toMatchObject({ signature, slot: 42, logs: ['valid fixture'] });
    peer.sockets[0]!.destroy();
    await expect.poll(() => peer.sockets.length).toBe(2);
    await expect.poll(() => states.filter((state) => state === 'ready').length).toBe(2);
    expect(peer.requests.filter(({ connection }) => connection === 1)).toHaveLength(3);
    const id = Number(
      peer.requests.find(
        ({ connection, message }) => connection === 1 && message.method === 'logsSubscribe',
      )!.message.id,
    );
    peer.send(1, notification(id + 100));
    await expect.poll(() => logs.length).toBe(2);
    transport.stop();
    const count = peer.sockets.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(peer.sockets).toHaveLength(count);
    expect(states).toContain('reconnecting');
    expect(states.at(-1)).toBe('stopped');
  });

  it('reconnects after ACK timeout and cancels reconnect on stop', async () => {
    const peer = await localPeer(false);
    cleanup.push(() => peer.close());
    const transport = new DiscoveryTransport(
      { ...config(), wsUrl: peer.url, ackTimeoutMs: 30 },
      [PUMP],
      () => {},
      () => {},
      undefined,
      () => 0,
    );
    cleanup.push(() => transport.stop());
    transport.start();
    await expect.poll(() => peer.sockets.length).toBeGreaterThan(1);
    transport.stop();
    const count = peer.sockets.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(peer.sockets).toHaveLength(count);
  });

  it('reconnects after missing slot heartbeat despite successful ACKs', async () => {
    const peer = await localPeer();
    cleanup.push(() => peer.close());
    const transport = new DiscoveryTransport(
      { ...config(), wsUrl: peer.url, heartbeatTimeoutMs: 50 },
      [PUMP],
      () => {},
      () => {},
      undefined,
      () => 0,
    );
    cleanup.push(() => transport.stop());
    transport.start();
    await expect.poll(() => peer.sockets.length).toBeGreaterThan(1);
  });
});
