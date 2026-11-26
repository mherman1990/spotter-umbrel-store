import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/test-support/**',
        'src/index.ts',
        'src/cli.ts',
        // Type-only contract modules have no executable statements.
        'src/**/types.ts',
        'src/engine/pipeline-contract.ts',
      ],
      // The 90% gate applies ONLY to the deterministic engine (Spotter convention, decision D32).
      thresholds: {
        'src/engine/**': { statements: 90, branches: 90, functions: 90, lines: 90 },
      },
    },
  },
});
