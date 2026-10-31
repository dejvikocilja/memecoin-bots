import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function start(env: Record<string, string>) {
  return spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--conditions=@memebots/source',
      fileURLToPath(new URL('./main.ts', import.meta.url)),
    ],
    {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      env,
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
}

describe('engine startup configuration boundary', () => {
  it('starts in paper mode with a valid fixture configuration', () => {
    const result = start({ DATABASE_URL: 'postgresql://127.0.0.1/bot_paper' });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).event).toBe('engine_status');
    expect(result.stdout).toContain('paper');
  });
  it.each([
    [{}, 'DATABASE_URL'],
    [
      { DATABASE_URL: 'postgresql://127.0.0.1/bot_paper', MARKET_DATA_ENABLED: 'invalid' },
      'MARKET_DATA_ENABLED',
    ],
    [
      {
        DATABASE_URL: 'postgresql://127.0.0.1/bot_paper',
        SOLANA_RPC_URL: 'file:///synthetic-rpc-secret',
      },
      'SOLANA_RPC_URL',
    ],
    [
      {
        DATABASE_URL: 'postgresql://127.0.0.1/bot_paper',
        SOLANA_WS_URL: 'https://synthetic-ws-secret.example',
      },
      'SOLANA_WS_URL',
    ],
    [{ DATABASE_URL: 'synthetic-invalid-db-secret' }, 'DATABASE_URL'],
    [{ DATABASE_URL: 'postgresql://127.0.0.1/bot_paper', BOT_MODE: 'live' }, 'BOT_MODE'],
    [
      { DATABASE_URL: 'postgresql://127.0.0.1/bot_paper', PRIVATE_KEY: 'synthetic-wallet-key' },
      'SIGNING_CONFIGURATION_NOT_ALLOWED',
    ],
  ] satisfies [Record<string, string>, string][])(
    'rejects invalid configuration before starting (%s)',
    (env, field) => {
      const result = start(env);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain(field);
      expect(result.stdout + result.stderr).not.toContain('synthetic-invalid-db-secret');
      expect(result.stdout + result.stderr).not.toContain('synthetic-wallet-key');
      expect(result.stdout + result.stderr).not.toContain('synthetic-rpc-secret');
      expect(result.stdout + result.stderr).not.toContain('synthetic-ws-secret');
      expect(result.stdout).not.toContain('engine_status');
    },
  );
});
