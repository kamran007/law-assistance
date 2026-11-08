import { Queue, Worker } from 'bullmq';
import { z } from 'zod';
import { createWorkerContext } from './context';
import { ensureChunkCollection } from './index/collection';
import { drainOutbox } from './index/outbox';
import { ANALYSIS_QUEUE, SCAN_QUEUE } from '@lawassist/providers';
import { processAnalysisJob } from './analysis/job';
import { BullAnalysisQueue } from './scan/objects';
import { markFailedAfterRetries, processScanJob } from './scan/pipeline';
import { runScrape } from './scrape/run-scrape';

/**
 * Worker process (TRD §3.1). Queues:
 *   scrape  nightly 02:00 Asia/Dhaka (conditional GET) + weekly full re-crawl Friday 03:00 (TRD §6.1)
 *   outbox  every 15 s: MySQL outbox → TEI embed → Qdrant (TRD §4.4, §6.4)
 *   scan      documents registered by the API: sanitize, extract text → `analysis` queue (TRD §8.2)
 *   analysis  LLM FIR extraction + dates, sections, Schedule II → structured_analysis (stages 3–5)
 * scrape and outbox run with concurrency 1: the crawl's 1 req/s limit is global, and the outbox has
 * one consumer. scan runs 2 at a time (CPU-bound tools); analysis 4 (waits on the LLM).
 */
export const SCRAPE_QUEUE = 'scrape';
export const OUTBOX_QUEUE = 'outbox';

const documentJobSchema = z.object({ artifactId: z.uuid(), ownerUserId: z.uuid() });

const scrapeJobSchema = z.object({
  kind: z.enum(['NIGHTLY', 'FULL', 'MANUAL']),
  actIds: z.array(z.number().int().positive()).optional(),
  force: z.boolean().optional(),
});

async function main() {
  const ctx = createWorkerContext();
  const connection = { url: ctx.cfg.REDIS_URL, maxRetriesPerRequest: null };

  await ensureChunkCollection(ctx.qdrant, ctx.cfg.QDRANT_COLLECTION, ctx.embedder.dimensions, ctx.log);

  const scrapeQueue = new Queue(SCRAPE_QUEUE, { connection });
  await scrapeQueue.upsertJobScheduler(
    'scrape-nightly',
    { pattern: '0 2 * * *', tz: 'Asia/Dhaka' },
    { name: 'scrape', data: { kind: 'NIGHTLY' }, opts: { removeOnComplete: 100, removeOnFail: 500 } },
  );
  await scrapeQueue.upsertJobScheduler(
    'scrape-weekly-full',
    { pattern: '0 3 * * 5', tz: 'Asia/Dhaka' },
    { name: 'scrape', data: { kind: 'FULL' }, opts: { removeOnComplete: 50, removeOnFail: 200 } },
  );

  const outboxQueue = new Queue(OUTBOX_QUEUE, { connection });
  await outboxQueue.upsertJobScheduler(
    'outbox-drain',
    { every: 15_000 },
    { name: 'drain', data: {}, opts: { removeOnComplete: 20, removeOnFail: 100 } },
  );

  const scrapeWorker = new Worker(
    SCRAPE_QUEUE,
    async (job) => runScrape(ctx.scrape, scrapeJobSchema.parse(job.data)),
    // A full crawl of ~1,480 Acts at 1 req/s takes hours; keep the lock alive meanwhile.
    { connection, concurrency: 1, lockDuration: 10 * 60_000 },
  );
  const outboxWorker = new Worker(OUTBOX_QUEUE, async () => drainOutbox({ db: ctx.db, indexer: ctx.indexer, log: ctx.log }), {
    connection,
    concurrency: 1,
    lockDuration: 5 * 60_000,
  });

  // Scan pipeline stages 1–2 (TRD §8.2). Jobs come from the API (BE-21) with 3 attempts.
  const analysis = BullAnalysisQueue.create(connection);
  const scanWorker = new Worker(
    SCAN_QUEUE,
    async (job) => processScanJob({ ...ctx.scan, analysis }, documentJobSchema.parse(job.data)),
    { connection, concurrency: 2, lockDuration: 5 * 60_000 },
  );
  scanWorker.on('failed', (job) => {
    if (!job) return;
    const parsed = documentJobSchema.safeParse(job.data);
    if (parsed.success && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      void markFailedAfterRetries(ctx.db, parsed.data).catch((e: unknown) => ctx.log.error({ jobId: job.id, err: String(e) }, 'could not mark scan failed'));
    }
  });

  // Stages 3–5 (TRD §8.2): LLM extraction + deterministic post-processing + Schedule II.
  const analysisWorker = new Worker(
    ANALYSIS_QUEUE,
    async (job) => processAnalysisJob({ db: ctx.db, llm: ctx.llm, log: ctx.log }, documentJobSchema.parse(job.data)),
    { connection, concurrency: 4, lockDuration: 5 * 60_000 },
  );
  analysisWorker.on('failed', (job) => {
    if (!job) return;
    const parsed = documentJobSchema.safeParse(job.data);
    if (parsed.success && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      void markFailedAfterRetries(ctx.db, parsed.data).catch((e: unknown) => ctx.log.error({ jobId: job.id, err: String(e) }, 'could not mark analysis failed'));
    }
  });

  for (const [name, w] of [
    ['scrape', scrapeWorker],
    ['outbox', outboxWorker],
    ['scan', scanWorker],
    ['analysis', analysisWorker],
  ] as const) {
    w.on('failed', (job, err) => ctx.log.error({ queue: name, jobId: job?.id, attempts: job?.attemptsMade, err: err.message }, 'job failed'));
  }
  ctx.log.info({ queues: [SCRAPE_QUEUE, OUTBOX_QUEUE, SCAN_QUEUE, ANALYSIS_QUEUE] }, 'worker started');

  const shutdown = async () => {
    ctx.log.info({}, 'shutting down');
    await Promise.all([scrapeWorker.close(), outboxWorker.close(), scanWorker.close(), analysisWorker.close()]);
    await Promise.all([scrapeQueue.close(), outboxQueue.close(), analysis.close()]);
    await ctx.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
