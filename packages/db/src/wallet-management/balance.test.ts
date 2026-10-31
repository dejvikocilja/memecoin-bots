import { describe, expect, it, vi } from 'vitest';
import { Secret } from '@memebots/config';
import { readWalletBalance } from './balance.js';
const address = 'So11111111111111111111111111111111111111112';
const endpoint = new Secret('https://example.invalid/?credential=synthetic-private-provider-784');
const response = (value: unknown) => new Response(JSON.stringify(value));
const valid = (balance: unknown) => ({
  jsonrpc: '2.0',
  id: 1,
  result: { context: { slot: 42 }, value: balance },
});
describe('read-only wallet balance', () => {
  it('uses confirmed getBalance only and returns exact bigint at safe JSON boundary', async () => {
    const fetcher = vi.fn(async () => response(valid(Number.MAX_SAFE_INTEGER)));
    const result = await readWalletBalance(endpoint, address, { fetch: fetcher });
    expect(result.balanceLamports).toBe(BigInt(Number.MAX_SAFE_INTEGER));
    expect(result.slot).toBe(42);
    const request = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(request[1].body as string)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'getBalance',
      params: [address, { commitment: 'confirmed' }],
    });
  });
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '100', null])(
    'rejects unsafe/malformed amount %s',
    async (balance) => {
      await expect(
        readWalletBalance(endpoint, address, { fetch: async () => response(valid(balance)) }),
      ).rejects.toThrow('BALANCE_UNAVAILABLE');
    },
  );
  it.each([
    { ...valid(1), id: 2 },
    { ...valid(1), error: { message: 'secret' } },
    { jsonrpc: '2.0', id: 1, result: { context: { slot: -1 }, value: 1 } },
    {},
  ])('rejects malformed RPC envelope', async (body) => {
    await expect(
      readWalletBalance(endpoint, address, { fetch: async () => response(body) }),
    ).rejects.toThrow('BALANCE_UNAVAILABLE');
  });
  it('bounds body and redacts thrown provider errors', async () => {
    await expect(
      readWalletBalance(endpoint, address, { fetch: async () => new Response('a'.repeat(66_000)) }),
    ).rejects.toThrow('Wallet operation failed: BALANCE_UNAVAILABLE.');
    await expect(
      readWalletBalance(endpoint, address, {
        fetch: async () => {
          throw new Error(endpoint.reveal());
        },
      }),
    ).rejects.toThrow('Wallet operation failed: BALANCE_UNAVAILABLE.');
    await expect(
      readWalletBalance(endpoint, address, {
        fetch: async () => new Response('', { status: 503 }),
      }),
    ).rejects.toThrow('BALANCE_UNAVAILABLE');
  });
  it('times out a stalled read and cancels caller-aborted requests', async () => {
    const fetcher: typeof fetch = async (_url, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        if (init!.signal!.aborted) reject(new Error('aborted'));
      });
    await expect(
      readWalletBalance(endpoint, address, { fetch: fetcher, timeoutMs: 5 }),
    ).rejects.toThrow('BALANCE_UNAVAILABLE');
    const controller = new AbortController();
    controller.abort();
    await expect(
      readWalletBalance(endpoint, address, { fetch: fetcher, signal: controller.signal }),
    ).rejects.toThrow('BALANCE_UNAVAILABLE');
  });
});
