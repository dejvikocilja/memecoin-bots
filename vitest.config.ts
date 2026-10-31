import { defineConfig } from 'vitest/config';

// One test run for the whole workspace. Each package keeps its own vitest config.
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
  },
});
