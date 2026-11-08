import { SCOB_JUDGMENT_JOB, SCOB_JUDGMENT_QUEUE } from '@lawassist/providers';
import { Queue, type ConnectionOptions } from 'bullmq';
import { z } from 'zod';
import { judgmentJobId, type ScobJudgmentJob, type ScobJudgmentQueue } from './crawl';

/**
 * `scob-judgment` producer. Job ids are stable per judgment (`scob-{issue}-{division}-{serial}`),
 * so a crawl that runs again while a judgment is still waiting doesn't queue it twice. Payloads are
 * public list metadata, no user data.
 */
export class BullScobJudgmentQueue implements ScobJudgmentQueue {
  constructor(private readonly queue: Queue) {}

  static create(connection: ConnectionOptions): BullScobJudgmentQueue {
    return new BullScobJudgmentQueue(new Queue(SCOB_JUDGMENT_QUEUE, { connection }));
  }

  async enqueue(jobs: ScobJudgmentJob[]): Promise<void> {
    await this.queue.addBulk(
      jobs.map((data) => ({
        name: SCOB_JUDGMENT_JOB,
        data,
        opts: { jobId: judgmentJobId(data.row), attempts: 3, backoff: { type: 'exponential', delay: 60_000 }, removeOnComplete: 500, removeOnFail: 1000 },
      })),
    );
  }

  close() {
    return this.queue.close();
  }
}

/** Validates a `scob-judgment` payload before processing (it comes from Redis, not from code). */
export const scobJudgmentJobSchema = z.object({
  row: z.object({
    issue: z.number().int().positive(),
    division: z.enum(['AD', 'HCD']),
    serial: z.number().int().positive(),
    parties: z.string(),
    authoringJudge: z.string().nullable(),
    citation: z.string().nullable(),
    caseNumber: z.string().nullable(),
    keyWords: z.string(),
    summary: z.string().nullable(),
    keyRatio: z.string(),
    keyRatioParagraphs: z.array(z.string()),
    pdfUrl: z.string().url().refine((u) => u.startsWith('https://www.supremecourt.gov.bd/'), 'SCOB PDFs only'),
  }),
  issueYear: z.number().int().nullable(),
  listingSnapshotKey: z.string(),
  force: z.boolean(),
});
