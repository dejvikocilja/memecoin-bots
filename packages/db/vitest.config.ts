import { defineProject } from 'vitest/config';

export default defineProject({
  resolve: { conditions: ['@memebots/source'] },
  test: {
    name: 'db',
    environment: 'node',
    // Every test file shares one database, so files run one after another.
    fileParallelism: false,
  },
});
