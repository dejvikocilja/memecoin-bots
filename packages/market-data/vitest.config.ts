import { defineProject } from 'vitest/config';
export default defineProject({
  resolve: { conditions: ['@memebots/source'] },
  test: { name: 'market-data', environment: 'node' },
});
