# Per-bot hot wallets (BOT-8)

The runtime remains **paper-only**. API/engine startup still rejects signing material
and live mode. Nothing here signs or sends transactions. Offline owner provisioning
is separate from runtime startup; only the future live executor may load persisted
private material. Do not use a main wallet or fund these wallets during development.

## Offline provisioning

The wallet CLI has `create`, `provision`, `view`, `refresh`, `cap`, and `inspect`
local owner commands. Commands read bounded JSON metadata on stdin and return only public
JSON on stdout. Errors use fixed codes through the shared logger. The existing
validated `DATABASE_URL` environment setting selects a loopback database; there is
no wallet key environment setting. Use Node 24.

`create` requires `name`, `strategy`, `riskProfileId`, `paperBankrollLamports`,
`label`, `spendCapLamports`, and `vaultDirectory`. Amounts in input/output JSON are
canonical nonnegative decimal strings. A risk profile must already exist.
`provision` takes `botId` instead of the new bot fields and supports a legacy bot
whose `wallet_id` is null. A finite cap is required, including zero to disable spending.
The created bot is always paper mode. An existing bot's mode is preserved.

Both commands read the **raw 32-byte random encryption key on FD 3**. Provision this
through an OS secret manager or a protected local source separate from the vault.
The command never creates or persists this key. A regular input file must have no
group/other permissions; keep it outside the repository and the vault, and protect
backups separately. No password derivation is provided. Shell history must never
contain key bytes, keypair arrays, or credentials.

To import, set `"import": true` in metadata and supply FD 4. The only accepted format
is a UTF-8 JSON array of exactly 64 integer bytes, Solana's seed-plus-public-key
format (32 bytes each). Input is bounded to 1024 bytes. The derived Ed25519 public
key must match the last 32 bytes; base58 secret strings, mnemonics, 32-byte-only
seeds and mismatches are rejected. Only the derived public address is displayed.
Do not put the import in a command argument, environment variable or metadata JSON.

A command invocation with already-protected files can use this form (paths are
placeholders; do not create real key material to try it):

```sh
node --import tsx --conditions=@memebots/source packages/db/src/wallet-management/cli.ts create < /protected/public-metadata.json 3< /separate/master-key
node --import tsx --conditions=@memebots/source packages/db/src/wallet-management/cli.ts provision < /protected/import-metadata.json 3< /separate/master-key 4< /protected/import-input
```

Invoke key-bearing commands directly with Node from the repository root: package
manager subprocesses may close FD 3/4. The `pnpm wallet` convenience command is
for public `view`, `refresh`, `cap`, and `inspect` operations.

The vault path must be absolute, canonical (resolve macOS `/var` aliases to
`/private/var`), outside any directory containing `.git`, and contain no symlink
components. Its parent must exist. The command creates a missing final directory
with mode 0700; existing directories must be owner-only 0700 and owned by this UID.
Files use opaque wallet UUIDs, 0600 permissions, authenticated AES-256-GCM envelopes,
exclusive atomic publication, and file/directory synchronization. Existing files
are never overwritten. Encryption uses the existing BOT-4 envelope with wallet ID
inside authenticated plaintext. Database rows contain public addresses and policy/
accounting only: never key bytes, encrypted envelopes, key paths or vault paths.

Generated/imported buffers and copied encryption keys are cleared where practical.
JavaScript strings, KeyObjects, GC copies, process inspection and a compromised
owner process cannot be securely erased or isolated by this module. Encryption
protects stored bytes without the separately held key, not a compromised process.

## One wallet per bot and upgrades

Migration `0008_wallet_management` makes `bots.wallet_id` NOT NULL. Existing UNIQUE
and foreign-key constraints prevent sharing a wallet. New managed bots receive
metadata and their association in one transaction after durable encrypted storage.
Per-name advisory locks and per-bot row locks make provisioning retries/races return
the same public association. Changed retry policy/identity fields are rejected;
use the explicit `cap` command to adjust policy.

Before upgrading a database with walletless bots, stop services, back up the database
and encrypted vault, and run the direct Node `provision` command **against the existing 0001
schema** for each walletless bot. The offline command works before 0008. Then run
`pnpm db:migrate`. Migration fails with a safe prerequisite message until all bots
have an association; it never manufactures keys, deletes bots or invents paper
wallets. Baseline public-only legacy wallet metadata needs a matching explicit
import; it cannot be replaced with an unrelated generated wallet. Existing public
wallets with a null cap remain disabled until the owner imports/provisions and
chooses a finite cap. SQL fixtures use public-only test wallets; production
provisioning always writes owned encrypted material first.

