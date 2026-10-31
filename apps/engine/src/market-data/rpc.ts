/** Deliberately read-only RPC surface: there is no sign/send method. */
export interface RpcInstruction {
  readonly programIdIndex: number;
  readonly stackHeight?: number | null;
  readonly accounts: readonly number[];
  readonly data: string;
}
export interface RpcTransaction {
  readonly slot: number;
  readonly blockTime?: number | null;
  readonly transaction: {
    readonly message: {
      readonly accountKeys: readonly string[];
      readonly instructions: readonly RpcInstruction[];
    };
  };
  readonly meta: {
    readonly err: unknown;
    readonly logMessages?: readonly string[];
    readonly loadedAddresses?: {
      readonly writable: readonly string[];
      readonly readonly: readonly string[];
    };
    readonly innerInstructions?: readonly {
      readonly index: number;
      readonly instructions: readonly RpcInstruction[];
    }[];
  };
}

export class RpcRequestError extends Error {
  constructor(readonly retryAfterMs: number = 0) {
    super('Read-only RPC request failed');
  }
}

export async function getTransaction(
  url: string,
  signature: string,
  signal: AbortSignal,
): Promise<RpcTransaction | null> {
  const response = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getTransaction',
      params: [
        signature,
        { commitment: 'confirmed', encoding: 'json', maxSupportedTransactionVersion: 0 },
      ],
    }),
  });
  if (!response.ok) {
    const retryAfter = response.headers.get('retry-after');
    const seconds = retryAfter === null ? 0 : Number(retryAfter);
    const delay = Number.isFinite(seconds)
      ? seconds * 1_000
      : Math.max(0, Date.parse(retryAfter ?? '') - Date.now());
    throw new RpcRequestError(Number.isFinite(delay) ? Math.max(0, delay) : 0);
  }
  const serialized = await response.text();
  if (serialized.length > 10_000_000) throw new Error('Oversized transaction');
  const body: unknown = JSON.parse(serialized);
  if (!isObject(body) || body.error !== undefined) throw new Error('RPC response failed');
  if (body.result === null) return null;
  // Decoder validates all instruction indices and fields before using them.
  if (
    !isObject(body.result) ||
    !Number.isSafeInteger(body.result.slot) ||
    !isObject(body.result.transaction) ||
    !isObject(body.result.transaction.message) ||
    !Array.isArray(body.result.transaction.message.accountKeys) ||
    !Array.isArray(body.result.transaction.message.instructions) ||
    !isObject(body.result.meta) ||
    !('err' in body.result.meta)
  )
    throw new Error('Malformed transaction');
  return body.result as unknown as RpcTransaction;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
