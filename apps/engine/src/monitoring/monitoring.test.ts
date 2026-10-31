import { Secret, SecretRegistry, createLogger } from '@memebots/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPollingLoop, withinDeadline } from './loop.js';
import { probeRpcHealth } from './rpc-health.js';

const endpoint = new Secret('https://rpc.example/private-provider-credential');
const response = (body: unknown) =>
  vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body)));
afterEach(() => {
  vi.useRealTimers();
});

describe('bounded RPC monitoring', () => {
  it('distinguishes disabled from health and validates the read-only response', async () => {
    const signal = new AbortController().signal;
    const fetcher = response({ jsonrpc: '2.0', id: 'health-1', result: 'ok' });
    expect(await probeRpcHealth(undefined, { signal, fetch: fetcher })).toEqual({
      status: 'disabled',
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await probeRpcHealth(endpoint, { signal, fetch: fetcher })).toEqual({
      status: 'healthy',
    });
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string).method).toBe('getHealth');
    for (const body of [
      null,
      [],
      {},
      { jsonrpc: '2.0', id: 'wrong', result: 'ok' },
      { jsonrpc: '2.0', id: 'health-1', result: 'behind' },
    ]) {
      expect(await probeRpcHealth(endpoint, { signal, fetch: response(body) })).toEqual({
        status: 'unhealthy',
        code: 'malformed',
      });
    }
    expect(
      await probeRpcHealth(endpoint, {
        signal,
        fetch: response({
          jsonrpc: '2.0',
          id: 'health-1',
          error: { message: 'private-provider-credential' },
        }),
      }),
    ).toEqual({ status: 'unhealthy', code: 'rpc' });
    expect(
      await probeRpcHealth(endpoint, {
        signal,
        fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 503 })),
      }),
    ).toEqual({ status: 'unhealthy', code: 'http' });
  });

  it('bounds fetch and body parsing, honors stop cancellation, and exposes no raw errors', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    const pending = probeRpcHealth(endpoint, { signal: controller.signal, fetch: fetcher });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await pending).toEqual({ status: 'unhealthy', code: 'timeout' });
    expect(fetcher.mock.calls[0]![1]!.signal?.aborted).toBe(true);
    const stopped = probeRpcHealth(endpoint, { signal: controller.signal, fetch: fetcher });
    controller.abort();
    expect(await stopped).toEqual({ status: 'unhealthy', code: 'unavailable' });
    const raw = await probeRpcHealth(endpoint, {
      signal: new AbortController().signal,
      fetch: vi.fn<typeof fetch>().mockRejectedValue(new Error('private-provider-credential')),
    });
    expect(JSON.stringify(raw)).not.toContain('private-provider-credential');
    expect(raw).toEqual({ status: 'unhealthy', code: 'transport' });
    const cancel = vi.fn();
    const bodyPending = probeRpcHealth(endpoint, {
      signal: new AbortController().signal,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel }))),
    });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await bodyPending).toEqual({ status: 'unhealthy', code: 'timeout' });
    expect(cancel).toHaveBeenCalled();
    for (const text of ['not valid JSON', 'x'.repeat(4_097)]) {
      expect(
        await probeRpcHealth(endpoint, {
          signal: new AbortController().signal,
          fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(text)),
        }),
      ).toEqual({ status: 'unhealthy', code: 'malformed' });
    }

    const logs: string[] = [];
    createLogger(new SecretRegistry(), (line) => logs.push(line)).error('monitoring_alert', raw);
    expect(logs.join()).not.toContain('private-provider-credential');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('independent serial polling', () => {
  it('starts immediately, polls at five seconds, prevents overlap and cleans up on repeated stop/start', async () => {
    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    const task = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const loop = createPollingLoop(task, 5_000, vi.fn());
    loop.start();
    loop.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(task).toHaveBeenCalledTimes(1);
    finish!();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(task).toHaveBeenCalledTimes(2);
    finish!();
    await loop.stop();
    await loop.stop();
    expect(vi.getTimerCount()).toBe(0);
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(task).toHaveBeenCalledTimes(3);
    finish!();
    await loop.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('deadline stops stalled work without resolving it as successful progress', async () => {
    vi.useFakeTimers();
    const result = withinDeadline(() => new Promise(() => {}), new AbortController().signal, 5_000);
    const assertion = expect(result).rejects.toThrow('OPERATION_CANCELLED');
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
});