A business-transaction failure rolls back public rows and removes the uncommitted
file. A process crash or uncertain COMMIT acknowledgement can leave a file without
a committed row; committed key material must not be deleted on an uncertain commit.
Run `pnpm wallet inspect` with `{"vaultDirectory":"/canonical/private/vault"}`
on stdin after stopping provisioning. It reports **opaque IDs only** as `orphanIds`
and `missingIds`. Check database recovery/commit state and backups before explicitly
removing confirmed orphan files. Missing material requires recovery from backup;
never regenerate a different key for an existing address. Temporary `.tmp` files
from an interrupted pre-publication write are encrypted and can be removed after
all provisioning processes stop. No automated orphan deletion or persisted-key
read/decrypt endpoint exists in this task. Inventory checks validate file type and
permissions, not ciphertext authenticity; future executor loading must authenticate
the envelope and derived address.

The down migration preserves wallets and encrypted files. It refuses to discard
reservation history or consumed budget; retain/reconcile that history before any
manual downgrade. An unused 0008 can be rolled down/up normally.

## Public balance and allowance

`pnpm wallet view` takes `{"botId":"<uuid>"}` on stdin. It shows bot/wallet IDs,
public address, cap, **paper bankroll separately**, observed on-chain lamports,
conservative usable lamports, observation timestamp/freshness, pending reservations,
consumed debit and effective spend availability. `refresh` takes the same input and
calls read-only `getBalance` at confirmed commitment using the existing validated,
redacted `SOLANA_RPC_URL`. There is no background RPC call on startup.

RPC calls have a five-second abort bound, bounded responses, strict JSON-RPC
validation and safe errors. Lamports are bigint internally and decimal strings in
JSON. Because JSON numbers can lose precision, RPC values above
`Number.MAX_SAFE_INTEGER` are rejected, never rounded. A missing, failed or older
than 60-second stored observation gives zero authorization availability; a failed
refresh does not renew its timestamp. Future executor dispatch must refresh/recheck
as appropriate. An RPC snapshot cannot guarantee funds survive later external
withdrawals, chain changes or fees. Avoid external wallet activity.

## Durable spend authorization contract

Future risk/executor code must call `reserveWalletSpend(pool, botId, idempotencyKey,
amountLamports, feeLamports)` before dispatch. The reservation covers the **total
maximum debit including network/priority/other SOL fees**. Wallet row locks serialize
requests across processes and restarts. The budget is:

```text
remaining cap = finite cap - cumulative settled debit - pending total debit
physical availability = conservative usable confirmed balance - pending total debit
available = max(0, min(remaining cap, physical availability)) while snapshot is fresh
```

A cap is a **cumulative authorization budget for this wallet**, with no daily reset,
restart reset, implicit sales recycling or reset on RPC refresh. This conservative
choice resolves the unspecified cap horizon. Null is disabled, never unlimited.
Zero/negative/noninteger buy amounts, negative fees, stale/unavailable balance,
parameter-mismatched retries, and over-limit requests fail closed. Amounts must fit
39 integer decimal digits; no floats/coercion. Same-key retries return the durable
original state and cannot reserve twice, including after finalization.

`settleWalletSpend` records actual total debit, no greater than reserved total;
consumed budget increases and conservative usable balance decreases. It may settle
zero only after a confirmed zero-debit outcome. `releaseWalletSpend` frees a pending
reservation only when dispatch is known not to have spent funds. Both are idempotent
for the same outcome; settle-after-release, release-after-settle, changed settlement
and excessive debit are rejected. Never release an ambiguous submitted transaction:
keep it pending and reconcile its confirmed outcome. There is no automatic expiry.

Refresh only lowers conservative usable funds; it **cannot replenish** funds after
settlement or external deposits, even if the RPC result is higher. This deliberately
avoids counting a pre-settlement RPC observation as newly available funds. Cap raises
through `pnpm wallet cap` (`botId`, `spendCapLamports`) restore policy budget only,
not physical availability. Physical balance increases/replenishment require a future
explicit owner reconciliation workflow with chain-finality/accounting evidence;
BOT-8 provides no reset button. External withdrawals can reduce availability to zero
while reservations remain pending. Do not claim an unchanged snapshot guarantees a
future transaction can pay. Live executor integration/reconciliation is future work.

Provisioning and cap changes write `wallet.provisioned` and `wallet.cap_changed`
public audit events in the same business transaction. These record the source
operation; future automatic entity-change auditing can add distinct canonical events
without duplicating these action names. SQL also rejects a cap below consumed plus
pending usage. The service boundary enforces reservations; arbitrary owner SQL can
alter accounting and is outside this application contract. There is no live executor
wired to it yet, so this is not a claim of live-fund protection.

Implementation references: [Solana getBalance](https://solana.com/docs/rpc/http/getbalance)
and [Node 24 crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html).
