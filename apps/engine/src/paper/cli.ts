import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createLogger, loadConfig, SecretRegistry } from '@memebots/config';
import type { ApprovedOrderIntent, PaperModel } from '@memebots/core';
import {
  createPool,
  inspectPaperOrder,
  loadPaperIntent,
  registerPaperIntent,
  reservePaperQuoteRequest,
  validatePaperIntent,
  withTransaction,
} from '@memebots/db';
import type { Pool } from '@memebots/db';
import { PaperBroker } from './broker.js';
import { integer, raw, validateModel } from './model.js';
import { JupiterReadOnlyQuoteProvider, parseQuoteJson, unavailableSnapshotQuote } from './quote.js';

interface ManualScenario {
  tokenMint: string;
  decimals: number;
  amountInRaw: string;
  bankrollLamports: string;
  maxSlippageBps: number;
  expiresInMs: number;
  entry: ApprovedOrderIntent['entry'];
  model: PaperModel;
  quoteRequirements: ApprovedOrderIntent['quoteRequirements'];
}
async function file(path: string | undefined): Promise<unknown> {
  if (!path) throw new Error('SCENARIO_FILE_REQUIRED');
  const text = await readFile(path, 'utf8');
  if (Buffer.byteLength(text) > 32768) throw new Error('SCENARIO_TOO_LARGE');
  return parseQuoteJson(text);
}
/** Deliberately owner-only paper scenario creation. Never presented as risk approval. */
async function manualDemo(pool: Pool, scenario: ManualScenario): Promise<ApprovedOrderIntent> {
  validateModel(scenario.model);
  integer(scenario.decimals, 0, 18);
  raw(scenario.bankrollLamports, true);
  integer(scenario.expiresInMs, 1000, 3600000);
  const id = randomUUID(),
    botId = randomUUID();
  const intent: ApprovedOrderIntent = {
    orderId: id,
    clientOrderId: `manual-paper:${id}`,
    botId,
    positionId: null,
    tokenMint: scenario.tokenMint,
    side: 'buy',
    mode: 'paper',
    amountInRaw: scenario.amountInRaw,
    maxSlippageBps: scenario.maxSlippageBps,
    expiresAt: Date.now() + scenario.expiresInMs,
    approval: { kind: 'manual_paper_scenario', reference: `owner-demo:${id}` },
    quoteRequirements: scenario.quoteRequirements,
    entry: scenario.entry,
    closeReason: null,
  };
  validatePaperIntent(intent);
  await withTransaction(pool, async (db) => {
    await db.query(
      `INSERT INTO risk_profiles(id,display_name,position_fraction,stop_loss_fraction,take_profit_ladder,trailing_stop_fraction,min_reward_risk,max_open_positions,daily_loss_limit_fraction,max_slippage_bps,min_liquidity_usd,min_safety_score,max_hold_minutes,losing_streak_limit) VALUES('paper_demo','Manual paper scenario',0.02,0.20,'[{"atGain":0.3,"sellFraction":0.4},{"atGain":0.6,"sellFraction":0.3}]',0.15,2,5,0.06,300,50000,60,720,4) ON CONFLICT DO NOTHING`,
    );
    // A public label only, no wallet key or funding. Compatible with paper wallet requirements.
    const wallet = await db.query<{ id: string }>(
      "INSERT INTO wallets(label,public_key) VALUES('manual paper public label',$1) RETURNING id",
      [publicLabel(id)],
    );
    await db.query('INSERT INTO tokens(mint,decimals) VALUES($1,$2) ON CONFLICT DO NOTHING', [
      scenario.tokenMint,
      scenario.decimals,
    ]);
    const token = await db.query<{ decimals: number }>(
      'SELECT decimals FROM tokens WHERE mint=$1',
      [scenario.tokenMint],
    );
    if (token.rows[0]!.decimals !== scenario.decimals) throw new Error('TOKEN_DECIMALS_MISMATCH');
    await db.query(
      "INSERT INTO bots(id,name,strategy,risk_profile_id,wallet_id,mode,paper_bankroll_lamports) VALUES($1,$2,'paper_demo','paper_demo',$3,'paper',$4)",
      [botId, `manual-paper:${id}`, wallet.rows[0]!.id, scenario.bankrollLamports],
    );
    await db.query(
      "INSERT INTO orders(id,client_order_id,bot_id,token_mint,side,mode,amount_in_raw,max_slippage_bps,reason) VALUES($1,$2,$3,$4,'buy','paper',$5,$6,'MANUAL_PAPER_SCENARIO_NOT_RISK_APPROVAL')",
      [
        id,
        intent.clientOrderId,
        botId,
        intent.tokenMint,
        intent.amountInRaw,
        intent.maxSlippageBps,
      ],
    );
  });
  await registerPaperIntent(pool, intent);
  return intent;
}
function publicLabel(id: string): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  return `P${[...id.replaceAll('-', '')].map((c) => alphabet[parseInt(c, 16)]).join('')}`;
}

