import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createPool } from '@memebots/db';
import { buildServer } from './server.js';
let app: FastifyInstance | undefined;
const pool = createPool('postgresql://test:test@127.0.0.1/unopened_test');
afterEach(async () => {
  await app?.close();
  app = undefined;
});
describe('local control request boundary', () => {
  const base = {
    host: '127.0.0.1:3001',
    origin: 'http://127.0.0.1:5173',
    'sec-fetch-site': 'same-origin',
  };
  function server() {
    app = buildServer({ mode: 'paper', control: { pool } });
    return app;
  }
  it('does not disclose sessions to foreign hosts, origins, metadata or nonbrowser requests', async () => {
    const s = server();
    for (const headers of [
      { ...base, host: 'evil.example' },
      { ...base, origin: 'https://evil.example' },
      { ...base, 'sec-fetch-site': 'cross-site' },
      { host: base.host },
    ]) {
      const r = await s.inject({ url: '/control/session', headers });
      expect(r.statusCode).toBe(403);
      expect(r.body).not.toContain('csrfToken');
      expect(r.headers['access-control-allow-origin']).toBeUndefined();
    }
  });
  it('requires a server session, exact JSON and its custom CSRF header', async () => {
    const s = server();
    const boot = await s.inject({ url: '/control/session', headers: base });
    expect(boot.statusCode).toBe(200);
    expect(boot.headers['cache-control']).toBe('no-store');
    expect(boot.headers['set-cookie']).toContain('HttpOnly; SameSite=Strict');
    const cookie = boot.headers['set-cookie']!.toString().split(';')[0]!;
    const repeated = await s.inject({ url: '/control/session', headers: { ...base, cookie } });
    expect(repeated.json().csrfToken).toBe(boot.json().csrfToken);
    const cases = [
      { ...base, 'content-type': 'application/json' },
      { ...base, cookie, 'content-type': 'application/json' },
      { ...base, cookie, 'content-type': 'application/json', 'x-local-csrf': 'wrong' },
      {
        ...base,
        cookie,
        'content-type': 'text/plain',
        'x-local-csrf': boot.json().csrfToken as string,
      },
    ];
    for (const headers of cases) {
      const r = await s.inject({ method: 'POST', url: '/control/bots', headers, payload: '{}' });
      expect(r.statusCode).toBe(403);
    }
    const valid = {
      ...base,
      cookie,
      'content-type': 'application/json',
      'x-local-csrf': boot.json().csrfToken as string,
    };
    const bad = await s.inject({
      method: 'POST',
      url: '/control/bots',
      headers: valid,
      payload: { privateKey: 'not-a-key' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('INVALID_FIELDS');
    expect(bad.body).not.toContain('not-a-key');
    const large = await s.inject({
      method: 'POST',
      url: '/control/bots',
      headers: valid,
      payload: { name: 'x'.repeat(20_000) },
    });
    expect(large.statusCode).toBe(413);
  });
  it('validates kill switch requests before touching the database (BOT-16)', async () => {
    const s = server();
    const boot = await s.inject({ url: '/control/session', headers: base });
    const headers = {
      ...base,
      cookie: boot.headers['set-cookie']!.toString().split(';')[0]!,
      'content-type': 'application/json',
      'x-local-csrf': boot.json().csrfToken as string,
    };
    const post = (payload: unknown) =>
      s.inject({
        method: 'POST',
        url: '/control/kill-switch',
        headers,
        payload: payload as object,
      });
    for (const [payload, code] of [
      [{ action: 'release' }, 'INVALID_CONFIRMATION'],
      [{ action: 'release', confirmation: 'yes' }, 'INVALID_CONFIRMATION'],
      [{ action: 'engage', sellAll: 'yes' }, 'INVALID_SELL_ALL'],
      [{ action: 'engage', confirmation: 'resume buying' }, 'INVALID_FIELDS'],
      [{ action: 'panic' }, 'INVALID_ACTION'],
      [{ action: 'engage', extra: 1 }, 'INVALID_FIELDS'],
    ] as const) {
      const r = await post(payload);
      expect(r.statusCode).toBe(400);
      expect(r.json().code).toBe(code);
    }
    // Without the local session and CSRF token nothing reaches the kill switch.
    const blocked = await s.inject({
      method: 'POST',
      url: '/control/kill-switch',
      headers: { ...base, 'content-type': 'application/json' },
      payload: { action: 'engage' },
    });
    expect(blocked.statusCode).toBe(403);
  });
});
