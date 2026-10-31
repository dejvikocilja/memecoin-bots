import { describe, expect, it, vi } from 'vitest';

import { createEngine } from './engine.js';

describe('createEngine', () => {
  it('starts and stops in paper mode', () => {
    const lines: string[] = [];
    const engine = createEngine({ mode: 'paper', log: (m) => lines.push(m) });

    engine.start();
    engine.start();
    expect(engine.running).toBe(true);
    engine.stop();

    expect(engine.running).toBe(false);
    expect(lines).toEqual(['engine started in paper mode', 'engine stopped']);
  });

  it('owns discovery lifecycle only outside off mode', () => {
    for (const mode of ['paper', 'off'] as const) {
      const discovery = { start: vi.fn(), stop: vi.fn(), status: vi.fn() };
      const engine = createEngine({ mode, log: () => {}, discovery });
      engine.start();
      engine.start();
      expect(discovery.start).toHaveBeenCalledTimes(mode === 'paper' ? 1 : 0);
      engine.stop();
      engine.stop();
      expect(discovery.stop).toHaveBeenCalledTimes(1);
    }
  });

  it('refuses live mode until live trading is built', () => {
    expect(() => createEngine({ mode: 'live', log: () => {} })).toThrow(
      /Live mode is not available/,
    );
  });
});
