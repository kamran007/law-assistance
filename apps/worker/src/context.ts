import { Redis } from 'ioredis';
import { pino } from 'pino';
import { loadConfig } from '@lawassist/config';
import { createDb } from '@lawassist/db';
import {
  QdrantChunkIndex,
  RedisArtifactEventPublisher,
  TeiEmbeddingProvider,
  createLlmClient,
  createQdrantClient,
  notConfiguredOcr,
  statuteGenerationKey,
} from '@lawassist/providers';
import { createPushNotifier } from './push';
import { S3DocumentObjects } from './scan/objects';
import { CliDocumentTools } from './scan/tools';
import { SectionIndexer } from './index/indexer';
import { PoliteHttpClient } from './scrape/http-client';
import { RedisConditionalCache } from './scrape/redis-conditional-cache';
import type { ScrapeDeps } from './scrape/run-scrape';
import { S3SnapshotStore } from './scrape/snapshot-store';
import { loadSourceConfig } from './scrape/source-config';

/** Wires real dependencies for the worker process and the CLI. */
export function createWorkerContext() {
  const cfg = loadConfig();
  const log = pino({
    level: cfg.LOG_LEVEL,
    // Defence in depth: document text, queries and credentials must never reach the logs.
    redact: { paths: ['*.body', '*.html', '*.text', '*.contentBody', '*.chunkText', '*.password', '*.authorization'], censor: '[redacted]' },
  });
  // Least privilege (TRD §4.3): scraper writes statute data as app_scraper; outbox/indexing runs as
  // app_worker. Neither DB user can do the other's job, so they need separate connections.
  const { db, close: closeDb } = createDb(cfg.DATABASE_URL, { connectionLimit: 5 });
  const scraperDb = cfg.SCRAPER_DATABASE_URL ? createDb(cfg.SCRAPER_DATABASE_URL, { connectionLimit: 3 }) : null;
  const redis = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: null });
  const config = loadSourceConfig();
  const scrape: ScrapeDeps = {
    db: scraperDb?.db ?? db,
    http: new PoliteHttpClient({ config, cache: new RedisConditionalCache(redis) }),
    snapshots: S3SnapshotStore.fromConfig(cfg),
    config,
    log,
    // The API caches section reads under the Act's generation (TRD §11.3); a new one hides them.
    onActSynced: async (bdlawsActId) => {
      await redis.incr(statuteGenerationKey(bdlawsActId));
    },
  };

  const qdrant = createQdrantClient({ url: cfg.QDRANT_URL, apiKey: cfg.QDRANT_API_KEY });
  const embedder = new TeiEmbeddingProvider({ url: cfg.TEI_EMBED_URL, model: cfg.EMBEDDING_MODEL });
  const indexer = new SectionIndexer({ db, embedder, index: new QdrantChunkIndex(qdrant, cfg.QDRANT_COLLECTION) });

  // Scan pipeline (TRD §8.2): user data, so it runs on the app_worker connection through scoped().
  // Status events for the API's SSE relay (TRD §8.1 step 4); push via FCM when a Firebase
  // service-account key is configured (FCM_SERVICE_ACCOUNT_*), otherwise a no-op.
  const events = new RedisArtifactEventPublisher(redis);
  const { push, enabled: pushEnabled } = createPushNotifier(cfg, db);
  log.info({ pushEnabled }, 'push notifications');

  const scan = {
    db,
    tools: new CliDocumentTools(),
    // Google Vision arrives with BE-20 (PRE-04); until then OCR-only documents fail clearly.
    ocr: notConfiguredOcr,
    objects: S3DocumentObjects.fromConfig(cfg),
    log,
    events,
    push,
  };

  // Stage 3 FIR extraction (TRD §7.6): key and relay URL from env only. Without a key, analysis
  // jobs fail with LLM_NOT_CONFIGURED instead of hanging.
  const llm = createLlmClient({
    baseURL: cfg.ANTHROPIC_BASE_URL,
    apiKey: cfg.ANTHROPIC_API_KEY,
    models: { extraction: cfg.LLM_MODEL_EXTRACTION, assistant: cfg.LLM_MODEL_ASSISTANT },
  });

  return {
    cfg,
    log,
    db,
    scrape,
    scan,
    llm,
    events,
    push,
    qdrant,
    embedder,
    indexer,
    async close() {
      await closeDb();
      await scraperDb?.close();
      redis.disconnect();
    },
  };
}
