# Memecoin Bots: notes for coding agents

Read `README.md`, `CONTRIBUTING.md` and `docs/architecture/TARGET_ARCHITECTURE.md` first.
Tasks, the specification and decisions live in ProjectBrain project BOT; call
`get_task_context` for your task's brief.

Hard rules:

- Never commit secrets, keypairs or `.env` files. Run `pnpm check:secrets`.
- Never add a code path that can sign or send a transaction outside the live executor.
- Strategies never size or exit positions; the risk manager has the final say.
- No wash trading, coordinated pumps or sandwiching, in any strategy.
- Run `pnpm check` before requesting review.
