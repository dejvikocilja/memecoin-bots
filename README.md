# Memecoin Bots

Automated, **paper-first** trading bots for memecoins on Solana. Each bot pairs one
**strategy** (how it finds trades) with one **risk profile** (Conservative, Balanced,
Aggressive or Degen: how much it bets, where it cuts losses and takes profit). An
independent risk manager sizes every order and can veto any trade.

Planning, tasks and decisions live in ProjectBrain, project **BOT**. This repository
holds the code.

> **Risk warning.** This software trades memecoins automatically. Memecoins are extremely
> volatile and speculative; most lose most or all of their value, and many are scams (rug
> pulls, honeypots). Automated trading can lose money faster than manual trading, and
> software bugs, network outages, failed transactions, slippage and MEV can cause losses
> beyond the configured limits. Backtests and paper trading overstate real results. Stop
> losses are not guaranteed to fill. This is a personal experimental tool, not financial,
> investment, legal or tax advice. Only use money you can afford to lose entirely. You
> alone are responsible for your trades and for any taxes owed.

## Status

Scaffold only (task BOT-3). Nothing here can trade real funds yet: the engine refuses
`live` mode until the live executor and kill switch are built.

## Layout

| Path             | What it is                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `packages/core`  | Shared types and constants: bot modes, risk profile names, strategy signals, the risk warning |
| `apps/engine`    | The bot engine (market data → strategies → risk manager → executor)                           |
| `apps/api`       | HTTP API for the dashboard (Fastify)                                                          |
| `apps/dashboard` | Web dashboard (React + Vite)                                                                  |
| `scripts/`       | Repository checks, such as the secret scanner                                                 |
| `docs/`          | Architecture and decision records                                                             |

## Run it locally

Needs **Node.js 24** (see `.nvmrc`) and **pnpm 10** (`corepack enable` sets it up).

```bash
corepack enable
pnpm install
cp .env.example .env
```

Start each part in its own terminal:

```bash
pnpm dev:engine      # engine in paper mode
pnpm dev:api         # API on http://127.0.0.1:3001/health
pnpm dev:dashboard   # dashboard on http://127.0.0.1:5173
```

PostgreSQL is optional until the data model lands (BOT-5). To run one locally:

```bash
docker compose up -d postgres
```

## Checks

`pnpm check` runs everything CI runs:

| Command              | What it does                                                                   |
| -------------------- | ------------------------------------------------------------------------------ |
| `pnpm check:secrets` | Fails if a `.env` file, a Solana keypair or a private key is in the repository |
| `pnpm lint`          | ESLint and Prettier                                                            |
| `pnpm typecheck`     | TypeScript in strict mode, every package                                       |
| `pnpm test`          | Vitest, every package                                                          |
| `pnpm build`         | Builds every package                                                           |

CI (`.github/workflows/ci.yml`) runs the same checks on every pull request.

## Secrets

- Never commit `.env`, keypair files or private keys. `.gitignore` covers the usual
  names, and `pnpm check:secrets` and CI catch anything that slips through.
- Wallet keys are loaded only by the executor, encrypted at rest (BOT-4 defines how).
- Each bot has its own small hot wallet. Never point a bot at your main wallet.

## Rules for this project

- Personal use only: own money, no customers, no public trade signals.
- No wash trading, no pumps, no sandwiching other traders.
- Every fill is recorded with enough detail to serve as the tax record.

See `CONTRIBUTING.md` for how work flows through ProjectBrain.
