import pg from 'pg';

/** Anything that can run a query: a pool, or a client inside a transaction. */
export type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

export type Pool = pg.Pool;

export function createPool(
  connectionString: string,
  options: { max?: number; timeoutMs?: number } = {},
): pg.Pool {
  if (connectionString.trim() === '') {
    throw new Error('DATABASE_URL is empty. Copy .env.example to .env and set it.');
  }
  return new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    ...(options.timeoutMs === undefined
      ? {}
      : {
          connectionTimeoutMillis: options.timeoutMs,
          query_timeout: options.timeoutMs,
          statement_timeout: Math.max(1, options.timeoutMs - 500),
        }),
  });
}

/** Runs `fn` inside a transaction on one connection; rolls back if it throws. */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
