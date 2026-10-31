# Paper execution (BOT-11)

The broker consumes an immutable, already-sized approved intent attached to an existing
PostgreSQL order. It does not generate signals, size orders, choose exits or certify
safety. The production executor factory accepts paper only. The live adapter factory
substitution exists only for contract tests; no signing, transaction construction,
transaction submission or real-money wallet access is implemented.

## Run and recover

Apply migrations with `pnpm db:migrate`. From the repository root:

```bash
# Explicit owner demonstration, using the committed hypothetical scenario:
pnpm --filter @memebots/engine paper manual-demo ../../docs/paper/scenario.json

# Process an existing order with a previously registered approved intent:
pnpm --filter @memebots/engine paper process ORDER_UUID IDEMPOTENCY_KEY scenario.json
pnpm --filter @memebots/engine paper inspect ORDER_UUID
pnpm --filter @memebots/engine paper recover ORDER_UUID SAME_IDEMPOTENCY_KEY scenario.json
pnpm --filter @memebots/engine paper cancel ORDER_UUID
```

Paths in these pnpm commands resolve from `apps/engine`. The scenario file supplies
`model`; processing uses the immutable intent in PostgreSQL, never scenario quantities.
`registerPaperIntent` is the trusted future risk-manager integration boundary. No
production risk manager currently invokes it. The CLI cannot register arbitrary
risk-manager approvals. `manual-demo` creates a separate bot/order with the persistent
`manual_paper_scenario` marker and reason `MANUAL_PAPER_SCENARIO_NOT_RISK_APPROVAL`.
Its wallet row is only a generated public label, never a key or funded wallet.
The supplied example is a hypothetical scenario, not a calibrated fee recommendation.

Before waiting, the CLI prints the order ID and idempotency key. SIGINT/SIGTERM closes
the pool and interrupts latency. Recovery with the same key reuses the saved model,
seed, draws, quantity, quote and UTC deadlines. Quote acquisition is serialized across
processes; a durable claim without saved evidence after a crash becomes explicitly
unavailable on recovery instead of being silently refetched. It never refreshes a stale quote or
rerolls an unsuccessful outcome. An unresolved attempt blocks a different key until
recovery completes. A terminal unavailable attempt can be followed by an explicit
new key; partial fills permit another attempt for the remaining approved input.
Filled/failed/cancelled orders cannot start a new attempt. Cancellation does not erase
previous partial fills. There are no pending bankroll or position holds to leak.

`PAPER_QUOTE_MOCK_URL=http://127.0.0.1:PORT` explicitly selects a local HTTP fixture
provider; only loopback HTTP origins are accepted. The same request validation runs,
and persisted provenance says `local_mock`. `PAPER_QUOTE_SOURCE=dex_snapshot` exercises
the explicit `DEXSCREENER_SNAPSHOT_NOT_EXECUTABLE_QUOTE` unavailable outcome. No BOT-7
snapshot gate or receipt/source timestamp semantics were changed.

## Quotes and honest evidence

The read-only adapter makes only `GET https://api.jup.ag/swap/v2/order` without taker,
payer, receiver or referral. It requests ExactIn, the approved slippage, and excludes
JupiterZ, Dflow and OKX. Initial support is non-gasless Metis with one to eight
sequential unsplit hops. A wrong route, mint, raw amount, mode, fee currency or extra
wallet charge is unavailable. Split/RFQ routes are deliberately unsupported. No
legacy endpoint or paid fallback is used. API credentials are optional and use shared
registered-secret configuration. Errors never persist raw provider payloads.

The documented keyless endpoint supports quote-only requests. Its current response
omits source timestamp/context slot and AMM fee amounts; the platform amount may
also be absent. `quoteRequirements.freshnessPolicy` must therefore be explicit:

- `bounded_request_age`: **MODEL** request-age policy. The adapter persists request
  start/receipt/expiry, response identity when present, null chain context, partial fee
  completeness, known fee currencies/rates and unknown fee component names. This is
  a simulation from an amount-specific net quote, with no claim of source-chain age
  or actual transaction executability.
- `chain_context`: the current Jupiter V2 adapter reports unavailable. It does not
  invent a source slot by querying a fresh current chain slot.

`fullyObservedCosts=true` always reports unavailable with the current model fee
scenario. Unknown AMM/platform amounts are never manufactured as zero. Quote-only
signature/priority/rent estimates are retained separately as provider estimates with
no taker context; they do not become observed actual costs. Network/priority costs
come from the explicitly selected `MODEL` scenario, including explicitly chosen zero.
Rent/account creation costs remain unknown and outside the cash scenario. Results
must not be represented as comprehensive actual execution costs or profitability.
USD valuations and SOL/USD remain null.

