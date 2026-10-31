# Contributing

## How work flows

1. Every change starts from a task in ProjectBrain project **BOT** (keys like `BOT-12`).
2. Work on the branch the task names: `task/BOT-<n>-<slug>`, from `main`.
3. Open a pull request titled `BOT-<n>: <task title>` with the line
   `ProjectBrain-Task: BOT-<n>` in its body.
4. Run `pnpm check` before asking for review. CI must be green.
5. Never push directly to `main`.

## Code rules

- TypeScript strict mode everywhere. No `any` without a comment saying why.
- Strategies only emit signals. Sizing, vetoes and exits belong to the risk manager and
  exit manager, so no strategy can bypass a risk limit.
- Nothing may move real funds unless the bot is in `live` mode, the kill switch is not
  engaged and the risk manager approved the order.
- API/engine logging goes through `@memebots/config`'s shared logger (no direct console
  or third-party log sinks). Register additional credentials before use and reveal
  secret wrappers only at the provider/database boundary.
- Bot state (positions, orders, fills, configuration) lives in PostgreSQL, never only in
  memory and never in AI chat history.
- Significant architecture changes get a decision record in ProjectBrain and a pointer in
  `docs/adr/`.
