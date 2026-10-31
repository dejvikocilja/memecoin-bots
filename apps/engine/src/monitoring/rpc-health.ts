import type { Secret } from '@memebots/config';
import type { AlertCode } from '@memebots/db';

import { OperationCancelledError, withinDeadline } from './loop.js';

export type RpcHealth =
  | { readonly status: 'disabled' | 'healthy' }
  | { readonly status: 'unhealthy'; readonly code: AlertCode };

/** Read-only getHealth; never include the endpoint, provider response or raw thrown error in output. */
export async function probeRpcHealth(
  endpoint: Secret | undefined,
  options: {
    readonly fetch?: typeof fetch;
    readonly signal: AbortSignal;
    readonly timeoutMs?: number;
  },
): Promise<RpcHealth> {
  if (!endpoint) return { status: 'disabled' };
  try {
    return await withinDeadline(
      async (signal): Promise<RpcHealth> => {
        const response = await (options.fetch ?? fetch)(endpoint.reveal(), {
          method: 'POST',
          signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 'health-1', method: 'getHealth' }),
        });
        if (!response.ok) return { status: 'unhealthy', code: 'http' };
        const reader = response.body?.getReader();
        if (!reader) return { status: 'unhealthy', code: 'malformed' };
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        const cancelBody = () => {
          void reader.cancel().catch(() => {});
        };
        signal.addEventListener('abort', cancelBody, { once: true });
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.length;
            if (bytes > 4_096) {
              cancelBody();
              return { status: 'unhealthy', code: 'malformed' };
            }
            chunks.push(chunk.value);
          }
        } finally {
          signal.removeEventListener('abort', cancelBody);
        }

        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return { status: 'unhealthy', code: 'malformed' };
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body))
          return { status: 'unhealthy', code: 'malformed' };
        const value = body as Record<string, unknown>;
        if (value.jsonrpc !== '2.0' || value.id !== 'health-1')
          return { status: 'unhealthy', code: 'malformed' };
        if ('error' in value) return { status: 'unhealthy', code: 'rpc' };
        return value.result === 'ok'
          ? { status: 'healthy' }
          : { status: 'unhealthy', code: 'malformed' };
      },
      options.signal,
      options.timeoutMs ?? 4_000,
    );
  } catch (error) {
    return {
      status: 'unhealthy',
      code: options.signal.aborted
        ? 'unavailable'
        : error instanceof OperationCancelledError
          ? 'timeout'
          : 'transport',
    };
  }
}
