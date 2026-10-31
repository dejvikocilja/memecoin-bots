# Token safety evidence (BOT-9)

The scanner is an auditable, read-only evidence pipeline. It never signs, sends,
chooses a trade, sizes a position or approves an order. A passed scan is not a
safety guarantee. Strategies and future risk management must reevaluate current
evidence under their own validated policy.

Run migrations, then scan one explicit mint:

```sh
pnpm db:migrate
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com pnpm scan:safety <mint> --once
# Optional complete JSON engineering policy file (not a credential file):
pnpm scan:safety <mint> --once --policy ./my-safety-policy.json
```

`DATABASE_URL` uses the existing protected configuration boundary and must point
to a local database. Do not put credentialed URLs in CLI arguments. The command
uses the shared redacted JSON logger and returns a `safety.report` event. Process
exit 0 means the scan completed, including a denial; consumers must read
`fields.decision.passed`. Invalid configuration, unavailable database or invalid
arguments return exit 1 with a fixed error code. This explicit `--once` command
has no implicit watchlist, polling, public writes or engine lifecycle integration.
All validation uses local mock RPC and disposable PostgreSQL, never mainnet.

## Supported collection and precise limits

`SafetyRpc` allows only `getAccountInfo`, `getTokenSupply`,
`getTokenLargestAccounts` and `getMultipleAccounts`. Each instance has a four
request budget, serial concurrency, five-second request deadlines and 128 KB
streaming response cap. HTTP 429 establishes bounded 1–60 second backoff; this
single scan reports unknown rather than retrying unboundedly. A scan finishes
within four request deadlines (plus decoding and database IO). Failure
messages never include endpoints, response bodies or provider errors. Only
normalized public facts enter persistence.

Classic SPL mint accounts must have the canonical token program owner, exactly
82 decoded bytes, initialization, bounded decimals and valid authority option
tags. Mint/supply/holder responses must agree on confirmed context slot, supply,
decimals and amounts. Nonexistent accounts, unknown programs, Token-2022 layouts
and unknown extensions remain unknown. Syntax-valid addresses alone never prove
mint existence. Supply and token-account raw balances use little-endian u64 and
bigint/decimal strings; no floating point amount arithmetic is used. Node 24 raw
JSON token validation rejects fractional, exponent or unsafe consumed numeric
fields before their rounded Number values can be used. Known unused account
`rentEpoch` and `lamports` metadata are validated as unsigned u64 directly from
the exact lexical token and discarded; this handles the normal rent-exempt
`rentEpoch=18446744073709551615` without rounding it into evidence. Optional
display-only `uiAmount` is discarded, never evidence.

Largest-accounts RPC returns at most twenty **token accounts**. The collector
resolves those accounts, validates mint/program/state/balance and aggregates by
token-account owner. A top-owner lower bound exceeding policy can prove a
failure. This collection cannot prove complete beneficial ownership or developer
attribution. No LP, burn or locker account is excluded by a label. Incomplete
enumeration, invalid denominator, zero supply, unresolved owners and inconsistent
slots cannot establish a concentration pass.

There is currently **no positive live adapter** for authenticated pool-to-LP
mapping plus burn/withdrawal restrictions, corroborated developer attribution,
complete holder enumeration, a route/account/mint/amount-specific unsigned sell
simulation, or coordinated bundle holdings coverage. LP, sell and bundle checks
therefore explicitly report `unknown/UNSUPPORTED`; holder evidence can fail but
cannot pass live. Missing coverage always denies. An RPC simulation's `err=null`,
a DEX quote, a burn label or a clean limited transaction history is not proof.
The CLI consequently cannot report an all-check live pass with current adapters.
Completing protocol-specific positive verification remains a stated scope gap,
not a configurable bypass.

## Engineering policy and evidence semantics

All six checks are mandatory for every policy. `pass`, `fail` and `unknown` are
computed on every request from validated observations, provenance and expiry;
no reusable permissive decision is cached. Any failed/unknown check denies,
even at a low minimum score. All weights, thresholds and TTLs are transparent
engineering defaults, not facts from the specification or calibrated risk scores:

| Check                                    | Weight |
| ---------------------------------------- | -----: |
| Mint authority revoked                   |     20 |
| Freeze authority revoked                 |     15 |
| LP burn or active restrictive lock       |     20 |
| Complete owner/developer concentration   |     20 |
| Verified amount-specific sell simulation |     15 |
| Documented bundle coverage               |     10 |

Default policy JSON (all fields required if supplying a file):

```json
{
  "version": "engineering_v1",
  "minScore": 100,
  "maxOwnerBps": 1000,
  "maxDeveloperBps": 500,
  "maxAgeMs": 60000,
  "refreshMs": 60000,
  "negativeCacheMs": 10000
}
```

Owner/developer limits use exact cross-multiplied basis-point comparisons; equality
is allowed. TTL/max age/refresh are at most 300 seconds, negative caching at most
60 seconds. Every check has its own observation/expiry, source/reference,
confirmed context slot (null if unsupported), coverage and bounded reason code.
LP/simulation/bundle positive fixtures are explicitly `scenario_fixture` and the
decision is marked `scenario=true`. These are synthetic evaluator exercises,
never manufactured mainnet evidence. The synthetic bundle heuristic is solely a
scenario contract, not a shipped coordinated-holdings detector.

## Durable state and concurrency

Migration `0009_token_safety` creates immutable evidence snapshots and immutable
policy evaluation history, a unique chain/mint/pool cache and fenced database
leases. Single-flight avoids duplicate in-process refresh. Thirty-second
DB-clock leases coordinate processes and allow crash recovery. An expired/replaced
lease cannot overwrite newer evidence; database refresh timestamps order writes.
Snapshots and evaluations reject UPDATE, DELETE and TRUNCATE. Cache survives
restart. Policy fingerprints include the entire validated versioned policy;
a stricter policy reuses facts but computes a new denial and evaluation record.
Future code must not read `tokens.safety_passed` as authoritative: it is a summary
associated with one snapshot and policy fingerprint in `safety_details`.

Expired subchecks deny even while a refresher is busy or unavailable. A competing
scan can return `refresh=pending` and explicit unknown evidence when no snapshot
exists. Collection failures produce a short negative cache; corrupt or
scope-mismatched cache data denies. Decision, token summary and safe audit event
commit in one transaction. Evidence collection and decision persistence have
separate atomic transactions so a reporting failure cannot erase collected facts.
Existing append-only audit protections remain in force.

Tests cover per-check synthetic good/adverse/unknown outcomes, exact owner
aggregation, stricter policies, expiry, malformed providers and numeric tokens,
bounded requests, redaction, real database restart/cache/lease/fencing/history,
transaction rollback, and an actual HTTP mock RPC → PostgreSQL → CLI JSON report.
The migration lifecycle tests target 0009 even if later task migrations exist.

Official RPC contracts: [account info](https://solana.com/docs/rpc/http/getaccountinfo),
[largest token accounts](https://solana.com/docs/rpc/http/gettokenlargestaccounts),
[simulation](https://solana.com/docs/rpc/http/simulatetransaction).
