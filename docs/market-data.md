# Market snapshots (BOT-7)

This read-only collector implements ADR-1's free DEX Screener snapshot feed. It can
schedule 200 tracked Solana mints in seven batches of at most 30 every 30 seconds.
Start with at most 10 allowlisted tokens, as ADR-1 specifies. Nothing here signs,
submits transactions, sizes orders or authorizes an entry.

## Run locally

Use Node 24, pnpm 10 and the local PostgreSQL instance described in the README.
Set these in the root `.env` (never commit that file):

```dotenv
MARKET_DATA_SOURCE=dexscreener
TRACKED_TOKEN_MINTS=<comma-separated Solana mint addresses>
DATABASE_URL=<your local PostgreSQL connection URL>
```

```bash
pnpm dev:market-data --once  # collect one cycle, then release the database lock
pnpm dev:market-data         # collect until SIGINT/SIGTERM
```

The source is off by default; an empty, duplicate, malformed or over-200 token list
fails before opening the database. Database connections must target loopback. The
collector creates only additive `market_feed_*` tables; it does not modify BOT-5's
domain tables. The package is usable independently while BOT-4 and BOT-5 are reviewed.
CLI errors contain fixed messages, never raw provider/database errors or environment
values. The process exits on a database failure; restarting resumes from committed state.

## What each record means

Each successful observation selects the token's base-token pair with the highest
known USD liquidity. Ties use pair address, DEX identifier and deterministic metric
ordering. Metrics describe that selected pair; they are not token-wide totals. A
selection change is visible in `pairAddress`; reports must split histories at that
change instead of treating different pools as one continuous series.

Prices retain the provider's decimal strings. The record includes USD liquidity,
5-minute/1-hour rolling volume and buy transaction counts when supplied, source and
pair provenance, local receipt time and explicit quality metadata. Rolling volume
observations overlap; adding them together double-counts activity.

**Known gaps:** DEX Screener does not supply a source quote timestamp, 1-minute volume,
or verified unique buyer counts through this endpoint. Those fields remain `null`;
`sourceFreshness` remains `unknown`. A buy transaction is not a unique buyer. Missing
data never becomes zero, and receipt time never becomes an upstream quote timestamp.
These observations are not tick data, OHLCV, executable quotes or proof of sellability.

`evaluateSnapshot` checks configurable receipt age and mandatory metrics. By default
it also requires a source timestamp, so current DEX observations are unusable for
that requirement. A research consumer may explicitly opt out of source timestamp
verification, but must still declare its metric needs. Momentum remains **not
evaluable** when its mandatory buyer/history data is unavailable. Do not synthesize
1-minute bars from overlapping 5-minute totals or silently reuse old observations.

## Limits, gaps and recovery

Official reference: [DEX Screener API](https://docs.dexscreener.com/api/reference),
`GET /tokens/v1/{chainId}/{tokenAddresses}`. The documented endpoint allows 30 mints
per request and 300 requests/minute. The collector spaces requests by one second,
uses a conservative 60-request rolling-minute budget and stops at 80% of that budget.
Normal 200-token polling uses 14 requests/minute. Every attempt, including retries,
is durably recorded before HTTP starts; restart cannot reset the local allowance.
There is no API key, paid fallback, subscription or automatic upgrade.

Responses are bounded to 2 MiB and ten seconds; redirects are refused. A transient
batch can retry once. `Retry-After` applies to all later batches/cycles, survives
restart and is bounded to 24 hours. A deadline, quota, missing token, invalid response
or outage becomes an explicit unavailable outcome. A slow cycle never queues old
polls. After an overrun/restart, `gapFrom` marks the unobserved interval; no backfill
or favorable synthetic fills are invented.

A PostgreSQL session advisory lock permits only one collector per stream. A cycle's
outcomes and checkpoint commit together. Replaying identical committed data is a
no-op; conflicting replays fail. Successful commits are immutable through database
triggers. `readTokenHistory({tokenAddress,from,to,limit})` returns bounded, ordered
snapshot and gap records for later backtests; `to` is exclusive. Paginate by the last
returned `scheduledAt` plus one millisecond. Historical availability is only as good
as the periods actually collected; unavailable records and gaps remain part of it.

## Checks and backup/restore

`pnpm check` runs offline provider/quality/scheduler tests. Set a dedicated test URL
to include PostgreSQL integration tests (CI requires them):

```bash
MARKET_DATA_TEST_DATABASE_URL=<scratch database URL> REQUIRE_MARKET_DATA_DB_TESTS=1 pnpm check
```

The capacity test runs the real decoder and scheduler against deterministic synthetic
HTTP responses for 200 tokens across 120 cycles: 24,000 outcomes, seven requests and
six simulated seconds per cycle. It checks scheduling headroom, not upstream coverage,
real network latency or a production SLA. Other tests cover malformed data, deadlines,
rate limits across restart, immutable history, exact decimal/null metadata round trips,
single-worker locks, transaction rollback and replay conflicts.

Stop the collector before backing up a local database. Keep the dump on protected
local storage; it contains all tables in that database, potentially including BOT-5
state. Use existing protected PostgreSQL connection settings (for example a local
service definition or password file), not a credential-bearing URL in shell history:

```bash
pg_dump --format=custom --file=market-feed.dump <local database name>
createdb <new scratch restore database name>
pg_restore --no-owner --dbname=<new scratch restore database name> market-feed.dump
```

Restore into a new database first. Compare cycle/record/request/backoff row counts,
read token history and checkpoint values, then run a single collection cycle against
the restored database. Never drop or overwrite the original to test recovery. Before
resuming actual research, refresh observations and preserve the downtime gap. Disk
retention and archival must be planned for sustained collection: at full capacity
the collector records roughly 576,000 token outcomes per day.
