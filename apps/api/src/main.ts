import { loadConfig } from '@lawassist/config';
import { createDb } from '@lawassist/db';
import { sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { buildApp } from './app';
import { anonymous } from './auth';
import { RedisSectionCache, resilient } from './modules/statutes/cache';
import { StatutesRepository } from './modules/statutes/repository';
import { dhakaToday } from './time';

const config = loadConfig();
const { db, close } = createDb(config.DATABASE_URL);
// One connection for the cache and rate limiting. Commands fail fast instead of queueing while
// Redis is down; both callers then fall back (cache → MySQL, rate limit → skipped).
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false });

const app = await buildApp(config, {
  checkReady: async () => {
    await db.execute(sql`SELECT 1`);
    return true;
  },
  rateLimitRedis: redis,
  statutes: {
    repo: new StatutesRepository(db),
    cache: resilient(new RedisSectionCache(redis), (err) => app.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'section cache unavailable')),
    // JWT auth arrives with BE-03/BE-04; until then every request is anonymous.
    authenticate: anonymous,
    today: dhakaToday,
  },
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await close();
  redis.disconnect();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.API_PORT, host: '0.0.0.0' });
