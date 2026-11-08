import { SCOB_JUDGMENT_JOB, SCOB_JUDGMENT_QUEUE } from '@lawassist/providers';
import { Queue, type ConnectionOptions } from 'bullmq';
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
