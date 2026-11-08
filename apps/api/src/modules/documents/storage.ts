import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/** The upload headers the client must send with the presigned PUT (they are signed). */
export interface PresignedUpload {
  url: string;
  headers: Record<string, string>;
}

/** Object storage for user documents (TRD §8.1). Interface so tests run without S3. */
export interface DocumentStorage {
  presignPut(key: string, contentType: string, sizeBytes: number, ttlSeconds: number): Promise<PresignedUpload>;
  /** Size and content type of an uploaded object, or null if it doesn't exist. */
  head(key: string): Promise<{ sizeBytes: number; contentType: string | undefined } | null>;
  /** The first `n` bytes, for the magic-byte check. */
  readStart(key: string, n: number): Promise<Uint8Array>;
  /** Short-lived download link for the owner ("View original scan"). */
  presignGet(key: string, opts: { ttlSeconds: number; contentType: string; disposition: 'inline' | 'attachment'; filename: string }): Promise<string>;
}

export interface S3StorageConfig {
  S3_ENDPOINT?: string | undefined;
  S3_REGION: string;
  S3_BUCKET: string;
  S3_ACCESS_KEY_ID?: string | undefined;
  S3_SECRET_ACCESS_KEY?: string | undefined;
  S3_SSE?: 'aws:kms' | 'AES256' | undefined;
}

export class S3DocumentStorage implements DocumentStorage {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
    private readonly sse: 'aws:kms' | 'AES256' | undefined,
  ) {}

  static fromConfig(cfg: S3StorageConfig): S3DocumentStorage {
    const s3 = new S3Client({
      region: cfg.S3_REGION,
      ...(cfg.S3_ENDPOINT ? { endpoint: cfg.S3_ENDPOINT, forcePathStyle: true } : {}),
      // Without explicit keys the SDK uses the default chain (IAM task role in AWS).
      ...(cfg.S3_ACCESS_KEY_ID && cfg.S3_SECRET_ACCESS_KEY ? { credentials: { accessKeyId: cfg.S3_ACCESS_KEY_ID, secretAccessKey: cfg.S3_SECRET_ACCESS_KEY } } : {}),
    });
    return new S3DocumentStorage(s3, cfg.S3_BUCKET, cfg.S3_SSE);
  }

  async presignPut(key: string, contentType: string, sizeBytes: number, ttlSeconds: number): Promise<PresignedUpload> {
    const cmd = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
      ContentLength: sizeBytes,
      ...(this.sse ? { ServerSideEncryption: this.sse } : {}),
    });
    const sseHeader: Record<string, string> = this.sse ? { 'x-amz-server-side-encryption': this.sse } : {};
    // Content-Type and Content-Length are signed, so S3 rejects an upload of another type or size.
    const url = await getSignedUrl(this.s3, cmd, {
      expiresIn: ttlSeconds,
      signableHeaders: new Set(['content-type', 'content-length', ...Object.keys(sseHeader)]),
      unhoistableHeaders: new Set(Object.keys(sseHeader)),
    });
    return { url, headers: { 'content-type': contentType, 'content-length': String(sizeBytes), ...sseHeader } };
  }

  async head(key: string) {
    try {
      const res = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { sizeBytes: res.ContentLength ?? 0, contentType: res.ContentType };
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || status === 403) return null;
      throw err;
    }
  }

  async presignGet(key: string, opts: { ttlSeconds: number; contentType: string; disposition: 'inline' | 'attachment'; filename: string }): Promise<string> {
    // The response headers are part of the signature: the link serves this type and disposition only.
    const cmd = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ResponseContentType: opts.contentType,
      ResponseContentDisposition: `${opts.disposition}; filename="${opts.filename}"`,
      ResponseCacheControl: 'private, no-store',
    });
    return getSignedUrl(this.s3, cmd, { expiresIn: opts.ttlSeconds });
  }

  async readStart(key: string, n: number): Promise<Uint8Array> {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=0-${n - 1}` }));
    return res.Body ? await res.Body.transformToByteArray() : new Uint8Array();
  }
}
