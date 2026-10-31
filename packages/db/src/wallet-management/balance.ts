import type { Secret } from '@memebots/config';
import { fail } from './validation.js';

export interface BalanceSnapshot {
  balanceLamports: bigint;
  observedAt: Date;
  slot: number;
}
export interface BalanceOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** Read-only getBalance. Unsafe JSON numbers are rejected rather than rounded. */
export async function readWalletBalance(
  endpoint: Secret,
  publicKey: string,
  options: BalanceOptions = {},
): Promise<BalanceSnapshot> {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(publicKey)) fail('INVALID_PUBLIC_KEY');
  const timeout = options.timeoutMs ?? 5_000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 5_000) fail('INVALID_TIMEOUT');
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const timer = setTimeout(() => controller.abort(), timeout);
  const observedAt = new Date();
  try {
    const response = await (options.fetch ?? fetch)(endpoint.reveal(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getBalance',
        params: [publicKey, { commitment: 'confirmed' }],
      }),
      signal,
    });
    if (!response.ok || !response.body) fail('BALANCE_UNAVAILABLE');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > 65_536) fail('BALANCE_UNAVAILABLE');
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (signal.aborted) fail('BALANCE_UNAVAILABLE');
    // Node 24 supplies the original primitive token in reviver context.source.
    // Never trust the already-rounded Number passed as `value`: e.g. a large
    // fractional token can round UP to an apparently safe integer.
    const body: unknown = JSON.parse(
      Buffer.concat(chunks).toString('utf8'),
      (_key: string, value: unknown, context?: { source?: string }): unknown => {
        if (typeof value !== 'number') return value;
        const source = context?.source;
        if (typeof source !== 'string' || !/^(0|[1-9][0-9]*)$/.test(source))
          fail('BALANCE_UNAVAILABLE');
        const exact = BigInt(source);
        if (exact > BigInt(Number.MAX_SAFE_INTEGER)) fail('BALANCE_UNAVAILABLE');
        return exact;
      },
    );
    if (
      !object(body) ||
      body.jsonrpc !== '2.0' ||
      body.id !== 1n ||
      'error' in body ||
      !object(body.result) ||
      !object(body.result.context) ||
      typeof body.result.context.slot !== 'bigint' ||
      typeof body.result.value !== 'bigint'
    )
      fail('BALANCE_UNAVAILABLE');
    return {
      balanceLamports: body.result.value,
      slot: Number(body.result.context.slot),
      observedAt,
    };
  } catch {
    return fail('BALANCE_UNAVAILABLE');
  } finally {
    clearTimeout(timer);
  }
}
