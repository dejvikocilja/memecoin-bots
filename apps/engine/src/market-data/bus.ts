import type { MarketDiscoveryEvent } from '@memebots/core';

export interface DiscoveryBus {
  publish(event: MarketDiscoveryEvent): void;
  subscribe(handler: (event: MarketDiscoveryEvent) => void): () => void;
}

/** Synchronous bounded fan-out; a broken consumer cannot stop discovery. */
export function createDiscoveryBus(onError: () => void = () => {}): DiscoveryBus {
  const handlers = new Set<(event: MarketDiscoveryEvent) => void>();
  return {
    publish(event) {
      for (const handler of [...handlers]) {
        try {
          handler(event);
        } catch {
          try {
            onError();
          } catch {
            /* Reporting must not break delivery either. */
          }
        }
      }
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
}
