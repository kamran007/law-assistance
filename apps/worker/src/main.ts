import { Queue, Worker } from 'bullmq';
import { z } from 'zod';
import { createWorkerContext } from './context';
import { runScrape } from './scrape/run-scrape';

/**
 * Worker process. Queues so far: `scrape` (TRD §3.1, §6.1).
 *   nightly  02:00 Asia/Dhaka  conditional GET, per-Act change detection
 *   weekly   Friday 03:00      full re-crawl (no conditional GET)
 * Concurrency 1: the 1 req/s limit is global, and one crawl at a time keeps it that way.
 */
export const SCRAPE_QUEUE = 'scrape';

const scrapeJobSchema = z.object({
  kind: z.enum(['NIGHTLY', 'FULL', 'MANUAL']),
  actIds: z.array(z.number().int().positive()).optional(),
  force: z.boolean().optional(),
});

async function main() {
  const ctx = createWorkerContext();
  const connection = { url: ctx.cfg.REDIS_URL, maxRetriesPerRequest: null };

  const queue = new Queue(SCRAPE_QUEUE, { connection });
  await queue.upsertJobScheduler(
    'scrape-nightly',
    { pattern: '0 2 * * *', tz: 'Asia/Dhaka' },
    { name: 'scrape', data: { kind: 'NIGHTLY' }, opts: { removeOnComplete: 100, removeOnFail: 500 } },
  );
  await queue.upsertJobScheduler(
    'scrape-weekly-full',
    { pattern: '0 3 * * 5', tz: 'Asia/Dhaka' },
    { name: 'scrape', data: { kind: 'FULL' }, opts: { removeOnComplete: 50, removeOnFail: 200 } },
  );

  const worker = new Worker(
    SCRAPE_QUEUE,
    async (job) => {
      const req = scrapeJobSchema.parse(job.data);
      return runScrape(ctx.scrape, req);
    },
    // A full crawl of ~1,480 Acts at 1 req/s takes hours; keep the lock alive meanwhile.
    { connection, concurrency: 1, lockDuration: 10 * 60_000 },
  );
  worker.on('failed', (job, err) => ctx.log.error({ jobId: job?.id, err: err.message }, 'scrape job failed'));
  ctx.log.info({ queue: SCRAPE_QUEUE }, 'worker started');

  const shutdown = async () => {
    ctx.log.info({}, 'shutting down');
    await worker.close();
    await queue.close();
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
