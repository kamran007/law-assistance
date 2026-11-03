import { Redis } from 'ioredis';
import { pino } from 'pino';
import { loadConfig } from '@lawassist/config';
import { createDb } from '@lawassist/db';
import { QdrantChunkIndex, TeiEmbeddingProvider, createQdrantClient } from '@lawassist/providers';
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
  const { db, close: closeDb } = createDb(cfg.DATABASE_URL, { connectionLimit: 5 });
  const redis = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: null });
  const config = loadSourceConfig();
  const scrape: ScrapeDeps = {
    db,
    http: new PoliteHttpClient({ config, cache: new RedisConditionalCache(redis) }),
    snapshots: S3SnapshotStore.fromConfig(cfg),
    config,
    log,
  };

  const qdrant = createQdrantClient({ url: cfg.QDRANT_URL, apiKey: cfg.QDRANT_API_KEY });
  const embedder = new TeiEmbeddingProvider({ url: cfg.TEI_EMBED_URL, model: cfg.EMBEDDING_MODEL });
  const indexer = new SectionIndexer({ db, embedder, index: new QdrantChunkIndex(qdrant, cfg.QDRANT_COLLECTION) });

  return {
    cfg,
    log,
    db,
    scrape,
    qdrant,
    embedder,
    indexer,
    async close() {
      await closeDb();
      redis.disconnect();
    },
  };
}
