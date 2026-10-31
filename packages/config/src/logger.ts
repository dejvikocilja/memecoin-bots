import { REDACTED, Secret, SecretRegistry } from './secrets.js';

const SENSITIVE_FIELD =
  /password|passwd|secret|private.?key|mnemonic|seed|authorization|cookie|api.?key|access.?token|refresh.?token|keypair|credential|connection.?string|database.?url|rpc.?url|^dsn$|^token$/i;
const MAX_DEPTH = 8;
const MAX_FIELDS = 100;
const MAX_STRING = 16_384;

function cleanText(text: string, registry: SecretRegistry): string {
  // Remove complete private-key blocks and conventional authentication headers
  // even if they did not originate in the application's config registry.
  let result = registry
    .redact(text)
    .replace(
      /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g,
      REDACTED,
    )
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, REDACTED)
    .replace(/\b(?:https?|wss?|postgres(?:ql)?):\/\/[^\s<>"']+/gi, (raw) => {
      try {
        const url = new URL(raw);
        url.username = '';
        url.password = '';
        // Preserve only the endpoint, never arbitrary query parameters/fragments.
        url.search = url.search ? '?redacted' : '';
        url.hash = '';
        return url.toString();
      } catch {
        return '[URL omitted]';
      }
    });
  result = registry.redact(result);
  return result.length > MAX_STRING ? `${result.slice(0, MAX_STRING)}[Truncated]` : result;
}

function sanitize(
  value: unknown,
  registry: SecretRegistry,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (typeof value === 'string') return cleanText(value, registry);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : '[Non-finite number]';
  if (typeof value === 'bigint') return cleanText(value.toString(), registry);
  if (typeof value === 'undefined') return '[Undefined]';
  if (typeof value === 'function' || typeof value === 'symbol') return '[Unsupported value]';
  if (typeof value !== 'object') return '[Unsupported value]';
  if (value instanceof Secret || value instanceof SecretRegistry) return REDACTED;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return '[Binary omitted]';
  if (seen.has(value)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[Depth limit]';
  seen.add(value);

  // Read descriptors, not values: getters and arbitrary toJSON methods are never
  // invoked. Build a fresh null-prototype object before calling JSON.stringify.
  const output: Record<string, unknown> = Object.create(null);
  const keys = Object.getOwnPropertyNames(value);
  for (const key of keys.slice(0, MAX_FIELDS)) {
    const outputKey = cleanText(key, registry);
    if (SENSITIVE_FIELD.test(key)) {
      output[outputKey] = REDACTED;
      continue;
    }
    if (key === 'stack') {
      output[outputKey] = '[Stack omitted]';
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    output[outputKey] =
      descriptor && 'value' in descriptor
        ? sanitize(descriptor.value, registry, seen, depth + 1)
        : '[Accessor omitted]';
  }
  if (keys.length > MAX_FIELDS) output['[Truncated]'] = true;
  return output;
}

/**
 * This logger protects registered secrets and recognized credential structures.
 * It cannot protect arbitrary unregistered strings or direct console/third-party
 * logging. Never pass private data to those sinks; register all config secrets.
 */
export function createLogger(registry: SecretRegistry, sink: (line: string) => void) {
  const write = (level: 'info' | 'error', event: string, fields?: unknown): void => {
    let safeEvent = 'invalid_event';
    let safeFields: unknown;
    try {
      if (typeof event === 'string' && /^[a-z][a-z0-9_.-]{0,79}$/i.test(event)) {
        safeEvent = registry.redact(event) === event ? event : 'redacted_event';
      }
      safeFields = sanitize(fields ?? {}, registry, new WeakSet<object>(), 0);
    } catch {
      // Do not log thrown values: a proxy/getter error may itself contain secrets.
      safeFields = '[Unserializable fields]';
    }
    sink(JSON.stringify({ level, event: safeEvent, fields: safeFields }));
  };
  return Object.freeze({
    info: (event: string, fields?: unknown): void => write('info', event, fields),
    error: (event: string, fields?: unknown): void => write('error', event, fields),
  });
}

export type AppLogger = ReturnType<typeof createLogger>;
