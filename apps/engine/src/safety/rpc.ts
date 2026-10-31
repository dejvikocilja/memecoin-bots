import type { Secret } from '@memebots/config';
import { address, object, raw, unknownEvidence, validateEvidence } from './evidence.js';
import type { Evidence, Observation } from './evidence.js';

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58(bytes: Uint8Array): string {
  let n = BigInt('0x' + Buffer.from(bytes).toString('hex'));
  let s = '';
  while (n > 0n) {
    s = ALPHABET[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    s = '1' + s;
  }
  return s;
}
function validAddress(value: string): boolean {
  if (!address(value)) return false;
  let n = 0n;
  for (const c of value) n = n * 58n + BigInt(ALPHABET.indexOf(c));
  let length = 0;
  while (n > 0n) {
    length++;
    n >>= 8n;
  }
  return length + (value.match(/^1*/)?.[0].length ?? 0) === 32;
}
export class SafetyRpcError extends Error {
  constructor(
    readonly code: 'RPC_UNAVAILABLE' | 'RATE_LIMITED' | 'BUDGET_EXCEEDED' | 'INVALID_RESPONSE',
  ) {
    super(code);
  }
}
export interface RpcOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  requestBudget?: number;
  now?: () => number;
}
/** Four-method, serial read-only surface. Never accepts a caller-supplied RPC method. */
export class SafetyRpc {
  private requests = 0;
  private active = false;
  private retryAt = 0;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly budget: number;
  private readonly now: () => number;
  constructor(
    private readonly endpoint: Secret,
    options: RpcOptions = {},
  ) {
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.maxBytes = options.maxBytes ?? 128_000;
    this.budget = options.requestBudget ?? 4;
    this.now = options.now ?? Date.now;
    if (
      ![this.timeoutMs, this.maxBytes, this.budget].every(
        (n) => Number.isSafeInteger(n) && n > 0,
      ) ||
      this.timeoutMs > 30000 ||
      this.maxBytes > 1_000_000 ||
      this.budget > 20
    )
      throw new Error('INVALID_RPC_LIMITS');
    const u = new URL(endpoint.reveal());
    if (
      u.protocol !== 'https:' &&
      !(u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))
    )
      throw new Error('INVALID_RPC_ENDPOINT');
  }
  private async call(
    method: 'getAccountInfo' | 'getTokenSupply' | 'getTokenLargestAccounts' | 'getMultipleAccounts',
    params: unknown[],
  ): Promise<unknown> {
    if (this.active || this.requests >= this.budget) throw new SafetyRpcError('BUDGET_EXCEEDED');
    if (this.now() < this.retryAt) throw new SafetyRpcError('RATE_LIMITED');
    this.requests++;
    this.active = true;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(this.endpoint.reveal(), {
        method: 'POST',
        signal: abort.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.requests, method, params }),
      });
      if (response.status === 429) {
        const seconds = Number(response.headers.get('retry-after') ?? 1);
        this.retryAt =
          this.now() +
          (Number.isFinite(seconds) ? Math.min(60000, Math.max(1000, seconds * 1000)) : 1000);
        throw new SafetyRpcError('RATE_LIMITED');
      }
      if (!response.ok || !response.body) throw new SafetyRpcError('RPC_UNAVAILABLE');
      const reader = response.body.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > this.maxBytes) {
            await reader.cancel();
            throw new SafetyRpcError('INVALID_RESPONSE');
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      // Node 24 supplies the raw JSON token. Reject unsafe numeric syntax BEFORE rounded values can be used.
      const parsed: unknown = JSON.parse(
        Buffer.concat(chunks).toString('utf8'),
        (_key: string, value: unknown, context?: { source?: string }) => {
          if (_key === 'uiAmount') return null; // Optional display float is never used or persisted.
          if (
            typeof value === 'number' &&
            (!Number.isFinite(value) ||
              !Number.isSafeInteger(value) ||
              (context?.source !== undefined && !/^-?(0|[1-9][0-9]*)$/.test(context.source)))
          )
            throw new SafetyRpcError('INVALID_RESPONSE');
          return value;
        },
      );
      if (
        !object(parsed) ||
        parsed.jsonrpc !== '2.0' ||
        parsed.id !== this.requests ||
        'error' in parsed ||
        !('result' in parsed)
      )
        throw new SafetyRpcError('INVALID_RESPONSE');
      return parsed.result;
    } catch (error) {
      throw error instanceof SafetyRpcError ? error : new SafetyRpcError('RPC_UNAVAILABLE');
    } finally {
      clearTimeout(timer);
      this.active = false;
    }
  }
  async collect(mint: string, pool: string | null = null, ttl = 60000): Promise<Evidence> {
    if (
      !validAddress(mint) ||
      (pool !== null && !validAddress(pool)) ||
      !Number.isSafeInteger(ttl) ||
      ttl < 1 ||
      ttl > 300000
    )
      throw new Error('INVALID_SCAN_INPUT');
    const result = unknownEvidence(mint, pool, this.now(), ttl);
    try {
      const account = context(
        await this.call('getAccountInfo', [mint, { encoding: 'base64', commitment: 'confirmed' }]),
      );
      if (object(account.value) && account.value.owner !== TOKEN_PROGRAM) {
        // This includes Token-2022. Its extensions have not been decoded or assessed.
        result.checks.mintAuthority.reason = 'UNSUPPORTED';
        result.checks.freezeAuthority.reason = 'UNSUPPORTED';
        return result;
      }
      const data = accountData(account.value, 82);
      if (
        !data ||
        data[45] !== 1 ||
        data[44]! > 18 ||
        ![0, 1].includes(data.readUInt32LE(0)) ||
        ![0, 1].includes(data.readUInt32LE(46))
      ) {
        result.checks.mintAuthority.reason = 'INVALID_MINT';
        result.checks.freezeAuthority.reason = 'INVALID_MINT';
        return result;
      }
      const supply = context(
        await this.call('getTokenSupply', [
          mint,
          { commitment: 'confirmed', minContextSlot: account.slot },
        ]),
      );
      if (
        !object(supply.value) ||
        !raw(supply.value.amount) ||
        supply.value.amount !== data.readBigUInt64LE(36).toString() ||
        supply.value.decimals !== data[44] ||
        supply.slot !== account.slot ||
        BigInt(supply.value.amount) === 0n
      )
        throw new SafetyRpcError('INVALID_RESPONSE');
      result.decimals = data[44]!;
      const observedAt = new Date(this.now()).toISOString();
      const observation = (
        slot: number,
        facts: Record<string, unknown>,
        coverage: Observation['coverage'],
      ): Observation => ({
        observedAt,
        expiresAt: new Date(Date.parse(observedAt) + ttl).toISOString(),
        provenance: {
          source: 'solana_rpc',
          reference: 'classic_spl_rpc_v1',
          slot,
          commitment: 'confirmed',
        },
        coverage,
        reason: 'OK',
        facts,
      });
      result.checks.mintAuthority = observation(
        account.slot,
        { authority: data.readUInt32LE(0) === 0 ? null : base58(data.subarray(4, 36)) },
        'mint',
      );
      result.checks.freezeAuthority = observation(
        account.slot,
        { authority: data.readUInt32LE(46) === 0 ? null : base58(data.subarray(50, 82)) },
        'mint',
      );
      try {
        const largest = context(
          await this.call('getTokenLargestAccounts', [mint, { commitment: 'confirmed' }]),
        );
        if (
          largest.slot !== account.slot ||
          !Array.isArray(largest.value) ||
          largest.value.length > 20 ||
          largest.value.length === 0
        )
          throw new SafetyRpcError('INVALID_RESPONSE');
        const accounts: { address: string; amount: string }[] = [];
        for (const v of largest.value) {
          if (
            !object(v) ||
            !address(v.address) ||
            !raw(v.amount) ||
            v.decimals !== result.decimals ||
            accounts.some((a) => a.address === v.address)
          )
            throw new SafetyRpcError('INVALID_RESPONSE');
          accounts.push({ address: v.address, amount: v.amount });
        }
        const resolved = context(
          await this.call('getMultipleAccounts', [
            accounts.map((a) => a.address),
            { encoding: 'base64', commitment: 'confirmed', minContextSlot: account.slot },
          ]),
        );
        if (
          resolved.slot !== account.slot ||
          !Array.isArray(resolved.value) ||
          resolved.value.length !== accounts.length
        )
          throw new SafetyRpcError('INVALID_RESPONSE');
        const owners = new Map<string, bigint>();
        for (let i = 0; i < accounts.length; i++) {
          const token = accountData(resolved.value[i], 165);
          if (
            !token ||
            base58(token.subarray(0, 32)) !== mint ||
            token.readBigUInt64LE(64).toString() !== accounts[i]!.amount ||
            token[108] !== 1
          )
            throw new SafetyRpcError('INVALID_RESPONSE');
          const owner = base58(token.subarray(32, 64));
          owners.set(owner, (owners.get(owner) ?? 0n) + token.readBigUInt64LE(64));
        }
        result.checks.holders = observation(
          account.slot,
          {
            supplyRaw: supply.value.amount,
            owners: [...owners].map(([owner, amount]) => ({ owner, amountRaw: amount.toString() })),
            complete: false,
            developerOwner: null,
            developerAttributionVerified: false,
          },
          'top20_accounts',
        );
      } catch {
        result.checks.holders.reason = 'RPC_UNAVAILABLE';
      }
    } catch {
      for (const check of ['mintAuthority', 'freezeAuthority', 'holders'] as const)
        result.checks[check].reason = 'RPC_UNAVAILABLE';
    }
    return validateEvidence(result);
  }
}
function context(v: unknown): { slot: number; value: unknown } {
  if (
    !object(v) ||
    !object(v.context) ||
    !Number.isSafeInteger(v.context.slot) ||
    (v.context.slot as number) < 0 ||
    !('value' in v)
  )
    throw new SafetyRpcError('INVALID_RESPONSE');
  return { slot: v.context.slot as number, value: v.value };
}
function accountData(v: unknown, length: number): Buffer | null {
  if (
    !object(v) ||
    v.owner !== TOKEN_PROGRAM ||
    v.executable !== false ||
    !Array.isArray(v.data) ||
    v.data.length !== 2 ||
    v.data[1] !== 'base64' ||
    typeof v.data[0] !== 'string' ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(v.data[0])
  )
    return null;
  const decoded = Buffer.from(v.data[0], 'base64');
  return decoded.length === length && decoded.toString('base64') === v.data[0] ? decoded : null;
}
