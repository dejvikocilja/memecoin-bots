import { describe, expect, it, vi } from 'vitest';
import { Secret } from '@memebots/config';
import { SafetyRpc } from './rpc.js';
import { FIXTURE_MINT, rpcFixture } from './rpc-fixtures.js';
import { DEFAULT_POLICY, evaluate } from './evidence.js';
const endpoint = new Secret('http://127.0.0.1:12345/private?credential=DO_NOT_PERSIST');
function mock(modify: (method: string, value: unknown) => unknown = (_m, v) => v): typeof fetch {
  return vi.fn(async (_url, init) => {
    const request = JSON.parse(init!.body as string) as { method: string; id: number };
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: modify(request.method, rpcFixture(request.method)),
      }),
    );
  });
}
describe('bounded read-only classic SPL RPC', () => {
  it('decodes mint and aggregates actual token-account owners; unsupported checks deny', async () => {
    const fetcher = mock();
    const e = await new SafetyRpc(endpoint, { fetch: fetcher }).collect(FIXTURE_MINT);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(e.decimals).toBe(9);
    expect(e.checks.mintAuthority.facts).toEqual({ authority: null });
    expect(e.checks.holders.facts!.owners).toEqual([
      expect.objectContaining({ amountRaw: '1200000000000000000' }),
    ]);
    const d = evaluate(e, DEFAULT_POLICY);
    expect(d.passed).toBe(false);
    expect(d.checks.holders.status).toBe('fail');
    for (const c of ['lp', 'sell', 'bundle'] as const)
      expect(d.checks[c]).toEqual({ status: 'unknown', reason: 'UNSUPPORTED' });
    expect(JSON.stringify(e)).not.toContain('DO_NOT_PERSIST');
  });
  it.each(['spoof', 'extensions', 'uninitialized', 'absent'])(
    'does not certify %s mints',
    async (kind) => {
      const e = await new SafetyRpc(endpoint, {
        fetch: mock((m, v) => {
          if (m !== 'getAccountInfo') return v;
          const x = v as { value: { owner: string; data: string[] } | null };
          if (kind === 'absent') x.value = null;
          else if (kind === 'spoof') x.value!.owner = FIXTURE_MINT;
          else {
            const b = Buffer.from(x.value!.data[0]!, 'base64');
            if (kind === 'uninitialized') b[45] = 0;
            x.value!.data[0] = (
              kind === 'extensions' ? Buffer.concat([b, Buffer.alloc(20)]) : b
            ).toString('base64');
          }
          return x;
        }),
      }).collect(FIXTURE_MINT);
      expect(evaluate(e, DEFAULT_POLICY).checks.mintAuthority.status).toBe('unknown');
      expect(e.decimals).toBe(null);
    },
  );
  it('denies inconsistent slots, malformed amounts, unsafe raw JSON numbers and bounded payloads', async () => {
    for (const response of [
      '{"jsonrpc":"2.0","id":1,"result":{"context":{"slot":9007199254740993},"value":null}}',
      '{"jsonrpc":"2.0","id":1,"result":{"context":{"slot":9007199254740990.75},"value":null}}',
      'x'.repeat(500),
    ]) {
      const e = await new SafetyRpc(endpoint, {
        fetch: vi.fn(async () => new Response(response)),
        maxBytes: 400,
      }).collect(FIXTURE_MINT);
      expect(e.checks.mintAuthority.reason).toBe('RPC_UNAVAILABLE');
    }
    const e = await new SafetyRpc(endpoint, {
      fetch: mock((m, v) =>
        m === 'getTokenSupply'
          ? { context: { slot: 101 }, value: { amount: '10000000000000000000', decimals: 9 } }
          : v,
      ),
    }).collect(FIXTURE_MINT);
    expect(e.decimals).toBeNull();
  });
  it('bounds request count, timeouts, concurrency and rate-limit retry', async () => {
    const fetcher = mock();
    const rpc = new SafetyRpc(endpoint, { fetch: fetcher, requestBudget: 1 });
    expect((await rpc.collect(FIXTURE_MINT)).decimals).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    const limited = vi.fn(
      async () => new Response('', { status: 429, headers: { 'retry-after': '60' } }),
    );
    const r = new SafetyRpc(endpoint, { fetch: limited });
    await r.collect(FIXTURE_MINT);
    await r.collect(FIXTURE_MINT);
    expect(limited).toHaveBeenCalledTimes(1);
    const waiting: typeof fetch = vi.fn(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(new Error('PRIVATE_URL')));
        }),
    );
    const slow = new SafetyRpc(endpoint, { fetch: waiting, timeoutMs: 5 });
    const both = await Promise.all([slow.collect(FIXTURE_MINT), slow.collect(FIXTURE_MINT)]);
    expect(waiting).toHaveBeenCalledTimes(1);
    expect(both.every((e) => e.decimals === null)).toBe(true);
  });
});
