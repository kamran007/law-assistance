import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
          exclude: ['**/*.int.test.ts', '**/node_modules/**', 'apps/web/**'],
        },
      },
      {
        // Web app (WEB-01+): components in jsdom, `@/` = apps/web/src.
        resolve: { alias: { '@': fileURLToPath(new URL('./apps/web/src', import.meta.url)) } },
        oxc: { jsx: { runtime: 'automatic' } },
        test: {
          name: 'web',
          include: ['apps/web/test/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          setupFiles: ['apps/web/test/setup.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['packages/*/test/**/*.int.test.ts', 'apps/*/test/**/*.int.test.ts'],
          testTimeout: 120_000,
          hookTimeout: 180_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
