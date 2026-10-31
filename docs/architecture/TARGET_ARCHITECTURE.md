# Target architecture

Source: ProjectBrain BOT specification v1, section 7, and ADR-1 (stack and hosting).

```
 market data ──► event bus ──► strategies ──► signals ──► risk manager ──► orders ──► executor ──► chain
 (RPC/WebSocket,                                  ▲              │                       │
  indexer,                    token safety ───────┘              ▼                       ▼
  price feeds)                scanner                       positions DB ◄──── fills / exits
                                                                 │
                                         dashboard · Telegram alerts · reports · audit log
```

## Where each part lives

| Component                               | Package                               | Task                |
| --------------------------------------- | ------------------------------------- | ------------------- |
| Shared types (modes, profiles, signals) | `packages/core`                       | BOT-3               |
| Config and secrets                      | `packages/config`, used by engine/API | BOT-4               |
| Data model and migrations               | to be added (`packages/db`)           | BOT-5               |
| Market data, safety scanner             | `apps/engine`                         | BOT-6, BOT-7, BOT-9 |
| Risk manager, exit manager, kill switch | `apps/engine`                         | Risk framework epic |
| Paper broker, live executor             | `apps/engine`                         | Execution epic      |
| Strategies (plugins)                    | `apps/engine`                         | Strategies epic     |
| HTTP API                                | `apps/api`                            | Dashboard epic      |
| Dashboard                               | `apps/dashboard`                      | Dashboard epic      |

## Fixed rules

- Strategies emit signals only; the risk manager sizes and can veto every order.
- The paper broker and the live executor share one interface.
- State lives in PostgreSQL; a restart resumes cleanly.
- Keys are loaded only by the executor and never logged.
- Default mode is `paper`; `live` needs an explicit per-bot switch and confirmation.

## Stack (ADR-1)

TypeScript in strict mode on Node.js 24, a pnpm workspace, Fastify for the API, React +
Vite for the dashboard and PostgreSQL for state. Hosting is local; free data sources first.
