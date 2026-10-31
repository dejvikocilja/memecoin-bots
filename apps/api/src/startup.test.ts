import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('API startup configuration boundary', () => {
  it('starts with immutable validated settings and serves health on loopback', async () => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const address = probe.address();
    if (!address || typeof address === 'string') throw new Error('No loopback port allocated');
    await new Promise<void>((resolve, reject) =>
      probe.close((error) => (error ? reject(error) : resolve())),
    );
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--conditions=@memebots/source',
        fileURLToPath(new URL('./main.ts', import.meta.url)),
      ],
      {
        cwd: fileURLToPath(new URL('../../../', import.meta.url)),
        env: { DATABASE_URL: 'postgresql://127.0.0.1/bot_paper', API_PORT: String(address.port) },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('API did not start')), 5000);
        child.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once('exit', (code) => {
          clearTimeout(timeout);
          reject(new Error(`API startup exited ${code}`));
        });
        child.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString();
          if (output.includes('api_listening')) {
            clearTimeout(timeout);
            resolve();
          }
        });
      });
      const response = await fetch(`http://127.0.0.1:${address.port}/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        status: 'ok',
        mode: 'paper',
        liveTradingAvailable: false,
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        await exited;
      }
    }
  }, 10_000);

  it.each([
    [{}, 'DATABASE_URL'],
    [
      {
        DATABASE_URL: 'postgresql://127.0.0.1/bot_paper',
        API_PORT: 'synthetic-secret-invalid-port',
      },
      'API_PORT',
    ],
    [{ DATABASE_URL: 'postgresql://127.0.0.1/bot_paper', API_HOST: '0.0.0.0' }, 'API_HOST'],
    [{ DATABASE_URL: 'postgresql://127.0.0.1/bot_paper', BOT_MODE: 'live' }, 'BOT_MODE'],
  ] satisfies [Record<string, string>, string][])(
    'fails before listening on invalid settings (%s)',
    (env, field) => {
      const result = spawnSync(
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
      expect(result.status).toBe(1);
      expect(result.stdout).toContain(field);
      expect(result.stdout + result.stderr).not.toContain('synthetic-secret-invalid-port');
      expect(result.stdout).not.toContain('api_listening');
    },
  );
});
