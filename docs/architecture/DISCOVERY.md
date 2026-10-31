# Pool and launch discovery (BOT-6)

The optional engine listener publishes read-only observations at **confirmed** commitment
on the in-process `DiscoveryBus`. `MarketDiscoveryEvent` is exported by `@memebots/core`:
`token-launched`, `bonding-curve-completed`, and `pool-created`. Each observation carries
its Solana program, protocol, transaction signature, slot, source event/instruction,
local observation time and semantic deduplication ID. A launch and completion are separate
facts; a completion does not assert that a destination pool exists or that a trade is safe.
No signing, wallet loading, order placement or transaction submission is implemented here.

## Enable and observe

The listener defaults disabled. The shared startup loader accepts only `paper` mode;
`live` and `off` startup values are rejected. The lower-level engine factory's `off`
mode never starts discovery. Node 24 and pnpm 10 are required. The engine and smoke
commands read the root `.env` when present, with shell environment taking precedence.
Use the non-secret demo defaults from `.env.example` (including required `DATABASE_URL`),
and opt in through the shell:

```sh
MARKET_DATA_ENABLED=true BOT_MODE=paper pnpm dev:engine
```

`SOLANA_RPC_URL` and `SOLANA_WS_URL` default to Solana's free public mainnet endpoints.
Only HTTP(S)/WS(S) URLs are accepted. Discovery is independent of `BOT_MARKET_DATA`:
leave that setting at `fixtures` for free public discovery without a Helius key. The shared
config loader validates and wraps endpoints; they reveal only at the provider boundary.
All engine/smoke output uses the shared redacting logger. Endpoint values and raw provider
errors are never logged; URLs may contain credentials. To run a bounded read-only smoke and print counts
and health without enabling the engine:

```sh
pnpm --filter @memebots/engine smoke:discovery --duration-ms 30000
```

The smoke validates the same startup settings, explicitly enables discovery, stops after
1–300 seconds, and reports a structured `discovery_smoke_summary` log with status
before shutdown. Zero observations prove neither source coverage nor a healthy event rate.
`maxNotificationToPublishMs` measures local receipt to publication, including RPC enrichment
when needed; it is not chain-to-bus latency.

Consumers subscribe using `createDiscoveryBus().subscribe(handler)` and receive a removal
callback. The engine accepts an optional `discovery` lifecycle dependency. Consumers must
return promptly; the bus is synchronous and isolates consumer/error-reporter exceptions.
The listener exposes `status()` with connection readiness, queue depth, counters and gaps.

## Exact supported mainnet families

| Family                | Published source                           | Enrichment                                                                      |
| --------------------- | ------------------------------------------ | ------------------------------------------------------------------------------- |
| pump.fun              | `CreateEvent`, `CompleteEvent`             | Ordinary Anchor logs; Create/CreateV2 can trigger fallback event-CPI enrichment |
| PumpSwap              | `CreatePoolEvent`                          | Logs or event-CPI                                                               |
| Raydium CPMM          | `initialize`, `initialize_with_permission` | Exact instruction discriminators, argument lengths, and accounts                |
| Raydium CLMM          | `PoolCreatedEvent`                         | Logs or event-CPI                                                               |
| Raydium legacy AMM v4 | `Initialize2`                              | Exact non-Anchor instruction tag/length and accounts                            |
| Meteora DLMM          | `LbPairCreate`                             | Logs or event-CPI across five current initialization variants                   |
| Meteora DAMM v2       | `EvtInitializePool`                        | Logs or event-CPI across three current initialization variants                  |
| Meteora DAMM v1       | `PoolCreated`                              | Logs or event-CPI across six current initialization variants                    |

The program IDs, initialization hints and pinned schemas live alongside the decoder in
`apps/engine/src/market-data`. `schemas.json` includes immutable primary-source URLs,
commit IDs and full-file SHA-256 hashes. Only required schema fragments are vendored;
nothing is downloaded at runtime. Full current Borsh layouts are bounds checked, including
variable strings, nested structs and enums. Unknown future revisions fail closed. Raw quote
mints are preserved, including pump.fun's default-public-key native SOL sentinel; no quote
is assumed to be wrapped SOL. Decoded amounts stay as bigint internally and are not
converted through imprecise numbers.

A Solana `mentions` subscription is only a filter. Runtime invocation stacks and successful
ancestors attribute log events to the actual emitting program. Failed transactions,
caught failed CPI observations, foreign-program payloads and incomplete invocation proofs
are rejected. Enrichment resolves both outer and inner instructions against static keys
plus v0 lookup-table writable/readonly addresses. Event-CPI instructions require matching
successful execution provenance. Multiple entities in a transaction remain separate events.

Raydium LaunchLab, Meteora DBC and other launchpads/program revisions are excluded. Pump
completion is observed from ordinary logs; CPI-only or truncated completion logs are not
recovered by fetching every trade. CLMM truncated logs likewise have no account-only
fallback. This is explicit family coverage, not a claim to cover every product under a brand.

## Delivery, load bounds and gaps

One native WebSocket subscribes to all eight programs plus slots for heartbeat. All ACKs
must succeed before readiness. Error, close, missing ACK and heartbeat timeout enter one
reconnect path with capped exponential backoff and jitter. Every reconnection resubscribes
all programs; stale generations are ignored. Stop invalidates callbacks, clears timers,
closes the socket and aborts HTTP work.

Successful creation hints without a usable direct event trigger `getTransaction` at
confirmed commitment with transaction version 0 support. Ordinary swaps cause no HTTP
requests. Requests have an 8-second timeout, a global four-per-second cap, concurrency
two and at most three retries (four attempts). Null/indexing lag, provider errors and
429s retry with backoff; `Retry-After` delays the whole queue. The queue holds at most
256 signatures, including active/retrying work. Signature coalescing avoids duplicate
HTTP work, and semantic event IDs suppress duplicate log/CPI delivery. Each dedup cache
holds at most 20,000 entries for ten minutes. There is no persistent trading state here.

Overflow, exhausted retries, known-schema decode failures and unrecognized candidate
transactions increment counters and make health degraded. Disconnects permanently flag a
possible gap for that listener instance. This listener does not backfill, guarantee lossless
delivery, persist dedup across restarts or establish finality. Solana's public free service
can throttle/drop subscriptions and offers no few-second SLA. The BOT-5 database package
now exists; listener persistence, historical catch-up and stronger provider guarantees
remain separate work.

## Verification

Offline tests exercise all eight families with independently encoded schema fixtures,
genuine public mainnet Pump and Meteora DAMM v2 replay fixtures, variable strings, arbitrary
quote mints, failed/spoofed/truncated payloads, v0 keys, caught failed CPI and duplicate events.
Local real WebSocket/HTTP tests cover subscription ACK order, reconnect/resubscribe,
heartbeat and ACK timeouts, receipt-to-bus delivery under five seconds, null retry,
global 429 cooldown, queue overflow, timeout, shutdown abort and retry exhaustion.
The tests bind ephemeral loopback ports and need permission to listen in restricted sandboxes.

A 30-second read-only smoke on 2026-10-31 using the free public mainnet endpoints observed
seven pump.fun launches and two Meteora DAMM v2 pools. All subscriptions were ready, nine
observations were published, and the maximum local receipt-to-publication delay was 97 ms.
The run reported no gaps, overflow, exhausted retries or decode failures. That is live
evidence for those two families during one short window, not live verification of every
family or a chain-to-bus latency guarantee. Mainnet replay fixtures retain public signatures
and source provenance. `pnpm check` runs the repository's complete validation pipeline.
