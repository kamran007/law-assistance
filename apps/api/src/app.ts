import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import type { AppConfig } from '@lawassist/config';
import Fastify, { type FastifyError } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';

export interface AppDeps {
  /** Readiness probe for downstream dependencies (DB, Redis…). */
  checkReady?: () => Promise<boolean>;
}

/** RFC 9457 problem details (TRD §5). */
export interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
}

const problem = (status: number, code: string, title: string, detail?: string): Problem => ({
  type: `https://lawassist.bd/errors/${code.toLowerCase().replace(/_/g, '-')}`,
  title,
  status,
  code,
  ...(detail ? { detail } : {}),
});

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
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(helmet);
  await app.register(cors, { origin: [config.WEB_ORIGIN], credentials: true });

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
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
    { schema: { response: { 200: z.object({ status: z.literal('ok') }) } } },
    async () => ({ status: 'ok' as const }),
  );

  app.get(
    '/ready',
    { schema: { response: { 200: z.object({ ready: z.boolean() }), 503: z.object({ ready: z.boolean() }) } } },
    async (_req, reply) => {
      const ready = deps.checkReady ? await deps.checkReady().catch(() => false) : true;
      return reply.status(ready ? 200 : 503).send({ ready });
    },
  );

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
