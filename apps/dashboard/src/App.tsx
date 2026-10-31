import { useEffect, useState } from 'react';
import { RISK_WARNING } from '@memebots/core';

type Health =
  | { state: 'loading' }
  | { state: 'ok'; mode: string; liveTradingAvailable: boolean }
  | { state: 'down' };

export function App() {
  const [health, setHealth] = useState<Health>({ state: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/health', { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { mode: string; liveTradingAvailable: boolean };
        setHealth({
          state: 'ok',
          mode: body.mode,
          liveTradingAvailable: body.liveTradingAvailable,
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) setHealth({ state: 'down' });
      });
    return () => controller.abort();
  }, []);

  return (
    <main>
      <h1>Memecoin Bots</h1>
      <section className="warning" role="note" aria-label="Risk warning">
        <strong>Risk warning.</strong> {RISK_WARNING}
      </section>
      <section>
        <h2>System</h2>
        <p>{describeHealth(health)}</p>
      </section>
    </main>
  );
}

export function describeHealth(health: Health): string {
  switch (health.state) {
    case 'loading':
      return 'Checking the API…';
    case 'down':
      return 'The API is not reachable. Start it with "pnpm dev:api".';
    case 'ok':
      return `API is up. Mode: ${health.mode}. Live trading: ${
        health.liveTradingAvailable ? 'available' : 'not available yet'
      }.`;
  }
}
