import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { base58 } from './vault.js';
export function ephemeralImport() {
  const privateKey = generateKeyPairSync('ed25519').privateKey;
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d!, 'base64url');
  const pub = Buffer.from(createPublicKey(privateKey).export({ format: 'jwk' }).x!, 'base64url');
  const secret = Buffer.concat([seed, pub]);
  const input = Buffer.from(JSON.stringify([...secret]));
  secret.fill(0);
  seed.fill(0);
  return { input, address: base58(pub) };
}
