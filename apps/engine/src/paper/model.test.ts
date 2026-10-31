import { describe, expect, it } from 'vitest';
import type { ApprovedOrderIntent, Executor, PaperModel } from '@memebots/core';
import { createExecutor, createTestExecutor } from '@memebots/core';
import { drawModel, raw, simulateOutput, validateModel } from './model.js';
const model: PaperModel = {
  version: 'paper-v1',
  minLatencyMs: 10,
  maxLatencyMs: 100,
  adverseSlippageBps: 100,
  failureProbability: 0,
  failureStage: 'submitted',
  partialFillBps: 10000,
  fees: { provenance: 'MODEL', selectedBy: 'test', networkLamports: '0', priorityLamports: '0' },
};
describe('paper model and executor contract', () => {
  it('uses exact conservative arithmetic above 2^53', () => {
    expect(raw('900719925474099312345678901234567890')).toBe(900719925474099312345678901234567890n);
    expect(simulateOutput('900719925474099312345678901234567890', 123)).toBe(
      ((900719925474099312345678901234567890n * 9877n) / 10000n).toString(),
    );
  });
  it('persists deterministic bounded draws with stable version', () => {
    expect(drawModel('a'.repeat(64), model)).toEqual(drawModel('a'.repeat(64), model));
    expect(drawModel('a'.repeat(64), model).latencyMs).toBeGreaterThanOrEqual(10);
    expect(drawModel('a'.repeat(64), model).latencyMs).toBeLessThanOrEqual(100);
  });
  it.each([-1, 1.01, NaN, Infinity])('rejects invalid probability %s', (failureProbability) => {
    expect(() => validateModel({ ...model, failureProbability })).toThrow();
  });
  it('rejects invalid quantities/fees/partial/latency', () => {
    for (const v of ['-1', '01', '1.1', '9007199254740992.1', 1]) expect(() => raw(v)).toThrow();
    expect(() => validateModel({ ...model, partialFillBps: 0 })).toThrow();
    expect(() => validateModel({ ...model, maxLatencyMs: 60001 })).toThrow();
    expect(() =>
      validateModel({ ...model, fees: { ...model.fees, networkLamports: '1000000001' } }),
    ).toThrow();
  });
  it('same caller contract substitutes paper/fake live only under test factory', async () => {
    const modes: string[] = [];
    const fake = (mode: string): Executor => ({
      execute: async (intent, key) => {
        modes.push(mode, key, intent.orderId);
        throw new Error('EXPECTED');
      },
      inspect: async () => [],
      cancel: async () => {},
    });
    const paper = fake('paper'),
      fakeLive = fake('fake-live');
    for (const mode of ['paper', 'live'] as const) {
      const executor = createTestExecutor(mode, { paper, fakeLive });
      expect(await executor.inspect('x')).toEqual([]);
      await executor.cancel('x');
      await expect(
        executor.execute({ orderId: 'approved' } as ApprovedOrderIntent, 'caller-key'),
      ).rejects.toThrow('EXPECTED');
    }
    expect(createExecutor('paper', paper)).toBe(paper);
    expect(() => createExecutor('live', fakeLive)).toThrow('LIVE_EXECUTOR_UNAVAILABLE');
    expect(modes).toEqual([
      'paper',
      'caller-key',
      'approved',
      'fake-live',
      'caller-key',
      'approved',
    ]);
  });
});
