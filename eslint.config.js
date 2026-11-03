import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/migrations/**', 'docs/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
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
