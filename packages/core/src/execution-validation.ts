import type { PaperModel } from './execution.js';

export function raw(value: unknown, positive = false): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,38})$/.test(value))
    throw new Error('INVALID_RAW_AMOUNT');
  const amount = BigInt(value);
  if (positive && amount === 0n) throw new Error('INVALID_RAW_AMOUNT');
  return amount;
}
export function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    throw new Error('INVALID_INTEGER');
  return value;
}
export function validateModel(model: PaperModel): void {
  if (model.version !== 'paper-v1') throw new Error('INVALID_MODEL');
  integer(model.minLatencyMs, 0, 60_000);
  integer(model.maxLatencyMs, model.minLatencyMs, 60_000);
  integer(model.adverseSlippageBps, 0, 5000);
  integer(model.partialFillBps, 1, 10000);
  if (
    !Number.isFinite(model.failureProbability) ||
    model.failureProbability < 0 ||
    model.failureProbability > 1 ||
    !['before_submission', 'submitted'].includes(model.failureStage)
  )
    throw new Error('INVALID_MODEL');
  if (model.fees.provenance !== 'MODEL' || !/^[a-zA-Z0-9_.:-]{1,80}$/.test(model.fees.selectedBy))
    throw new Error('EXPLICIT_FEE_SCENARIO_REQUIRED');
  if (
    raw(model.fees.networkLamports) > 1_000_000_000n ||
    raw(model.fees.priorityLamports) > 1_000_000_000n
  )
    throw new Error('INVALID_MODEL_FEE');
}
