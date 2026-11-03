import { loadConfig } from '@lawassist/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp, type App } from '../src/app';

const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'mysql://u:p@localhost:3306/db' });
let app: App;

beforeAll(async () => {
  app = await buildApp(config, { checkReady: async () => false });
  app.post('/echo', { schema: { body: z.object({ n: z.number().int() }) } }, async (req) => req.body);
  app.get('/boom', async () => {
    throw new Error('db password=hunter2 leaked?');
  });
  await app.ready();
});
afterAll(() => app.close());

describe('api skeleton', () => {
  it('GET /health → 200 with request id and security headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('GET /ready → 503 when a dependency is down', async () => {
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
  });

  it('validation errors use RFC 9457 problem details', async () => {
    const res = await app.inject({ method: 'POST', url: '/echo', payload: { n: 'x' } });
    expect(res.statusCode).toBe(422);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ status: 422, code: 'VALIDATION_FAILED' });
  });

  it('unknown routes → 404 problem', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });

  it('internal errors never leak messages', async () => {
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('hunter2');
  });
});
