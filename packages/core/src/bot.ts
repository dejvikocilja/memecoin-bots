/**
 * How a bot runs. Every bot starts in `paper`; `live` needs an explicit
 * per-bot switch and a confirmation (spec section 8).
 */
export const BOT_MODES = ['off', 'paper', 'live'] as const;
export type BotMode = (typeof BOT_MODES)[number];

export const DEFAULT_BOT_MODE: BotMode = 'paper';

export function isBotMode(value: unknown): value is BotMode {
  return typeof value === 'string' && (BOT_MODES as readonly string[]).includes(value);
}

/** Parses a mode from config or user input; anything unknown is an error, never a silent default. */
export function parseBotMode(value: string | undefined): BotMode {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_BOT_MODE;
  }
  const normalised = value.trim().toLowerCase();
  if (!isBotMode(normalised)) {
    throw new Error(`Unknown bot mode "${value}". Use one of: ${BOT_MODES.join(', ')}.`);
  }
  return normalised;
}
