import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createAppContext } from '@memebots/config';
import { createPool, SafetyStore } from '@memebots/db';
import { DEFAULT_POLICY, validatePolicy } from './evidence.js';
import { SafetyRpc } from './rpc.js';
import { SafetyScanner } from './service.js';

/** Explicit single-mint read-only scan. Config rejects live/signing material before opening IO. */
export async function runSafetyCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  sink: (line: string) => void,
): Promise<number> {
  const context = createAppContext(env, sink);
  if (!context) return 1;
  let pool;
  try {
    const [mint, once, ...rest] = args;
    if (
      !mint ||
      once !== '--once' ||
      (rest.length !== 0 && (rest.length !== 2 || rest[0] !== '--policy'))
    )
      throw new Error('INVALID_ARGUMENTS');
    let policy = DEFAULT_POLICY;
    if (rest[1]) {
      const bytes = await readFile(rest[1]);
      if (bytes.byteLength > 4096) throw new Error('INVALID_POLICY');
      policy = validatePolicy(JSON.parse(bytes.toString('utf8')));
    }
    pool = createPool(context.config.databaseUrl.reveal(), { max: 2 });
    const scanner = new SafetyScanner(new SafetyStore(pool), async (token, scope, ttl) =>
      new SafetyRpc(context.config.discovery.rpcUrl).collect(token, scope, ttl),
    );
    const report = await scanner.scan(mint, null, policy);
    context.logger.info('safety.report', report);
    // A completed denial is a valid scan, not an IO/process failure.
    return 0;
  } catch {
    context.logger.error('safety.scan_failed', { code: 'SAFETY_SCAN_FAILED' });
    return 1;
  } finally {
    await pool?.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runSafetyCli(process.argv.slice(2), process.env, (line) =>
    process.stdout.write(line + '\n'),
  );
}
