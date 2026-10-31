import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { TextDecoder } from 'node:util';

const ALGORITHM = 'aes-256-gcm';
const VERSION = 1;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_PLAINTEXT_BYTES = 64 * 1024;
const MAX_ENVELOPE_CHARACTERS = 88_000;
const AUTHENTICATED_CONTEXT = Buffer.from('BOT-4:secret-vault:v1:aes-256-gcm', 'utf8');
const ENVELOPE_FIELDS = ['algorithm', 'ciphertext', 'nonce', 'tag', 'version'];

type SecretEnvelope = {
  version: number;
  algorithm: string;
  nonce: string;
  ciphertext: string;
  tag: string;
};

function copyKey(key: Uint8Array): Buffer {
  if (!(key instanceof Uint8Array) || key.byteLength !== KEY_BYTES) {
    throw new Error();
  }
  return Buffer.from(key);
}

function decodeBase64(value: unknown, minimumBytes: number, maximumBytes: number): Buffer {
  if (
    typeof value !== 'string' ||
    value.length > Math.ceil(maximumBytes / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error();
  }

  const bytes = Buffer.from(value, 'base64');
  if (
    bytes.length < minimumBytes ||
    bytes.length > maximumBytes ||
    bytes.toString('base64') !== value
  ) {
    throw new Error();
  }
  return bytes;
}

function parseEnvelope(value: string): SecretEnvelope {
  if (typeof value !== 'string' || value.length > MAX_ENVELOPE_CHARACTERS) {
    throw new Error();
  }
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error();
  }

  const fields = Object.keys(parsed).sort();
  if (
    fields.length !== ENVELOPE_FIELDS.length ||
    fields.some((field, i) => field !== ENVELOPE_FIELDS[i])
  ) {
    throw new Error();
  }
  const envelope = parsed as SecretEnvelope;
  if (envelope.version !== VERSION || envelope.algorithm !== ALGORITHM) {
    throw new Error();
  }
  return envelope;
}

/**
 * Encrypt a UTF-8 secret with a caller-supplied 32-byte key.
 * The returned versioned JSON contains no key. Persisting it and managing the
 * key are the caller's responsibility; this function does not write files.
 */
export function encryptSecret(plaintext: string, key: Uint8Array): string {
  let keyCopy: Buffer | undefined;
  let plaintextBytes: Buffer | undefined;
  try {
    keyCopy = copyKey(key);
    if (typeof plaintext !== 'string' || plaintext.length > MAX_PLAINTEXT_BYTES) {
      throw new Error();
    }
    plaintextBytes = Buffer.from(plaintext, 'utf8');
    if (
      plaintextBytes.length > MAX_PLAINTEXT_BYTES ||
      plaintextBytes.toString('utf8') !== plaintext
    ) {
      throw new Error();
    }

    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ALGORITHM, keyCopy, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(AUTHENTICATED_CONTEXT);
    const ciphertext = Buffer.concat([cipher.update(plaintextBytes), cipher.final()]);
    const envelope: SecretEnvelope = {
      version: VERSION,
      algorithm: ALGORITHM,
      nonce: nonce.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    };
    return JSON.stringify(envelope);
  } catch {
    throw new Error('Unable to encrypt secret.');
  } finally {
    keyCopy?.fill(0);
    plaintextBytes?.fill(0);
  }
}

/**
 * Authenticate an envelope before returning its plaintext. Invalid formats,
 * keys, or authentication failures all produce the same non-sensitive error.
 */
export function decryptSecret(envelope: string, key: Uint8Array): string {
  let keyCopy: Buffer | undefined;
  let pendingPlaintext: Buffer | undefined;
  let plaintextBytes: Buffer | undefined;
  try {
    keyCopy = copyKey(key);
    const parsed = parseEnvelope(envelope);
    const nonce = decodeBase64(parsed.nonce, NONCE_BYTES, NONCE_BYTES);
    const tag = decodeBase64(parsed.tag, TAG_BYTES, TAG_BYTES);
    const ciphertext = decodeBase64(parsed.ciphertext, 0, MAX_PLAINTEXT_BYTES);
    const decipher = createDecipheriv(ALGORITHM, keyCopy, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(AUTHENTICATED_CONTEXT);
    decipher.setAuthTag(tag);
    pendingPlaintext = decipher.update(ciphertext);
    // Do not decode or return the unauthenticated output of update().
    const finalPlaintext = decipher.final();
    plaintextBytes = Buffer.concat([pendingPlaintext, finalPlaintext]);
    finalPlaintext.fill(0);
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(plaintextBytes);
  } catch {
    throw new Error('Unable to decrypt secret.');
  } finally {
    keyCopy?.fill(0);
    pendingPlaintext?.fill(0);
    plaintextBytes?.fill(0);
  }
}
