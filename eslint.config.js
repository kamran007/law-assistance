import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/migrations/**', 'docs/**', '**/.next/**', '**/next-env.d.ts', 'packages/contracts/src/schema.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Web app (WEB-01): Next.js rules (Core Web Vitals) and React hooks.
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { '@next/next': nextPlugin, 'react-hooks': reactHooks },
    settings: { next: { rootDir: 'apps/web' } },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Tenant isolation (TRD §4.3): apps may only reach tenant-owned tables through scoped().
    files: ['apps/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@lawassist/db/schema',
              message: 'Import from "@lawassist/db" and use scoped(db, userId) for tenant-owned tables (TRD §4.3).',
            },
          ],
          patterns: [
            {
              group: ['@lawassist/db/src/*', '**/packages/db/src/*'],
              message: 'Use the public "@lawassist/db" entry point.',
            },
          ],
        },
      ],
    },
  },
);
