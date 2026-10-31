import { describe, expect, it } from 'vitest';

import { parseCollectorSettings } from './configuration.js';

const mint = 'So11111111111111111111111111111111111111112';
const base = {
  MARKET_DATA_SOURCE: 'dexscreener',
  DATABASE_URL: 'postgres://test@127.0.0.1:5432/test',
  TRACKED_TOKEN_MINTS: mint,
};

describe('collector settings', () => {
  it.each(['localhost', '127.0.0.1', '[::1]'])('accepts a plain PostgreSQL URL on %s', (host) => {
    const databaseUrl = `postgresql://test@${host}:5432/test`;
    expect(parseCollectorSettings({ ...base, DATABASE_URL: databaseUrl })).toEqual({
      databaseUrl,
      tokens: [mint],
    });
  });

  it.each([
    'postgres://test@remote.example/test',
    'https://test@localhost/test',
    'postgres://test@127.0.0.1/test?host=remote.example',
    'postgres://test@127.0.0.1/test?%68ost=remote.example',
    'postgres://test@127.0.0.1/test?hostaddr=203.0.113.10',
    'postgres://test@127.0.0.1/test?service=remote',
    'postgres://test@127.0.0.1/test?sslmode=require',
    'postgres://test@127.0.0.1/test#fragment',
    'invalid-url',
    '',
  ])('rejects alternate driver destinations and unsupported URL options: %s', (databaseUrl) => {
    expect(() => parseCollectorSettings({ ...base, DATABASE_URL: databaseUrl })).toThrow();
  });

  it.each([
    { MARKET_DATA_SOURCE: 'off' },
    { MARKET_DATA_SOURCE: undefined },
    { TRACKED_TOKEN_MINTS: '' },
    { TRACKED_TOKEN_MINTS: 'invalid-mint' },
    { TRACKED_TOKEN_MINTS: `${mint},${mint}` },
  ])('fails invalid source and tracked-token configuration before I/O: %j', (change) => {
    expect(() => parseCollectorSettings({ ...base, ...change })).toThrow();
  });

  it('never copies credentials or other configuration values into errors', () => {
    const secret = 'sentinel-do-not-log';
    for (const change of [
      { DATABASE_URL: `postgres://test:${secret}@remote.example/test` },
      { DATABASE_URL: `postgres://test:${secret}@localhost/test?host=remote.example` },
      { MARKET_DATA_SOURCE: secret },
      { TRACKED_TOKEN_MINTS: secret },
    ]) {
      try {
        parseCollectorSettings({ ...base, ...change });
        expect.fail('Invalid settings must throw');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect(String(error)).not.toContain(secret);
      }
    }
  });
});
