import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildOpenApiSpec } from '../src/openapi';

/** packages/contracts must match the API's route schemas (WEB-01). */
describe('packages/contracts/openapi.json', () => {
  it('is up to date (run `pnpm --filter @lawassist/api openapi` after changing routes)', async () => {
    const committed = JSON.parse(readFileSync(new URL('../../../packages/contracts/openapi.json', import.meta.url), 'utf8'));
    expect(committed).toEqual(await buildOpenApiSpec());
  });
});
