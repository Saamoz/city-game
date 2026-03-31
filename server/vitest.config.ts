import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: true,
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
  },
});
