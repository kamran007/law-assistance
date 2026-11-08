import { randomUUID } from 'node:crypto';
import { ANALYSIS_JOB, ANALYSIS_QUEUE, SCAN_JOB, SCAN_QUEUE } from '@lawassist/providers';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

/** Starts the scan pipeline for a registered document (TRD §8.1 step 3, §8.2). */
export interface ScanQueue {
  enqueue(job: { artifactId: string; ownerUserId: string }): Promise<void>;
}

/**
 * BullMQ producer. The job id is the artifact id, so a retried registration never starts a second
 * pipeline. The payload carries ids only (the worker loads data through `scoped()`), never document
 * text. The consumer is the worker's scan pipeline (BE-22).
 */
export class BullScanQueue implements ScanQueue {
  private readonly queue: Queue;

  constructor(connection: Redis) {
    this.queue = new Queue(SCAN_QUEUE, {
      connection,
      defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 1000, removeOnFail: 5000 },
    });
  }

  async enqueue(job: { artifactId: string; ownerUserId: string }): Promise<void> {
    await this.queue.add(SCAN_JOB, job, { jobId: job.artifactId });
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

/** Re-runs stages 4–6 after field corrections (TRD §8.5): the worker's `analysis` queue. */
export interface AnalysisQueue {
  enqueueReanalysis(job: { artifactId: string; ownerUserId: string }): Promise<void>;
}

export class BullAnalysisQueue implements AnalysisQueue {
  private readonly queue: Queue;

  constructor(connection: Redis) {
    this.queue = new Queue(ANALYSIS_QUEUE, {
      connection,
      defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 1000, removeOnFail: 5000 },
    });
  }

  async enqueueReanalysis(job: { artifactId: string; ownerUserId: string }): Promise<void> {
    // A fresh id per run: BullMQ ignores an add whose id it still remembers (the first analysis
    // used the artifact id). Double starts are prevented by the READY → SCHEDULE_LOOKUP guard.
    await this.queue.add(ANALYSIS_JOB, { ...job, mode: 'reanalyze' }, { jobId: `${job.artifactId}-reanalyze-${randomUUID()}` });
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
