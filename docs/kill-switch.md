# Kill switch and losing-streak breaker (BOT-16)

Two safety stops that work on every bot, paper today and live later.

## Global kill switch

**What it does.** One action stops **all buying on every bot**. It never blocks
selling: stop losses, take-profits, trailing and time stops keep running, so open
positions stay protected.

- **Stop all buying.** Two steps, so one busy bot cannot delay the stop for everyone:
  1. The switch flips in a short transaction that locks only the kill-switch row. From
     that moment no bot can create a buy order or a buy execution attempt (the database
     refuses them itself, migration 0016), and a buy already in flight settles with no fill.
  2. Open buy orders are cancelled bot by bot. A bot whose lock is busy is skipped and
     reported (`botsNotYetCleared`); its open buys still cannot execute, and engaging
     again clears them.
- **Stop buying and sell everything** (optional). The exit manager also closes every
  open position of every bot in `paper` mode, with close reason `kill_switch`, at its
  next check (`pnpm exit once` / `pnpm exit watch`). No price quote is needed to decide.
  Bots switched `off` are not managed by the exit manager and are not sold; switch
  them back to `paper` if you want them flattened too.
- **Release.** Bots in `paper` mode may buy again, except bots paused after a losing
  streak. Releasing needs a typed confirmation (`resume buying`) and refuses if the switch
  changed since you looked (`KILL_SWITCH_CHANGED`). Engaging needs neither, so it always
  works in an emergency, even from a stale dashboard tab.

Every engage and release is written to the audit log (actor, sell-all, revision) and
opens or resolves an alert (category `kill_switch`; turning on "sell everything" opens a
second alert, `sell_all`) on the same alert queue the monitor already delivers. Telegram alerts and commands (BOT-26) will read from it.

### Where to reach it

| Where        | How                                                                                                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard    | The **Emergency stop** panel at the top of the bot controls.                                                                                                                                                              |
| Command line | `pnpm kill status`, `pnpm kill engage [--sell-all]`, `pnpm kill release --confirm "resume buying"`                                                                                                                        |
| HTTP (local) | `GET /control/kill-switch`; `POST /control/kill-switch` with `{"action":"engage","sellAll":false}` or `{"action":"release","confirmation":"resume buying"}`. Same local session and CSRF rules as the rest of `/control`. |
| Telegram     | Not yet: BOT-26 will call the same database functions.                                                                                                                                                                    |

### How fast

The drill test (`packages/db/src/kill-switch.test.ts`) runs 8 bots writing buy orders
in a tight loop, engages the switch and checks that, as soon as engage returns, no bot
holds an open buy and none can create one. Engage takes well under a second in the
test (typically 50–250 ms); the requirement is under 5 seconds. A second test holds one
bot's lock open and checks the stop still takes effect for every bot within 5 seconds.

## Losing-streak breaker

Each risk profile has a **losing streak limit**: the
number of consecutive losing closes after which the bot should stop (seeded values:
Conservative 3, Balanced 4, Aggressive 5, Degen 5). BOT-13 already
counts the streak and refuses new entries at the limit. BOT-16 adds:

- **Pause.** When the streak reaches the limit, the bot is marked _paused_. It cannot
  buy; its exits keep running. Pending buys are refused when they next try to execute.
- **Audit and alert.** A `bot.paused` audit entry and a `losing_streak` alert for that bot.
- **Resume.** Only the owner resumes a paused bot (dashboard button, or
  `POST /control/bots/:id/resume` with the bot's revision). Resuming resets the
  streak to zero, audits `bot.resumed` and resolves the alert.

Pausing is different from switching a bot `off`: _off_ cancels its orders and stops
managing its positions; _paused_ only stops buying.

## Rules the database enforces

- One kill-switch row that cannot be deleted; every change bumps its revision.
- While the switch is on or the bot is paused: no new buy order that could trade (any
  status except vetoed, cancelled or failed), no reopening of a finished buy, no moving an
  order to the buy side or to another bot, and no buy execution attempt. A buy already in
  flight settles with no fill. Vetoed buy records and all sells are still allowed.
- Lock order is always **bot → kill switch → orders**. The buy check takes the bot's
  key-share lock first, so a writer that did not lock its bot cannot deadlock with an
  engage (the drill found and now guards this).

## Rolling back

Reverting migration 0016 lets bots buy again. If the switch was on or any bot was paused,
it records `kill_switch.removed_by_rollback` in the audit log (with that state) and closes
their open alerts, so the history and the alert feed stay truthful.

## Limits

- Paper only, like the rest of the system: live trading is still refused.
- "Sell everything" depends on the exit manager running (`pnpm exit watch`).
- Telegram access to the kill switch waits for BOT-26.
- Every buy check briefly share-locks the single kill-switch row. Fine at paper scale;
  revisit before the live executor.
