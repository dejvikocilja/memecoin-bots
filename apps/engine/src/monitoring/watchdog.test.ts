import { Secret, SecretRegistry, createLogger } from '@memebots/config';
import { observeHealth, pollBotAlerts } from '@memebots/db';
import type { Queryable } from '@memebots/db';
import { afterEach, expect, it, vi } from 'vitest';

import { createWatchdog } from './watchdog.js';

vi.mock('@memebots/db', () => ({
  MONITOR_INTERVAL_MS: 5_000,
  observeHealth: vi.fn(),
  pollBotAlerts: vi.fn(),
}));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it('continues independent bot scans through RPC timeout and cancels/cleans up on stop', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
  const watchdog = createWatchdog({
    db: {} as Queryable,
    logger: createLogger(new SecretRegistry(), () => {}),
    endpoint: new Secret('https://rpc.example/secret'),
    fetch: fetcher,
  });
  watchdog.start();
  watchdog.start();
  await vi.advanceTimersByTimeAsync(15_000);
  expect(pollBotAlerts).toHaveBeenCalledTimes(4);
  expect(observeHealth).toHaveBeenCalledWith(
    expect.anything(),
    'rpc_unhealthy',
    'solana',
    true,
    'timeout',
  );
  await watchdog.stop();
  await watchdog.stop();
  expect(fetcher.mock.calls.at(-1)![1]!.signal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