const registry = new SecretRegistry();
const logger = createLogger(registry, (line) => process.stdout.write(`${line}\n`));
const controller = new AbortController();
const stop = () => controller.abort();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
let pool: Pool | undefined;
try {
  const config = loadConfig(process.env, registry);
  pool = createPool(config.databaseUrl.reveal(), { max: 2 });
  const [command, id, key, scenarioPath] = process.argv.slice(2);
  if (command === 'inspect') {
    if (!id) throw new Error('ORDER_ID_REQUIRED');
    const attempts = await pool.query(
      'SELECT id,idempotency_key,sequence,input_raw,ready_at_ms FROM paper_execution_attempts WHERE order_id=$1 ORDER BY sequence',
      [id],
    );
    logger.info('paper_inspect', {
      orderId: id,
      results: await inspectPaperOrder(pool, id),
      attempts: attempts.rows,
    });
  } else if (command === 'cancel') {
    if (!id) throw new Error('ORDER_ID_REQUIRED');
    const { cancelPaperOrder } = await import('@memebots/db');
    await cancelPaperOrder(pool, id);
    logger.info('paper_cancelled', { orderId: id });
  } else if (command === 'manual-demo' || command === 'process' || command === 'recover') {
    const scenario = (await file(command === 'manual-demo' ? id : scenarioPath)) as ManualScenario;
    validateModel(scenario.model);
    const intent =
      command === 'manual-demo'
        ? await manualDemo(pool, scenario)
        : await loadPaperIntent(pool, id ?? '');
    if (command !== 'manual-demo' && !key) throw new Error('IDEMPOTENCY_KEY_REQUIRED');
    const mock = process.env.PAPER_QUOTE_MOCK_URL;

    const provider =
      process.env.PAPER_QUOTE_SOURCE === 'dex_snapshot'
        ? { quote: async () => unavailableSnapshotQuote, currentContext: async () => undefined }
        : new JupiterReadOnlyQuoteProvider({
            budget: { take: () => reservePaperQuoteRequest(pool!) },
            ...(config.providers.jupiterApiKey ? { apiKey: config.providers.jupiterApiKey } : {}),
            ...(mock ? { localMockUrl: mock } : {}),
          });
    logger.info('paper_order_ready', {
      orderId: intent.orderId,
      idempotencyKey: key ?? `demo:${intent.orderId}`,
      approvalKind: intent.approval.kind,
    });
    const broker = new PaperBroker(pool, provider, scenario.model, { signal: controller.signal });
    logger.info('paper_execution', {
      approvalKind: intent.approval.kind,
      result: await broker.execute(intent, key ?? `demo:${intent.orderId}`),
    });
  } else
    throw new Error(
      'USAGE: manual-demo scenario.json | process/recover orderId idempotencyKey scenario.json | inspect/cancel orderId',
    );
} catch {
  logger.error('paper_command_failed', {
    code: controller.signal.aborted ? 'INTERRUPTED_RECOVER_WITH_SAME_KEY' : 'PAPER_COMMAND_FAILED',
  });
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  await pool?.end();
}
