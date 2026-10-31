import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RISK_WARNING } from '@memebots/core';

import { App, describeHealth } from './App';

describe('App', () => {
  it('always shows the risk warning', () => {
    const html = renderToString(<App />);
    expect(html).toContain('Risk warning');
    expect(html).toContain(RISK_WARNING.slice(0, 60));
  });
});

describe('describeHealth', () => {
  it('says plainly that live trading is not available yet', () => {
    expect(describeHealth({ state: 'ok', mode: 'paper', liveTradingAvailable: false })).toBe(
      'API is up. Mode: paper. Live trading: not available yet.',
    );
    expect(describeHealth({ state: 'down' })).toMatch(/not reachable/);
  });
});
