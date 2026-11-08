import { randomBytes } from 'node:crypto';
import { loadConfig } from '@lawassist/config';
import { createDb } from '@lawassist/db';
import { sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { buildApp } from './app';
import { jwtAuthenticate } from './modules/auth/authenticate';
import { ChannelOtpSender, ConsoleOtpSender } from './modules/auth/otp';
import { SmtpOtpSender } from './modules/auth/otp-email';
import { AuthService } from './modules/auth/service';
import { TokenService } from './modules/auth/tokens';
import { RedisArtifactEventHub, RedisArtifactEventPublisher } from '@lawassist/providers';
import { BullAnalysisQueue, BullScanQueue } from './modules/documents/queue';
import { S3DocumentStorage } from './modules/documents/storage';
import { RedisSectionCache, resilient } from './modules/statutes/cache';
import { StatutesRepository } from './modules/statutes/repository';
import { JudgmentsRepository } from './modules/judgments/repository';
import { dhakaToday } from './time';

const config = loadConfig();
const dev = config.NODE_ENV === 'development';
const { db, close } = createDb(config.DATABASE_URL);
// One connection for the cache and rate limiting. Commands fail fast instead of queueing while
// Redis is down; both callers then fall back (cache → MySQL, rate limit → skipped).
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
// BullMQ needs its own connection that retries (maxRetriesPerRequest: null) rather than failing fast.
const queueRedis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const scanQueue = new BullScanQueue(queueRedis);
const analysisQueue = new BullAnalysisQueue(queueRedis);
// Document status events (TRD §8.1 step 4): one subscriber connection per API process, shared by
// every open SSE stream; ioredis keeps it in subscriber mode, so it cannot be the shared one.
const eventsRedis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const eventHub = new RedisArtifactEventHub(eventsRedis);
const eventPublisher = new RedisArtifactEventPublisher(queueRedis);

// Staging/production can't boot without keys (packages/config). In local development a missing
// key gets a throwaway value: tokens and codes then stop working when the process restarts.
const tokens =
  config.JWT_PRIVATE_KEY && config.JWT_PUBLIC_KEY ? await TokenService.fromPem(config.JWT_PRIVATE_KEY, config.JWT_PUBLIC_KEY) : await TokenService.ephemeral();
const otpKey = config.OTP_HMAC_KEY ?? randomBytes(32).toString('hex');
const authenticate = jwtAuthenticate(tokens);
// OTP delivery: `console` prints codes (development only; config refuses it elsewhere). `smtp`
// emails them; SMS has no gateway until PRE-05, so SMS codes are printed in development only.
const otpSender =
  config.OTP_DELIVERY === 'smtp'
    ? new ChannelOtpSender({ EMAIL: SmtpOtpSender.fromUrl(config.SMTP_URL!, config.OTP_EMAIL_FROM!), ...(dev ? { SMS: new ConsoleOtpSender() } : {}) })
    : new ConsoleOtpSender();

const documentStorage = S3DocumentStorage.fromConfig(config);
const app = await buildApp(config, {
  checkReady: async () => {
    await db.execute(sql`SELECT 1`);
    return true;
  },
  rateLimitRedis: redis,
  statutes: {
    repo: new StatutesRepository(db),
    cache: resilient(new RedisSectionCache(redis), (err) => app.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'section cache unavailable')),
    authenticate,
    today: dhakaToday,
  },
  judgments: { repo: new JudgmentsRepository(db), storage: documentStorage },
  auth: {
    // OTP_DELIVERY=console is the only sender until PRE-05; config refuses it outside development.
    service: new AuthService({ db, tokens, sender: otpSender, otpKey }),
    authenticate,
    secureCookies: !dev,
  },
  cases: { db, authenticate, today: dhakaToday },
  devices: { db, authenticate },
  drafts: { db, authenticate },
  conversations: { db, authenticate },
  documents: {
    db,
    authenticate,
    storage: documentStorage,
    queue: scanQueue,
    analysis: analysisQueue,
    events: eventHub,
    publisher: eventPublisher,
  },
});
if (dev && (!config.JWT_PRIVATE_KEY || !config.OTP_HMAC_KEY)) {
  app.log.warn('JWT/OTP keys not set: using throwaway keys; sessions end when the API restarts');
}

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await scanQueue.close();
  await analysisQueue.close();
  eventsRedis.disconnect();
  await close();
  redis.disconnect();
  queueRedis.disconnect();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.API_PORT, host: '0.0.0.0' });
