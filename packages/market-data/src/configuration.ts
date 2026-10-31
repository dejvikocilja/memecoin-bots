import { validateFeedTokens } from './feed.js';

/** Validate configuration without opening a database or issuing HTTP requests. */
export function parseCollectorSettings(env: NodeJS.ProcessEnv): {
  databaseUrl: string;
  tokens: string[];
} {
  if (env.MARKET_DATA_SOURCE !== 'dexscreener') {
    throw new Error('Set MARKET_DATA_SOURCE=dexscreener to enable read-only collection.');
  }
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required.');
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('Invalid local database configuration.');
  }
  // node-postgres accepts query parameters that override the authority hostname.
  // For this local prototype, reject every query/fragment before passing the URL
  // to the driver rather than maintaining a second URL interpretation.
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error('Use a local PostgreSQL URL without query parameters or fragments.');
  }
  const tokens = (env.TRACKED_TOKEN_MINTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  validateFeedTokens(tokens);
  return { databaseUrl, tokens };
}
