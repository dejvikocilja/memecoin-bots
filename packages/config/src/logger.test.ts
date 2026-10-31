import assert from 'node:assert/strict';
import { test } from 'vitest';
import { inspect } from 'node:util';
import { createLogger } from './logger.js';
import { REDACTED, Secret, SecretRegistry } from './secrets.js';

const API_KEY = 'synthetic-helius-key/+?2026';
const WALLET_KEY = 'synthetic-wallet-secret-DO-NOT-USE';

function setup() {
  const registry = new SecretRegistry();
  registry.register(API_KEY);
  registry.register(WALLET_KEY);
  const lines: string[] = [];
  return { registry, lines, logger: createLogger(registry, (line) => lines.push(line)) };
}

test('secrets reveal only explicitly; JSON, coercion and normal/deep inspection redact', () => {
  const secret = new Secret(API_KEY);
  assert.equal(secret.reveal(), API_KEY);
  for (const rendered of [
    String(secret),
    `${secret}`,
    JSON.stringify(secret),
    inspect(secret),
    inspect({ secret }, { showHidden: true }),
    inspect(secret, { customInspect: false, showHidden: true }),
  ]) {
    assert.ok(!rendered.includes(API_KEY));
  }
  assert.equal(secret.toJSON(), REDACTED);
  assert.equal(inspect(secret), REDACTED);
});

test('registry redacts literal, URI-encoded, JSON-escaped and base64 credentials', () => {
  const { registry } = setup();
  const values = [
    API_KEY,
    encodeURIComponent(API_KEY),
    encodeURIComponent(API_KEY).replace(/%[0-9A-F]{2}/g, (s) => s.toLowerCase()),
    Buffer.from(API_KEY).toString('base64'),
    Buffer.from(API_KEY).toString('base64url'),
  ];
  for (const value of values)
    assert.equal(registry.redact(`before ${value} after`), `before ${REDACTED} after`);
  const quoted = 'synthetic-"quote"\nsecret';
  registry.register(quoted);
  assert.equal(registry.redact(JSON.stringify(quoted).slice(1, -1)), REDACTED);
  assert.ok(!inspect(registry, { customInspect: false, showHidden: true }).includes(API_KEY));
  assert.equal(JSON.stringify(registry), JSON.stringify(REDACTED));
});

test('actual serialized sink never contains synthetic credentials through nested errors, keys or encoding', () => {
  const { logger, lines } = setup();
  const cause = new Error(`provider ${API_KEY}`);
  const error = new Error(`wallet ${WALLET_KEY}`, { cause });
  logger.error('provider_failed', {
    description: `raw=${API_KEY} uri=${encodeURIComponent(API_KEY)} base64=${Buffer.from(API_KEY).toString('base64')}`,
    nested: [{ opaque: WALLET_KEY }],
    error,
    [API_KEY]: 'secret used as a property name',
    wrapped: new Secret(API_KEY),
  });
  assert.equal(lines.length, 1);
  assert.doesNotThrow(() => JSON.parse(lines[0]!));
  for (const value of [
    API_KEY,
    WALLET_KEY,
    encodeURIComponent(API_KEY),
    Buffer.from(API_KEY).toString('base64'),
  ]) {
    assert.ok(!lines[0]!.includes(value), `leaked fixture variant ${value}`);
  }
  assert.match(lines[0]!, /REDACTED/);
});

test('unregistered sensitive fields and URL credentials/query values are removed', () => {
  const { logger, lines } = setup();
  logger.info('request_failed', {
    apiKey: 'unregistered-key',
    private_key: 'unregistered-wallet',
    authorization: 'Bearer unknown-token',
    databaseUrl: 'postgresql://dbuser:dbpassword@localhost/bot',
    endpoint:
      'https://rpc.example.test/path?api-key=query-secret&extra=other-secret#secret-fragment',
    connection: 'postgresql://alice:url-password@localhost/bot?password=query-password',
    description: 'Authorization: Bearer unregistered-header-token',
    // Construct a synthetic marker so the repository scanner still rejects actual PEM files.
    pem: [
      '-----BEGIN ',
      'PRIVATE KEY-----\nunregistered-pem-value\n-----END ',
      'PRIVATE KEY-----',
    ].join(''),
  });
  for (const value of [
    'unregistered-key',
    'unregistered-wallet',
    'unknown-token',
    'dbpassword',
    'query-secret',
    'other-secret',
    'secret-fragment',
    'url-password',
    'query-password',
    'unregistered-header-token',
    'unregistered-pem-value',
  ])
    assert.ok(!lines[0]!.includes(value));
  assert.match(lines[0]!, /rpc\.example\.test/);
});

test('cycles, binary data, getters and toJSON cannot leak or execute during logging', () => {
  const { logger, lines } = setup();
  let executed = 0;
  const object: Record<string, unknown> = {
    binary: Buffer.from(API_KEY),
    bytes: new Uint8Array(Buffer.from(WALLET_KEY)),
    toJSON() {
      executed++;
      return API_KEY;
    },
  };
  Object.defineProperty(object, 'dangerous', {
    enumerable: true,
    get() {
      executed++;
      throw new Error(API_KEY);
    },
  });
  object.self = object;
  logger.info('shape_test', object);
  assert.equal(executed, 0);
  assert.ok(!lines[0]!.includes(API_KEY));
  assert.match(lines[0]!, /Binary omitted/);
  assert.match(lines[0]!, /Accessor omitted/);
  assert.match(lines[0]!, /Circular/);
});

test('proxy failures and invalid event names produce safe diagnostics', () => {
  const { logger, lines, registry } = setup();
  registry.register('syntheticEventSecret');
  logger.error(
    'syntheticEventSecret',
    new Proxy(
      {},
      {
        ownKeys() {
          throw new Error(API_KEY);
        },
      },
    ),
  );
  logger.error(`invalid ${WALLET_KEY}`);
  assert.equal(JSON.parse(lines[0]!).event, 'redacted_event');
  assert.equal(JSON.parse(lines[1]!).event, 'invalid_event');
  assert.ok(
    lines.every(
      (line) =>
        !line.includes(API_KEY) &&
        !line.includes(WALLET_KEY) &&
        !line.includes('syntheticEventSecret'),
    ),
  );
});

test('registered full URLs are redacted before structural URL normalization', () => {
  const { logger, lines, registry } = setup();
  const url = 'https://rpc.example.test/secret-path-key?custom=secret-query';
  registry.register(url);
  logger.info('endpoint_failed', { description: `request to ${url}` });
  assert.ok(!lines[0]!.includes('secret-path-key'));
  assert.ok(!lines[0]!.includes('secret-query'));
});

test('empty secrets fail without echoing input; longest registered secrets redact atomically', () => {
  const registry = new SecretRegistry();
  assert.throws(() => registry.register(''), /non-empty string/);
  registry.register('synthetic');
  registry.register('synthetic-longer-key');
  assert.equal(registry.redact('synthetic-longer-key'), REDACTED);
});
