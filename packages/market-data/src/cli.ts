import { DexScreenerProvider } from './provider.js';
import { createMarketFeed } from './feed.js';
import { openPostgresSnapshotStore } from './store.js';
import { parseCollectorSettings } from './configuration.js';

/** No raw exception, provider payload, environment or connection URL reaches a log sink. */
export async function main(env: NodeJS.ProcessEnv, args: readonly string[]): Promise<void> {
  const { databaseUrl, tokens } = parseCollectorSettings(env);
  if (args.some((arg) => arg !== '--once')) throw new Error('Supported option: --once.');
  // Validate before opening a database or issuing a provider request.
  const provider = new DexScreenerProvider();
  const store = await openPostgresSnapshotStore({ connectionString: databaseUrl });
  try {
    const feed = createMarketFeed({ tokens, provider, store });
    if (args.includes('--once')) {
      const cycle = await feed.collectOnce();
      process.stdout.write(
        `${JSON.stringify({ event: 'market_feed_cycle', scheduledAt: cycle?.scheduledAt ?? null, tokens: cycle?.outcomes.length ?? 0, available: cycle?.outcomes.filter((o) => o.status === 'ok').length ?? 0, sourceFreshness: 'unknown', replayed: cycle === null })}\n`,
      );
    } else {
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      try {
        await feed.run(controller.signal);
      } finally {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
      }
    }
  } finally {
    await store.close();
  }
}

// This module is the dedicated collector entrypoint, separate from the trading engine.
await main(process.env, process.argv.slice(2)).catch(() => {
  process.stderr.write(
    'Market collection stopped. Check source, tracked mints and local database settings; no entries are authorized by this collector.\n',
  );
  process.exitCode = 1;
});
