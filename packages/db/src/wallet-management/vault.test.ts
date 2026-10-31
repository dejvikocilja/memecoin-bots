import { randomBytes, randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdtemp,
  realpath,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decryptSecret } from '@memebots/config';
import { createOfflineVault } from './vault.js';
import { ephemeralImport } from './test-support.js';

const dirs: string[] = [];
async function temp() {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'bot-wallet-')));
  dirs.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
describe('offline wallet vault', () => {
  it('creates encrypted Ed25519 material with private permissions and no public secret DTO', async () => {
    const dir = await temp();
    const vault = await createOfflineVault(join(dir, 'vault'));
    const id = randomUUID(),
      key = randomBytes(32);
    const address = await vault.provision(id, key);
    expect(address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    const file = join(dir, 'vault', `${id}.vault.json`);
    const envelope = await readFile(file, 'utf8');
    const plaintext = JSON.parse(decryptSecret(envelope, key)) as {
      walletId: string;
      keypair: string;
    };
    expect(plaintext.walletId).toBe(id);
    expect(Buffer.from(plaintext.keypair, 'base64')).toHaveLength(64);
    expect(envelope).not.toContain(plaintext.keypair);
    expect((await lstat(file)).mode & 0o777).toBe(0o600);
    expect((await lstat(join(dir, 'vault'))).mode & 0o777).toBe(0o700);
    expect(() => decryptSecret(envelope, randomBytes(32))).toThrow('Unable to decrypt secret.');
    const parsed = JSON.parse(envelope);
    parsed.tag = Buffer.alloc(16).toString('base64');
    expect(() => decryptSecret(JSON.stringify(parsed), key)).toThrow('Unable to decrypt secret.');
    expect(await vault.listIds()).toEqual([id]);
    key.fill(0);
  });
  it('imports exactly the derived public address and refuses overwriting existing material', async () => {
    const dir = await temp();
    const vault = await createOfflineVault(join(dir, 'vault'));
    const key = randomBytes(32),
      id = randomUUID();
    const imported = ephemeralImport();
    expect(await vault.provision(id, key, imported.input)).toBe(imported.address);
    const before = await readFile(join(dir, 'vault', `${id}.vault.json`));
    await expect(vault.provision(id, key)).rejects.toThrow('PROVISION_FAILED');
    expect(await readFile(join(dir, 'vault', `${id}.vault.json`))).toEqual(before);
    imported.input.fill(0);
    key.fill(0);
  });
  it.each(['[]', 'not-json', '[256]', ' '.repeat(1025)])(
    'rejects malformed/oversize imports without reflecting input',
    async (value) => {
      const dir = await temp();
      const vault = await createOfflineVault(join(dir, 'vault'));
      await expect(
        vault.provision(randomUUID(), randomBytes(32), Buffer.from(value)),
      ).rejects.toThrow('Wallet operation failed: PROVISION_FAILED.');
      expect(await vault.listIds()).toEqual([]);
    },
  );
  it('rejects public/seed mismatch and invalid encryption key', async () => {
    const dir = await temp();
    const vault = await createOfflineVault(join(dir, 'vault'));
    const imported = ephemeralImport();
    const bytes = JSON.parse(imported.input.toString()) as number[];
    bytes[63] = (bytes[63]! + 1) % 256;
    await expect(
      vault.provision(randomUUID(), randomBytes(32), Buffer.from(JSON.stringify(bytes))),
    ).rejects.toThrow('PROVISION_FAILED');
    await expect(vault.provision(randomUUID(), randomBytes(31))).rejects.toThrow(
      'PROVISION_FAILED',
    );
    expect(await vault.listIds()).toEqual([]);
    imported.input.fill(0);
  });
  it('rejects symlink directories, repository directories, loose permissions and path traversal', async () => {
    const dir = await temp();
    const root = join(dir, 'vault');
    await createOfflineVault(root);
    await symlink(root, join(dir, 'alias'));
    await expect(createOfflineVault(join(dir, 'alias'))).rejects.toThrow('VAULT_UNAVAILABLE');
    await expect(createOfflineVault(`${root}/../vault`)).rejects.toThrow('VAULT_UNAVAILABLE');
    await writeFile(join(dir, '.git'), 'gitdir: test');
    await expect(createOfflineVault(root)).rejects.toThrow('VAULT_UNAVAILABLE');
    await rm(join(dir, '.git'));
    await chmod(root, 0o755);
    await expect(createOfflineVault(root)).rejects.toThrow('VAULT_UNAVAILABLE');
  });
  it('rejects symlink files and unsafe IDs without reading keys', async () => {
    const dir = await temp();
    const root = join(dir, 'vault');
    const vault = await createOfflineVault(root);
    const id = randomUUID();
    await symlink(join(dir, 'unknown'), join(root, `${id}.vault.json`));
    await expect(vault.listIds()).rejects.toThrow('VAULT_UNAVAILABLE');
    await expect(vault.provision('../outside', randomBytes(32))).rejects.toThrow('INVALID_ID');
  });
});
