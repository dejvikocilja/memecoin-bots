# Monitoring and automatic audit (BOT-12)

Run migrations before starting the engine. Start the engine and watchdog in **separate,
independently supervised processes**:

```sh
pnpm db:migrate
pnpm dev:engine
# A separate terminal/supervisor:
pnpm monitor watch
pnpm monitor health
pnpm monitor alerts
```

`health` and `alerts` are read-only snapshots of open incidents, bot heartbeat state,
and the last RPC/discovery observation. They emit shared structured logger output.
`unknown_stale` means a service observation is older than 30 seconds; it is not a
fresh healthy result. Offline fixtures with discovery disabled report RPC as
`disabled_offline`. API `/health` remains the API process readiness endpoint; use
the monitoring CLI for bot/provider health. No dashboard or Telegram delivery is
implemented here.

## Liveness, progress, and timing

Every persisted paper bot has an expected-heartbeat row, including bots which have
never started. The independent observer scans every five seconds. A heartbeat older
than **40 seconds**, or a bot with no first heartbeat 40 seconds after becoming
expected, opens one `bot_stalled` incident. Repeated observations update the same
incident; fresh progress resolves it. A later stall creates a new incident. Mode
`off` and an explicit graceful engine shutdown disable the expectation and resolve
an existing incident on the next observer poll. A crash does not disable it.
Switching an off bot back to paper creates a fresh expectation; start/restart its
engine to acquire it.

The engine acquires known persisted paper bots at startup, with a random owner and
monotonically increasing per-bot generation. A concurrent healthy owner cannot be
replaced. After 40 seconds without progress a new engine may acquire the lease;
the old generation cannot publish or release the replacement's lease. New bots
created while an engine is already running are expected immediately and need an
engine restart to be managed by this scaffold.

Current managed ticks run every ten seconds and read each bot's persisted mode.
A successful read for a still-paper bot publishes **scaffold liveness**. No strategy,
risk manager, order executor, or position-management loop exists yet. This heartbeat
therefore proves only that the engine event loop and this policy-read tick work.
Future bot runtimes must inject and await their actual work via `ManagedBotTick`
and `publishBotProgress`, and honor the cancellation signal. The publisher runs
only after the awaited tick completes; a failed or stuck tick cannot refresh it.
Ticks have a five-second deadline, never overlap, and stop cancellation suppresses
late progress. The deadline cannot forcibly stop a misbehaving future adapter's
side effects; adapters must honor cancellation before making state changes.

The watchdog's bot polling is independent of its RPC polling. Its DB calls have a
two-second client deadline and 1.5-second server statement timeout. Under a healthy,
supervised monitor and DB, ordinary logger output and no pending delivery backlog,
the 40-second stale threshold + at most five seconds to poll + bounded SQL/read
places durable stall detection and structured emission within **50 seconds** of the
last confirmed heartbeat (under one minute). No timeout on an optional RPC request
can hold up this scan. Engine DB calls use a five-second client deadline and
4.5-second server timeout. Engine shutdown owns timer, lease and DB-pool cleanup.

This is not an infrastructure availability guarantee: a dead monitor, unreachable
DB, blocked stdout, or an excessive delivery backlog can prevent timely alerts.
Supervise both processes and monitor their infrastructure externally. DB failures
emit only fixed `MONITOR_DB_UNAVAILABLE` codes when logging remains available;
DB-dependent durable evidence cannot be promised while the DB itself is down.

## Alerts and delivery

Categories are `bot_stalled`, `rpc_unhealthy`, and `discovery_unhealthy`. Metadata is
limited to IDs, timestamps, transitions and fixed codes (`heartbeat_stale`, `http`,
`rpc`, `malformed`, `timeout`, `transport`, `unavailable`). Provider URLs, raw errors,
HTTP bodies and arbitrary payloads are excluded. Incidents are mutable dedup/state
rows; their opened/resolved events are append-only, with database-clock timestamps.
The unique open category/entity pair and transaction lock deduplicate across
watchdog restarts and concurrent observations.

The supported notification sink is **durable event + shared redacted logger**:
opened events log at error level, resolved events at info level. Delivery receipts
are separate from immutable events. Unreceipted events retry after restart; a
crash after output but before receipt can repeat an event, so downstream consumers
must deduplicate by event ID. Up to 100 pending events are emitted per poll. A
failed sink leaves them unreceipted. This outbox is the integration boundary for
future optional notification channels, not evidence of third-party delivery.
Only the logger channel is implemented.

RPC probing is enabled for discovery or mainnet market-data mode, uses read-only
[getHealth](https://solana.com/docs/rpc/http/gethealth), and validates HTTP success,
JSON-RPC version/ID and the exact `ok` result. Fetch and body parsing have a
four-second deadline and stop cancellation. Provider response errors, malformed
responses, timeout and recovery feed the same durable incident lifecycle.
Discovery transport reconnect/ready and transaction RPC failure/success transitions
also feed durable health; recovery of one source cannot clear another outstanding
source failure. Sparse or absent market events are never interpreted as failure.
A recorded discovery gap remains a historical data-coverage limitation even after
connectivity recovers.

## Automatic audit and startup

Database triggers run in the same transaction as business writes. An audit insert
failure rolls back the write, including direct SQL callers. Covered entities:

- Orders: INSERT and updates of bot/position/token/side/mode/status/amount/slippage/
  veto reason. Canonical actions are `order.created`, `order.updated`, and explicit
  `order.vetoed`. Only whitelisted veto category codes are copied; other free text
  becomes `unspecified`. No order reason, failure reason or client id is copied.
- Bots: strategy identifier, profile association, wallet association, mode and paper
  bankroll. Strategy-parameter changes record a boolean without copying JSON.
- Wallets: cap creation/change. Wallet labels, addresses and encrypted storage details
  are not copied by these policy triggers.
- Risk profiles: numeric sizing/exit/limit policy fields, optional safety mode, and
  at most 16 ladder steps containing only numeric gain/sale fractions. Malformed or
  oversized legacy ladders are marked omitted without copying their content.

Policy creation/change uses `config.created` / `config.changed` with
`source: database_trigger`. No-op policy updates do not generate canonical events.
Changes to display labels and names are intentionally outside canonical policy
coverage. Automatic deletion auditing is not added by BOT-12.

`setAuditActor` sets transaction-local `owner`, `system`, or `bot:<uuid>` attribution;
the DB validates the context and falls back to `system/database`. Legacy
`recordAudit` stays backward compatible and accepts application-provided details:
callers remain responsible for its data hygiene. Future risk callers can use
`recordRiskVeto` with a typed fixed category for a complementary `risk.vetoed`
intent event. Once an order exists, its canonical `order.vetoed` comes from SQL.
Wallet provisioning/profile edit application audit actions may remain complementary
intent events, with distinct names; callers must not manually duplicate canonical
`config.changed` or `order.*` events.

Engine and watchdog boot each durably record `runtime.boot` and a fingerprint of an
explicit nonsecret startup-policy snapshot. A subsequent changed safe snapshot
records `config.changed`; identical restarts or provider credential/endpoint changes
do not. Startup fails closed with a fixed error if this durable audit cannot be
written. API startup is not part of these engine/monitor boot events. Audit history
continues to reject UPDATE, DELETE and TRUNCATE. Migration 0012 down removes its
monitoring tables/state but preserves the existing append-only canonical audit
history; back up monitoring history before an intentional rollback. Reapplying
rebuilds expected rows for persisted bots, without inventing prior heartbeats.
