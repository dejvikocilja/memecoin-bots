import { defineProject } from 'vitest/config';

export default defineProject({
  resolve: { conditions: ['@memebots/source'] },
  ssr: { resolve: { conditions: ['@memebots/source'] } },
  test: { name: 'engine', environment: 'node' },
});
