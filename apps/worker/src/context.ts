import { Redis } from 'ioredis';
import { pino } from 'pino';
import { loadConfig } from '@lawassist/config';
import { createDb } from '@lawassist/db';
import { QdrantChunkIndex, TeiEmbeddingProvider, createQdrantClient, notConfiguredOcr, statuteGenerationKey } from '@lawassist/providers';
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
  const scan = {
    db,
    tools: new CliDocumentTools(),
    // Google Vision arrives with BE-20 (PRE-04); until then OCR-only documents fail clearly.
    ocr: notConfiguredOcr,
    objects: S3DocumentObjects.fromConfig(cfg),
    log,
  };

  return {
    cfg,
    log,
    db,
    scrape,
    scan,
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
