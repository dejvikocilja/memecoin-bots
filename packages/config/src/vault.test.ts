import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { test } from 'vitest';
import { decryptSecret, encryptSecret } from './vault.js';

// Synthetic test material only. These are not production keys or credentials.
const KEY = Uint8Array.from({ length: 32 }, (_, index) => index);
const SECRET = 'synthetic-test-secret-α🔐';
const MAX_BYTES = 64 * 1024;

type Envelope = {
  version: number;
  algorithm: string;
  nonce: string;
  ciphertext: string;
  tag: string;
};

function parse(value: string): Envelope {
  return JSON.parse(value) as Envelope;
}

function change(value: string, changes: Record<string, unknown>): string {
  return JSON.stringify({ ...parse(value), ...changes });
}

function flipBase64(value: string): string {
  const bytes = Buffer.from(value, 'base64');
  bytes.writeUInt8(bytes.readUInt8(0) ^ 1, 0);
  return bytes.toString('base64');
}

function rejectsWithoutLeaking(action: () => unknown, operation: 'encrypt' | 'decrypt'): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, `Unable to ${operation} secret.`);
    assert.equal('cause' in error, false);
    assert.equal(error.message.includes(SECRET), false);
    assert.equal(error.message.includes(Buffer.from(KEY).toString('hex')), false);
    return true;
  });
}

test('round trips UTF-8, empty text, and a leading BOM without changing caller keys', () => {
  const originalKey = Uint8Array.from(KEY);
  for (const value of [SECRET, '', '\uFEFFleading BOM', 'a\n\u0000b']) {
    assert.equal(decryptSecret(encryptSecret(value, KEY), KEY), value);
  }
  assert.deepEqual(KEY, originalKey);
});

test('envelope has only versioned cryptographic fields and a fresh nonce each time', () => {
  const first = encryptSecret(SECRET, KEY);
  const second = encryptSecret(SECRET, KEY);
  const parsed = parse(first);
  assert.deepEqual(Object.keys(parsed).sort(), [
    'algorithm',
    'ciphertext',
    'nonce',
    'tag',
    'version',
  ]);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.algorithm, 'aes-256-gcm');
  assert.equal(Buffer.from(parsed.nonce, 'base64').length, 12);
  assert.equal(Buffer.from(parsed.tag, 'base64').length, 16);
  assert.notEqual(parsed.nonce, parse(second).nonce);
  assert.notEqual(first, second);
  assert.equal(first.includes(SECRET), false);
  assert.equal(first.includes(Buffer.from(KEY).toString('base64')), false);
});

test('authenticates ciphertext, nonce, and tag and rejects a wrong key', () => {
  const envelope = encryptSecret(SECRET, KEY);
  const parsed = parse(envelope);
  for (const field of ['ciphertext', 'nonce', 'tag'] as const) {
    rejectsWithoutLeaking(
      () => decryptSecret(change(envelope, { [field]: flipBase64(parsed[field]) }), KEY),
      'decrypt',
    );
  }
  const wrongKey = Uint8Array.from(KEY);
  wrongKey[0] = KEY[0]! ^ 1;
  rejectsWithoutLeaking(() => decryptSecret(envelope, wrongKey), 'decrypt');
});

test('rejects ciphertext produced under a different authenticated context', () => {
  const nonce = Buffer.alloc(12, 17);
  const cipher = createCipheriv('aes-256-gcm', KEY, nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from('synthetic-other-context'));
  const ciphertext = Buffer.concat([cipher.update(SECRET, 'utf8'), cipher.final()]);
  const envelope = JSON.stringify({
    version: 1,
    algorithm: 'aes-256-gcm',
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  });
  rejectsWithoutLeaking(() => decryptSecret(envelope, KEY), 'decrypt');
});

test('rejects altered versions, algorithms, and unknown fields', () => {
  const envelope = encryptSecret(SECRET, KEY);
  for (const changes of [
    { version: 2 },
    { version: '1' },
    { version: null },
    { algorithm: 'aes-128-gcm' },
    { aad: 'replacement' },
    { key: Buffer.from(KEY).toString('base64') },
  ]) {
    rejectsWithoutLeaking(() => decryptSecret(change(envelope, changes), KEY), 'decrypt');
  }
});

test('rejects malformed, missing, or wrongly typed envelope values', () => {
  const envelope = encryptSecret(SECRET, KEY);
  const missingField: Partial<Envelope> = parse(envelope);
  delete missingField.tag;
  for (const value of [
    '',
    '{',
    'null',
    '[]',
    '1',
    'true',
    JSON.stringify(SECRET),
    '{}',
    JSON.stringify(missingField),
    change(envelope, { nonce: null }),
    change(envelope, { ciphertext: 42 }),
    change(envelope, { tag: [] }),
    ' '.repeat(88_001),
    null as unknown as string,
  ]) {
    rejectsWithoutLeaking(() => decryptSecret(value, KEY), 'decrypt');
  }
});

test('requires canonical base64 and exact nonce and tag sizes', () => {
  const envelope = encryptSecret(SECRET, KEY);
  const parsed = parse(envelope);
  for (const changes of [
    { nonce: Buffer.alloc(11).toString('base64') },
    { nonce: Buffer.alloc(13).toString('base64') },
    { tag: Buffer.alloc(15).toString('base64') },
    { tag: Buffer.alloc(17).toString('base64') },
    { ciphertext: '$not-base64$' },
    { ciphertext: 'YQ' },
    { ciphertext: 'YR==' }, // Decodes to "a" but has nonzero padding bits.
    { ciphertext: `${parsed.ciphertext}\n` },
    { nonce: '' },
    { tag: '' },
  ]) {
    rejectsWithoutLeaking(() => decryptSecret(change(envelope, changes), KEY), 'decrypt');
  }
});

test('limits plaintext by UTF-8 bytes and rejects malformed surrogate input', () => {
  const boundary = 'x'.repeat(MAX_BYTES);
  assert.equal(decryptSecret(encryptSecret(boundary, KEY), KEY), boundary);
  for (const value of [
    'x'.repeat(MAX_BYTES + 1),
    '🔐'.repeat(MAX_BYTES / 4 + 1),
    '\uD800',
    null as unknown as string,
  ]) {
    rejectsWithoutLeaking(() => encryptSecret(value, KEY), 'encrypt');
  }
  const envelope = encryptSecret(SECRET, KEY);
  rejectsWithoutLeaking(
    () =>
      decryptSecret(
        change(envelope, {
          ciphertext: Buffer.alloc(MAX_BYTES + 1).toString('base64'),
        }),
        KEY,
      ),
    'decrypt',
  );
});

test('requires exactly 32 key bytes and does not coerce other key types', () => {
  const envelope = encryptSecret(SECRET, KEY);
  for (const key of [
    new Uint8Array(0),
    new Uint8Array(31),
    new Uint8Array(33),
    'synthetic-key' as unknown as Uint8Array,
    Array.from(KEY) as unknown as Uint8Array,
    null as unknown as Uint8Array,
  ]) {
    rejectsWithoutLeaking(() => encryptSecret(SECRET, key), 'encrypt');
    rejectsWithoutLeaking(() => decryptSecret(envelope, key), 'decrypt');
  }
});
