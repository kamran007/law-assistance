import { loadConfig } from '@lawassist/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, CORS_METHODS, type App } from '../src/app';
import { buildOpenApiSpec } from '../src/openapi';

/**
 * The web app calls the API cross-origin, so the browser preflights every non-simple request.
 * A method missing from the CORS list fails in the browser as a network error ("Can't reach the
 * server") although server-side tests pass; this suite catches that.
 */
const WEB = 'http://localhost:3001';
let app: App;

beforeAll(async () => {
  app = await buildApp(loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'mysql://u:p@localhost:3306/db', WEB_ORIGIN: WEB }));
  await app.ready();
});
afterAll(() => app.close());

const preflight = (method: string, origin = WEB) =>
  app.inject({
    method: 'OPTIONS',
    url: '/api/v1/me',
    headers: { origin, 'access-control-request-method': method, 'access-control-request-headers': 'accept-language,authorization,content-type,if-match' },
  });

describe('CORS for the web origin', () => {
  it.each(['PATCH', 'DELETE', 'POST'])('allows a %s preflight with the headers the web client sends', async (method) => {
    const res = await preflight(method);
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(WEB);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(String(res.headers['access-control-allow-methods']).split(',').map((m) => m.trim())).toContain(method);
    expect(String(res.headers['access-control-allow-headers'])).toContain('if-match');
  });

  it('does not allow other origins', async () => {
    const res = await preflight('PATCH', 'http://evil.test');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('exposes ETag so the browser can read versions', async () => {
    const res = await app.inject({ method: 'GET', url: '/health', headers: { origin: WEB } });
    expect(String(res.headers['access-control-expose-headers'])).toContain('ETag');
  });

  it('every method used by an API route is allowed cross-origin', async () => {
    const spec = (await buildOpenApiSpec()) as { paths: Record<string, Record<string, unknown>> };
    const used = new Set(Object.values(spec.paths).flatMap((ops) => Object.keys(ops).map((m) => m.toUpperCase())));
    expect([...used].filter((m) => !(CORS_METHODS as readonly string[]).includes(m))).toEqual([]);
  });
});
