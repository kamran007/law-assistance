import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ANALYSIS_JOB, ANALYSIS_QUEUE, type DocumentJob } from '@lawassist/providers';
import { Queue } from 'bullmq';
import type { AnalysisQueue, DocumentObjects } from './pipeline';

/** User documents in S3 (TRD §8.1 key layout). Writes use the bucket's SSE setting. */
export class S3DocumentObjects implements DocumentObjects {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
    private readonly sse: 'aws:kms' | 'AES256' | undefined,
  ) {}

  static fromConfig(cfg: {
    S3_ENDPOINT?: string | undefined;
    S3_REGION: string;
    S3_BUCKET: string;
    S3_ACCESS_KEY_ID?: string | undefined;
    S3_SECRET_ACCESS_KEY?: string | undefined;
    S3_SSE?: 'aws:kms' | 'AES256' | undefined;
  }): S3DocumentObjects {
    const s3 = new S3Client({
      region: cfg.S3_REGION,
      ...(cfg.S3_ENDPOINT ? { endpoint: cfg.S3_ENDPOINT, forcePathStyle: true } : {}),
      ...(cfg.S3_ACCESS_KEY_ID && cfg.S3_SECRET_ACCESS_KEY ? { credentials: { accessKeyId: cfg.S3_ACCESS_KEY_ID, secretAccessKey: cfg.S3_SECRET_ACCESS_KEY } } : {}),
    });
    return new S3DocumentObjects(s3, cfg.S3_BUCKET, cfg.S3_SSE);
  }

  async get(key: string): Promise<Uint8Array> {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error('empty object body');
    return res.Body.transformToByteArray();
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes, ContentType: contentType, ...(this.sse ? { ServerSideEncryption: this.sse } : {}) }),
    );
  }
}

/** Hands a document to stage 3 (BE-23). Job id = artifact id, so a re-run never queues it twice. */
export class BullAnalysisQueue implements AnalysisQueue {
  constructor(private readonly queue: Queue) {}

  static create(connection: { url: string; maxRetriesPerRequest: null }): BullAnalysisQueue {
    return new BullAnalysisQueue(new Queue(ANALYSIS_QUEUE, { connection, defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 1000, removeOnFail: 5000 } }));
  }

  async enqueue(job: DocumentJob): Promise<void> {
    await this.queue.add(ANALYSIS_JOB, job, { jobId: job.artifactId });
  }

  close(): Promise<void> {
    return this.queue.close();
  }
}
