export class WalletError extends Error {
  constructor(readonly code: string) {
    super(`Wallet operation failed: ${code}.`);
    this.name = 'WalletError';
  }
}
export function fail(code: string): never {
  throw new WalletError(code);
}
export function lamports(value: unknown, positive = false): bigint {
  if (typeof value !== 'bigint' || value < (positive ? 1n : 0n) || value >= 10n ** 39n)
    fail('INVALID_AMOUNT');
  return value as bigint;
}
export function text(value: unknown, max = 128): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    fail('INVALID_METADATA');
  return value as string;
}
export function uuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
    fail('INVALID_ID');
  return value;
}
