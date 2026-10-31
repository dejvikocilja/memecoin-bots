# @memebots/db

PostgreSQL schema, migrations and data access. Bot state lives here, never only in
memory, so a restart resumes cleanly (spec section 7).

## Migrations

Plain SQL files in `migrations/`: `NNNN_name.up.sql` and a matching `NNNN_name.down.sql`.
Each one runs in its own transaction and is recorded in `schema_migrations`. A
PostgreSQL advisory lock stops two processes from migrating at the same time.

```bash
pnpm db:migrate        # apply everything pending
pnpm db:status         # list migrations and when they were applied
pnpm db:rollback       # revert the newest migration
pnpm db:rollback 3     # revert the newest three
```

All three read `DATABASE_URL` from the root `.env` (or the environment) through the shared config loader from BOT-4, which only accepts a database on this computer and keeps the password out of the logs. Never edit a migration that has been merged; add a new one.

## Tables

| Table           | What it holds                                                                                                                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `risk_profiles` | The numbers behind each profile: size, stop loss, take-profit ladder, trailing stop, min reward:risk, limits. Position size is capped at 5% by the database itself. Rows are seeded by BOT-10.     |
| `wallets`       | Hot wallets: label, **public key only**, optional spend cap. Private keys are never stored here.                                                                                                   |
| `bots`          | Strategy + parameters, risk profile, wallet (one wallet per bot), mode (`off`/`paper`/`live`, default `paper`), paper bankroll. A bot cannot be `live` without a wallet.                           |
| `tokens`        | Mint, symbol, decimals, and the latest safety scan result.                                                                                                                                         |
| `positions`     | Open or closed holdings: entry price, size, remaining size, cost, stop, high-water mark for the trailing stop, take-profit steps still to fire, realised PnL. One open position per bot and token. |
| `orders`        | Every order the risk manager approved or vetoed, with its reason. `client_order_id` makes retries safe.                                                                                            |
| `fills`         | What actually executed: amounts, SOL and USD prices, fees, slippage, wallet and transaction signature. **Append-only**; it is also the tax record (BOT-2).                                         |
| `audit_log`     | Every order, veto and config change. **Append-only**.                                                                                                                                              |

Conventions: raw token amounts and lamports are integers (`numeric(39,0)`, `bigint` in
TypeScript); prices and fractions are exact decimals (`numeric`, decimal strings in
TypeScript). Every position, order and fill records whether it was `paper` or `live`, so
the two never mix in reports.

## Using it

```ts
import { createPool, loadOpenPositions, migrateUp, recordAudit } from '@memebots/db';

const pool = createPool(process.env.DATABASE_URL ?? '');
await migrateUp(pool);
const open = await loadOpenPositions(pool); // everything the exit manager needs after a restart
```

## Tests

The tests run against a real PostgreSQL database named in `TEST_DATABASE_URL`. Its name
must end in `_test` because the tests wipe it. Without it the database tests are skipped
locally; CI always runs them.
