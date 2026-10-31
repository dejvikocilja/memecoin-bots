import { createHash } from 'node:crypto';

import type { PaperModel, PaperDraws as Draws } from '@memebots/core';

import { raw, integer, validateModel } from '@memebots/core';
export { raw, integer, validateModel } from '@memebots/core';

export function drawModel(seed: string, model: PaperModel): Draws {
  validateModel(model);
  if (!/^[a-f0-9]{64}$/.test(seed)) throw new Error('INVALID_SEED');
  const hash = createHash('sha256').update(`paper-v1:${seed}`).digest();
  return Object.freeze({
    latencyMs:
      model.minLatencyMs + (hash.readUInt32BE(0) % (model.maxLatencyMs - model.minLatencyMs + 1)),
    failurePpm: hash.readUInt32BE(4) % 1_000_000,
  });
}
export function simulateOutput(quotedOutput: string, adverseBps: number): string {
  return (
    (raw(quotedOutput, true) * BigInt(10000 - integer(adverseBps, 0, 5000))) /
    10000n
  ).toString();
}
