import { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { S3DocumentStorage } from '../src/modules/documents/storage';

/** Presigned download links (offline: signing needs no network). */
describe('S3DocumentStorage.presignGet', () => {
  it('signs the response type, disposition and no-store, with the given expiry', async () => {
    const s3 = new S3Client({ region: 'ap-south-1', endpoint: 'http://localhost:9000', forcePathStyle: true, credentials: { accessKeyId: 'k', secretAccessKey: 's' } });
    const url = new URL(await new S3DocumentStorage(s3, 'bucket', undefined).presignGet('tenants/u/cases/c/a/original.pdf', { ttlSeconds: 300, contentType: 'application/pdf', disposition: 'inline', filename: 'original.pdf' }));
    expect(url.pathname).toBe('/bucket/tenants/u/cases/c/a/original.pdf');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('response-content-type')).toBe('application/pdf');
    expect(url.searchParams.get('response-content-disposition')).toBe('inline; filename="original.pdf"');
    expect(url.searchParams.get('response-cache-control')).toBe('private, no-store');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });
});