The provider's net exchange amounts already reflect embedded swap/platform charges;
the broker records fee metadata without deducting those charges again. It applies
extra adverse slippage once, rounding output down. The effective minimum is the
maximum of the provider threshold and the approved minimum rounded up. Equality
passes; output below the effective minimum fails before hypothetical submission.

HTTP timeout is two seconds, also checked with a monotonic clock. Quote lifetime is
at most five seconds from **request start**, bounded by the selected maximum age,
order expiry and any explicit provider expiry. Freshness is checked again after
simulated latency. Backward/future clocks or elapsed deadlines fail closed; persisted
UTC deadlines permit conservative restart recovery. These timing limits are
engineering assumptions, not measured distributions or proof upstream data is fresh.
The CLI's durable PostgreSQL budget caps quote requests at 20/minute with at least
two seconds between requests, including across restarts/concurrent CLI processes. The CLI pool has two connections;
a caller sharing its pool with the durable request-budget adapter must provide at
least two connections, because quote acquisition retains one connection.
Denied requests do not retry in the background.

## Accounting and model

`paper-v1` explicitly selects bounded latency, adverse slippage bps, failure
probability/stage, partial-fill bps and network/priority lamports. A cryptographic seed
and deterministic SHA-256-derived draws are committed before IO/latency. The initial
partial fraction defines the hypothetical input actually quoted; the executor never
increases the approved quantity. A tiny partial amount that rounds to zero is rejected.
Failure probability is represented at one part per million resolution. These are
user-selected distributions, not empirically calibrated execution realism.

Each settlement transaction locks the persisted order, its bot bankroll and relevant
position. It rechecks the immutable intent, modes, status, approval, available SOL,
input holdings, saved quote/model/draws and exact simulated result. Principal plus
modeled fees must be affordable before hypothetical submission, even for a simulated
submitted failure. Such a failure charges the configured fees once and has no fake
zero-token fill. Preflight/slippage/expiry/unavailable/cancel outcomes charge no fee.

A successful transaction appends the fill and result, debits/credits the bankroll,
updates existing `positions`, binds the exact created position to its buy order, advances order status and appends safe audit details
atomically. No second holdings ledger exists. Acquisition basis includes selected
network/priority fees; sale basis is removed proportionally, rounded up for
conservative realized PnL. Raw balances, quantities and basis math use bigint/exact
PostgreSQL numeric. Position and fill prices use PostgreSQL numeric division; decimals
0–18 and amounts above 2^53 are tested. Paper fills have no signature and preserve
separate tax fee fields. Fills, intents, attempts, quote evidence, results and audit
records reject mutation/deletion/truncation. A partial buy cannot attach to a later
replacement position after its originally associated position closes. Execution time
is resampled after all settlement locks so waiting cannot turn an expired quote into a fill.

Migration `0011_paper_execution` also permits zero-slippage orders. Rolling it down
refuses while such orders exist, preserving the original stricter schema instead of
silently rewriting approved orders. Down/up lifecycle tests use disposable data.

## Evidence and limits

The tests cover deterministic replay, partial remainder, buys/sells, fee provenance,
exact minimum rounding, source/missing-evidence policy, unsafe numeric JSON tokens,
timeouts/oversize/errors, cancellation, interrupted latency, rollback after fill
insertion, concurrent funds/holdings protection and the CLI HTTP-mock-to-PostgreSQL
pipeline. A sanitized genuine two-hop V2 response is committed as a schema regression
fixture; its prices are not used as current market claims. An authorized public
keyless read-only smoke on 2026-10-31 returned a real Metis quote with null transaction
and no source slot or AMM fee amounts. No transaction was built, signed or sent.

Official sources checked 2026-10-31:

- [Current Jupiter Swap API and keyless quotes](https://developers.jup.ag/docs/swap)
- [Order API schema](https://developers.jup.ag/docs/api-reference/swap/order)
- [Fee inclusion and quote-only semantics](https://developers.jup.ag/docs/swap/order-and-execute)
- [V2 OpenAPI](https://raw.githubusercontent.com/jup-ag/docs/main/openapi-spec/swap/v2/swap.yaml)

The stricter original planning requirement for fully observed fees/chain freshness was
corrected by the saved BOT-11 supplemental decision. This implementation supplies
useful explicitly modeled paper results from live net quotes. Calibration, complete
on-chain fee observation, verified source-chain freshness and production live switching
remain future work.
