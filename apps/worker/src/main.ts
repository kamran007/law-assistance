import { Queue, Worker } from 'bullmq';
import { z } from 'zod';
import { createWorkerContext } from './context';
import { ensureChunkCollection, ensureJudgmentCollection } from './index/collection';
import { drainOutbox } from './index/outbox';
import { ANALYSIS_QUEUE, SCAN_QUEUE } from '@lawassist/providers';
import { processAnalysisJob } from './analysis/job';
import { BullAnalysisQueue } from './scan/objects';
import { markFailedAfterRetries, processScanJob } from './scan/pipeline';
import { runScrape } from './scrape/run-scrape';
import { runScobCrawl } from './scob/crawl';
import { processScobJudgment } from './scob/process';
import { scobJudgmentJobSchema } from './scob/queue';
import { SCOB_JUDGMENT_QUEUE, SCOB_QUEUE } from '@lawassist/providers';

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
const analysisJobSchema = documentJobSchema.extend({ mode: z.enum(['full', 'reanalyze']).optional() });

const scobCrawlJobSchema = z.object({
  kind: z.enum(['WEEKLY', 'BACKFILL', 'MANUAL']),
  issues: z.array(z.number().int().positive()).optional(),
  all: z.boolean().optional(),
});

const scrapeJobSchema = z.object({
  kind: z.enum(['NIGHTLY', 'FULL', 'MANUAL']),
  actIds: z.array(z.number().int().positive()).optional(),
  force: z.boolean().optional(),
});

async function main() {
  const ctx = createWorkerContext();
  const connection = { url: ctx.cfg.REDIS_URL, maxRetriesPerRequest: null };

  await ensureChunkCollection(ctx.qdrant, ctx.cfg.QDRANT_COLLECTION, ctx.embedder.dimensions, ctx.log);
  await ensureJudgmentCollection(ctx.qdrant, ctx.cfg.QDRANT_JUDGMENT_COLLECTION, ctx.embedder.dimensions, ctx.log);

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

  // SCOB case law (TRD §6A.1): weekly, Saturday 04:00 Dhaka, only when enabled (PRE-11: site terms).
  const scobQueue = new Queue(SCOB_QUEUE, { connection });
  if (ctx.cfg.SCOB_CRAWL_ENABLED) {
    await scobQueue.upsertJobScheduler(
      'scob-weekly',
      { pattern: '0 4 * * 6', tz: 'Asia/Dhaka' },
      { name: 'scob', data: { kind: 'WEEKLY' }, opts: { removeOnComplete: 50, removeOnFail: 200 } },
    );
  } else {
    await scobQueue.removeJobScheduler('scob-weekly');
  }
  const scobWorker = new Worker(SCOB_QUEUE, async (job) => runScobCrawl(ctx.scob, scobCrawlJobSchema.parse(job.data)), {
    connection,
    concurrency: 1,
    lockDuration: 10 * 60_000,
  });

  // One judgment at a time: downloads share the SCOB host limiter (TRD §6A.3).
  const scobJudgmentWorker = new Worker(SCOB_JUDGMENT_QUEUE, async (job) => processScobJudgment(ctx.scobProcess, scobJudgmentJobSchema.parse(job.data)), {
    connection,
    concurrency: 1,
    lockDuration: 5 * 60_000,
  });

  // The outbox pauses while TEI is unreachable; log only when that changes, not every 15 s.
  let teiUp: boolean | null = null;
  const embedderReady = async () => {
    const ok = await ctx.embedder.ready();
    if (ok !== teiUp) ctx.log[ok ? 'info' : 'warn']({ embedder: ok }, ok ? 'embedding server reachable: outbox indexing runs' : 'embedding server not reachable: outbox indexing paused');
    teiUp = ok;
    return ok;
  };

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
  const outboxWorker = new Worker(OUTBOX_QUEUE, async () => drainOutbox({ db: ctx.db, indexer: ctx.indexer, judgments: ctx.judgmentIndexer, log: ctx.log, ready: embedderReady }), {
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
      void markFailedAfterRetries(ctx.db, parsed.data, ctx.scan).catch((e: unknown) => ctx.log.error({ jobId: job.id, err: String(e) }, 'could not mark scan failed'));
    }
  });

  // Stages 3–5 (TRD §8.2): LLM extraction + deterministic post-processing + Schedule II.
  const analysisWorker = new Worker(
    ANALYSIS_QUEUE,
    async (job) => processAnalysisJob({ db: ctx.db, llm: ctx.llm, log: ctx.log, events: ctx.events, push: ctx.push }, analysisJobSchema.parse(job.data)),
    { connection, concurrency: 4, lockDuration: 5 * 60_000 },
  );
  analysisWorker.on('failed', (job) => {
    if (!job) return;
    const parsed = documentJobSchema.safeParse(job.data);
    if (parsed.success && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      void markFailedAfterRetries(ctx.db, parsed.data, ctx.scan).catch((e: unknown) => ctx.log.error({ jobId: job.id, err: String(e) }, 'could not mark analysis failed'));
    }
  });

  for (const [name, w] of [
    ['scrape', scrapeWorker],
    ['scob', scobWorker],
    ['scob-judgment', scobJudgmentWorker],
    ['outbox', outboxWorker],
    ['scan', scanWorker],
    ['analysis', analysisWorker],
  ] as const) {
    w.on('failed', (job, err) => ctx.log.error({ queue: name, jobId: job?.id, attempts: job?.attemptsMade, err: err.message }, 'job failed'));
  }
  ctx.log.info({ queues: [SCRAPE_QUEUE, OUTBOX_QUEUE, SCAN_QUEUE, ANALYSIS_QUEUE, SCOB_QUEUE, SCOB_JUDGMENT_QUEUE], scobWeekly: ctx.cfg.SCOB_CRAWL_ENABLED }, 'worker started');

  const shutdown = async () => {
    ctx.log.info({}, 'shutting down');
    await Promise.all([scrapeWorker.close(), scobWorker.close(), scobJudgmentWorker.close(), outboxWorker.close(), scanWorker.close(), analysisWorker.close()]);
    await Promise.all([scrapeQueue.close(), scobQueue.close(), outboxQueue.close(), analysis.close()]);
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
