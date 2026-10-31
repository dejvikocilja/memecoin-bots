#!/usr/bin/env node
// Fails if a tracked file looks like a secret: a .env file, a Solana keypair
// (JSON array of 64 bytes), a PEM private key or a base58 secret key assigned
// in source. Runs in CI and in `pnpm check`. Spec section 8: keys are never committed.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  {
    encoding: 'utf8',
  },
)
  .split('\0')
  .filter(Boolean);

const problems = [];
const keypairArray = /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/;
const pemKey = /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/;
const base58Secret = /(?:secret|private)[_-]?key\s*[:=]\s*['"]?[1-9A-HJ-NP-Za-km-z]{80,90}['"]?/i;

for (const file of files) {
  const name = file.split('/').pop() ?? file;
  if (/^\.env(\..+)?$/.test(name) && name !== '.env.example') {
    problems.push(`${file}: .env files must not be committed`);
    continue;
  }
  if (file === 'pnpm-lock.yaml' || file.startsWith('scripts/check-no-secrets')) continue;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  if (keypairArray.test(text))
    problems.push(`${file}: looks like a Solana keypair (64-byte array)`);
  if (pemKey.test(text)) problems.push(`${file}: contains a PEM private key`);
  if (base58Secret.test(text))
    problems.push(`${file}: assigns what looks like a base58 secret key`);
}

if (problems.length > 0) {
  console.error('Possible secrets found:\n' + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}
console.log(`No secrets found in ${files.length} files.`);
