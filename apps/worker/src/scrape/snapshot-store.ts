import { gunzipSync, gzipSync } from 'node:zlib';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

/** Raw HTML snapshots, gzip-compressed (TRD §6.1): `raw/bdlaws/{act_id}/{fetched_at}.html.gz`. */
export interface SnapshotStore {
  put(actId: number, fetchedAt: Date, html: string): Promise<string>;
  /** Stores HTML gzip-compressed under an explicit key (SCOB list pages, TRD §6A.1). */
  putKey(key: string, html: string): Promise<string>;
  get(key: string): Promise<string>;
}

/** ISO timestamp without ':' so the key is safe in every S3 client and on local disks. */
export function snapshotKey(actId: number, fetchedAt: Date): string {
  return `raw/bdlaws/${actId}/${fetchedAt.toISOString().replace(/:/g, '-')}.html.gz`;
}

export class S3SnapshotStore implements SnapshotStore {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
  ) {}

  static fromConfig(cfg: {
    S3_ENDPOINT?: string | undefined;
    S3_REGION: string;
    S3_BUCKET: string;
    S3_ACCESS_KEY_ID?: string | undefined;
    S3_SECRET_ACCESS_KEY?: string | undefined;
  }): S3SnapshotStore {
    const client = new S3Client({
      region: cfg.S3_REGION,
      ...(cfg.S3_ENDPOINT ? { endpoint: cfg.S3_ENDPOINT, forcePathStyle: true } : {}),
      // Without explicit keys the SDK uses the default chain (IAM role in AWS).
      ...(cfg.S3_ACCESS_KEY_ID && cfg.S3_SECRET_ACCESS_KEY
        ? { credentials: { accessKeyId: cfg.S3_ACCESS_KEY_ID, secretAccessKey: cfg.S3_SECRET_ACCESS_KEY } }
        : {}),
    });
    return new S3SnapshotStore(client, cfg.S3_BUCKET);
  }

  async put(actId: number, fetchedAt: Date, html: string): Promise<string> {
    return this.putKey(snapshotKey(actId, fetchedAt), html);
  }

  async putKey(key: string, html: string): Promise<string> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: gzipSync(Buffer.from(html, 'utf8')),
        ContentType: 'text/html; charset=utf-8',
        ContentEncoding: 'gzip',
      }),
    );
    return key;
  }

  async get(key: string): Promise<string> {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const bytes = await res.Body!.transformToByteArray();
    return gunzipSync(bytes).toString('utf8');
  }
}

export class MemorySnapshotStore implements SnapshotStore {
  readonly objects = new Map<string, Buffer>();

  async put(actId: number, fetchedAt: Date, html: string): Promise<string> {
    return this.putKey(snapshotKey(actId, fetchedAt), html);
  }

  async putKey(key: string, html: string): Promise<string> {
    this.objects.set(key, gzipSync(Buffer.from(html, 'utf8')));
    return key;
  }

  async get(key: string): Promise<string> {
    const obj = this.objects.get(key);
    if (!obj) throw new Error(`No snapshot ${key}`);
    return gunzipSync(obj).toString('utf8');
  }
}
