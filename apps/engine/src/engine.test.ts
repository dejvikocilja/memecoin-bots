import { describe, expect, it } from 'vitest';

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

  it('refuses live mode until live trading is built', () => {
    expect(() => createEngine({ mode: 'live', log: () => {} })).toThrow(
      /Live mode is not available/,
    );
  });
});
