import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { AppConfig } from '@lawassist/config';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { authRoutes, type AuthRoutesDeps } from './modules/auth/routes';
import { caseRoutes, type CaseRoutesDeps } from './modules/cases/routes';
import { conversationRoutes, type ConversationRoutesDeps } from './modules/conversations/routes';
import { statuteRoutes, type StatuteRoutesDeps } from './modules/statutes/routes';
import { ApiError, problem } from './problem';

export { problem, type Problem } from './problem';

export interface AppDeps {
  /** Readiness probe for downstream dependencies (DB, Redis…). */
  checkReady?: () => Promise<boolean>;
  /** Statute read API (BE-06). Omitted in tests of the bare skeleton. */
  statutes?: StatuteRoutesDeps;
  /** OTP login, sessions and /me (BE-03/BE-04). */
  auth?: AuthRoutesDeps;
  /** Case files (BE-15). */
  cases?: CaseRoutesDeps;
  /** General conversations (BE-12). */
  conversations?: ConversationRoutesDeps;
  /** Shared rate-limit counters across API tasks (TRD §5.5). In-memory when omitted. */
  rateLimitRedis?: Redis;
}

export const API_PREFIX = '/api/v1';

/**
 * Who a route's data belongs to. Every route under /api/v1 must declare one in `config.access`;
 * the tenant-isolation suite (QA-01) fails on unclassified routes and checks every `tenant` route
 * with another user's ids.
 * - public: reference data (statutes) or auth entry points
 * - self:   the caller's own account (/me), no resource ids in the URL
 * - tenant: user-owned resources addressed by id (cases, conversations, artifacts)
 */
export type RouteAccess = 'public' | 'self' | 'tenant';

declare module 'fastify' {
  interface FastifyContextConfig {
    access?: RouteAccess;
  }
  interface FastifyInstance {
    /** Every route with its declared access class, collected at registration (QA-01). */
    routeList: { method: string; url: string; access: RouteAccess | undefined }[];
  }
}

/**
 * Safety-net limit per client for routes without their own limit. Route-specific limits from
 * TRD §5.5 (OTP, assistant, scan, voice) are set on those routes when they are added.
 */
export const DEFAULT_RATE_LIMIT = { max: 300, timeWindow: '1 minute' } as const;

export async function buildApp(config: AppConfig, deps: AppDeps = {}) {
  const app = Fastify({
    logger:
      config.NODE_ENV === 'test'
        ? false
        : {
            level: config.LOG_LEVEL,
            // Never log credentials, document text, transcripts or queries (TRD §12.3).
            redact: {
              paths: ['req.headers.authorization', 'req.headers.cookie', '*.token', '*.query', '*.content', '*.text'],
              remove: true,
            },
          },
    genReqId: () => crypto.randomUUID(),
    requestIdHeader: false,
    bodyLimit: 1024 * 1024,
    // Behind the ALB (TRD §13.2), so the client IP for rate limiting comes from X-Forwarded-For.
    trustProxy: config.NODE_ENV === 'production' || config.NODE_ENV === 'staging',
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const routeList: FastifyInstance['routeList'] = [];
  app.decorate('routeList', routeList);
  app.addHook('onRoute', (r) => {
    for (const method of [r.method].flat()) {
      if (method !== 'HEAD') routeList.push({ method, url: r.url, access: r.config?.access });
    }
  });

  await app.register(swagger, {
    openapi: {
      info: { title: 'BD-LawAssist API', version: '1.0.0' },
      servers: [{ url: '/' }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs', staticCSP: true });

  await app.register(helmet, {
    // Swagger UI (/docs) sets its own CSP via `staticCSP`; everything else gets helmet's default.
    contentSecurityPolicy: { useDefaults: true },
  });
  await app.register(cors, { origin: [config.WEB_ORIGIN], credentials: true });
  await app.register(cookie);
  await app.register(rateLimit, {
    ...DEFAULT_RATE_LIMIT,
    ...(deps.rateLimitRedis ? { redis: deps.rateLimitRedis, nameSpace: 'ratelimit:api:' } : {}),
    // Never block on a Redis outage: serving law text matters more than the limit.
    skipOnError: true,
    allowList: (req) => req.url === '/health' || req.url === '/ready',
    errorResponseBuilder: (_req, ctx) =>
      Object.assign(new ApiError(429, 'RATE_LIMITED', 'Too many requests', `Try again in ${Math.ceil(ctx.ttl / 1000)} s`), {
        statusCode: 429,
      }),
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  app.setErrorHandler((err: FastifyError | ApiError, req, reply) => {
    if (err instanceof ApiError) {
      return reply.status(err.status).type('application/problem+json').send(err.toProblem());
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      const detail = err.validation.map((v) => `${v.instancePath || '(body)'} ${v.message}`).join('; ');
      return reply.status(422).type('application/problem+json').send(problem(422, 'VALIDATION_FAILED', 'Invalid request', detail));
    }
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    if (status === 500) req.log.error({ err }, 'unhandled error');
    const body =
      status === 500
        ? problem(500, 'INTERNAL_ERROR', 'Something went wrong')
        : problem(status, err.code ?? 'REQUEST_ERROR', err.message);
    return reply.status(status).type('application/problem+json').send(body);
  });

  app.setNotFoundHandler((_req, reply) =>
    reply.status(404).type('application/problem+json').send(problem(404, 'NOT_FOUND', 'Not found')),
  );

  app.get(
    '/health',
    { schema: { hide: true, response: { 200: z.object({ status: z.literal('ok') }) } } },
    async () => ({ status: 'ok' as const }),
  );

  app.get(
    '/ready',
    { schema: { hide: true, response: { 200: z.object({ ready: z.boolean() }), 503: z.object({ ready: z.boolean() }) } } },
    async (_req, reply) => {
      const ready = deps.checkReady ? await deps.checkReady().catch(() => false) : true;
      return reply.status(ready ? 200 : 503).send({ ready });
    },
  );

  if (deps.statutes) await app.register(statuteRoutes(deps.statutes), { prefix: API_PREFIX });
  if (deps.auth) await app.register(authRoutes(deps.auth), { prefix: API_PREFIX });
  if (deps.cases) await app.register(caseRoutes(deps.cases), { prefix: API_PREFIX });
  if (deps.conversations) await app.register(conversationRoutes(deps.conversations), { prefix: API_PREFIX });

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
