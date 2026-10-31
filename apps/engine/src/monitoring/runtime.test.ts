import { SecretRegistry, createLogger } from '@memebots/config';
import {
  acquireBotLeases,
  observeHealth,
  publishBotProgress,
  releaseBotLeases,
} from '@memebots/db';
import type { Pool } from '@memebots/db';
import type * as Db from '@memebots/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBotRuntime } from './runtime.js';

vi.mock('@memebots/db', async (original) => ({
  ...(await original<typeof Db>()),
  acquireBotLeases: vi.fn(),
  publishBotProgress: vi.fn(),
  releaseBotLeases: vi.fn(),
  observeHealth: vi.fn(),
}));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
const lease = { botId: 'bot-id', ownerId: 'owner-id', generation: '1' };
function setup(tick?: (botId: string, signal: AbortSignal) => Promise<void>) {
  const lines: string[] = [];
  vi.mocked(acquireBotLeases).mockResolvedValue([lease]);
  const query = vi.fn().mockResolvedValue({ rows: [{ mode: 'paper' }] });
  const runtime = createBotRuntime({
    pool: { query } as unknown as Pool,
    logger: createLogger(new SecretRegistry(), (line) => lines.push(line)),
    ...(tick ? { tick } : {}),
  });
  return { runtime, query, lines };
}

describe('engine managed progress wiring', () => {
  it('awaits real work before progress, rejects blind timer refresh, and releases on stop', async () => {
    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    const tick = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { runtime, query } = setup(tick);
    await runtime.start();
    await runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(query).toHaveBeenCalled();
    expect(publishBotProgress).not.toHaveBeenCalled();
    finish!();
    await vi.advanceTimersByTimeAsync(0);
    expect(publishBotProgress).toHaveBeenCalledWith(expect.anything(), lease, 'strategy');
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(5_000); // hung future strategy adapter reaches its deadline
    expect(publishBotProgress).toHaveBeenCalledTimes(1);
    await runtime.stop();
    await runtime.stop();
    expect(releaseBotLeases).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('quarantines a never-settling tick across multiple polls and stop/start while keeping shutdown bounded', async () => {
    vi.useFakeTimers();
    const tick = vi.fn(() => new Promise<void>(() => {}));
    const { runtime, query } = setup(tick);
    await runtime.start();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(1);
    expect(publishBotProgress).not.toHaveBeenCalled();
    await runtime.stop(); // Does not await the adapter which ignored its aborted signal.
    expect(releaseBotLeases).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await runtime.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(publishBotProgress).not.toHaveBeenCalled();
    await runtime.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('suppresses late completion after timeout and retries only once the underlying tick settles', async () => {
    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    const tick = vi
      .fn<(_: string, signal: AbortSignal) => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const { runtime } = setup(tick);
    await runtime.start();
    await vi.advanceTimersByTimeAsync(35_000);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(tick.mock.calls[0]![1].aborted).toBe(true);
    expect(publishBotProgress).not.toHaveBeenCalled();
    finish!();
    await vi.advanceTimersByTimeAsync(0);
    expect(publishBotProgress).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(publishBotProgress).toHaveBeenCalledTimes(1);
    await runtime.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('publishes honest scaffold progress and persists discovery failure/recovery independent of event frequency', async () => {
    vi.useFakeTimers();
    const { runtime } = setup();
    runtime.discoveryHealth(true, 'transport');
    runtime.discoveryHealth(true, 'rpc');
    runtime.discoveryHealth(false, 'transport'); // transport recovery cannot hide ongoing RPC failure
    await runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(publishBotProgress).toHaveBeenCalledWith(expect.anything(), lease, 'scaffold');
    expect(observeHealth).toHaveBeenLastCalledWith(
      expect.anything(),
      'discovery_unhealthy',
      'discovery',
      true,
      'rpc',
    );
    runtime.discoveryHealth(false, 'rpc');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(observeHealth).toHaveBeenLastCalledWith(
      expect.anything(),
      'discovery_unhealthy',
      'discovery',
      false,
      'rpc',
    );
    await runtime.stop();
  });

  it('does not heartbeat when DB reads fail or bot is disabled, and sanitizes failures', async () => {
    vi.useFakeTimers();
    const { runtime, query, lines } = setup();
    query.mockRejectedValueOnce(new Error('https://secret-provider.example'));
    await runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(publishBotProgress).not.toHaveBeenCalled();
    expect(lines.join()).not.toContain('secret-provider');
    query.mockResolvedValue({ rows: [{ mode: 'off' }] });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(publishBotProgress).not.toHaveBeenCalled();
    await runtime.stop();
  });
});
