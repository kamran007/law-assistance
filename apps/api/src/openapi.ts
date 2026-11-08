import { loadConfig } from '@lawassist/config';
import { createDb } from '@lawassist/db';
import { noopArtifactEvents } from '@lawassist/providers';
import { buildApp } from './app';
import type { Authenticate } from './auth';
import { AuthService } from './modules/auth/service';
import { TokenService } from './modules/auth/tokens';
import { noCache } from './modules/statutes/cache';
import { StatutesRepository } from './modules/statutes/repository';

/**
 * The OpenAPI document of the full API, built from the real route schemas with inert dependencies
 * (no request is ever served, so nothing connects). `packages/contracts/openapi.json` is generated
 * from this (`pnpm --filter @lawassist/api openapi`); a unit test fails when the two drift.
 */
export async function buildOpenApiSpec(): Promise<Record<string, unknown>> {
  const { db, close } = createDb('mysql://spec:spec@127.0.0.1:1/spec', { connectionLimit: 1 });
  const tokens = await TokenService.ephemeral();
  const authenticate: Authenticate = async () => null;
  const unused = () => Promise.reject(new Error('spec build only'));
  const app = await buildApp(loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'mysql://spec:spec@127.0.0.1:1/spec' }), {
    statutes: { repo: new StatutesRepository(db), cache: noCache, authenticate, today: () => '2026-01-01' },
    auth: { service: new AuthService({ db, tokens, sender: { send: unused }, otpKey: 'k'.repeat(32) }), authenticate, secureCookies: true },
    cases: { db, authenticate, today: () => '2026-01-01' },
    devices: { db, authenticate },
    conversations: { db, authenticate },
    documents: {
      db,
      authenticate,
      storage: { presignPut: unused, head: unused, readStart: unused },
      queue: { enqueue: unused },
      analysis: { enqueueReanalysis: unused },
      events: { subscribe: unused },
      publisher: noopArtifactEvents,
    },
  });
  try {
    await app.ready();
    // Stable output: the server list is environment-specific and left to the client's baseUrl.
    const spec = structuredClone(app.swagger()) as Record<string, unknown>;
    delete spec.servers;
    return spec;
  } finally {
    await app.close();
    await close();
  }
}
